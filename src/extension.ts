import * as vscode from 'vscode';
import { extractCsrfToken, fetchStats, findAntigravityProcess, findListeningPorts, findValidPort } from './api';
import {
	CACHE_TTL_MS,
	CATEGORY_ORDER,
	CONFIG_NAMESPACE,
	DEFAULT_REFRESH_INTERVAL,
	EXPORT_HISTORY_COMMAND,
	EXTENSION_TITLE,
	FAILED_REFRESH_DELAY_MS,
	INITIAL_DELAY_MS,
	MAX_FAILED_REFRESH_DELAY_MS,
	MIN_DISPLAY_DELAY_MS,
	MS_PER_SECOND,
	OPEN_PANEL_COMMAND,
	REFRESH_COMMAND,
	SETTINGS_COMMAND,
	STATUS_BAR_PRIORITY,
	USE_MOCK_DATA
} from './constants';
import { createErrorTooltip } from './formatter';
import { QuotaHistory, QuotaHistoryEntry } from './history';
import { NotificationManager } from './notifications';
import { UsageViewProvider } from './panel';
import { renderStats } from './renderer';
import { CachedConnection, UsageStatistics } from './types';
import { getErrorMessage } from './utils';

async function loadMockUsageStatistics(): Promise<UsageStatistics> {
	const fs = await import('fs');
	const path = await import('path');
	const filePath = path.join(__dirname, '..', 'dev', 'testData.json');
	const raw = fs.readFileSync(filePath, 'utf-8');
	const testData = JSON.parse(raw);
	const now = Date.now();
	const groups: Record<string, { quota: number; resetTime: number | null }> = {};
	for (const [name, data] of Object.entries(testData.usageStatistics.groups)) {
		const entry = data as { quota: number; resetTimeOffsetMs?: number };
		groups[name] = {
			quota: entry.quota,
			resetTime: entry.resetTimeOffsetMs ? now + entry.resetTimeOffsetMs : null
		};
	}
	return { groups, plan: testData.usageStatistics.plan, planName: testData.usageStatistics.planName, credits: testData.usageStatistics.credits };
}

class ExtensionState implements vscode.Disposable {
	private readonly outputChannel: vscode.OutputChannel;
	statusBarItem!: vscode.StatusBarItem;
	refreshTimer?: ReturnType<typeof setTimeout>;
	initialRefreshTimeout?: ReturnType<typeof setTimeout>;
	cachedConnection: CachedConnection | null = null;
	lastStatsData: UsageStatistics | null = null;
	refreshPromise: Promise<void> | null = null;
	lastRefreshSucceeded = false;
	consecutiveFailures = 0;
	isActive = false;
	notificationManager = new NotificationManager();
	refreshLoopGeneration = 0;
	quotaHistory: QuotaHistory;
	usageViewProvider = new UsageViewProvider();
	readonly context: vscode.ExtensionContext;

	constructor(context: vscode.ExtensionContext) {
		this.context = context;
		const savedHistory = context.globalState.get<QuotaHistoryEntry[]>('quotaHistory', []);
		const savedDailyUsage = context.globalState.get<import('./types').DailyUsageEntry[]>('quotaDailyUsage', []);
		this.quotaHistory = new QuotaHistory(savedHistory, savedDailyUsage);
		this.outputChannel = vscode.window.createOutputChannel(EXTENSION_TITLE);

		this.isActive = true;

		this.usageViewProvider.onHistoryChanged = (history) => {
			this.context.globalState.update('quotaHistory', history.getRawEntries());
			this.context.globalState.update('quotaDailyUsage', history.getRawDailyUsage());
		};

		context.subscriptions.push(this.outputChannel);
		this.recreateStatusBarItem();
	}

	recreateStatusBarItem() {
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

	dispose() {
		this.statusBarItem?.dispose();
		this.usageViewProvider.dispose();
		this.isActive = false;
		this.refreshLoopGeneration++;
		this.clearTimers();
		this.cachedConnection = null;
		this.lastStatsData = null;
		this.refreshPromise = null;
		this.lastRefreshSucceeded = false;
		this.consecutiveFailures = 0;
		this.notificationManager.clear();
		this.quotaHistory.clear();
	}

	clearTimers() {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = undefined;
		}
		if (this.initialRefreshTimeout) {
			clearTimeout(this.initialRefreshTimeout);
			this.initialRefreshTimeout = undefined;
		}
	}

	log(message: string, error?: unknown) {
		if (!this.isActive) { return; }
		const timestamp = new Date().toISOString();
		const logMessage = error
			? `[${timestamp}] ${message}: ${getErrorMessage(error)}`
			: `[${timestamp}] ${message}`;
		this.outputChannel.appendLine(logMessage);
	}
}

let state: ExtensionState | undefined;

export function activate(context: vscode.ExtensionContext) {
	if (!vscode.env.appName.toLowerCase().includes('antigravity')) {
		vscode.window.showWarningMessage(
			'AG Usage is designed exclusively for the Antigravity IDE. It will not work correctly in this editor.',
			'I understand'
		);
	}

	state = new ExtensionState(context);
	context.subscriptions.push(state);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(UsageViewProvider.viewType, state.usageViewProvider)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(REFRESH_COMMAND, async () => {
			await refresh(true);
			if (state?.lastRefreshSucceeded) {
				startAutoRefresh(false);
			}
		}),
		vscode.commands.registerCommand(SETTINGS_COMMAND, () => vscode.commands.executeCommand('workbench.action.openSettings', CONFIG_NAMESPACE)),
		vscode.commands.registerCommand(OPEN_PANEL_COMMAND, () => focusUsagePanel()),
		vscode.commands.registerCommand('ag-usage.openModelsSettings', () => vscode.commands.executeCommand('workbench.action.openAntigravitySettingsWithId', undefined, 'Models')),
		vscode.commands.registerCommand(EXPORT_HISTORY_COMMAND, async () => {
			if (!state) return;
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
			if (uri) {
				const fs = await import('fs');
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
		}),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (!e.affectsConfiguration(CONFIG_NAMESPACE)) { return; }
			if (!state) { return; }

			state.log('Configuration changed');

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
				state.context.globalState.update('quotaHistory', state.quotaHistory.getRawEntries());
				state.context.globalState.update('quotaDailyUsage', state.quotaHistory.getRawDailyUsage());
				if (state.lastStatsData) {
					state.usageViewProvider.update(state.lastStatsData, state.quotaHistory);
				}
			}

			if ((e.affectsConfiguration(`${CONFIG_NAMESPACE}.notifyOnFullQuota`) || e.affectsConfiguration(`${CONFIG_NAMESPACE}.lowQuotaNotificationThreshold`)) && state.lastStatsData) {
				state.notificationManager.checkQuotaNotifications(state.lastStatsData, state.lastStatsData);
			}

			if (e.affectsConfiguration(`${CONFIG_NAMESPACE}.refreshInterval`)) {
				startAutoRefresh(false);
				return;
			}

			if ((e.affectsConfiguration(`${CONFIG_NAMESPACE}.statusBarAlignment`) || e.affectsConfiguration(`${CONFIG_NAMESPACE}.statusBarPriority`)) && state) {
				state.recreateStatusBarItem();
			}

			if (!rerenderFromCache()) {
				refresh(false).catch(err => state?.log('Refresh after configuration change failed', err));
			}
		}),
		vscode.window.onDidChangeActiveColorTheme(() => {
			if (!rerenderFromCache()) {
				refresh(false).catch(err => state?.log('Refresh after theme change failed', err));
			}
		}),
	);

	state.log('Extension activated');

	state.initialRefreshTimeout = setTimeout(() => {
		startAutoRefresh(true);
	}, INITIAL_DELAY_MS);
}

async function focusUsagePanel() {
	try {
		await vscode.commands.executeCommand('ag-usage.sidebarPanel.focus');
	} catch (error) {
		const message = getErrorMessage(error);
		state?.log('Failed to open usage panel', error);
		vscode.window.showErrorMessage(`Failed to open AG Usage Dashboard: ${message}`);
	}
}

export async function deactivate() {
	if (state) {
		state.isActive = false;
		state.log('Extension deactivating');
		if (state.refreshPromise) {
			await state.refreshPromise;
		}
		state = undefined;
	}
}

function startAutoRefresh(showFirst: boolean = false) {
	if (!state) { return; }
	state.clearTimers();
	const generation = ++state.refreshLoopGeneration;

	const runLoop = async (show: boolean) => {
		if (!state || !state.isActive || state.refreshLoopGeneration !== generation) { return; }

		try {
			await refresh(show);
		} catch (error) {
			state?.log('Auto-refresh failed', error);
		}

		if (!state || !state.isActive || state.refreshLoopGeneration !== generation) { return; }

		const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
		const rawInterval = config.get<number>('refreshInterval', DEFAULT_REFRESH_INTERVAL);
		let intervalSeconds = (typeof rawInterval !== 'number' || isNaN(rawInterval)) ? DEFAULT_REFRESH_INTERVAL : rawInterval;
		intervalSeconds = intervalSeconds === 0 ? 0 : Math.max(10, intervalSeconds);

		if (intervalSeconds === 0) {
			state.log('Auto-refresh disabled (interval set to 0)');
			return;
		}

		let delayMs: number;
		if (state.lastRefreshSucceeded) {
			state.consecutiveFailures = 0;
			delayMs = intervalSeconds * MS_PER_SECOND;
		} else {
			state.consecutiveFailures++;
			delayMs = Math.min(
				FAILED_REFRESH_DELAY_MS * Math.pow(2, state.consecutiveFailures - 1),
				MAX_FAILED_REFRESH_DELAY_MS
			);
		}

		state.log(`Scheduling next refresh in ${delayMs / 1000}s`);
		state.refreshTimer = setTimeout(() => runLoop(false), delayMs);
	};

	runLoop(showFirst);
}

function isCacheValid(cache: CachedConnection | null): boolean {
	return !!cache && (Date.now() - cache.timestamp) < CACHE_TTL_MS;
}

function rerenderFromCache(force: boolean = false): boolean {
	if (!state || (!force && state.refreshPromise)) { return false; }
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

async function refresh(showRefreshing: boolean) {
	if (!state || !state.isActive) { return; }

	if (state.refreshPromise) {
		if (showRefreshing) {
			state.statusBarItem.text = state.cachedConnection ? '$(sync~spin) Refreshing...' : '$(sync~spin) Connecting...';
		}
		await state.refreshPromise;
		return;
	}

	const currentState = state;

	const applyStatsUpdate = (statsData: UsageStatistics, logMessage: string) => {
		const previousStatsData = currentState.lastStatsData;
		currentState.lastStatsData = statsData;
		currentState.lastRefreshSucceeded = true;
		currentState.quotaHistory.recordSnapshot(statsData.groups);
		const result = renderStats(statsData);
		currentState.statusBarItem.text = result.text;
		currentState.statusBarItem.tooltip = result.tooltip;
		currentState.statusBarItem.color = undefined;
		currentState.statusBarItem.backgroundColor = undefined;
		currentState.notificationManager.checkQuotaNotifications(statsData, previousStatsData);

		currentState.usageViewProvider.update(statsData, currentState.quotaHistory);
		currentState.context.globalState.update('quotaHistory', currentState.quotaHistory.getRawEntries());
		currentState.context.globalState.update('quotaDailyUsage', currentState.quotaHistory.getRawDailyUsage());

		currentState.log(logMessage);
	};

	const executeRefresh = async () => {
		if (!currentState.isActive) { return; }
		if (showRefreshing) {
			currentState.statusBarItem.text = currentState.cachedConnection ? '$(sync~spin) Refreshing...' : '$(sync~spin) Connecting...';
		}
		const minDelay = showRefreshing ? new Promise(r => setTimeout(r, MIN_DISPLAY_DELAY_MS)) : Promise.resolve();

		try {
			let statsData: UsageStatistics;

			if (USE_MOCK_DATA) {
				await minDelay;
				if (!currentState.isActive) { return; }
				statsData = await loadMockUsageStatistics();
				applyStatsUpdate(statsData, 'Refresh completed using mock data');
				return;
			}

			const connection = currentState.cachedConnection;
			if (connection && isCacheValid(connection)) {
				try {
					[statsData] = await Promise.all([fetchStats(connection.port, connection.csrfToken), minDelay]);
					if (!currentState.isActive) { return; }
					applyStatsUpdate(statsData, 'Refresh completed using cached connection');
					return;
				} catch (error) {
					currentState.log('Cached connection failed, attempting reconnection', error);
					currentState.cachedConnection = null;
				}
			}

			currentState.log('Searching for Antigravity process');
			const processInfo = await findAntigravityProcess();
			if (!currentState.isActive) { return; }
			currentState.log(`Found process with PID: ${processInfo.pid}`);

			const csrfToken = extractCsrfToken(processInfo.cmd);
			if (!csrfToken) {
				throw new Error('CSRF token not found in process command line');
			}

			const ports = await findListeningPorts(processInfo.pid);
			if (!currentState.isActive) { return; }
			if (ports.length === 0) {
				throw new Error('No listening ports found for the Antigravity process');
			}
			currentState.log(`Found ${ports.length} listening port(s): ${ports.join(', ')}`);

			const port = await findValidPort(ports, csrfToken);
			if (!currentState.isActive) { return; }
			currentState.log(`Validated port: ${port}`);

			currentState.cachedConnection = { port, csrfToken, timestamp: Date.now() };

			[statsData] = await Promise.all([fetchStats(port, csrfToken), minDelay]);
			if (!currentState.isActive) { return; }
			applyStatsUpdate(statsData, 'Refresh completed successfully');
		} catch (error) {
			if (!currentState.isActive) { return; }
			currentState.lastRefreshSucceeded = false;
			await minDelay;
			const err = error instanceof Error ? error : new Error(String(error));
			currentState.log('Refresh failed', err);
			currentState.statusBarItem.text = `$(error) ${EXTENSION_TITLE}`;
			currentState.statusBarItem.tooltip = createErrorTooltip(err);
			currentState.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
			currentState.statusBarItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
		}
	};

	const execution = executeRefresh();
	currentState.refreshPromise = execution;

	try {
		await execution;
	} finally {
		if (currentState.refreshPromise === execution) {
			currentState.refreshPromise = null;
		}
	}
}
