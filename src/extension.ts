import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConnectionHint, discoverConnection, fetchStats } from './api';
import {
	CACHE_TTL_MS,
	CLOSE_PANEL_SETTINGS_COMMAND,
	CONFIG_NAMESPACE,
	DEFAULT_LIVE_SYNC,
	DEFAULT_REFRESH_INTERVAL,
	DISPLAY_TICK_INTERVAL_MS,
	EXPORT_HISTORY_COMMAND,
	EXTENSION_TITLE,
	FAILED_REFRESH_DELAY_MS,
	FOCUS_REFRESH_COOLDOWN_MS,
	GLOBAL_STATE_KEYS,
	GOOGLE_ANTIGRAVITY_EXTENSION_ID,
	INITIAL_DELAY_MS,
	MAX_FAILED_REFRESH_DELAY_MS,
	MAX_RESET_TIMER_RETRIES,
	MIN_DISPLAY_DELAY_MS,
	MS_PER_SECOND,
	OPEN_MODELS_SETTINGS_COMMAND,
	OPEN_PANEL_COMMAND,
	OPEN_PANEL_SETTINGS_COMMAND,
	PANEL_SETTINGS_OPEN_CONTEXT,
	PUBLIC_STATUS_REFRESH_INTERVAL_MS,
	REFRESH_COMMAND,
	RESET_TIMER_BUFFER_MS,
	RESET_TIMER_MAX_DELAY_MS,
	RESET_TIMER_RETRY_DELAY_MS,
	SETTINGS_COMMAND,
	STATUS_BAR_PRIORITY,
	USE_MOCK_DATA
} from './constants';
import { isAntigravityIde } from './environment';
import { createErrorTooltip, formatQuotaPercent, getConnectionErrorDetail } from './formatter';
import { QuotaHistory, QuotaHistoryEntry } from './history';
import { fetchModelUsage } from './modelusage';
import { NotificationManager } from './notifications';
import { UsageViewProvider } from './panel';
import { renderStats } from './renderer';
import { fetchStatusGatorStatus } from './statusgator';
import {
	CachedConnection,
	DailyUsageEntry,
	ModelUsageSummary,
	PublicServiceStatus,
	QuotaGroup,
	ServiceStatus,
	UsageStatistics
} from './types';
import { getErrorMessage, isLikelyServerGlitch, normalizeRefreshIntervalSeconds, validatePort } from './utils';
import { ConversationWatcher } from './watcher';

interface RefreshOptions {
	includePublicStatus?: boolean;
	forceModelUsage?: boolean;
	followUpIfInFlight?: boolean;
}

interface QueuedRefreshRequest {
	showRefreshing: boolean;
	includePublicStatus: boolean;
	forceModelUsage: boolean;
}

interface MockDataFile {
	usageStatistics: {
		groups: Record<string, {
			quota: number;
			resetTimeOffsetMs?: number;
			models?: string[];
			buckets?: Array<{ window: string; displayName: string; quota: number; resetTimeOffsetMs?: number }>;
		}>;
		plan?: string;
		planName?: string;
		credits?: UsageStatistics['credits'];
	};
	modelUsage?: {
		conversationCount?: number;
		entries?: ModelUsageSummary['entries'];
	};
}

async function loadMockData(): Promise<{ statsData: UsageStatistics; modelUsage: ModelUsageSummary }> {
	const filePath = path.join(__dirname, '..', 'dev', 'testData.json');
	const raw = await fs.promises.readFile(filePath, 'utf-8');
	const testData = JSON.parse(raw) as MockDataFile;
	const now = Date.now();

	const groups: Record<string, QuotaGroup> = {};
	for (const [name, entry] of Object.entries(testData.usageStatistics.groups)) {
		groups[name] = {
			quota: entry.quota,
			resetTime: entry.resetTimeOffsetMs ? now + entry.resetTimeOffsetMs : null,
			models: entry.models,
			buckets: entry.buckets?.map(({ resetTimeOffsetMs, ...bucket }) => ({
				...bucket,
				resetTime: resetTimeOffsetMs ? now + resetTimeOffsetMs : null
			}))
		};
	}

	const entries: ModelUsageSummary['entries'] = (testData.modelUsage?.entries ?? []).map(entry => ({ ...entry }));
	const totalGenerations = entries.reduce((sum, entry) => sum + entry.count, 0);

	return {
		statsData: {
			groups,
			plan: testData.usageStatistics.plan,
			planName: testData.usageStatistics.planName,
			credits: testData.usageStatistics.credits
		},
		modelUsage: {
			entries,
			totalGenerations,
			conversationCount: testData.modelUsage?.conversationCount ?? entries.length,
			scannedAt: now
		}
	};
}

function isProcessNotFoundError(error: Error): boolean {
	return /process not found/i.test(error.message);
}

function extractConnectionFields(source: unknown): ConnectionHint | null {
	if (!source || typeof source !== 'object') {
		return null;
	}
	const record = source as Record<string, unknown>;
	const portCandidates = [record.port, record.hubPort, record.serverPort, record.httpsPort, record.httpPort];
	let port: number | undefined;
	for (const candidate of portCandidates) {
		const parsed = typeof candidate === 'number'
			? candidate
			: typeof candidate === 'string' && /^\d{1,5}$/.test(candidate.trim())
				? Number(candidate.trim())
				: NaN;
		if (validatePort(parsed)) {
			port = parsed;
			break;
		}
	}
	if (port === undefined) {
		return null;
	}
	const tokenCandidates = [record.csrfToken, record.token];
	let csrfToken: string | undefined;
	for (const candidate of tokenCandidates) {
		if (typeof candidate === 'string' && candidate.trim().length > 0) {
			csrfToken = candidate.trim();
			break;
		}
	}
	return { port, csrfToken };
}

function getExtensionConnectionHint(log: (message: string, error?: unknown) => void): ConnectionHint | null {
	const extension = vscode.extensions.getExtension(GOOGLE_ANTIGRAVITY_EXTENSION_ID);
	if (!extension || !extension.isActive) {
		return null;
	}
	try {
		const exportsObj = extension.exports as Record<string, unknown> | undefined;
		if (!exportsObj || typeof exportsObj !== 'object') {
			return null;
		}
		const direct = extractConnectionFields(exportsObj);
		if (direct) {
			return direct;
		}
		for (const key of ['connection', 'server', 'backend', 'hub', 'languageServer']) {
			const nested = extractConnectionFields(exportsObj[key]);
			if (nested) {
				return nested;
			}
		}
		return null;
	} catch (error) {
		log('Failed to read Antigravity extension connection exports', error);
		return null;
	}
}

function isLiveSyncEnabled(): boolean {
	return vscode.workspace.getConfiguration(CONFIG_NAMESPACE).get<boolean>('liveSync', DEFAULT_LIVE_SYNC);
}

function getConfiguredRefreshIntervalSeconds(): number {
	const rawInterval = vscode.workspace.getConfiguration(CONFIG_NAMESPACE).get<number>('refreshInterval', DEFAULT_REFRESH_INTERVAL);
	return normalizeRefreshIntervalSeconds(rawInterval);
}

function hasActiveResetTime(statsData: UsageStatistics): boolean {
	const now = Date.now();
	for (const group of Object.values(statsData.groups)) {
		if (group.buckets?.length) {
			if (group.buckets.some(bucket => typeof bucket.resetTime === 'number' && bucket.resetTime > now)) {
				return true;
			}
		} else if (typeof group.resetTime === 'number' && group.resetTime > now) {
			return true;
		}
	}
	return false;
}

class ExtensionState implements vscode.Disposable {
	private outputChannel?: vscode.OutputChannel;
	statusBarItem!: vscode.StatusBarItem;
	refreshTimer?: ReturnType<typeof setTimeout>;
	resetTimer?: ReturnType<typeof setTimeout>;
	displayTickTimer?: ReturnType<typeof setInterval>;
	initialRefreshTimeout?: ReturnType<typeof setTimeout>;
	conversationWatcher?: ConversationWatcher;
	cachedConnection: CachedConnection | null = null;
	lastStatsData: UsageStatistics | null = null;
	lastPreviousStatsData: UsageStatistics | null = null;
	refreshPromise: Promise<void> | null = null;
	refreshIncludesPublicStatus = false;
	queuedRefreshRequest: QueuedRefreshRequest | null = null;
	lastRefreshSucceeded = false;
	consecutiveFailures = 0;
	resetRetryCount = 0;
	pendingRefreshOnFocus = false;
	isActive = false;
	isFocused = vscode.window.state.focused;
	lastRefreshTimestamp = 0;
	lastSuccessfulRefreshTimestamp = 0;
	notificationManager = new NotificationManager();
	refreshLoopGeneration = 0;
	serviceStatus: ServiceStatus = 'loading';
	publicServiceStatus: PublicServiceStatus | null = null;
	modelUsage: ModelUsageSummary | null = null;
	quotaHistory: QuotaHistory;
	usageViewProvider = new UsageViewProvider();
	readonly context: vscode.ExtensionContext;

	constructor(context: vscode.ExtensionContext) {
		this.context = context;
		const savedHistory = context.globalState.get<QuotaHistoryEntry[]>(GLOBAL_STATE_KEYS.QUOTA_HISTORY, []);
		const savedDailyUsage = context.globalState.get<DailyUsageEntry[]>(GLOBAL_STATE_KEYS.DAILY_USAGE, []);
		this.quotaHistory = new QuotaHistory(savedHistory, savedDailyUsage);

		this.isActive = true;

		this.usageViewProvider.onHistoryChanged = () => {
			this.persistHistory();
		};

		this.recreateStatusBarItem();
	}

	recreateStatusBarItem(): void {
		const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
		const alignment = config.get<string>('statusBarAlignment') === 'Left'
			? vscode.StatusBarAlignment.Left
			: vscode.StatusBarAlignment.Right;
		const priority = config.get<number>('statusBarPriority', STATUS_BAR_PRIORITY);

		if (this.statusBarItem) {
			const oldItem = this.statusBarItem;
			this.statusBarItem = vscode.window.createStatusBarItem(alignment, priority);
			this.statusBarItem.command = oldItem.command;
			this.statusBarItem.text = oldItem.text;
			this.statusBarItem.tooltip = oldItem.tooltip;
			this.statusBarItem.color = oldItem.color;
			this.statusBarItem.backgroundColor = oldItem.backgroundColor;
			oldItem.dispose();
		} else {
			this.statusBarItem = vscode.window.createStatusBarItem(alignment, priority);
			this.statusBarItem.command = REFRESH_COMMAND;
			this.statusBarItem.text = `$(rocket) ${EXTENSION_TITLE}`;
		}

		this.statusBarItem.show();
	}

	persistHistory(): void {
		void this.context.globalState
			.update(GLOBAL_STATE_KEYS.QUOTA_HISTORY, this.quotaHistory.getRawEntries())
			.then(undefined, err => this.log('Failed to persist quota history', err));
		void this.context.globalState
			.update(GLOBAL_STATE_KEYS.DAILY_USAGE, this.quotaHistory.getRawDailyUsage())
			.then(undefined, err => this.log('Failed to persist daily usage', err));
	}

	syncPanel(errorMessage?: string | null, statsData: UsageStatistics | null = this.lastStatsData): void {
		this.usageViewProvider.update(
			statsData,
			this.quotaHistory,
			this.serviceStatus,
			this.publicServiceStatus,
			this.modelUsage,
			errorMessage,
			this.lastSuccessfulRefreshTimestamp || undefined
		);
	}

	clearInitialRefreshTimeout(): void {
		if (this.initialRefreshTimeout) {
			clearTimeout(this.initialRefreshTimeout);
			this.initialRefreshTimeout = undefined;
		}
	}

	clearTimers(): void {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = undefined;
		}
		this.clearInitialRefreshTimeout();
	}

	clearResetTimer(): void {
		if (this.resetTimer) {
			clearTimeout(this.resetTimer);
			this.resetTimer = undefined;
		}
	}

	clearDisplayTickTimer(): void {
		if (this.displayTickTimer) {
			clearInterval(this.displayTickTimer);
			this.displayTickTimer = undefined;
		}
	}

	disposeWatcher(): void {
		if (this.conversationWatcher) {
			this.conversationWatcher.dispose();
			this.conversationWatcher = undefined;
		}
	}

	dispose(): void {
		this.statusBarItem?.dispose();
		this.usageViewProvider.dispose();
		this.outputChannel?.dispose();
		this.outputChannel = undefined;
		this.isActive = false;
		this.refreshLoopGeneration++;
		this.clearTimers();
		this.clearResetTimer();
		this.clearDisplayTickTimer();
		this.disposeWatcher();
		this.notificationManager.clear();
		this.cachedConnection = null;
		this.lastStatsData = null;
		this.lastPreviousStatsData = null;
		this.refreshPromise = null;
		this.refreshIncludesPublicStatus = false;
		this.queuedRefreshRequest = null;
		this.lastRefreshSucceeded = false;
		this.lastRefreshTimestamp = 0;
		this.lastSuccessfulRefreshTimestamp = 0;
		this.consecutiveFailures = 0;
		this.resetRetryCount = 0;
		this.pendingRefreshOnFocus = false;
		this.serviceStatus = 'disconnected';
		this.publicServiceStatus = null;
		this.modelUsage = null;
	}

	private getOutputChannel(): vscode.OutputChannel {
		if (!this.outputChannel) {
			this.outputChannel = vscode.window.createOutputChannel(EXTENSION_TITLE);
		}
		return this.outputChannel;
	}

	log(message: string, error?: unknown): void {
		if (!this.isActive) { return; }
		const timestamp = new Date().toISOString();
		const logMessage = error
			? `[${timestamp}] ${message}: ${getErrorMessage(error)}`
			: `[${timestamp}] ${message}`;
		this.getOutputChannel().appendLine(logMessage);
	}
}

let state: ExtensionState | undefined;

export function activate(context: vscode.ExtensionContext) {
	if (!isAntigravityIde() && !vscode.extensions.getExtension(GOOGLE_ANTIGRAVITY_EXTENSION_ID)) {
		vscode.window.showWarningMessage(
			'AG Usage requires the Antigravity IDE or the Google Antigravity extension to be running.',
			'I understand'
		);
	}

	void vscode.commands.executeCommand('setContext', PANEL_SETTINGS_OPEN_CONTEXT, false);

	state = new ExtensionState(context);
	state.usageViewProvider.onDidBecomeVisible = () => {
		refresh(true, { includePublicStatus: true, followUpIfInFlight: true })
			.then(() => {
				if (state?.isActive && !state.lastRefreshSucceeded) {
					scheduleNextAutoRefresh();
				}
			})
			.catch(err => state?.log('Refresh after opening panel failed', err));
	};
	state.usageViewProvider.log = (message, error) => state?.log(message, error);
	state.syncPanel();
	context.subscriptions.push(state);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(UsageViewProvider.viewType, state.usageViewProvider)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(REFRESH_COMMAND, async () => {
			await refresh(true, { includePublicStatus: true, forceModelUsage: true, followUpIfInFlight: true });
			if (state?.isActive) {
				scheduleNextAutoRefresh();
			}
		}),
		vscode.commands.registerCommand(SETTINGS_COMMAND, () => vscode.commands.executeCommand('workbench.action.openSettings', CONFIG_NAMESPACE)),
		vscode.commands.registerCommand(OPEN_PANEL_COMMAND, () => focusUsagePanel()),
		vscode.commands.registerCommand(OPEN_MODELS_SETTINGS_COMMAND, async () => {
			try {
				await vscode.commands.executeCommand('workbench.action.openAntigravitySettingsWithId', undefined, 'Models');
			} catch (error) {
				state?.log('Failed to open Antigravity models settings', error);
				vscode.window.showWarningMessage('Could not open Antigravity model settings. This Antigravity version may not support it.');
			}
		}),
		vscode.commands.registerCommand(OPEN_PANEL_SETTINGS_COMMAND, () => {
			state?.usageViewProvider.openSettings();
			void focusUsagePanel();
		}),
		vscode.commands.registerCommand(CLOSE_PANEL_SETTINGS_COMMAND, () => {
			state?.usageViewProvider.closeSettings();
		}),
		vscode.commands.registerCommand(EXPORT_HISTORY_COMMAND, () => exportHistory()),
		vscode.workspace.onDidChangeConfiguration(e => handleConfigurationChange(e)),
		vscode.window.onDidChangeActiveColorTheme(() => {
			if (!rerenderFromCache()) {
				refresh(false).catch(err => state?.log('Refresh after theme change failed', err));
			}
		}),
		vscode.window.onDidChangeWindowState(e => {
			if (!state) { return; }
			state.isFocused = e.focused;

			if (!e.focused) {
				state.clearDisplayTickTimer();
				const pauseWhenUnfocused = vscode.workspace.getConfiguration(CONFIG_NAMESPACE).get<boolean>('pauseWhenUnfocused', true);
				if (pauseWhenUnfocused && state.refreshTimer) {
					if (state.lastRefreshSucceeded) {
						state.clearTimers();
						state.log('Auto-refresh paused (window lost focus)');
					} else {
						state.log('Window lost focus while disconnected; keeping retry backoff alive');
					}
				}
			} else {
				state.log('Window gained focus');
				onWindowFocused();
			}
		})
	);

	syncLiveSyncState();

	state.initialRefreshTimeout = setTimeout(() => {
		if (state) {
			state.initialRefreshTimeout = undefined;
			startAutoRefresh(true);
		}
	}, INITIAL_DELAY_MS);
}

async function exportHistory(): Promise<void> {
	if (!state) { return; }
	const history = state.quotaHistory.getRawEntries();
	const dailyUsage = state.quotaHistory.getRawDailyUsage();
	if (history.length === 0 && dailyUsage.length === 0) {
		vscode.window.showInformationMessage('No history data to export.');
		return;
	}
	const uri = await vscode.window.showSaveDialog({
		filters: { 'JSON Files': ['json'] },
		defaultUri: vscode.Uri.file('ag-usage-history.json'),
		title: 'Export AG Usage History'
	});
	if (!uri) { return; }

	const formattedHistory = history.map(entry => ({
		...entry,
		delta: Math.round(entry.delta * 10) / 10,
		date: new Date(entry.timestamp).toLocaleString(),
		resetDate: entry.resetTime ? new Date(entry.resetTime).toLocaleString() : null
	}));
	const formattedDailyUsage = dailyUsage.map(entry => ({
		...entry,
		consumedPercent: `${Math.round(entry.consumed * 100)}%`
	}));
	const data = JSON.stringify({ history: formattedHistory, dailyUsage: formattedDailyUsage }, null, 2);
	try {
		await fs.promises.writeFile(uri.fsPath, data, 'utf-8');
		vscode.window.showInformationMessage('AG Usage history exported successfully.');
	} catch (error) {
		state.log('Failed to export history', error);
		vscode.window.showErrorMessage(`Failed to export history: ${getErrorMessage(error)}`);
	}
}

function handleConfigurationChange(e: vscode.ConfigurationChangeEvent): void {
	if (!e.affectsConfiguration(CONFIG_NAMESPACE) || !state) { return; }

	state.log('Configuration changed');

	let needsPanelUpdate = false;
	let needsPanelSync = false;
	let needsStatusBarRerender = false;
	let needsAutoRefreshRestart = false;
	let needsPublicStatusRefresh = false;

	if (e.affectsConfiguration(`${CONFIG_NAMESPACE}.enableHistoryTracking`) || e.affectsConfiguration(`${CONFIG_NAMESPACE}.maxHistoryItems`)) {
		const isEnabled = vscode.workspace.getConfiguration(CONFIG_NAMESPACE).get<boolean>('enableHistoryTracking', true);
		if (!isEnabled) {
			state.quotaHistory.clear();
		} else {
			state.quotaHistory.prune();
			if (state.lastStatsData && e.affectsConfiguration(`${CONFIG_NAMESPACE}.enableHistoryTracking`)) {
				state.quotaHistory.recordSnapshot(state.lastStatsData.groups);
			}
		}
		state.persistHistory();
		needsPanelUpdate = true;
	}

	if ((e.affectsConfiguration(`${CONFIG_NAMESPACE}.notifyOnFullQuota`) || e.affectsConfiguration(`${CONFIG_NAMESPACE}.lowQuotaNotificationThreshold`)) && state.lastStatsData) {
		if (e.affectsConfiguration(`${CONFIG_NAMESPACE}.lowQuotaNotificationThreshold`)) {
			state.notificationManager.clearLowQuotaNotifications();
		}
		state.notificationManager.checkQuotaNotifications(state.lastStatsData, state.lastPreviousStatsData);
	}

	if (e.affectsConfiguration(`${CONFIG_NAMESPACE}.enablePublicStatus`)) {
		const isEnabled = vscode.workspace.getConfiguration(CONFIG_NAMESPACE).get<boolean>('enablePublicStatus', true);
		if (!isEnabled) {
			state.publicServiceStatus = null;
			needsPanelSync = true;
		} else {
			needsPublicStatusRefresh = true;
		}
	}

	if (e.affectsConfiguration(`${CONFIG_NAMESPACE}.panelSections`)) {
		needsPanelUpdate = true;
	}

	if (e.affectsConfiguration(`${CONFIG_NAMESPACE}.liveSync`)) {
		syncLiveSyncState();
		needsPanelUpdate = true;
	}

	if (e.affectsConfiguration(`${CONFIG_NAMESPACE}.refreshInterval`) || e.affectsConfiguration(`${CONFIG_NAMESPACE}.pauseWhenUnfocused`)) {
		needsPanelUpdate = true;
		needsAutoRefreshRestart = true;
	}

	if (e.affectsConfiguration(`${CONFIG_NAMESPACE}.statusBarAlignment`) || e.affectsConfiguration(`${CONFIG_NAMESPACE}.statusBarPriority`)) {
		state.recreateStatusBarItem();
	}

	const formattingChanged =
		e.affectsConfiguration(`${CONFIG_NAMESPACE}.resetTimeDisplay`) ||
		e.affectsConfiguration(`${CONFIG_NAMESPACE}.absoluteTimeFormat`) ||
		e.affectsConfiguration(`${CONFIG_NAMESPACE}.dateFormatLocale`);
	if (formattingChanged) {
		needsStatusBarRerender = true;
		needsPanelUpdate = true;
	}

	const statusBarContentChanged =
		e.affectsConfiguration(`${CONFIG_NAMESPACE}.statusBarDisplay`) ||
		e.affectsConfiguration(`${CONFIG_NAMESPACE}.statusBarLimitDisplay`) ||
		e.affectsConfiguration(`${CONFIG_NAMESPACE}.statusBarCountdown`) ||
		e.affectsConfiguration(`${CONFIG_NAMESPACE}.statusBarWeeklyReset`);
	if (statusBarContentChanged) {
		needsStatusBarRerender = true;
	}

	if (needsPanelSync) {
		state.syncPanel();
	} else if (needsPanelUpdate && !state.usageViewProvider.isSettingsOpen()) {
		state.usageViewProvider.updateView();
	}
	if (state.usageViewProvider.isSettingsOpen()) {
		state.usageViewProvider.syncSettings();
	}

	let triggeredRefresh = false;
	if (needsAutoRefreshRestart) {
		if (state.lastStatsData && state.lastRefreshSucceeded) {
			scheduleNextAutoRefresh();
			if (needsPublicStatusRefresh) {
				triggeredRefresh = true;
				refresh(false, { includePublicStatus: true }).catch(err => state?.log('Public status refresh after enabling failed', err));
			}
		} else {
			triggeredRefresh = true;
			startAutoRefresh(false);
		}
	} else if (needsPublicStatusRefresh) {
		triggeredRefresh = true;
		refresh(false, { includePublicStatus: true }).catch(err => state?.log('Public status refresh after enabling failed', err));
	}

	if (needsStatusBarRerender && !rerenderFromCache() && !triggeredRefresh) {
		refresh(false).catch(err => state?.log('Refresh after configuration change failed', err));
	}
}

async function focusUsagePanel(): Promise<void> {
	try {
		await vscode.commands.executeCommand('ag-usage.sidebarPanel.focus');
	} catch (error) {
		const message = getErrorMessage(error);
		state?.log('Failed to open usage panel', error);
		vscode.window.showErrorMessage(`Failed to open AG Usage Dashboard: ${message}`);
	}
}

export async function deactivate(): Promise<void> {
	if (!state) { return; }
	state.log('Extension deactivating');
	state.isActive = false;
	state.clearTimers();
	state.clearResetTimer();
	state.clearDisplayTickTimer();
	state.disposeWatcher();
	if (state.refreshPromise) {
		await state.refreshPromise;
	}
	state = undefined;
}

function syncLiveSyncState(): void {
	if (!state || !state.isActive) { return; }
	if (USE_MOCK_DATA || !isLiveSyncEnabled()) {
		state.disposeWatcher();
		state.clearResetTimer();
		state.resetRetryCount = 0;
		return;
	}
	if (!state.conversationWatcher) {
		state.conversationWatcher = new ConversationWatcher(
			() => handleConversationActivity(),
			(message, error) => state?.log(message, error)
		);
	} else {
		state.conversationWatcher.ensureWatchers();
	}
	if (state.lastStatsData) {
		scheduleResetRefresh(state.lastStatsData);
	}
}

function handleConversationActivity(): void {
	if (!state || !state.isActive || !isLiveSyncEnabled()) { return; }
	const pauseWhenUnfocused = vscode.workspace.getConfiguration(CONFIG_NAMESPACE).get<boolean>('pauseWhenUnfocused', true);
	if (pauseWhenUnfocused && !state.isFocused) {
		if (!state.pendingRefreshOnFocus) {
			state.pendingRefreshOnFocus = true;
			state.log('Conversation activity detected while unfocused; deferring refresh until focus');
		}
		return;
	}
	state.log('Conversation activity detected; syncing usage');
	refresh(false, { forceModelUsage: true, followUpIfInFlight: true })
		.then(() => {
			if (state?.isActive && !state.lastRefreshSucceeded) {
				scheduleNextAutoRefresh();
			}
		})
		.catch(err => state?.log('Live sync refresh failed', err));
}

function handleResetTimerFired(): void {
	if (!state || !state.isActive || !isLiveSyncEnabled()) { return; }
	const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
	const pauseWhenUnfocused = config.get<boolean>('pauseWhenUnfocused', true);
	const notifyOnFullQuota = config.get<boolean>('notifyOnFullQuota', false);
	if (pauseWhenUnfocused && !state.isFocused && !notifyOnFullQuota) {
		state.pendingRefreshOnFocus = true;
		state.log('Quota reset timer reached while unfocused; deferring refresh until focus');
		return;
	}
	state.log('Quota reset timer reached; syncing usage');
	refresh(false, { followUpIfInFlight: true })
		.then(() => {
			if (state?.isActive && !state.lastRefreshSucceeded) {
				scheduleNextAutoRefresh();
			}
		})
		.catch(err => state?.log('Reset-time sync refresh failed', err));
}

function scheduleResetRefresh(statsData: UsageStatistics): void {
	if (!state || !state.isActive) { return; }
	state.clearResetTimer();
	if (USE_MOCK_DATA || !isLiveSyncEnabled()) { return; }

	const now = Date.now();
	let earliestFutureReset: number | null = null;
	let hasOverdueReset = false;

	for (const group of Object.values(statsData.groups)) {
		const candidates = group.buckets?.length
			? group.buckets
			: [{ quota: group.quota, resetTime: group.resetTime }];
		for (const candidate of candidates) {
			if (typeof candidate.resetTime !== 'number' || !Number.isFinite(candidate.resetTime)) {
				continue;
			}
			if (formatQuotaPercent(candidate.quota) >= 100) {
				continue;
			}
			if (candidate.resetTime > now) {
				if (earliestFutureReset === null || candidate.resetTime < earliestFutureReset) {
					earliestFutureReset = candidate.resetTime;
				}
			} else {
				hasOverdueReset = true;
			}
		}
	}

	if (hasOverdueReset) {
		if (state.resetRetryCount < MAX_RESET_TIMER_RETRIES) {
			state.resetRetryCount++;
			state.log(`Quota reset time elapsed; scheduling verification refresh in ${RESET_TIMER_RETRY_DELAY_MS / 1000}s`);
			state.resetTimer = setTimeout(() => handleResetTimerFired(), RESET_TIMER_RETRY_DELAY_MS);
			return;
		}
		if (earliestFutureReset === null) {
			return;
		}
	} else {
		state.resetRetryCount = 0;
	}

	if (earliestFutureReset === null) {
		return;
	}

	const targetResetTime = earliestFutureReset;
	const rawDelayMs = Math.max(RESET_TIMER_BUFFER_MS, targetResetTime - now + RESET_TIMER_BUFFER_MS);
	const clampedDelayMs = Math.min(rawDelayMs, RESET_TIMER_MAX_DELAY_MS);
	state.log(`Scheduled quota reset sync in ${Math.round(clampedDelayMs / 1000)}s`);
	state.resetTimer = setTimeout(() => {
		if (!state || !state.isActive) { return; }
		if (rawDelayMs > RESET_TIMER_MAX_DELAY_MS && targetResetTime > Date.now() && state.lastStatsData) {
			scheduleResetRefresh(state.lastStatsData);
			return;
		}
		handleResetTimerFired();
	}, clampedDelayMs);
}

function updateDisplayTickTimer(): void {
	if (!state || !state.isActive || !state.isFocused || !state.lastStatsData || !state.lastRefreshSucceeded || !hasActiveResetTime(state.lastStatsData)) {
		state?.clearDisplayTickTimer();
		return;
	}
	if (!state.displayTickTimer) {
		state.displayTickTimer = setInterval(() => {
			rerenderFromCache();
			if (!state?.isActive || !state.lastStatsData || !hasActiveResetTime(state.lastStatsData)) {
				state?.clearDisplayTickTimer();
			}
		}, DISPLAY_TICK_INTERVAL_MS);
	}
}

function onWindowFocused(): void {
	if (!state || !state.isActive) { return; }

	const wasPending = state.pendingRefreshOnFocus;
	state.pendingRefreshOnFocus = false;
	updateDisplayTickTimer();

	const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
	const pauseWhenUnfocused = config.get<boolean>('pauseWhenUnfocused', true);
	const elapsedMs = Date.now() - state.lastRefreshTimestamp;

	if (isLiveSyncEnabled()) {
		if (wasPending || state.lastRefreshTimestamp === 0 || !state.lastRefreshSucceeded || elapsedMs >= FOCUS_REFRESH_COOLDOWN_MS) {
			state.log(`Syncing usage after window focus (elapsed: ${Math.round(elapsedMs / 1000)}s)`);
			refresh(false, { includePublicStatus: true, forceModelUsage: wasPending, followUpIfInFlight: true })
				.then(() => {
					if (state?.isActive) {
						scheduleNextAutoRefresh();
					}
				})
				.catch(err => state?.log('Focus sync refresh failed', err));
		} else {
			rerenderFromCache();
			if (pauseWhenUnfocused) {
				scheduleNextAutoRefresh();
			}
		}
		return;
	}

	if (!pauseWhenUnfocused) {
		rerenderFromCache();
		return;
	}

	const intervalSeconds = getConfiguredRefreshIntervalSeconds();
	if (intervalSeconds === 0) {
		if (!state.lastRefreshSucceeded) {
			startAutoRefresh(false);
		} else {
			rerenderFromCache();
		}
		return;
	}

	const intervalMs = intervalSeconds * MS_PER_SECOND;
	if (state.lastRefreshTimestamp === 0 || !state.lastRefreshSucceeded || elapsedMs >= intervalMs) {
		state.log(`Resuming auto-refresh after window focus (elapsed: ${Math.round(elapsedMs / 1000)}s)`);
		startAutoRefresh(false);
	} else {
		rerenderFromCache();
		const remainingMs = intervalMs - elapsedMs;
		const generation = ++state.refreshLoopGeneration;
		state.log(`Resuming auto-refresh schedule in ${Math.round(remainingMs / 1000)}s`);
		state.clearTimers();
		state.refreshTimer = setTimeout(() => {
			if (state && state.isActive && state.refreshLoopGeneration === generation) {
				startAutoRefresh(false);
			}
		}, remainingMs);
	}
}

function scheduleNextAutoRefresh(generation?: number): void {
	if (!state || !state.isActive) { return; }
	if (generation !== undefined && state.refreshLoopGeneration !== generation) { return; }

	const activeGeneration = generation ?? ++state.refreshLoopGeneration;
	state.clearTimers();

	const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
	const pauseWhenUnfocused = config.get<boolean>('pauseWhenUnfocused', true);
	if (pauseWhenUnfocused && !state.isFocused && state.lastRefreshSucceeded) {
		state.log('Auto-refresh paused (window not focused)');
		return;
	}

	const intervalSeconds = getConfiguredRefreshIntervalSeconds();
	let delayMs: number;
	if (state.lastRefreshSucceeded) {
		state.consecutiveFailures = 0;
		if (intervalSeconds === 0) {
			state.log(isLiveSyncEnabled() ? 'Periodic polling disabled (Live Sync active)' : 'Auto-refresh disabled (interval set to 0)');
			return;
		}
		delayMs = intervalSeconds * MS_PER_SECOND;
	} else {
		const failureAttempt = Math.max(1, state.consecutiveFailures);
		delayMs = Math.min(
			FAILED_REFRESH_DELAY_MS * Math.pow(2, failureAttempt - 1),
			MAX_FAILED_REFRESH_DELAY_MS
		);
	}

	state.log(`Scheduling next refresh in ${delayMs / 1000}s`);
	state.refreshTimer = setTimeout(() => {
		void runAutoRefreshStep(false, activeGeneration);
	}, delayMs);
}

async function runAutoRefreshStep(show: boolean, generation: number): Promise<void> {
	if (!state || !state.isActive || state.refreshLoopGeneration !== generation) { return; }

	const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
	const pauseWhenUnfocused = config.get<boolean>('pauseWhenUnfocused', true);
	if (pauseWhenUnfocused && !state.isFocused && state.lastRefreshSucceeded) {
		state.log('Auto-refresh paused (window not focused)');
		return;
	}

	try {
		await refresh(show, { includePublicStatus: true });
	} catch (error) {
		state?.log('Auto-refresh failed', error);
	}

	scheduleNextAutoRefresh(generation);
}

function startAutoRefresh(showFirst: boolean = false): void {
	if (!state) { return; }
	state.clearTimers();
	const generation = ++state.refreshLoopGeneration;
	void runAutoRefreshStep(showFirst, generation);
}

function isCacheValid(cache: CachedConnection | null): boolean {
	return !!cache && (Date.now() - cache.timestamp) < CACHE_TTL_MS;
}

function rerenderFromCache(): boolean {
	if (!state || state.refreshPromise) { return false; }
	if (!state.lastStatsData || !state.lastRefreshSucceeded) { return false; }
	try {
		const result = renderStats(state.lastStatsData);
		state.statusBarItem.text = result.text;
		state.statusBarItem.tooltip = result.tooltip;
		state.statusBarItem.color = undefined;
		state.statusBarItem.backgroundColor = undefined;
		return true;
	} catch (error) {
		state.log('Failed to render stats from cache', error);
		return false;
	}
}

async function executeRefreshPass(currentState: ExtensionState, request: QueuedRefreshRequest): Promise<void> {
	if (!currentState.isActive) { return; }

	const { showRefreshing, includePublicStatus, forceModelUsage } = request;
	const needsPublicStatus = includePublicStatus && (currentState.publicServiceStatus === null
		|| Date.now() - currentState.publicServiceStatus.checkedAt >= PUBLIC_STATUS_REFRESH_INTERVAL_MS);

	currentState.refreshIncludesPublicStatus = needsPublicStatus;
	currentState.serviceStatus = 'loading';
	if (!currentState.lastStatsData) {
		currentState.syncPanel(null);
	}

	if (showRefreshing) {
		currentState.statusBarItem.text = currentState.cachedConnection ? '$(sync~spin) Refreshing...' : '$(sync~spin) Connecting...';
	}

	const minDelay = showRefreshing ? new Promise(r => setTimeout(r, MIN_DISPLAY_DELAY_MS)) : Promise.resolve();
	const publicStatusEnabled = vscode.workspace.getConfiguration(CONFIG_NAMESPACE).get<boolean>('enablePublicStatus', true);

	const refreshPublicStatus = async (): Promise<PublicServiceStatus | null> => {
		try {
			return await fetchStatusGatorStatus();
		} catch (error) {
			currentState.log('StatusGator status refresh failed', error);
			return currentState.publicServiceStatus;
		}
	};

	const refreshModelUsage = async (forceRefresh: boolean): Promise<ModelUsageSummary | null> => {
		try {
			return await fetchModelUsage((message, error) => currentState.log(message, error), forceRefresh);
		} catch (error) {
			currentState.log('Model usage scan failed', error);
			return currentState.modelUsage;
		}
	};

	const modelUsagePromise: Promise<ModelUsageSummary | null> | null = USE_MOCK_DATA ? null : refreshModelUsage(forceModelUsage);
	const publicStatusPromise = !needsPublicStatus || USE_MOCK_DATA || !publicStatusEnabled
		? Promise.resolve(currentState.publicServiceStatus)
		: refreshPublicStatus();

	const applyStatsUpdate = (statsData: UsageStatistics, logMessage: string, publicStatus: PublicServiceStatus | null) => {
		const previousStatsData = currentState.lastStatsData;
		const serverGlitch = isLikelyServerGlitch(statsData.groups);

		const now = Date.now();
		currentState.lastRefreshSucceeded = true;
		currentState.lastRefreshTimestamp = now;
		currentState.lastSuccessfulRefreshTimestamp = now;
		const recoveredFromFailure = currentState.consecutiveFailures > 0;
		currentState.consecutiveFailures = 0;
		if (recoveredFromFailure && getConfiguredRefreshIntervalSeconds() === 0) {
			currentState.clearTimers();
		}

		let historyChanged = false;
		if (serverGlitch) {
			currentState.serviceStatus = 'glitch';
			currentState.log('Server reported all groups at 0% with elapsed reset time — treating as a server glitch; skipping history record');
		} else {
			currentState.lastPreviousStatsData = previousStatsData;
			currentState.lastStatsData = statsData;
			currentState.serviceStatus = Object.keys(statsData.groups).length === 0 ? 'degraded' : 'connected';
			historyChanged = currentState.quotaHistory.recordSnapshot(statsData.groups);
		}
		currentState.publicServiceStatus = publicStatus;

		const dataToDisplay = serverGlitch && previousStatsData ? previousStatsData : statsData;
		const result = renderStats(dataToDisplay);
		currentState.statusBarItem.text = result.text;
		currentState.statusBarItem.tooltip = result.tooltip;
		currentState.statusBarItem.color = undefined;
		currentState.statusBarItem.backgroundColor = undefined;

		if (!serverGlitch) {
			currentState.notificationManager.checkQuotaNotifications(statsData, previousStatsData);
		}

		currentState.syncPanel(null, dataToDisplay);
		if (historyChanged) {
			currentState.persistHistory();
		}

		currentState.conversationWatcher?.ensureWatchers();
		scheduleResetRefresh(statsData);
		updateDisplayTickTimer();

		currentState.log(logMessage);
	};

	try {
		if (USE_MOCK_DATA) {
			const [mockData] = await Promise.all([loadMockData(), minDelay]);
			if (!currentState.isActive) { return; }
			currentState.modelUsage = mockData.modelUsage;
			applyStatsUpdate(mockData.statsData, 'Refresh completed using mock data', currentState.publicServiceStatus);
			return;
		}

		const connection = currentState.cachedConnection;
		if (connection && isCacheValid(connection)) {
			try {
				const [fetchedStatsData, publicStatus, , modelUsage] = await Promise.all([
					fetchStats(connection.port, connection.csrfToken, connection.protocol, message => currentState.log(message)),
					publicStatusPromise,
					minDelay,
					modelUsagePromise ?? Promise.resolve(null)
				]);
				if (!currentState.isActive) { return; }
				currentState.modelUsage = modelUsage ?? currentState.modelUsage;
				applyStatsUpdate(fetchedStatsData, 'Refresh completed using cached connection', publicStatus);
				return;
			} catch (error) {
				currentState.log('Cached connection failed, attempting reconnection', error);
				currentState.cachedConnection = null;
			}
		}

		currentState.log('Searching for Antigravity process');
		const discovered = await discoverConnection(
			message => currentState.log(message),
			{
				isAntigravityIde: isAntigravityIde(),
				extensionHint: getExtensionConnectionHint((message, error) => currentState.log(message, error))
			}
		);
		if (!currentState.isActive) { return; }
		currentState.log(`Connected to Antigravity on port: ${discovered.port} (${discovered.protocol})`);

		currentState.cachedConnection = { ...discovered, timestamp: Date.now() };

		const [fetchedStatsData, publicStatus, , modelUsage] = await Promise.all([
			fetchStats(discovered.port, discovered.csrfToken, discovered.protocol, message => currentState.log(message)),
			publicStatusPromise,
			minDelay,
			modelUsagePromise ?? Promise.resolve(null)
		]);
		if (!currentState.isActive) { return; }
		currentState.modelUsage = modelUsage ?? currentState.modelUsage;
		applyStatsUpdate(fetchedStatsData, 'Refresh completed successfully', publicStatus);
	} catch (error) {
		if (!currentState.isActive) { return; }
		currentState.lastRefreshSucceeded = false;
		currentState.lastRefreshTimestamp = Date.now();
		currentState.consecutiveFailures++;
		currentState.serviceStatus = 'disconnected';
		currentState.clearDisplayTickTimer();
		const [, publicStatus, modelUsage] = await Promise.all([
			minDelay,
			publicStatusPromise,
			modelUsagePromise ?? Promise.resolve(null)
		]);
		if (!currentState.isActive) { return; }
		currentState.publicServiceStatus = publicStatus;
		currentState.modelUsage = modelUsage ?? currentState.modelUsage;
		const err = error instanceof Error ? error : new Error(String(error));
		const connectionError = getConnectionErrorDetail(err);
		currentState.log('Refresh failed', err);
		if (!isAntigravityIde() && isProcessNotFoundError(err)) {
			currentState.serviceStatus = 'not-found';
			currentState.statusBarItem.text = `$(rocket) ${EXTENSION_TITLE}`;
			currentState.statusBarItem.tooltip = 'The Antigravity extension is not started or initialized. Start it, then click to retry.';
			currentState.statusBarItem.color = undefined;
			currentState.statusBarItem.backgroundColor = undefined;
		} else {
			currentState.statusBarItem.text = `$(error) ${EXTENSION_TITLE}`;
			currentState.statusBarItem.tooltip = createErrorTooltip(err);
			currentState.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
			currentState.statusBarItem.color = new vscode.ThemeColor('statusBarItem.errorForeground');
		}
		const panelError = currentState.serviceStatus === 'disconnected' ? connectionError : null;
		currentState.syncPanel(panelError);
	}
}

async function refresh(showRefreshing: boolean, options: RefreshOptions = {}): Promise<void> {
	if (!state || !state.isActive) { return; }

	const currentState = state;
	const replacedInitialRefresh = currentState.initialRefreshTimeout !== undefined;
	currentState.clearInitialRefreshTimeout();

	const includePublicStatus = options.includePublicStatus === true || replacedInitialRefresh;
	const forceModelUsage = options.forceModelUsage === true || showRefreshing;
	const needsPublicStatus = includePublicStatus && (currentState.publicServiceStatus === null
		|| Date.now() - currentState.publicServiceStatus.checkedAt >= PUBLIC_STATUS_REFRESH_INTERVAL_MS);

	if (currentState.refreshPromise) {
		const runningIncludesPublicStatus = currentState.refreshIncludesPublicStatus;
		if (showRefreshing) {
			currentState.statusBarItem.text = currentState.cachedConnection ? '$(sync~spin) Refreshing...' : '$(sync~spin) Connecting...';
		}
		if (options.followUpIfInFlight || (needsPublicStatus && !runningIncludesPublicStatus)) {
			currentState.queuedRefreshRequest = {
				showRefreshing: Boolean(currentState.queuedRefreshRequest?.showRefreshing || showRefreshing),
				includePublicStatus: Boolean(currentState.queuedRefreshRequest?.includePublicStatus || includePublicStatus),
				forceModelUsage: Boolean(currentState.queuedRefreshRequest?.forceModelUsage || forceModelUsage)
			};
		}
		await currentState.refreshPromise;
		if (replacedInitialRefresh && currentState.isActive && !currentState.refreshTimer) {
			scheduleNextAutoRefresh();
		}
		return;
	}

	const executeLoop = async () => {
		let nextRequest: QueuedRefreshRequest | null = {
			showRefreshing,
			includePublicStatus,
			forceModelUsage
		};

		while (nextRequest && currentState.isActive) {
			await executeRefreshPass(currentState, nextRequest);
			nextRequest = currentState.queuedRefreshRequest;
			currentState.queuedRefreshRequest = null;
		}
	};

	const execution = executeLoop();
	currentState.refreshPromise = execution;

	try {
		await execution;
	} finally {
		if (currentState.refreshPromise === execution) {
			currentState.refreshPromise = null;
			currentState.refreshIncludesPublicStatus = false;
			currentState.queuedRefreshRequest = null;
		}
	}

	if (replacedInitialRefresh && currentState.isActive && !currentState.refreshTimer) {
		scheduleNextAutoRefresh();
	}
}
