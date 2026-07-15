import * as vscode from 'vscode';
import { extractCsrfToken, fetchStats, findAntigravityProcess, findListeningPorts, findValidPort } from './api';
import {
	CACHE_TTL_MS,
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
	PUBLIC_STATUS_REFRESH_INTERVAL_MS,
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
import { fetchStatusGatorStatus } from './statusgator';
import { CachedConnection, PublicServiceStatus, QuotaGroup, ServiceStatus, UsageStatistics } from './types';
import { getErrorMessage, isLikelyServerGlitch } from './utils';

async function loadMockUsageStatistics(): Promise<UsageStatistics> {
	const fs = await import('fs');
	const path = await import('path');
	const filePath = path.join(__dirname, '..', 'dev', 'testData.json');
	const raw = fs.readFileSync(filePath, 'utf-8');
	const testData = JSON.parse(raw);
	const now = Date.now();
	const groups: Record<string, QuotaGroup> = {};
	for (const [name, data] of Object.entries(testData.usageStatistics.groups)) {
		const entry = data as { quota: number; resetTimeOffsetMs?: number; models?: string[] };
		groups[name] = {
			quota: entry.quota,
			resetTime: entry.resetTimeOffsetMs ? now + entry.resetTimeOffsetMs : null,
			models: entry.models
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
	refreshIncludesPublicStatus = false;
	lastRefreshSucceeded = false;
	consecutiveFailures = 0;
	isActive = false;
	notificationManager = new NotificationManager();
	refreshLoopGeneration = 0;
	serviceStatus: ServiceStatus = 'loading';
	publicServiceStatus: PublicServiceStatus | null = null;
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
		this.refreshIncludesPublicStatus = false;
		this.lastRefreshSucceeded = false;
		this.consecutiveFailures = 0;
		this.serviceStatus = 'disconnected';
		this.publicServiceStatus = null;
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
	state.usageViewProvider.onDidBecomeVisible = () => {
		refresh(true, { includePublicStatus: true }).catch(err => state?.log('Refresh after opening panel failed', err));
	};
	state.usageViewProvider.update(state.lastStatsData, state.quotaHistory, state.serviceStatus, state.publicServiceStatus);
	context.subscriptions.push(state);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(UsageViewProvider.viewType, state.usageViewProvider)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(REFRESH_COMMAND, async () => {
			await refresh(true, { includePublicStatus: true });
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
					state.usageViewProvider.update(state.lastStatsData, state.quotaHistory, state.serviceStatus, state.publicServiceStatus);
				}
			}

			if ((e.affectsConfiguration(`${CONFIG_NAMESPACE}.notifyOnFullQuota`) || e.affectsConfiguration(`${CONFIG_NAMESPACE}.lowQuotaNotificationThreshold`)) && state.lastStatsData) {
				state.notificationManager.checkQuotaNotifications(state.lastStatsData, state.lastStatsData);
			}

			if (e.affectsConfiguration(`${CONFIG_NAMESPACE}.enablePublicStatus`)) {
				const isEnabled = vscode.workspace.getConfiguration(CONFIG_NAMESPACE).get<boolean>('enablePublicStatus', true);
				if (!isEnabled) {
					state.publicServiceStatus = null;
					state.usageViewProvider.update(state.lastStatsData, state.quotaHistory, state.serviceStatus, state.publicServiceStatus);
				} else {
					refresh(false, { includePublicStatus: true }).catch(err => state?.log('Public status refresh after enabling failed', err));
				}
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
			await refresh(show, { includePublicStatus: true });
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

interface RefreshOptions {
	includePublicStatus?: boolean;
}

async function refresh(showRefreshing: boolean, options: RefreshOptions = {}) {
	if (!state || !state.isActive) { return; }

	const includePublicStatus = options.includePublicStatus === true;
	const needsPublicStatus = includePublicStatus && (state.publicServiceStatus === null
		|| Date.now() - state.publicServiceStatus.checkedAt >= PUBLIC_STATUS_REFRESH_INTERVAL_MS);
	if (state.refreshPromise) {
		const runningIncludesPublicStatus = state.refreshIncludesPublicStatus;
		if (showRefreshing) {
			state.statusBarItem.text = state.cachedConnection ? '$(sync~spin) Refreshing...' : '$(sync~spin) Connecting...';
		}
		await state.refreshPromise;
		if (needsPublicStatus && !runningIncludesPublicStatus && state?.isActive) {
			await refresh(showRefreshing, { includePublicStatus: true });
		}
		return;
	}

	const currentState = state;
	currentState.refreshIncludesPublicStatus = needsPublicStatus;
	currentState.serviceStatus = 'loading';
	currentState.usageViewProvider.update(currentState.lastStatsData, currentState.quotaHistory, currentState.serviceStatus, currentState.publicServiceStatus);

	const refreshPublicStatus = async (): Promise<PublicServiceStatus | null> => {
		try {
			return await fetchStatusGatorStatus();
		} catch (error) {
			currentState.log('StatusGator status refresh failed', error);
			return currentState.publicServiceStatus;
		}
	};

	const applyStatsUpdate = (statsData: UsageStatistics, logMessage: string, publicStatus: PublicServiceStatus | null) => {
		const previousStatsData = currentState.lastStatsData;
		const serverGlitch = isLikelyServerGlitch(statsData.groups);

		currentState.lastRefreshSucceeded = true;

		if (serverGlitch) {
			currentState.serviceStatus = 'glitch';
			currentState.log('Server reported all groups at 0% with elapsed reset time — treating as a server glitch; skipping history record');
		} else {
			currentState.lastStatsData = statsData;
			currentState.serviceStatus = Object.keys(statsData.groups).length === 0 ? 'degraded' : 'connected';
			currentState.quotaHistory.recordSnapshot(statsData.groups);
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

		currentState.usageViewProvider.update(dataToDisplay, currentState.quotaHistory, currentState.serviceStatus, currentState.publicServiceStatus);
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
		const publicStatusEnabled = vscode.workspace.getConfiguration(CONFIG_NAMESPACE).get<boolean>('enablePublicStatus', true);
		const publicStatusPromise = !needsPublicStatus || USE_MOCK_DATA || !publicStatusEnabled
			? Promise.resolve(currentState.publicServiceStatus)
			: refreshPublicStatus();

		try {
			let statsData: UsageStatistics;

			if (USE_MOCK_DATA) {
				await minDelay;
				if (!currentState.isActive) { return; }
				statsData = await loadMockUsageStatistics();
				applyStatsUpdate(statsData, 'Refresh completed using mock data', currentState.publicServiceStatus);
				return;
			}

			const connection = currentState.cachedConnection;
			if (connection && isCacheValid(connection)) {
				try {
					const [fetchedStatsData, publicStatus] = await Promise.all([fetchStats(connection.port, connection.csrfToken), publicStatusPromise, minDelay]);
					if (!currentState.isActive) { return; }
					applyStatsUpdate(fetchedStatsData, 'Refresh completed using cached connection', publicStatus);
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

			const [fetchedStatsData, publicStatus] = await Promise.all([fetchStats(port, csrfToken), publicStatusPromise, minDelay]);
			if (!currentState.isActive) { return; }
			applyStatsUpdate(fetchedStatsData, 'Refresh completed successfully', publicStatus);
		} catch (error) {
			if (!currentState.isActive) { return; }
			currentState.lastRefreshSucceeded = false;
			currentState.serviceStatus = 'disconnected';
			await minDelay;
			currentState.publicServiceStatus = await publicStatusPromise;
			if (!currentState.isActive) { return; }
			const err = error instanceof Error ? error : new Error(String(error));
			currentState.log('Refresh failed', err);
			currentState.statusBarItem.text = `$(error) ${EXTENSION_TITLE}`;
			currentState.statusBarItem.tooltip = createErrorTooltip(err);
			currentState.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
			currentState.statusBarItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
			currentState.usageViewProvider.update(currentState.lastStatsData, currentState.quotaHistory, currentState.serviceStatus, currentState.publicServiceStatus);
		}
	};

	const execution = executeRefresh();
	currentState.refreshPromise = execution;

	try {
		await execution;
	} finally {
		if (currentState.refreshPromise === execution) {
			currentState.refreshPromise = null;
			currentState.refreshIncludesPublicStatus = false;
		}
	}
}
