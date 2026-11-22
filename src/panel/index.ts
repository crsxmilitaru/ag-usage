import * as crypto from 'crypto';
import * as vscode from 'vscode';
import {
	CONFIG_NAMESPACE,
	DEFAULT_LIVE_SYNC,
	DEFAULT_REFRESH_INTERVAL,
	GITHUB_ISSUES_URL,
	OPEN_MODELS_SETTINGS_COMMAND,
	PANEL_SETTINGS_OPEN_CONTEXT,
	PanelSectionId,
	REFRESH_COMMAND,
	SETTINGS_COMMAND
} from '../constants';
import { getAbsoluteTimeFormat, resolveLocale } from '../formatter';
import { QuotaHistory } from '../history';
import { AbsoluteTimeFormat, ModelUsageSummary, PublicServiceStatus, ServiceStatus, UsageStatistics } from '../types';
import {
	escapeHtml,
	getErrorMessage,
	normalizePanelSectionLayout,
	normalizeRefreshIntervalSeconds,
	PanelSectionSlot
} from '../utils';
import { buildQuotaCards, buildTopRow } from './cards';
import {
	buildCustomTooltipElement,
	buildErrorBanner,
	buildErrorScreen,
	buildFallbackErrorHtml,
	buildInitialLoadingScreen,
	buildNotFoundScreen
} from './screens';
import { getPanelScript } from './script';
import {
	buildSettingsView,
	PanelSettingsState,
	readPanelSettings,
	resetAllPanelSettings,
	resetPanelSetting,
	updatePanelSetting
} from './settings';
import { getSettingsScript } from './settingsScript';
import { getSettingsStyles } from './settingsStyles';
import { getPanelStyles } from './styles';
import { buildHeatmapSection, buildModelUsageSection, buildPublicHealthChart, buildResetCalendarSection } from './widgets';

interface PanelBuildContext {
	statsData: UsageStatistics | null;
	history: QuotaHistory;
	heatmapMonth: number;
	heatmapYear: number;
	locale?: string;
	timeFormat: AbsoluteTimeFormat;
	publicServiceStatus: PublicServiceStatus | null;
	modelUsage: ModelUsageSummary | null;
}

interface PanelRenderOptions {
	ctx: PanelBuildContext;
	serviceStatus: ServiceStatus;
	refreshInterval: number;
	panelSections: PanelSectionSlot[];
	errorMessage: string | null;
	liveSync: boolean;
	updatedAt: number;
}

function buildPanelSectionContent(id: PanelSectionId, ctx: PanelBuildContext): string {
	switch (id) {
		case 'plan':
			return buildTopRow(ctx.statsData);
		case 'health':
			return buildPublicHealthChart(ctx.publicServiceStatus, ctx.locale, ctx.timeFormat);
		case 'quotas': {
			const cards = buildQuotaCards(ctx.statsData, ctx.history, ctx.locale, ctx.timeFormat);
			if (!cards) { return ''; }
			return `<div class="section"><div class="quota-grid">${cards}</div></div>`;
		}
		case 'resets':
			return buildResetCalendarSection(ctx.statsData, ctx.locale, ctx.timeFormat);
		case 'models':
			return buildModelUsageSection(ctx.modelUsage);
		case 'activity':
			return buildHeatmapSection(ctx.history.getDailyUsage(), ctx.heatmapMonth, ctx.heatmapYear, ctx.locale);
		default:
			return '';
	}
}

function buildOrderedPanelBody(ctx: PanelBuildContext, layout: PanelSectionSlot[]): string {
	const sections: string[] = [];
	for (const slot of layout) {
		if (slot.hidden) {
			continue;
		}
		const html = buildPanelSectionContent(slot.id, ctx);
		if (html.length > 0) {
			sections.push(html);
		}
	}
	return sections.join('');
}

function formatSyncFooterLabel(liveSync: boolean, refreshInterval: number): string {
	const pollingSeconds = normalizeRefreshIntervalSeconds(refreshInterval);
	if (liveSync && pollingSeconds > 0) {
		return `Live + ${pollingSeconds}s`;
	}
	if (liveSync) {
		return 'Live sync';
	}
	return pollingSeconds > 0 ? `Auto: ${pollingSeconds}s` : 'Auto: Off';
}

function buildPanelHtml(options: PanelRenderOptions): string {
	const { ctx, serviceStatus, refreshInterval, panelSections, errorMessage, liveSync, updatedAt } = options;
	const nonce = crypto.randomBytes(16).toString('base64');
	const showInitialLoading = serviceStatus === 'loading' && !ctx.statsData;
	const showNotFound = serviceStatus === 'not-found' && !ctx.statsData;
	const showError = Boolean(errorMessage) && !ctx.statsData && !showInitialLoading && !showNotFound;
	const isFullScreen = showInitialLoading || showNotFound || showError;
	const bodyClass = isFullScreen ? ' class="panel-loading-body"' : '';

	let bodyContent: string;
	if (showInitialLoading) {
		bodyContent = buildInitialLoadingScreen();
	} else if (showNotFound) {
		bodyContent = buildNotFoundScreen();
	} else if (showError && errorMessage) {
		bodyContent = buildErrorScreen(errorMessage);
	} else {
		const errorBanner = errorMessage ? buildErrorBanner(errorMessage) : '';
		const syncLabel = formatSyncFooterLabel(liveSync, refreshInterval);
		bodyContent = `${errorBanner}${buildOrderedPanelBody(ctx, panelSections)}<div class="panel-footer"><span id="lastUpdated">Updated just now</span><span class="refresh-interval-info">• ${escapeHtml(syncLabel)}</span></div>`;
	}

	return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><title>AG Usage</title><style>${getPanelStyles()}</style></head><body${bodyClass}>${bodyContent}${buildCustomTooltipElement()}<script nonce="${nonce}">${getPanelScript(updatedAt)}</script></body></html>`;
}

function buildSettingsHtml(settings: PanelSettingsState): string {
	const nonce = crypto.randomBytes(16).toString('base64');
	return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><title>AG Usage Settings</title><style>${getPanelStyles()}${getSettingsStyles()}</style></head><body>${buildSettingsView(settings)}<script nonce="${nonce}">${getSettingsScript(settings)}</script></body></html>`;
}

export class UsageViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'ag-usage.sidebarPanel';
	private view?: vscode.WebviewView;
	private lastStatsData: UsageStatistics | null = null;
	private quotaHistory: QuotaHistory | null = null;
	private lastServiceStatus: ServiceStatus = 'disconnected';
	private lastErrorMessage: string | null = null;
	private publicServiceStatus: PublicServiceStatus | null = null;
	private modelUsage: ModelUsageSummary | null = null;
	private lastUpdatedAt: number = Date.now();
	private heatmapMonth: number = new Date().getMonth();
	private heatmapYear: number = new Date().getFullYear();
	private heatmapNavigated = false;
	private settingsOpen = false;
	private renderedMode: 'dashboard' | 'settings' | null = null;
	private notifiedVisible = false;
	private settingsMutationQueue: Promise<void> = Promise.resolve();
	private pendingSettingsMutations = 0;
	private viewDisposables: vscode.Disposable[] = [];
	public onHistoryChanged?: (history: QuotaHistory) => void;
	public onDidBecomeVisible?: () => void;
	public log?: (message: string, error?: unknown) => void;

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	) {
		this.disposeViewListeners();
		this.view = webviewView;
		this.renderedMode = null;
		this.notifiedVisible = false;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: []
		};

		webviewView.onDidDispose(() => {
			if (this.view === webviewView) {
				this.view = undefined;
				this.renderedMode = null;
				this.notifiedVisible = false;
				this.setSettingsOpen(false, false);
			}
			this.disposeViewListeners();
		}, null, this.viewDisposables);

		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) {
				this.notifyVisible();
			} else {
				this.notifiedVisible = false;
			}
		}, null, this.viewDisposables);

		webviewView.webview.onDidReceiveMessage((rawMessage: unknown) => {
			if (!rawMessage || typeof rawMessage !== 'object') { return; }
			const message = rawMessage as Record<string, unknown>;
			const command = message.command;
			if (command === 'clearHistory') {
				if (this.quotaHistory && typeof message.category === 'string' && message.category.length < 100) {
					this.quotaHistory.clearCategory(message.category);
					this.onHistoryChanged?.(this.quotaHistory);
					this.updateView();
				}
			} else if (command === 'retry') {
				void vscode.commands.executeCommand(REFRESH_COMMAND);
			} else if (command === 'copyError' && typeof message.text === 'string') {
				void vscode.env.clipboard.writeText(message.text).then(() => {
					void this.view?.webview.postMessage({ command: 'copyErrorResult', success: true });
				}, (error: unknown) => {
					this.log?.('Failed to copy panel error', error);
					void this.view?.webview.postMessage({ command: 'copyErrorResult', success: false });
				});
			} else if (command === 'openIssues') {
				void vscode.env.openExternal(vscode.Uri.parse(GITHUB_ISSUES_URL));
			} else if (command === 'openAntigravitySettings') {
				void vscode.commands.executeCommand(OPEN_MODELS_SETTINGS_COMMAND);
			} else if (command === 'prevMonth') {
				this.shiftHeatmapMonth(-1);
			} else if (command === 'nextMonth') {
				this.shiftHeatmapMonth(1);
			} else if (command === 'closeSettings') {
				this.setSettingsOpen(false, true);
			} else if (command === 'openVsCodeSettings') {
				void vscode.commands.executeCommand(SETTINGS_COMMAND);
			} else if (command === 'updateSetting' && typeof message.key === 'string') {
				this.enqueueSettingsMutation(() => this.handleUpdateSettingMessage(message.key as string, message.value));
			} else if (command === 'resetSetting' && typeof message.key === 'string') {
				this.enqueueSettingsMutation(() => this.handleResetSettingMessage(message.key as string));
			} else if (command === 'resetAllSettings') {
				void this.handleResetAllSettingsMessage();
			}
		}, null, this.viewDisposables);

		this.updateView();
		if (webviewView.visible) {
			this.notifyVisible();
		}
	}

	private shiftHeatmapMonth(delta: number): void {
		this.syncHeatmapToCurrentMonth();
		this.heatmapMonth += delta;
		if (this.heatmapMonth < 0) {
			this.heatmapMonth = 11;
			this.heatmapYear--;
		} else if (this.heatmapMonth > 11) {
			this.heatmapMonth = 0;
			this.heatmapYear++;
		}
		const now = new Date();
		this.heatmapNavigated = this.heatmapMonth !== now.getMonth() || this.heatmapYear !== now.getFullYear();
		this.updateView();
	}

	private syncHeatmapToCurrentMonth(): void {
		if (this.heatmapNavigated) { return; }
		const now = new Date();
		this.heatmapMonth = now.getMonth();
		this.heatmapYear = now.getFullYear();
	}

	private notifyVisible(): void {
		if (this.notifiedVisible) { return; }
		this.notifiedVisible = true;
		this.onDidBecomeVisible?.();
	}

	private setSettingsOpen(open: boolean, rerender: boolean): void {
		if (this.settingsOpen === open) { return; }
		this.settingsOpen = open;
		void vscode.commands.executeCommand('setContext', PANEL_SETTINGS_OPEN_CONTEXT, this.settingsOpen);
		if (rerender) {
			this.updateView();
		}
	}

	public isSettingsOpen(): boolean {
		return this.settingsOpen;
	}

	public openSettings(): void {
		this.setSettingsOpen(true, true);
	}

	public closeSettings(): void {
		this.setSettingsOpen(false, true);
	}

	public syncSettings(): void {
		if (!this.view || !this.settingsOpen || this.renderedMode !== 'settings') { return; }
		if (this.pendingSettingsMutations > 0) { return; }
		void this.view.webview.postMessage({
			command: 'settingsSync',
			settings: readPanelSettings()
		});
	}

	public update(
		statsData: UsageStatistics | null,
		history: QuotaHistory,
		serviceStatus: ServiceStatus = 'disconnected',
		publicServiceStatus: PublicServiceStatus | null = null,
		modelUsage: ModelUsageSummary | null = null,
		errorMessage?: string | null,
		updatedAt?: number
	): void {
		this.lastStatsData = statsData;
		this.quotaHistory = history;
		this.lastServiceStatus = serviceStatus;
		this.publicServiceStatus = publicServiceStatus;
		this.modelUsage = modelUsage;
		if (typeof updatedAt === 'number' && Number.isFinite(updatedAt) && updatedAt > 0) {
			this.lastUpdatedAt = updatedAt;
		} else if (serviceStatus !== 'loading' && serviceStatus !== 'disconnected' && serviceStatus !== 'not-found' && statsData !== null) {
			this.lastUpdatedAt = Date.now();
		}
		if (errorMessage !== undefined) {
			this.lastErrorMessage = errorMessage;
		} else if (serviceStatus !== 'disconnected') {
			this.lastErrorMessage = null;
		}
		if (this.view && !this.settingsOpen) {
			this.updateView();
		}
	}

	public updateView(): void {
		if (!this.view) { return; }
		if (this.settingsOpen) {
			if (this.renderedMode === 'settings') {
				this.syncSettings();
				return;
			}
			try {
				this.view.webview.html = buildSettingsHtml(readPanelSettings());
				this.renderedMode = 'settings';
			} catch (error) {
				const message = getErrorMessage(error);
				this.log?.('Failed to render panel settings', error);
				this.renderedMode = null;
				this.view.webview.html = buildFallbackErrorHtml(message);
			}
			return;
		}
		if (!this.quotaHistory) { return; }
		this.syncHeatmapToCurrentMonth();
		const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
		const locale = resolveLocale(config.get<string>('dateFormatLocale', 'default'));
		const timeFormat = getAbsoluteTimeFormat();
		const refreshInterval = config.get<number>('refreshInterval', DEFAULT_REFRESH_INTERVAL);
		const liveSync = config.get<boolean>('liveSync', DEFAULT_LIVE_SYNC);
		const panelSections = normalizePanelSectionLayout(config.get<unknown>('panelSections'));
		const ctx = this.getPanelBuildContext(locale, timeFormat);

		try {
			this.view.webview.html = buildPanelHtml({
				ctx,
				serviceStatus: this.lastServiceStatus,
				refreshInterval,
				panelSections,
				errorMessage: this.lastErrorMessage,
				liveSync,
				updatedAt: this.lastUpdatedAt
			});
			this.renderedMode = 'dashboard';
		} catch (error) {
			const message = getErrorMessage(error);
			this.lastErrorMessage = message;
			this.log?.('Failed to render usage panel', error);
			try {
				this.view.webview.html = buildPanelHtml({
					ctx: {
						...ctx,
						statsData: null,
						publicServiceStatus: null,
						modelUsage: null
					},
					serviceStatus: 'disconnected',
					refreshInterval,
					panelSections,
					errorMessage: message,
					liveSync,
					updatedAt: this.lastUpdatedAt
				});
				this.renderedMode = 'dashboard';
			} catch (fallbackError) {
				this.log?.('Failed to render usage panel error state', fallbackError);
				this.renderedMode = null;
				this.view.webview.html = buildFallbackErrorHtml(message);
			}
		}
	}

	private enqueueSettingsMutation(work: () => Promise<void>): void {
		this.pendingSettingsMutations++;
		this.settingsMutationQueue = this.settingsMutationQueue.then(async () => {
			try {
				await work();
			} catch (error) {
				this.log?.('Unexpected error while updating panel settings', error);
			} finally {
				this.pendingSettingsMutations--;
				if (this.pendingSettingsMutations === 0) {
					this.syncSettings();
				}
			}
		});
	}

	private async handleUpdateSettingMessage(key: string, value: unknown): Promise<void> {
		if (!this.settingsOpen) { return; }
		try {
			await updatePanelSetting(key, value);
		} catch (error) {
			this.log?.(`Failed to update setting ${key}`, error);
			vscode.window.showErrorMessage(`Failed to update setting "${key}": ${getErrorMessage(error)}`);
		}
	}

	private async handleResetSettingMessage(key: string): Promise<void> {
		if (!this.settingsOpen) { return; }
		try {
			await resetPanelSetting(key);
		} catch (error) {
			this.log?.(`Failed to reset setting ${key}`, error);
			vscode.window.showErrorMessage(`Failed to reset setting "${key}": ${getErrorMessage(error)}`);
		}
	}

	private async handleResetAllSettingsMessage(): Promise<void> {
		if (!this.settingsOpen) { return; }
		const confirmation = await vscode.window.showWarningMessage(
			'Reset all AG Usage settings to their default values?',
			{ modal: true },
			'Reset'
		);
		if (confirmation !== 'Reset' || !this.settingsOpen) { return; }
		this.enqueueSettingsMutation(async () => {
			if (!this.settingsOpen) { return; }
			try {
				await resetAllPanelSettings();
			} catch (error) {
				this.log?.('Failed to reset AG Usage settings', error);
				vscode.window.showErrorMessage(`Failed to reset settings: ${getErrorMessage(error)}`);
			}
		});
	}

	private getPanelBuildContext(locale: string | undefined, timeFormat: AbsoluteTimeFormat): PanelBuildContext {
		return {
			statsData: this.lastStatsData,
			history: this.quotaHistory!,
			heatmapMonth: this.heatmapMonth,
			heatmapYear: this.heatmapYear,
			locale,
			timeFormat,
			publicServiceStatus: this.publicServiceStatus,
			modelUsage: this.modelUsage
		};
	}

	private disposeViewListeners(): void {
		this.viewDisposables.forEach(d => d.dispose());
		this.viewDisposables = [];
	}

	public dispose(): void {
		this.setSettingsOpen(false, false);
		this.disposeViewListeners();
		this.view = undefined;
		this.renderedMode = null;
		this.notifiedVisible = false;
	}
}
