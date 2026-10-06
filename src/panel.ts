import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { BUCKET_OPACITY, CATEGORY_NAMES, CATEGORY_ORDER, CONFIG_NAMESPACE, MODEL_KEYWORDS, MODEL_USAGE_COLLAPSED_ROWS, MS_PER_HOUR, PANEL_LAYOUT_EDITING_CONTEXT, PANEL_SECTION_IDS, PANEL_SECTION_LABELS, PanelSectionId, PROGRESS_STOPS, MODELS_COLORS, REFRESH_COMMAND, STATUSGATOR_SERVICE_URL, THEME_COLORS } from './constants';
import { isAntigravityIde } from './environment';
import { formatFullTimestamp, formatLocalDate, formatQuotaPercent, formatRelativeTime, formatRemainingTimeSeparate, resolveLocale } from './formatter';
import { QuotaHistory, QuotaHistoryEntry } from './history';
import { DailyUsageEntry, ModelUsageEntry, ModelUsageSummary, PublicServiceStatus, QuotaGroup, ServiceStatus, UsageStatistics } from './types';
import { escapeHtml, getErrorMessage, getProgressStopIndex, hidePanelSection, isNotStartedQuota, isWeeklyLimitReached, movePanelSection, normalizeModelName, normalizePanelSectionLayout, PanelSectionSlot, serializePanelSectionLayout, showPanelSection, sortQuotaBuckets } from './utils';

export class UsageViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'ag-usage.sidebarPanel';
	private view?: vscode.WebviewView;
	private lastStatsData: UsageStatistics | null = null;
	private quotaHistory: QuotaHistory | null = null;
	private lastServiceStatus: ServiceStatus = 'disconnected';
	private lastErrorMessage: string | null = null;
	private publicServiceStatus: PublicServiceStatus | null = null;
	private modelUsage: ModelUsageSummary | null = null;
	private heatmapMonth: number = new Date().getMonth();
	private heatmapYear: number = new Date().getFullYear();
	private layoutEditing = false;
	private notifiedVisible = false;
	private disposables: vscode.Disposable[] = [];
	public onHistoryChanged?: (history: QuotaHistory) => void;
	public onDidBecomeVisible?: () => void;
	public log?: (message: string, error?: unknown) => void;

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	) {
		this.view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: []
		};

		webviewView.onDidDispose(() => {
			this.view = undefined;
		}, null, this.disposables);

		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) {
				this.notifyVisible();
			} else {
				this.notifiedVisible = false;
			}
		}, null, this.disposables);

		webviewView.webview.onDidReceiveMessage((message) => {
			if (message.command === 'clearHistory') {
				if (this.quotaHistory && typeof message.category === 'string' && message.category.length < 100) {
					this.quotaHistory.clearCategory(message.category);
					this.onHistoryChanged?.(this.quotaHistory);
					this.updateView();
				}
			} else if (message.command === 'retry') {
				vscode.commands.executeCommand(REFRESH_COMMAND);
			} else if (message.command === 'copyError' && typeof message.text === 'string') {
				void vscode.env.clipboard.writeText(message.text).then(() => {
					void this.view?.webview.postMessage({ command: 'copyErrorResult', success: true });
				}, (error: unknown) => {
					this.log?.('Failed to copy panel error', error);
					void this.view?.webview.postMessage({ command: 'copyErrorResult', success: false });
				});
			} else if (message.command === 'openIssues') {
				void vscode.env.openExternal(vscode.Uri.parse('https://github.com/crsxmilitaru/ag-usage/issues'));
			} else if (message.command === 'openAntigravitySettings') {
				vscode.commands.executeCommand('workbench.action.openAntigravitySettingsWithId', undefined, 'Models')
					.then(undefined, () => {
						vscode.window.showWarningMessage('Could not open Antigravity model settings. This Antigravity version may not support it.');
					});
			} else if (message.command === 'prevMonth') {
				this.heatmapMonth--;
				if (this.heatmapMonth < 0) {
					this.heatmapMonth = 11;
					this.heatmapYear--;
				}
				this.updateView();
			} else if (message.command === 'nextMonth') {
				this.heatmapMonth++;
				if (this.heatmapMonth > 11) {
					this.heatmapMonth = 0;
					this.heatmapYear++;
				}
				this.updateView();
			} else if (message.command === 'moveSection' || message.command === 'hideSection' || message.command === 'showSection') {
				void this.handlePanelLayoutMessage(message);
			}
		}, null, this.disposables);

		this.updateView();
		if (webviewView.visible) {
			this.notifyVisible();
		}
	}

	private notifyVisible(): void {
		if (this.notifiedVisible) { return; }
		this.notifiedVisible = true;
		this.onDidBecomeVisible?.();
	}

	public update(statsData: UsageStatistics | null, history: QuotaHistory, serviceStatus: ServiceStatus = 'disconnected', publicServiceStatus: PublicServiceStatus | null = null, modelUsage: ModelUsageSummary | null = null, errorMessage?: string | null) {
		this.lastStatsData = statsData;
		this.quotaHistory = history;
		this.lastServiceStatus = serviceStatus;
		this.publicServiceStatus = publicServiceStatus;
		this.modelUsage = modelUsage;
		if (errorMessage !== undefined) {
			this.lastErrorMessage = errorMessage;
		} else if (serviceStatus !== 'disconnected') {
			this.lastErrorMessage = null;
		}
		if (this.view) {
			this.updateView();
		}
	}

	public updateView() {
		if (!this.view || !this.quotaHistory) { return; }
		const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
		const locale = resolveLocale(config.get<string>('dateFormatLocale', 'default'));
		const refreshInterval = config.get<number>('refreshInterval', 60);
		const panelSections = normalizePanelSectionLayout(config.get<unknown>('panelSections'));
		try {
			this.view.webview.html = buildPanelHtml(this.lastStatsData, this.quotaHistory, this.heatmapMonth, this.heatmapYear, locale, this.lastServiceStatus, refreshInterval, this.publicServiceStatus, this.modelUsage, panelSections, this.layoutEditing, this.lastErrorMessage);
		} catch (error) {
			const message = getErrorMessage(error);
			this.lastErrorMessage = message;
			this.log?.('Failed to render usage panel', error);
			try {
				this.view.webview.html = buildPanelHtml(null, this.quotaHistory, this.heatmapMonth, this.heatmapYear, locale, 'disconnected', refreshInterval, null, null, panelSections, false, message);
			} catch (fallbackError) {
				this.log?.('Failed to render usage panel error state', fallbackError);
				this.view.webview.html = buildFallbackErrorHtml(message);
			}
		}
	}

	public toggleLayoutEditing(): void {
		this.layoutEditing = !this.layoutEditing;
		void vscode.commands.executeCommand('setContext', PANEL_LAYOUT_EDITING_CONTEXT, this.layoutEditing);
		this.updateView();
	}

	private getPanelBuildContext(locale?: string): PanelBuildContext {
		return {
			statsData: this.lastStatsData,
			history: this.quotaHistory!,
			heatmapMonth: this.heatmapMonth,
			heatmapYear: this.heatmapYear,
			locale,
			publicServiceStatus: this.publicServiceStatus,
			modelUsage: this.modelUsage
		};
	}

	private async handlePanelLayoutMessage(message: { command?: string; sectionId?: string; direction?: string }) {
		if (!this.quotaHistory || !this.layoutEditing) { return; }
		const sectionId = message.sectionId;
		if (typeof sectionId !== 'string' || !(PANEL_SECTION_IDS as readonly string[]).includes(sectionId)) { return; }
		const id = sectionId as PanelSectionId;
		const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
		const locale = resolveLocale(config.get<string>('dateFormatLocale', 'default'));
		const ctx = this.getPanelBuildContext(locale);
		let layout = normalizePanelSectionLayout(config.get<unknown>('panelSections'));
		const isDisplayed = (section: PanelSectionId) => {
			const slot = layout.find(item => item.id === section);
			if (!slot) { return false; }
			if (slot.hidden) { return true; }
			return panelSectionHasContent(section, ctx);
		};
		if (message.command === 'moveSection') {
			const direction = message.direction === 'down' ? 'down' : message.direction === 'up' ? 'up' : null;
			if (!direction) { return; }
			layout = movePanelSection(layout, id, direction, isDisplayed);
		} else if (message.command === 'hideSection') {
			layout = hidePanelSection(layout, id);
		} else if (message.command === 'showSection') {
			layout = showPanelSection(layout, id);
		} else {
			return;
		}
		try {
			await config.update('panelSections', serializePanelSectionLayout(layout), getPanelSectionsUpdateTarget());
		} catch (error) {
			this.log?.('Failed to update panel section layout', error);
		}
	}

	dispose() {
		if (this.layoutEditing) {
			this.layoutEditing = false;
			void vscode.commands.executeCommand('setContext', PANEL_LAYOUT_EDITING_CONTEXT, false);
		}
		this.disposables.forEach(d => d.dispose());
		this.disposables = [];
	}
}

function formatPercent(fraction: number): string {
	return `${formatQuotaPercent(fraction)}%`;
}

function getBarColorClass(fraction: number): string {
	const pct = formatQuotaPercent(fraction);
	const idx = getProgressStopIndex(pct);
	return `bar-p${PROGRESS_STOPS[idx]}`;
}

function getDeltaClass(delta: number): string {
	if (delta > 0) { return 'delta-positive'; }
	if (delta < 0) { return 'delta-negative'; }
	return '';
}

function formatDelta(delta: number): string {
	const pct = Math.round(delta * 100);
	return pct > 0 ? `+${pct}%` : `${pct}%`;
}

function buildHistoryItemHtml(entry: QuotaHistoryEntry, previousEntry?: QuotaHistoryEntry, locale?: string): string {
	const deltaClass = getDeltaClass(entry.delta);
	let detailsHtml: string;
	const isFullyRestored = entry.currentQuota >= 1 && entry.previousQuota < 1;

	if (entry.isInitial) {
		detailsHtml = `<div class="history-item-change">
				<span class="cell-value">Started at ${escapeHtml(formatPercent(entry.currentQuota))}</span>
			</div>`;
	} else if (isFullyRestored) {
		detailsHtml = `<div class="history-item-change">
				<span class="cell-delta delta-positive">✓ Fully restored</span>
			</div>`;
	} else {
		detailsHtml = `<div class="history-item-change">
				<span class="cell-value">${escapeHtml(formatPercent(entry.previousQuota))} → ${escapeHtml(formatPercent(entry.currentQuota))}</span>
				<span class="cell-delta ${deltaClass}">${escapeHtml(formatDelta(entry.delta))}</span>
			</div>`;
	}

	let resetHtml = '—';
	if (entry.resetTime !== null) {
		if (entry.resetTime > entry.timestamp) {
			let rt = entry.resetTime;
			let ts = entry.timestamp;
			if (isFullyRestored) {
				const ROUND_MS = 15 * 60 * 1000;
				rt = Math.round(rt / ROUND_MS) * ROUND_MS;
				ts = Math.round(ts / ROUND_MS) * ROUND_MS;
			}
			const timer = formatRemainingTimeSeparate(rt, ts);
			if (timer.absoluteText) {
				resetHtml = `${escapeHtml(timer.absoluteText)} <span class="reset-interval">(${escapeHtml(timer.relativeText)})</span>`;
			} else {
				resetHtml = escapeHtml(timer.relativeText);
			}
		} else {
			resetHtml = escapeHtml(formatFullTimestamp(entry.resetTime, locale));
		}
	}

	const tsDate = new Date(entry.timestamp);
	const dateStr = new Intl.DateTimeFormat(locale, { month: '2-digit', day: '2-digit' }).format(tsDate);
	const timeStr = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false }).format(tsDate);

	let lapseHtml = '';
	if (previousEntry !== undefined) {
		let diffMs = Math.max(0, entry.timestamp - previousEntry.timestamp);
		if (isFullyRestored) {
			const ROUND_MS = 15 * 60 * 1000;
			diffMs = Math.round(diffMs / ROUND_MS) * ROUND_MS;
		}
		lapseHtml = `<div class="history-lapsed">↑ ${escapeHtml(formatRelativeTime(diffMs))}</div>`;
	}

	return `
		<div class="history-row">
			<div class="history-date">
				<span class="history-date-day">${escapeHtml(dateStr)}</span>
				<span class="history-date-time">${escapeHtml(timeStr)}</span>
				${lapseHtml}
			</div>
			<div class="history-content">
				${detailsHtml}
				<div class="cell-reset">Reset: ${resetHtml}</div>
			</div>
		</div>`;
}

function buildHistorySparkline(entries: QuotaHistoryEntry[], locale?: string): string {
	if (entries.length < 2) { return ''; }

	const chartEntries: QuotaHistoryEntry[] = [];
	entries.forEach((entry, idx) => {
		if (idx === 0 || idx === entries.length - 1) {
			chartEntries.push(entry);
		} else {
			const lastKept = chartEntries[chartEntries.length - 1];
			const quotaDiff = Math.abs(entry.currentQuota - lastKept.currentQuota);
			const timeDiff = entry.timestamp - lastKept.timestamp;
			if (quotaDiff >= 0.05 || timeDiff >= 30 * 60 * 1000) {
				chartEntries.push(entry);
			}
		}
	});

	if (chartEntries.length < 2) { return ''; }

	const width = 200;
	const height = 44;
	const padding = 8;
	const chartWidth = width - padding * 2;
	const chartHeight = height - padding * 2;

	const scaleX = (i: number) => padding + (chartEntries.length > 1 ? i / (chartEntries.length - 1) : 0.5) * chartWidth;
	const scaleY = (val: number) => padding + chartHeight - (val / 100) * chartHeight;

	const lineColor = 'var(--text-secondary)';

	let pathD = '';
	let dotsHtml = '';
	chartEntries.forEach((entry, i) => {
		const pct = entry.currentQuota * 100;
		const x = scaleX(i);
		const y = scaleY(pct);
		pathD += (i === 0 ? 'M' : 'L') + `${x},${y}`;

		const timeStr = formatFullTimestamp(entry.timestamp, locale);
		const tooltip = `Quota: ${Math.round(pct)}%\nTime: ${timeStr}`;

		const dotColor = pct >= 100 ? 'var(--success)' : pct < 20 ? 'var(--error)' : lineColor;
		dotsHtml += `<circle cx="${x}" cy="${y}" r="3" fill="${dotColor}" stroke="var(--card-bg)" stroke-width="1.5"><title>${escapeHtml(tooltip)}</title></circle>`;
	});

	const y100 = scaleY(100);
	const y0 = scaleY(0);

	return `
		<div class="history-chart">
			<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
				<line x1="${padding}" y1="${y100}" x2="${width - padding}" y2="${y100}" class="chart-guide" vector-effect="non-scaling-stroke"/>
				<line x1="${padding}" y1="${y0}" x2="${width - padding}" y2="${y0}" class="chart-guide" vector-effect="non-scaling-stroke"/>
				<path d="${pathD}" fill="none" stroke="${lineColor}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
				${dotsHtml}
			</svg>
		</div>`;
}

function buildHistorySectionHtml(category: string, categoryEntries: QuotaHistoryEntry[], locale?: string): string {
	if (categoryEntries.length === 0) { return ''; }

	const sparklineHtml = buildHistorySparkline(categoryEntries.slice(0, 20).reverse(), locale);

	return `
		<details class="card-history-details" data-category="${escapeHtml(category)}">
			<summary class="card-history-summary">
				${sparklineHtml}
				<div class="card-action-overlay">
					<span class="expand-text">Expand</span>
					<svg class="expand-icon" width="14" height="14" viewBox="0 0 16 16"><path fill="currentColor" d="M8 11.5L2.5 6l.7-.7L8 10.1l4.8-4.8.7.7L8 11.5z"/></svg>
					<span class="collapse-text">Collapse</span>
					<svg class="collapse-icon" width="14" height="14" viewBox="0 0 16 16"><path fill="currentColor" d="M8 4.5l5.5 5.5-.7.7L8 5.9l-4.8 4.8-.7-.7L8 4.5z"/></svg>
				</div>
			</summary>
			<div class="history-list">
				<div class="history-list-inner">
					${categoryEntries.map((entry, index) => {
		const previousEntry = categoryEntries[index + 1];
		return buildHistoryItemHtml(entry, previousEntry, locale);
	}).join('')}
					<div class="history-clear-row" role="button" tabindex="0" data-category="${escapeHtml(category)}">
						<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M10 3h3v1h-1v9l-1 1H4l-1-1V4H2V3h3V2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1zM6 2v1h3V2H6zm4 11V4H5v9h5z" /></svg>
						<span>Clear History</span>
					</div>
				</div>
			</div>
		</details>`;
}

function buildCardHeaderHtml(category: string, group: QuotaGroup | undefined, locale?: string, plan?: string): string {
	if (!group) {
		return `
			<div class="quota-card-header">
				<div class="quota-card-title">
					<span class="quota-label">${escapeHtml(category)}</span>
				</div>
				<div class="quota-value">—</div>
			</div>`;
	}

	const pct = formatQuotaPercent(group.quota);
	const colorClass = getBarColorClass(group.quota);

	const rawModels = group.models?.filter(Boolean) ?? [];
	const seenModels = new Set<string>();
	const modelsList: string[] = [];
	for (const rawModel of rawModels) {
		const name = normalizeModelName(rawModel);
		if (name && !seenModels.has(name)) {
			seenModels.add(name);
			modelsList.push(name);
		}
	}
	let infoButtonHtml = '';
	if (modelsList.length > 0) {
		const modelsSummary = escapeHtml(modelsList.join(', '));
		const tooltipContent = modelsList.map(m => `<div class="tooltip-model-item">${escapeHtml(m)}</div>`).join('');
		infoButtonHtml = `
			<div class="info-button-container">
				<button type="button" class="info-button" aria-label="Models in this group: ${modelsSummary}">
					<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
						<path fill-rule="evenodd" clip-rule="evenodd" d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM2.5 8a5.5 5.5 0 1 1 11 0 5.5 5.5 0 0 1-11 0zM8 4a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zM8 7a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5a.75.75 0 0 1 .75-.75z"/>
					</svg>
				</button>
				<div role="tooltip" class="info-tooltip">
					<div class="tooltip-title">Models in this group</div>
					<div class="tooltip-models-list">
						${tooltipContent}
					</div>
				</div>
			</div>`;
	}

	if (group.buckets?.length) {
		const orderedBuckets = sortQuotaBuckets(group.buckets);
		const weeklyBucket = orderedBuckets.find(b => b.window.toLowerCase() === 'weekly');
		const isWeeklyDepleted = weeklyBucket !== undefined && formatQuotaPercent(weeklyBucket.quota) === 0;

		const bucketRows = orderedBuckets.map(bucket => {
			const bucketPct = formatQuotaPercent(bucket.quota);
			const bucketColorClass = getBarColorClass(bucket.quota);
			const isWeeklyBucket = bucket.window.toLowerCase() === 'weekly';
			let resetValueHtml = '';
			if (bucket.resetTime) {
				const resetMs = bucket.resetTime - Date.now();
				if (!isNotStartedQuota(bucketPct, resetMs)) {
					if (resetMs > 0) {
						const timer = formatRemainingTimeSeparate(bucket.resetTime);
						resetValueHtml = timer.absoluteText
							? `<span>${escapeHtml(timer.relativeText)}</span><span class="abs-time"> (${escapeHtml(timer.absoluteText)})</span>`
							: `<span>${escapeHtml(timer.relativeText)}</span>`;
					} else {
						resetValueHtml = `<span>${escapeHtml(formatFullTimestamp(bucket.resetTime, locale))}</span>`;
					}
				} else {
					resetValueHtml = '<span>Not started</span>';
				}
			}

			const bucketLabel = bucket.window.toLowerCase() === 'weekly' ? 'Weekly' : bucket.window.toLowerCase() === '5h' ? '5h' : bucket.displayName;
			const isDisabled = !isWeeklyBucket && isWeeklyDepleted;

			return `
				<div class="quota-bucket-row ${isWeeklyBucket ? 'weekly-bucket' : 'five-hour-container'}${isDisabled ? ' disabled-bucket' : ''}">
					<div class="quota-bucket-row-body">
						<span class="bucket-value ${bucketColorClass}">${bucketPct}%</span>
						<div class="bucket-meta">
							<span class="bucket-label">${escapeHtml(bucketLabel)}</span>
							${resetValueHtml ? `<span class="bucket-reset-time">${resetValueHtml}</span>` : ''}
						</div>
					</div>
					<div class="quota-bar-track bucket-bar">
						<div class="quota-bar-continuous-bg">
							<div class="quota-bar-continuous-fill ${bucketColorClass}" style="width:${bucketPct}%"></div>
						</div>
					</div>
				</div>`;
		}).join('');

		return `
		<div class="quota-card-header">
			<div class="quota-card-title">
				<span class="quota-label">${escapeHtml(category)}</span>
			</div>
			${infoButtonHtml ? `<div class="quota-header-actions">${infoButtonHtml}</div>` : ''}
		</div>
		<div class="quota-card-inner-wrap">
			<div class="quota-card-inner-content quota-buckets">
				${bucketRows}
			</div>
		</div>`;
	}

	let resetLabel = 'Resets at';
	let resetValueHtml = 'Not started';
	if (group.resetTime) {
		const resetMs = group.resetTime - Date.now();
		const isNotStarted = isNotStartedQuota(pct, resetMs);
		const weeklyLimitReached = isWeeklyLimitReached(pct, resetMs, plan);
		if (weeklyLimitReached) {
			resetLabel = 'Weekly limit resets at';
			const timer = formatRemainingTimeSeparate(group.resetTime);
			resetValueHtml = timer.absoluteText
				? `${escapeHtml(timer.relativeText)} <span class="reset-interval">(${escapeHtml(timer.absoluteText)})</span>`
				: escapeHtml(timer.relativeText);
		} else if (!isNotStarted) {
			if (resetMs > 0) {
				const timer = formatRemainingTimeSeparate(group.resetTime);
				if (timer.absoluteText) {
					resetValueHtml = `${escapeHtml(timer.absoluteText)} <span class="reset-interval">(${escapeHtml(timer.relativeText)})</span>`;
				} else {
					resetValueHtml = escapeHtml(timer.relativeText);
				}
			} else {
				resetValueHtml = escapeHtml(formatFullTimestamp(group.resetTime, locale));
			}
		}
	}

	return `
		<div class="quota-card-header">
			<div class="quota-card-title">
				<span class="quota-label">${escapeHtml(category)}</span>
			</div>
			<div class="quota-header-actions">
				<span class="quota-value ${colorClass}">${pct}%</span>
				${infoButtonHtml}
			</div>
		</div>
		<div class="quota-card-inner-wrap">
			<div class="quota-card-inner-content">
				<div class="quota-bar-track">
					${Array.from({ length: 5 }).map((_, i) => {
		const startPct = i * 20;
		const fillPct = Math.max(0, Math.min(100, (pct - startPct) * 5));
		return `<div class="quota-bar-segment-bg"><div class="quota-bar-segment-fill ${colorClass}" style="width:${fillPct}%"></div></div>`;
	}).join('')}
				</div>
				<div class="quota-reset">
					<span class="reset-label">${resetLabel}</span>
					<span class="reset-value">${resetValueHtml}</span>
				</div>
			</div>
		</div>`;
}

function buildQuotaCards(statsData: UsageStatistics | null, history: QuotaHistory, locale?: string): string {
	const groups = statsData?.groups || {};
	const plan = `${statsData?.plan ?? ''} ${statsData?.planName ?? ''}`.trim();
	const entries = history.getEntries();

	const grouped = new Map<string, QuotaHistoryEntry[]>();
	for (const entry of entries) {
		const catEntries = grouped.get(entry.category) || [];
		catEntries.push(entry);
		grouped.set(entry.category, catEntries);
	}

	const categories = CATEGORY_ORDER.filter(c => groups[c] !== undefined || (grouped.has(c) && (grouped.get(c)?.length ?? 0) > 0));

	if (categories.length === 0) {
		if (!statsData) { return '<div class="empty-state loading">Waiting for data…</div>'; }
		return '<div class="empty-state">No quota data available</div>';
	}

	return categories.map(category => {
		const group = groups[category];
		const categoryEntries = (grouped.get(category) || []).slice().reverse();

		const headerHtml = buildCardHeaderHtml(category, group, locale, plan);
		const historyHtml = buildHistorySectionHtml(category, categoryEntries, locale);

		return `
			<div class="quota-card">
				${headerHtml}
				<div class="quota-card-inner-wrap">
					<div class="quota-card-inner-content">
						${historyHtml}
					</div>
				</div>
			</div>`;
	}).join('');
}

function buildProgressVars(palette: string[]): string {
	return PROGRESS_STOPS.map((stop, i) => `\t--progress-${stop}: ${palette[i]};`).join('\n');
}

function getPanelStyles(): string {
	return `
:root {
	--panel-bg: var(--vscode-sideBar-background);
	--card-bg: var(--vscode-editor-background);
	--card-border: color-mix(in srgb, var(--vscode-editorWidget-border, var(--vscode-panel-border)) 50%, transparent);
	--text-primary: var(--vscode-foreground);
	--text-secondary: var(--vscode-descriptionForeground);
	--text-muted: var(--vscode-disabledForeground);
	--table-row-hover: var(--vscode-list-hoverBackground);
	--table-border: var(--vscode-editorGroup-border, var(--vscode-panel-border));
	--success: ${THEME_COLORS.dark.success};
	--warning: ${THEME_COLORS.dark.warning};
	--error: ${THEME_COLORS.dark.error};
	--models-gemini: ${MODELS_COLORS.dark.gemini};
	--models-other: ${MODELS_COLORS.dark.other};
	--metric-row-bg: color-mix(in srgb, #000 ${BUCKET_OPACITY.defaultBg * 100}%, var(--card-bg));
	--metric-row-border: color-mix(in srgb, var(--card-border) ${BUCKET_OPACITY.defaultBorder * 100}%, transparent);
${buildProgressVars(THEME_COLORS.dark.progress)}
	--radius-sm: 6px;
	--radius-lg: 10px;
}

body.vscode-light {
${buildProgressVars(THEME_COLORS.light.progress)}
	--error: ${THEME_COLORS.light.error};
	--models-gemini: ${MODELS_COLORS.light.gemini};
	--models-other: ${MODELS_COLORS.light.other};
}

html { container-type: inline-size; container-name: panel; height: 100%; }
body { height: 100%; }

* {
	margin: 0;
	padding: 0;
	box-sizing: border-box;
	scrollbar-width: thin;
	scrollbar-color: var(--vscode-scrollbarSlider-background) transparent;
}
*::-webkit-scrollbar { width: 6px; height: 6px; }
*::-webkit-scrollbar-track { background: transparent; }
*::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 3px; }
*::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }
*::-webkit-scrollbar-thumb:active { background: var(--vscode-scrollbarSlider-activeBackground); }

body {
	background: var(--panel-bg);
	color: var(--text-primary);
	font-family: var(--vscode-font-family);
	font-size: var(--vscode-font-size);
	line-height: 1.5;
	padding: 8px 12px 16px;
	gap: 12px;
	display: flex;
	flex-direction: column;
	user-select: none;
	overflow-y: auto;
	scrollbar-gutter: stable;
	max-width: 650px;
	margin: 0 auto;
	width: 100%;
}

.section {
	display: flex;
	flex-direction: column;
}

.quota-grid {
	display: flex;
	flex-direction: column;
	gap: 12px;
}

.panel-footer {
	padding: 0;
	padding-bottom: 10px;
	font-size: 10px;
	color: var(--text-muted);
	text-align: center;
	flex-shrink: 0;
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 4px;
}
.refresh-interval-info {
	opacity: 0.7;
}

.empty-state {
	text-align: center;
	color: var(--text-muted);
	padding: 32px 16px;
	font-style: italic;
}
.empty-state.loading {
	animation: pulse 1.8s ease-in-out infinite;
}
.panel-loading-body {
	justify-content: center;
	min-height: 100%;
	overflow: hidden;
}
.panel-loading-screen {
	display: flex;
	flex: 1;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 16px;
	min-height: 280px;
	text-align: center;
	color: var(--text-secondary);
}
.panel-loading-spinner {
	width: 34px;
	height: 34px;
	border: 2px solid var(--table-border);
	border-top-color: var(--progress-80);
	border-radius: 50%;
	animation: spin 0.9s linear infinite;
}
.panel-loading-title {
	font-size: 13px;
	font-weight: 700;
	text-transform: uppercase;
	letter-spacing: 0.6px;
	color: var(--text-primary);
}
.panel-loading-subtitle {
	max-width: 220px;
	font-size: 11px;
	line-height: 1.4;
	color: var(--text-muted);
}
.panel-notfound-icon {
	opacity: 0.5;
}
.panel-loading-body:has(.panel-error-screen) {
	overflow: auto;
	justify-content: safe center;
}
.panel-error-screen {
	gap: 16px;
	padding: 28px 8px;
	color: var(--text-primary);
}
.panel-error-icon {
	color: var(--error);
	flex-shrink: 0;
}
.panel-error-copy {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 10px;
	width: 100%;
	max-width: 420px;
}
.panel-error-title {
	font-size: 15px;
	font-weight: 700;
	line-height: 1.3;
	color: var(--error);
}
.panel-error-message {
	font-size: 13px;
	line-height: 1.5;
	color: var(--text-primary);
	word-break: break-word;
	overflow-wrap: anywhere;
	white-space: pre-wrap;
	user-select: text;
}
.panel-error-actions {
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 8px;
}
.panel-error-actions-row {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 8px;
}
.panel-error-actions-row .panel-error-action {
	width: 104px;
}
.panel-error-action {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	box-sizing: border-box;
	background: var(--card-bg);
	color: var(--text-primary);
	border: 1px solid var(--card-border);
	border-radius: var(--radius-sm);
	padding: 6px 12px;
	font: inherit;
	font-size: 12px;
	font-weight: 600;
	line-height: 1.4;
	text-decoration: none;
	cursor: pointer;
	user-select: none;
	transition: border-color 0.15s ease, background-color 0.15s ease;
}
.panel-error-action:hover {
	background: var(--table-row-hover);
	border-color: var(--text-secondary);
}
.panel-error-action:focus-visible {
	border-color: var(--text-secondary);
	outline: 1px solid var(--vscode-focusBorder);
	outline-offset: 2px;
}
.panel-error-banner {
	display: flex;
	flex-direction: column;
	gap: 10px;
	margin-bottom: 12px;
	padding: 10px 12px;
	border: 1px solid color-mix(in srgb, var(--error) 55%, var(--card-border));
	background: color-mix(in srgb, var(--error) 14%, var(--card-bg));
	border-radius: var(--radius-lg);
}
.panel-error-banner-header {
	display: flex;
	align-items: flex-start;
	gap: 10px;
}
.panel-error-banner-text {
	flex: 1;
	min-width: 0;
	display: flex;
	flex-direction: column;
	gap: 4px;
	text-align: left;
}
.panel-error-banner-title {
	font-size: 12px;
	font-weight: 700;
	line-height: 1.3;
	color: var(--error);
}
.panel-error-banner .panel-error-message {
	font-size: 13px;
	text-align: left;
}
.panel-error-banner .panel-error-actions {
	align-items: flex-start;
}
.panel-error-banner .panel-error-actions-row {
	justify-content: flex-start;
}
@keyframes pulse {
	0%, 100% { opacity: 0.4; }
	50% { opacity: 1; }
}
@keyframes spin {
	to { transform: rotate(360deg); }
}

.quota-card {
	background: var(--card-bg);
	border: 1px solid var(--card-border);
	border-radius: var(--radius-lg);
	padding: 14px;
	flex: 0 0 auto;
	display: flex;
	flex-direction: column;
}
.quota-card-inner-wrap {
	display: grid;
	grid-template-rows: 1fr;
	transition: grid-template-rows 0.15s cubic-bezier(0.4, 0, 0.2, 1);
}
.quota-card.minimized .quota-card-inner-wrap {
	grid-template-rows: 0fr;
}
.quota-card.minimized .quota-card-header { margin-bottom: 0; }
.quota-card-inner-content {
	overflow: hidden;
}
.quota-card.minimized { cursor: pointer; }

.quota-card-header {
	display: flex;
	justify-content: space-between;
	align-items: center;
	margin-bottom: 10px;
	transition: margin-bottom 0.15s cubic-bezier(0.4, 0, 0.2, 1);
}
.quota-card-title { display: flex; align-items: center; gap: 8px; }
.quota-label {
	font-size: 12px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.6px;
	color: var(--text-secondary);
}
.quota-value { font-size: 20px; font-weight: 700; letter-spacing: 0; }
.quota-value.bar-p0 { color: var(--progress-0); }
.quota-value.bar-p20 { color: var(--progress-20); }
.quota-value.bar-p40 { color: var(--progress-40); }
.quota-value.bar-p60 { color: var(--progress-60); }
.quota-value.bar-p80 { color: var(--progress-80); }
.quota-value.bar-p100 { color: var(--progress-100); }
.quota-buckets { display: flex; flex-direction: column; gap: 8px; }
.quota-bucket-row {
	display: flex;
	flex-direction: column;
	position: relative;
	background: var(--metric-row-bg);
	border: 1px solid var(--metric-row-border);
	border-radius: var(--radius-sm);
	padding: 10px 12px 8px;
	min-height: 50px;
}

.five-hour-container {
	margin: 0;
}

.weekly-bucket {
	margin: 0;
	background: color-mix(in srgb, #000 ${BUCKET_OPACITY.weeklyBg * 100}%, var(--card-bg));
	border-color: color-mix(in srgb, var(--metric-row-border) ${BUCKET_OPACITY.weeklyBorder * 100}%, transparent);
}
.disabled-bucket {
	opacity: 0.4;
}

.bucket-label {
	font-size: 11px;
	font-weight: 650;
	color: var(--text-muted);
	line-height: 1.05;
	max-width: 100%;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.quota-bucket-row-body {
	display: flex;
	justify-content: space-between;
	align-items: center;
	margin-bottom: 8px;
	gap: 10px;
}

.bucket-value {
	font-size: 18px;
	font-weight: 800;
	line-height: 1;
	font-variant-numeric: tabular-nums;
}
.bucket-meta {
	display: flex;
	flex-direction: column;
	align-items: flex-end;
	gap: 2px;
	min-width: 0;
	text-align: right;
}
.bucket-value.bar-p0 { color: var(--progress-0); }
.bucket-value.bar-p20 { color: var(--progress-20); }
.bucket-value.bar-p40 { color: var(--progress-40); }
.bucket-value.bar-p60 { color: var(--progress-60); }
.bucket-value.bar-p80 { color: var(--progress-80); }
.bucket-value.bar-p100 { color: var(--progress-100); }

.bucket-reset-time {
	font-size: 11px;
	font-weight: 600;
	color: var(--text-secondary);
	line-height: 1.05;
	font-variant-numeric: tabular-nums;
	max-width: 100%;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.bucket-reset-time .abs-time {
	opacity: 0.68;
}

.bucket-bar {
	margin-bottom: 0;
	height: 5px;
	gap: 0;
}

.quota-bar-track { display: flex; gap: 2px; height: 6px; margin-bottom: 8px; }
.quota-bar-segment-bg { flex: 1; background: var(--table-border); border-radius: 3px; overflow: hidden; }
.quota-bar-segment-fill { height: 100%; border-radius: 3px; transition: width 0.3s ease; }
.quota-bar-continuous-bg { flex: 1; background: var(--table-border); border-radius: 3px; overflow: hidden; }
.quota-bar-continuous-fill { height: 100%; border-radius: 3px; transition: width 0.3s ease; }
.quota-bar-segment-fill.bar-p0 { background: var(--progress-0); }
.quota-bar-segment-fill.bar-p20 { background: var(--progress-20); }
.quota-bar-segment-fill.bar-p40 { background: var(--progress-40); }
.quota-bar-segment-fill.bar-p60 { background: var(--progress-60); }
.quota-bar-segment-fill.bar-p80 { background: var(--progress-80); }
.quota-bar-segment-fill.bar-p100 { background: var(--progress-100); }
.quota-bar-continuous-fill.bar-p0 { background: var(--progress-0); }
.quota-bar-continuous-fill.bar-p20 { background: var(--progress-20); }
.quota-bar-continuous-fill.bar-p40 { background: var(--progress-40); }
.quota-bar-continuous-fill.bar-p60 { background: var(--progress-60); }
.quota-bar-continuous-fill.bar-p80 { background: var(--progress-80); }
.quota-bar-continuous-fill.bar-p100 { background: var(--progress-100); }

.quota-reset { display: flex; justify-content: space-between; align-items: center; }
.reset-label { font-size: 11px; color: var(--text-muted); }
.reset-value { font-size: 11px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.reset-interval { color: var(--text-muted); opacity: 0.8; }

.top-row {
	display: flex;
	flex-direction: row;
	gap: 8px;
	flex-shrink: 0;
	flex-wrap: wrap;
}
.top-row .quota-card {
	padding: 10px 12px;
	flex: 1 1 100px;
	min-width: 100px;
	position: relative;
	overflow: hidden;
	transition: background 0.15s ease, border-color 0.15s ease;
	text-decoration: none;
	color: inherit;
	display: flex;
	flex-direction: row;
	align-items: center;
	justify-content: center;
}
.top-row .quota-card.clickable-card {
	cursor: pointer;
}
.top-row .quota-card.clickable-card:hover {
	background: var(--table-row-hover);
	border-color: var(--vscode-focusBorder);
}
.card-action-overlay {
	position: absolute;
	inset: 0;
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 6px;
	font-size: 10px;
	font-weight: 600;
	text-transform: uppercase;
	color: var(--text-secondary);
	opacity: 0;
	transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
	pointer-events: none;
	text-decoration: none;
}
.top-row .quota-card.clickable-card:hover .card-action-overlay,
.card-history-summary:hover .card-action-overlay,
.public-health-chart:hover .card-action-overlay {
	opacity: 1;
	color: var(--text-primary);
	background: color-mix(in srgb, var(--vscode-editorWidget-background) 70%, transparent);
	backdrop-filter: blur(8px);
}
.card-history-summary:hover .card-action-overlay {
	background: transparent;
	backdrop-filter: none;
}
.plan-value {
	font-size: 12px;
	font-weight: 600;
	letter-spacing: 0.5px;
	color: var(--text-primary);
	text-transform: uppercase;
	line-height: 1.1;
	text-align: center;
}

.credits-info { display: flex; align-items: center; gap: 8px; }
.credits-label { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-secondary); line-height: 1.1; max-width: 60px; }
.credits-amount { font-size: 18px; font-weight: 700; line-height: 1; }
.credits-ok { color: var(--success); }
.credits-low { color: var(--error); }
.card-history-details { margin-top: 6px; position: relative; }

.card-history-summary {
	cursor: pointer;
	user-select: none;
	list-style: none;
	flex-shrink: 0;
	margin-top: 12px;
	border-radius: var(--radius-sm);
	position: relative;
	overflow: hidden;
}
.card-history-summary .card-action-overlay {
	position: absolute;
	top: auto;
	left: 0;
	right: 0;
	bottom: 2px;
	min-height: 18px;
	opacity: 0.72;
	background: transparent;
	backdrop-filter: none;
}
.card-history-details[open] .card-history-summary .expand-text,
.card-history-details[open] .card-history-summary .expand-icon {
	display: none;
}
.card-history-details:not([open]) .card-history-summary .collapse-text,
.card-history-details:not([open]) .card-history-summary .collapse-icon {
	display: none;
}
.card-history-summary:focus-visible {
	outline: 1px solid var(--vscode-focusBorder);
	outline-offset: 2px;
}
.card-history-summary::-webkit-details-marker { display: none; }
.history-clear-row {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 6px;
	padding: 8px;
	margin-top: 4px;
	cursor: pointer;
	border-radius: var(--radius-sm);
	color: var(--text-muted);
	font-size: 11px;
	transition: all 0.15s ease;
	flex-shrink: 0;
}
.history-clear-row:hover, .history-clear-row:focus-visible {
	background: var(--table-row-hover);
	color: var(--error);
}
.history-clear-row:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }

.history-chart { background: var(--panel-bg); border-radius: var(--radius-sm); padding: 4px 4px 16px; transition: opacity 0.15s ease; opacity: 0.7; }
.history-chart:hover { opacity: 1; }
.history-chart svg { display: block; width: 100%; height: 44px; max-height: 44px; }
.history-chart circle { transition: r 0.15s ease; cursor: default; }
.history-chart circle:hover { r: 4.5; }
.chart-guide { stroke: var(--table-border); stroke-width: 0.8; stroke-dasharray: 2 1; opacity: 0.6; }

.history-list {
	display: grid;
	grid-template-rows: 0fr;
	transition: grid-template-rows 0.15s cubic-bezier(0.4, 0, 0.2, 1);
}

.history-list.expanded {
	grid-template-rows: 1fr;
}

.history-list-inner {
	display: flex;
	flex-direction: column;
	gap: 4px;
	padding-right: 4px;
	padding-top: 8px;
	overflow: hidden;
	max-height: 400px;
	opacity: 0;
	transition: opacity 0.12s cubic-bezier(0.4, 0, 0.2, 1);
}

.history-list.expanded .history-list-inner {
	opacity: 1;
}
.history-list-inner.scrollable {
	overflow-y: auto;
	overflow-x: hidden;
}

.history-row {
	display: flex;
	background: var(--card-bg);
	border: 1px solid var(--card-border);
	border-radius: var(--radius-sm);
	overflow: hidden;
	flex-shrink: 0;
}
.history-date {
	padding: 6px 10px;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 1px;
	border-right: 1px solid var(--card-border);
	width: 65px;
	flex-shrink: 0;
}
.history-date-day { font-size: 11px; font-weight: 600; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.history-date-time { font-size: 10px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
.history-lapsed { font-size: 9px; color: var(--text-muted); margin-top: 2px; opacity: 0.7; }
.history-content { padding: 6px 10px; display: flex; flex-direction: column; justify-content: center; gap: 2px; flex: 1; min-width: 0; }
.history-item-change { display: flex; gap: 6px; align-items: center; }
.cell-value { color: var(--text-secondary); font-size: 12px; }
.cell-delta { font-weight: 600; font-size: 11px; }
.delta-positive { color: var(--success); }
.delta-negative { color: var(--error); }
.cell-reset { color: var(--text-muted); font-size: 10px; }

.heatmap-section {
	background: var(--card-bg);
	border: 1px solid var(--card-border);
	border-radius: var(--radius-lg);
	padding: 14px 16px;
	flex-shrink: 0;
	min-width: 0;
}
.heatmap-header {
	display: flex;
	justify-content: space-between;
	align-items: center;
	margin-bottom: 12px;
}
.heatmap-title {
	font-size: 12px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.6px;
	color: var(--text-secondary);
}
.heatmap-nav {
	display: flex;
	align-items: center;
	gap: 8px;
	user-select: none;
}
.nav-btn {
	background: transparent;
	border: none;
	color: var(--text-muted);
	cursor: pointer;
	font-size: 16px;
	padding: 0 4px;
	border-radius: 4px;
	display: flex;
	align-items: center;
	justify-content: center;
	transition: all 0.1s ease;
}
.nav-btn:hover, .nav-btn:focus-visible {
	color: var(--text-primary);
	background: var(--table-row-hover);
}
.nav-btn:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.heatmap-month-title {
	font-size: 11px;
	font-weight: 600;
	color: var(--text-secondary);
	text-transform: uppercase;
	letter-spacing: 0.5px;
	min-width: 80px;
	text-align: center;
}
.heatmap-grid {
	--heatmap-gap: 3px;
	--heatmap-cell-max: 28px;
	--heatmap-cell-min: 8px;
	display: flex;
	flex-direction: column;
	gap: 4px;
	flex: 0 1 calc(7 * var(--heatmap-cell-max) + 6 * var(--heatmap-gap));
	width: auto;
	max-width: calc(7 * var(--heatmap-cell-max) + 6 * var(--heatmap-gap));
	min-width: calc(7 * var(--heatmap-cell-min) + 6 * var(--heatmap-gap));
}
.heatmap-labels,
.heatmap-week {
	display: grid;
	grid-template-columns: repeat(7, minmax(var(--heatmap-cell-min), 1fr));
	gap: var(--heatmap-gap);
	width: 100%;
}
.heatmap-label {
	min-width: 0;
	font-size: 9px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.2px;
	line-height: 1;
	color: var(--text-muted);
	text-align: center;
	white-space: nowrap;
	overflow: hidden;
}
.heatmap-weeks {
	display: flex;
	flex-direction: column;
	gap: var(--heatmap-gap);
	width: 100%;
	min-width: 0;
}
.heatmap-cell {
	width: 100%;
	aspect-ratio: 1;
	height: auto;
	min-width: 0;
	container-type: inline-size;
	container-name: heatmap-cell;
	border-radius: 3px;
	transition: opacity 0.15s ease;
	display: flex;
	align-items: center;
	justify-content: center;
}
.heatmap-cell-num {
	max-width: 100%;
	overflow: hidden;
	font-size: 11px;
	font-weight: 600;
	line-height: 1;
	color: var(--text-secondary);
	font-variant-numeric: tabular-nums;
	pointer-events: none;
}
.heatmap-cell.level-3 .heatmap-cell-num,
.heatmap-cell.level-4 .heatmap-cell-num {
	color: var(--text-primary);
}
.heatmap-cell:not(.future):hover {
	opacity: 0.75;
}
.heatmap-cell.level-0,
.heatmap-cell.future {
	background: var(--table-border);
}
.heatmap-cell.level-1 { background: color-mix(in srgb, var(--success) 30%, var(--card-bg)); }
.heatmap-cell.level-2 { background: color-mix(in srgb, var(--success) 50%, var(--card-bg)); }
.heatmap-cell.level-3 { background: color-mix(in srgb, var(--success) 72%, var(--card-bg)); }
.heatmap-cell.level-4 { background: color-mix(in srgb, var(--success) 88%, var(--card-bg)); }
.heatmap-cell.future { opacity: 0.15; }
.heatmap-cell.other-month { opacity: 0.1 !important; }
.heatmap-cell.today { outline: 1.5px solid var(--text-muted); outline-offset: -0.5px; }
.heatmap-body {
	display: flex;
	justify-content: center;
	align-items: flex-end;
	gap: 18px;
	width: 100%;
	min-width: 0;
}
.heatmap-legend {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 3px;
	flex: 0 0 auto;
	font-size: 9px;
	color: var(--text-muted);
}
.heatmap-legend .heatmap-cell {
	width: 10px;
	height: 10px;
	aspect-ratio: auto;
	flex: none;
}
.heatmap-legend .heatmap-cell-num {
	display: none;
}
.heatmap-legend span {
	margin: 1px 0;
}

.reset-calendar-section {
	background: var(--card-bg);
	border: 1px solid var(--card-border);
	border-radius: var(--radius-lg);
	padding: 14px 16px;
	flex-shrink: 0;
	display: flex;
	flex-direction: column;
	gap: 12px;
}
.reset-calendar-header {
	display: flex;
	justify-content: space-between;
	align-items: center;
	gap: 10px;
}
.reset-calendar-title {
	font-size: 12px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.6px;
	color: var(--text-secondary);
}
.reset-calendar-meta {
	font-size: 11px;
	font-weight: 500;
	color: var(--text-muted);
	font-variant-numeric: tabular-nums;
}
.reset-calendar-timeline {
	display: flex;
	flex-direction: column;
	gap: 6px;
}
.reset-calendar-days {
	display: grid;
	grid-template-columns: repeat(var(--reset-calendar-days, 7), minmax(0, 1fr));
	gap: 2px;
}
.reset-calendar-day {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 3px;
	padding: 5px 0;
	border-radius: var(--radius-sm);
	min-width: 0;
}
.reset-calendar-day-name {
	font-size: 9px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.4px;
	line-height: 1;
	color: var(--text-muted);
	white-space: nowrap;
	overflow: hidden;
	max-width: 100%;
}
.reset-calendar-day-num {
	font-size: 11px;
	font-weight: 600;
	line-height: 1;
	color: var(--text-secondary);
	font-variant-numeric: tabular-nums;
}
.reset-calendar-day-reset .reset-calendar-day-num {
	color: var(--text-primary);
}
.reset-calendar-day-today {
	background: color-mix(in srgb, var(--text-secondary) 12%, transparent);
}
.reset-calendar-day-today .reset-calendar-day-name,
.reset-calendar-day-today .reset-calendar-day-num {
	color: var(--text-primary);
}
.reset-calendar-track {
	position: relative;
	height: 16px;
}
.reset-calendar-bar {
	position: absolute;
	left: 0;
	right: 0;
	top: 50%;
	height: 4px;
	transform: translateY(-50%);
	border-radius: 2px;
	background: color-mix(in srgb, var(--text-secondary) 18%, transparent);
	overflow: hidden;
}
.reset-calendar-bar-elapsed {
	height: 100%;
	background: color-mix(in srgb, var(--text-secondary) 50%, transparent);
}
.reset-calendar-sep {
	position: absolute;
	top: 50%;
	width: 2px;
	height: 6px;
	transform: translate(-50%, -50%);
	background: var(--card-bg);
	pointer-events: none;
}
.reset-calendar-now {
	position: absolute;
	top: 1px;
	bottom: 1px;
	width: 2px;
	transform: translateX(-50%);
	background: var(--text-primary);
	border-radius: 1px;
	z-index: 2;
}
.reset-calendar-dot {
	position: absolute;
	top: 50%;
	width: 12px;
	height: 12px;
	border-radius: 50%;
	transform: translate(calc(-50% + var(--dot-offset, 0px)), -50%);
	border: 2px solid var(--card-bg);
	z-index: 3;
	transition: transform 0.15s ease;
}
.reset-calendar-dot:hover,
.reset-calendar-dot.scaled {
	transform: translate(calc(-50% + var(--dot-offset, 0px)), -50%) scale(1.3);
	z-index: 4;
}
.reset-calendar-labels {
	display: grid;
	grid-template-columns: repeat(var(--reset-calendar-days, 7), minmax(0, 1fr));
	gap: 2px;
}
.reset-calendar-label-cell {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 2px;
	min-width: 0;
}
.reset-calendar-label {
	font-size: 10px;
	font-weight: 600;
	line-height: 1.2;
	white-space: nowrap;
	display: inline-block;
	cursor: pointer;
	transition: transform 0.15s ease;
	transform-origin: center center;
}
.reset-calendar-label:hover,
.reset-calendar-label.scaled {
	transform: scale(1.15);
}

.model-usage-section {
	background: var(--card-bg);
	border: 1px solid var(--card-border);
	border-radius: var(--radius-lg);
	padding: 14px 16px;
	flex-shrink: 0;
	display: flex;
	flex-direction: column;
	gap: 8px;
}
.model-usage-header {
	display: flex;
	justify-content: space-between;
	align-items: center;
	gap: 10px;
}
.model-usage-title {
	font-size: 12px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.6px;
	color: var(--text-secondary);
}
.model-usage-meta {
	display: flex;
	flex-direction: column;
	align-items: flex-end;
	gap: 1px;
	font-size: 10px;
	color: var(--text-muted);
	line-height: 1.3;
	text-align: right;
	white-space: nowrap;
}
.model-usage-row {
	display: flex;
	flex-direction: column;
	gap: 5px;
	background: var(--metric-row-bg);
	border: 1px solid var(--metric-row-border);
	border-radius: var(--radius-sm);
	padding: 8px 12px 7px;
}
.model-usage-row-top {
	display: flex;
	justify-content: space-between;
	align-items: center;
	gap: 10px;
}
.model-usage-info {
	display: flex;
	align-items: center;
	gap: 8px;
	min-width: 0;
}
.model-usage-name {
	font-size: 12px;
	font-weight: 600;
	color: var(--text-primary);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.model-usage-level {
	font-size: 10px;
	font-weight: 600;
	color: var(--text-secondary);
	border: 1px solid var(--metric-row-border);
	border-radius: 999px;
	padding: 1px 8px;
	flex-shrink: 0;
}
.model-usage-count {
	font-size: 12px;
	font-weight: 700;
	color: var(--text-secondary);
	font-variant-numeric: tabular-nums;
	white-space: nowrap;
	display: inline-flex;
	align-items: baseline;
	gap: 4px;
	flex-shrink: 0;
}
.model-usage-share {
	font-size: 10px;
	font-weight: 500;
	color: var(--text-muted);
}
.model-usage-bar {
	height: 2px;
	background: color-mix(in srgb, var(--text-muted) 35%, transparent);
	overflow: hidden;
}
.model-usage-bar-fill {
	height: 100%;
	transition: width 0.3s ease;
}
.model-usage-bar-fill--gemini {
	background: var(--models-gemini);
}
.model-usage-bar-fill--other {
	background: var(--models-other);
}
.model-usage-extra-rows {
	display: flex;
	flex-direction: column;
	gap: 8px;
	padding-top: 2px;
}
.model-usage-toggle {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 6px;
	cursor: pointer;
	user-select: none;
	list-style: none;
	padding: 6px;
	border-radius: var(--radius-sm);
	color: var(--text-muted);
	font-size: 11px;
	transition: all 0.15s ease;
}
.model-usage-toggle::-webkit-details-marker { display: none; }
.model-usage-toggle:hover, .model-usage-toggle:focus-visible {
	background: var(--table-row-hover);
	color: var(--text-primary);
}
.model-usage-toggle:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.model-usage-more[open] .model-usage-show-more,
.model-usage-more[open] .model-usage-toggle-more-icon,
.model-usage-more:not([open]) .model-usage-show-less,
.model-usage-more:not([open]) .model-usage-toggle-less-icon {
	display: none;
}

.public-health-section {
	background: var(--card-bg);
	border: 1px solid var(--card-border);
	border-radius: var(--radius-lg);
	padding: 12px;
	flex-shrink: 0;
}
.public-health-header {
	display: flex;
	justify-content: space-between;
	align-items: flex-start;
	gap: 10px;
	margin-bottom: 8px;
}
.public-health-title {
	font-size: 12px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.6px;
	color: var(--text-secondary);
	line-height: 1.2;
}
.public-health-time {
	font-size: 10px;
	color: var(--text-muted);
	line-height: 1.2;
	align-self: center;
}
.public-health-chart {
	background: color-mix(in srgb, var(--panel-bg) 78%, var(--card-bg));
	border: 1px solid var(--table-border);
	border-radius: var(--radius-sm);
	padding: 6px;
	position: relative;
	overflow: hidden;
}
.public-health-chart > svg {
	display: block;
	width: 100%;
	height: 126px;
	max-height: 126px;
}
.public-health-legend {
	display: flex;
	flex-wrap: wrap;
	justify-content: center;
	gap: 8px;
	margin-top: 8px;
	font-size: 10px;
	color: var(--text-secondary);
}
.public-health-legend span {
	display: inline-flex;
	align-items: center;
	gap: 4px;
}
.health-dot {
	width: 7px;
	height: 7px;
	border-radius: 50%;
	display: inline-block;
}
.health-up { background: #21bf73; }
.health-warn { background: #ffa133; }
.health-down { background: #fd5e53; }
.public-health-chart-overlay {
	pointer-events: auto !important;
	cursor: pointer;
}
.public-health-chart-overlay:focus {
	outline: none;
}
.public-health-chart-overlay:focus-visible {
	outline: 1px solid var(--vscode-focusBorder);
	outline-offset: -2px;
}

.quota-header-actions {
	display: flex;
	align-items: center;
	gap: 8px;
}
.info-button-container {
	position: relative;
	display: inline-flex;
	align-items: center;
}
.info-button {
	background: transparent;
	border: none;
	color: var(--text-muted);
	cursor: pointer;
	padding: 4px;
	border-radius: 4px;
	display: flex;
	align-items: center;
	justify-content: center;
	transition: color 0.12s ease, background-color 0.12s ease;
}
.info-button:hover,
.info-button:focus-visible {
	color: var(--text-primary);
	background-color: var(--table-row-hover);
	outline: none;
}
.info-tooltip {
	position: absolute;
	right: 0;
	top: calc(100% + 6px);
	z-index: 100;
	width: max-content;
	max-width: 220px;
	background: color-mix(in srgb, var(--vscode-editorWidget-background, var(--card-bg)) 95%, transparent);
	border: 1px solid var(--card-border);
	border-radius: var(--radius-sm);
	padding: 8px 10px;
	box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
	backdrop-filter: blur(8px);
	visibility: hidden;
	opacity: 0;
	pointer-events: none;
	transform: translateY(-4px);
	transition: opacity 0.15s cubic-bezier(0.4, 0, 0.2, 1), transform 0.15s cubic-bezier(0.4, 0, 0.2, 1), visibility 0.15s;
}
.info-button-container:hover .info-tooltip,
.info-button-container:focus-within .info-tooltip {
	visibility: visible;
	opacity: 1;
	transform: translateY(0);
}
.tooltip-title {
	font-size: 10px;
	font-weight: 700;
	text-transform: uppercase;
	letter-spacing: 0.5px;
	color: var(--text-muted);
	margin-bottom: 6px;
	border-bottom: 1px solid var(--card-border);
	padding-bottom: 4px;
	text-align: left;
}
.tooltip-models-list {
	display: flex;
	flex-direction: column;
	gap: 4px;
	text-align: left;
}
.tooltip-model-item {
	font-size: 11px;
	font-weight: 500;
	color: var(--text-primary);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.custom-tooltip {
	position: fixed;
	z-index: 1000;
	pointer-events: none;
	opacity: 0;
	visibility: hidden;
	transform: translateY(4px) scale(0.96);
	transition: opacity 0.12s cubic-bezier(0.16, 1, 0.3, 1), transform 0.12s cubic-bezier(0.16, 1, 0.3, 1), visibility 0.12s;
	background: color-mix(in srgb, var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background, var(--card-bg))) 96%, transparent);
	border: 1px solid color-mix(in srgb, var(--vscode-editorHoverWidget-border, var(--card-border)) 80%, transparent);
	border-radius: var(--radius-sm);
	padding: 7px 9px;
	box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28);
	backdrop-filter: blur(8px);
	max-width: min(260px, calc(100vw - 16px));
	min-width: 90px;
	display: flex;
	flex-direction: column;
	gap: 4px;
	font-family: var(--vscode-font-family);
	font-size: 11px;
	line-height: 1.35;
	color: var(--text-primary);
}
.custom-tooltip.visible {
	opacity: 1;
	visibility: visible;
	transform: translateY(0) scale(1) !important;
}
.custom-tooltip[data-placement="bottom"] {
	transform: translateY(-4px) scale(0.96);
}
.custom-tooltip-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
}
.custom-tooltip-title-wrap {
	display: flex;
	align-items: center;
	gap: 6px;
	min-width: 0;
}
.custom-tooltip-title {
	font-size: 11px;
	font-weight: 600;
	color: var(--text-primary);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.custom-tooltip-badge {
	font-size: 9px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.3px;
	padding: 1px 5px;
	border-radius: 3px;
	background: color-mix(in srgb, var(--text-secondary) 15%, transparent);
	color: var(--text-secondary);
	white-space: nowrap;
	flex-shrink: 0;
}
.custom-tooltip-badge.badge-today,
.custom-tooltip-badge.badge-now {
	background: color-mix(in srgb, var(--text-primary) 15%, transparent);
	color: var(--text-primary);
}
.custom-tooltip-body {
	display: flex;
	flex-direction: column;
	gap: 3px;
	color: var(--text-secondary);
}
.custom-tooltip-list {
	display: flex;
	flex-direction: column;
	gap: 3px;
}
.custom-tooltip-row {
	display: flex;
	align-items: center;
	gap: 6px;
	font-size: 11px;
	color: var(--text-secondary);
}
.custom-tooltip-dot {
	width: 6px;
	height: 6px;
	border-radius: 50%;
	flex-shrink: 0;
}
.custom-tooltip-sub {
	font-size: 10px;
	color: var(--text-muted);
}
[data-custom-tooltip] {
	outline: none;
}
[data-custom-tooltip]:focus-visible {
	outline: 1px solid var(--vscode-focusBorder);
	outline-offset: 1px;
}

.panel-section-block {
	display: flex;
	flex-direction: column;
	gap: 4px;
}
.panel-section-toolbar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	padding: 0 2px;
	min-height: 22px;
}
.panel-section-toolbar-main {
	display: flex;
	align-items: center;
	gap: 6px;
	min-width: 0;
}
.panel-section-toolbar-label {
	font-size: 10px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.4px;
	color: var(--text-muted);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.panel-section-hidden-tag {
	font-size: 10px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.4px;
	color: var(--text-muted);
	flex-shrink: 0;
	opacity: 0.75;
}
.panel-section-block.is-hidden > :not(.panel-section-toolbar) {
	opacity: 0.4;
	pointer-events: none;
}
.panel-section-toolbar-actions {
	display: flex;
	align-items: center;
	gap: 2px;
	flex-shrink: 0;
}
.panel-section-btn {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 22px;
	height: 22px;
	padding: 0;
	border: none;
	border-radius: var(--radius-sm);
	background: transparent;
	color: var(--text-muted);
	cursor: pointer;
	transition: background 0.15s ease, color 0.15s ease;
}
.panel-section-btn:hover:not(:disabled) {
	background: var(--table-row-hover);
	color: var(--text-primary);
}
.panel-section-btn:focus-visible {
	outline: 1px solid var(--vscode-focusBorder);
	outline-offset: -1px;
}
.panel-section-btn:disabled {
	opacity: 0.35;
	cursor: default;
}

@container panel (max-width: 400px) {
	body {
		padding: clamp(4px, 2cqw, 8px) clamp(6px, 3cqw, 12px);
		gap: clamp(6px, 3cqw, 12px);
	}
	.quota-grid {
		gap: clamp(6px, 3cqw, 12px);
	}
	.quota-card {
		padding: clamp(8px, 3.5cqw, 14px);
	}
	.quota-bucket-row {
		padding: clamp(6px, 2.5cqw, 10px) clamp(8px, 3cqw, 12px) clamp(5px, 2cqw, 8px);
		min-height: clamp(38px, 12.5cqw, 50px);
	}
	.quota-value {
		font-size: clamp(13px, 5cqw, 20px);
	}
	.bucket-value {
		font-size: clamp(12px, 4.5cqw, 18px);
	}
	.quota-label, .heatmap-title, .public-health-title, .model-usage-title, .model-usage-name, .reset-calendar-title {
		font-size: clamp(9px, 3cqw, 12px);
	}
	.bucket-label, .bucket-reset-time, .reset-label, .reset-value {
		font-size: clamp(8px, 2.75cqw, 11px);
	}
	.heatmap-section, .public-health-section, .model-usage-section, .reset-calendar-section {
		padding: clamp(8px, 3.5cqw, 14px);
	}
	.heatmap-body {
		gap: clamp(8px, 4cqw, 18px);
	}
	.heatmap-label {
		font-size: 8px;
	}
	.heatmap-cell-num {
		font-size: clamp(8px, 2.6cqw, 10px);
	}
}
@container panel (max-width: 220px) {
	.heatmap-label {
		font-size: 7px;
		letter-spacing: 0;
	}
}
@container heatmap-cell (max-width: 16px) {
	.heatmap-cell-num {
		display: none;
	}
}
`;
}

function buildTopRow(statsData: UsageStatistics | null): string {
	const planDisplay = statsData?.planName ?? statsData?.plan ?? '';
	const credits = statsData?.credits;

	let planCard = '';
	if (planDisplay) {
		planCard = `
			<a class="quota-card clickable-card" href="https://antigravity.google/docs/plans">
				<div class="plan-value">${escapeHtml(planDisplay)}</div>
				<div class="card-action-overlay">
					<span>Plans info</span>
					<svg width="14" height="14" viewBox="0 0 16 16"><path fill="currentColor" d="M8.2 3.2l5.4 5.4-5.4 5.4-.7-.7 4.2-4.2H2v-1h9.7L7.5 3.9l.7-.7z"/></svg>
				</div>
			</a>`;
	}

	let creditsCard = '';
	if (credits) {
		const isLow = credits.creditAmount <= credits.minimumCreditAmountForUsage;
		const colorClass = isLow ? 'credits-low' : 'credits-ok';
		const showModelsAction = isAntigravityIde();
		const interactiveAttrs = showModelsAction ? ' class="quota-card clickable-card" role="button" tabindex="0" data-action="openModels"' : ' class="quota-card"';
		const modelsOverlay = showModelsAction
			? `
				<div class="card-action-overlay">
					<span>Models</span>
					<svg width="14" height="14" viewBox="0 0 16 16"><path fill="currentColor" d="M8.2 3.2l5.4 5.4-5.4 5.4-.7-.7 4.2-4.2H2v-1h9.7L7.5 3.9l.7-.7z"/></svg>
				</div>`
			: '';
		creditsCard = `
			<div${interactiveAttrs}>
				<div class="credits-info">
					<span class="credits-label">Extra Credits</span>
					<span class="credits-amount ${colorClass}">${credits.creditAmount.toLocaleString()}</span>
				</div>${modelsOverlay}
			</div>`;
	}

	if (!planCard && !creditsCard) { return ''; }
	return `<div class="top-row">${planCard}${creditsCard}</div>`;
}

function buildInitialLoadingScreen(): string {
	return `
		<div class="panel-loading-screen" role="status" aria-live="polite">
			<div class="panel-loading-spinner" aria-hidden="true"></div>
			<div>
				<div class="panel-loading-title">Connecting to Antigravity</div>
				<div class="panel-loading-subtitle">Finding the local usage API and loading quota data.</div>
			</div>
		</div>`;
}

function formatPanelErrorMessage(message: string): string {
	return message
		.replace(/^Connection failed:\s*/i, '')
		.replace(/\s*Click to retry\.?$/i, '')
		.trim();
}

function buildErrorIcon(size = 34): string {
	return `
		<svg class="panel-error-icon" width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true">
			<path fill="var(--error)" d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM7.25 4.75h1.5v4.5h-1.5v-4.5zm0 5.5h1.5V12h-1.5v-1.75z"/>
		</svg>`;
}

function buildErrorScreen(message: string): string {
	const detail = formatPanelErrorMessage(message) || message;
	return `
		<div class="panel-loading-screen panel-error-screen" role="alert">
			${buildErrorIcon()}
			<div class="panel-error-copy">
				<div class="panel-error-title">Connection failed</div>
				<div class="panel-error-message">${escapeHtml(detail)}</div>
			</div>
			<div class="panel-error-actions">
				<div class="panel-error-actions-row">
					<button type="button" class="panel-error-action" data-action="retry">Retry</button>
					<button type="button" class="panel-error-action" data-action="copy-error" data-copy-label="Copy error">Copy error</button>
				</div>
				<button type="button" class="panel-error-action" data-action="open-issues">GitHub Issues</button>
			</div>
		</div>`;
}

function buildErrorBanner(message: string): string {
	const detail = formatPanelErrorMessage(message) || message;
	return `
		<div class="panel-error-banner" role="alert">
			<div class="panel-error-banner-header">
				${buildErrorIcon(18)}
				<div class="panel-error-banner-text">
					<div class="panel-error-banner-title">Connection failed</div>
					<div class="panel-error-message">${escapeHtml(detail)}</div>
				</div>
			</div>
			<div class="panel-error-actions">
				<div class="panel-error-actions-row">
					<button type="button" class="panel-error-action" data-action="retry">Retry</button>
					<button type="button" class="panel-error-action" data-action="copy-error" data-copy-label="Copy error">Copy error</button>
				</div>
				<button type="button" class="panel-error-action" data-action="open-issues">GitHub Issues</button>
			</div>
		</div>`;
}

function buildFallbackErrorHtml(message: string): string {
	const nonce = crypto.randomBytes(16).toString('base64');
	const detail = escapeHtml(formatPanelErrorMessage(message) || message);
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--vscode-sideBar-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
.panel-error-fallback { width: min(420px, calc(100% - 32px)); padding: 28px 8px; text-align: center; }
h1 { margin: 0 0 10px; font-size: 15px; line-height: 1.3; color: #ef4444; }
p { margin: 0 0 16px; font-size: 13px; line-height: 1.5; word-break: break-word; overflow-wrap: anywhere; white-space: pre-wrap; user-select: text; }
.panel-error-actions { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; }
.panel-error-actions-row { display: flex; align-items: center; justify-content: center; gap: 8px; }
.panel-error-actions-row .panel-error-action { width: 104px; }
.panel-error-action { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; font: inherit; font-size: 12px; font-weight: 600; line-height: 1.4; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border, #333)); background: var(--vscode-editor-background); color: var(--vscode-foreground); cursor: pointer; text-decoration: none; user-select: none; }
.panel-error-action:hover { border-color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
	<div class="panel-error-fallback" role="alert">
		<h1>Couldn't display usage</h1>
		<p>${detail}</p>
		<div class="panel-error-actions">
			<div class="panel-error-actions-row">
				<button type="button" class="panel-error-action" id="retry">Retry</button>
				<button type="button" class="panel-error-action" id="copy-error">Copy error</button>
			</div>
			<button type="button" class="panel-error-action" id="open-issues">GitHub Issues</button>
		</div>
	</div>
<script nonce="${nonce}">
const vscodeApi = acquireVsCodeApi();
document.getElementById('retry').addEventListener('click', () => {
	vscodeApi.postMessage({ command: 'retry' });
});
document.getElementById('copy-error').addEventListener('click', () => {
	const errorText = document.querySelector('.panel-error-fallback p')?.textContent || '';
	vscodeApi.postMessage({ command: 'copyError', text: errorText });
});
document.getElementById('open-issues').addEventListener('click', () => {
	vscodeApi.postMessage({ command: 'openIssues' });
});
</script>
</body>
</html>`;
}

function buildNotFoundScreen(): string {
	return `
		<div class="panel-loading-screen" role="status" aria-live="polite">
			<svg class="panel-notfound-icon" width="34" height="34" viewBox="0 0 16 16" fill="var(--text-muted)" aria-hidden="true">
				<path d="M5.244 2.027L4.93 1H3.3l-.312 1.027-.825-.504-.814.814.504.825L.826 3.474v1.63l1.027.312-.504.825.814.814.825-.504.312 1.027h1.63l.312-1.027.825.504.814-.814-.504-.825 1.027-.312V3.474l-1.027-.312.504-.825-.814-.814-.825.504zM4.116 6.2a1.911 1.911 0 1 1 0-3.822 1.911 1.911 0 0 1 0 3.822z"/>
				<path d="M14.158 9.608l-.504-.825L14.68 8.47v-1.63l-1.026-.312.504-.825-.814-.814-.825.504L12.207 4.366h-1.63l-.312 1.027-.825-.504-.814.814.504.825-1.027.312v1.63l1.027.312-.504.825.814.814.825-.504.312 1.027h1.63l.312-1.027.825.504.814-.814zM11.392 9.22a1.911 1.911 0 1 1 0-3.822 1.911 1.911 0 0 1 0 3.822z"/>
				<path d="M6.076 13.863L5.764 14.89h-1.63l-.312-1.027-.825.504-.814-.814.504-.825-1.027-.312v-1.63l1.027-.312-.504-.825.814-.814.825.504.312-1.027h1.63l.312 1.027.825-.504.814.814-.504.825 1.027.312v1.63l-1.027.312.504.825-.814.814-.825-.504zM4.949 13.05a1.911 1.911 0 1 1 0-3.822 1.911 1.911 0 0 1 0 3.822z"/>
			</svg>
			<div>
				<div class="panel-loading-title">Extension Not Found</div>
				<div class="panel-loading-subtitle">The Antigravity extension is not started or initialized. Start it, then click the status bar item to retry.</div>
			</div>
		</div>`;
}

function getPublicHealthColor(status: 0 | 1 | 2): string {
	if (status === 2) { return '#fd5e53'; }
	if (status === 1) { return '#ffa133'; }
	return '#21bf73';
}

function getPublicHealthLabel(status: 0 | 1 | 2): string {
	if (status === 2) { return 'Likely outage'; }
	if (status === 1) { return 'Possible outage'; }
	return 'Service up';
}

function buildPublicHealthChart(publicServiceStatus: PublicServiceStatus | null, locale?: string): string {
	const points = publicServiceStatus?.healthPoints;
	if (!points?.length) { return ''; }

	const width = 320;
	const height = 126;
	const padLeft = 6;
	const padRight = 6;
	const padTop = 8;
	const padBottom = 10;
	const chartWidth = width - padLeft - padRight;
	const chartHeight = height - padTop - padBottom;
	const maxUpValue = Math.max(1, ...points.filter(point => point.status === 0).map(point => point.value));
	const rawMax = Math.max(1, ...points.map(point => point.value));
	const chartMax = Math.ceil(Math.max(maxUpValue * 4, rawMax * 1.1));
	const barGap = 1;
	const barWidth = Math.max(1, (chartWidth / points.length) - barGap);
	const ticks = [0, Math.round(chartMax / 2), chartMax];

	const gridHtml = ticks.map(tick => {
		const y = padTop + chartHeight - (tick / chartMax) * chartHeight;
		return `<line x1="${padLeft}" y1="${y.toFixed(1)}" x2="${width - padRight}" y2="${y.toFixed(1)}" stroke="var(--table-border)" stroke-width="0.8"/>`;
	}).join('');

	const barsHtml = points.map((point, index) => {
		const x = padLeft + index * (chartWidth / points.length);
		const barHeight = Math.max(1, (point.value / chartMax) * chartHeight);
		const y = padTop + chartHeight - barHeight;
		const label = `${formatFullTimestamp(point.timestamp, locale)}: ${getPublicHealthLabel(point.status)} (${point.value.toLocaleString()})`;
		return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" fill="${getPublicHealthColor(point.status)}"><title>${escapeHtml(label)}</title></rect>`;
	}).join('');

	return `
		<div class="public-health-section">
			<div class="public-health-header">
				<div class="public-health-title">Service health</div>
				<div class="public-health-time">24h</div>
			</div>
			<div class="public-health-chart">
				<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Google Antigravity service health over the last 24 hours">
					${gridHtml}
					${barsHtml}
				</svg>
				<a class="public-health-chart-overlay card-action-overlay" href="${escapeHtml(STATUSGATOR_SERVICE_URL)}">
					<span>Public status</span>
					<svg width="14" height="14" viewBox="0 0 16 16"><path fill="currentColor" d="M8.2 3.2l5.4 5.4-5.4 5.4-.7-.7 4.2-4.2H2v-1h9.7L7.5 3.9l.7-.7z"/></svg>
				</a>
			</div>
			<div class="public-health-legend">
				<span><i class="health-dot health-up"></i>Service up</span>
				<span><i class="health-dot health-warn"></i>Possible outage</span>
				<span><i class="health-dot health-down"></i>Likely outage</span>
			</div>
		</div>`;
}

interface ResetCalendarEvent {
	id?: string;
	label: string;
	category: string;
	resetTime: number;
	colorVar: string;
}

const RESET_CALENDAR_MIN_DAYS = 7;
const RESET_CALENDAR_MAX_DAYS = 8;
const RESET_CALENDAR_CLUSTER_PCT = 3;
const RESET_CALENDAR_CLUSTER_OFFSET_PX = 7;
const RESET_CALENDAR_WEEKLY_FALLBACK_MS = 18 * MS_PER_HOUR;

function getLocalDayStart(timestamp: number): number {
	const date = new Date(timestamp);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

function addLocalDays(dayStart: number, days: number): number {
	const date = new Date(dayStart);
	date.setDate(date.getDate() + days);
	return date.getTime();
}

function getResetCalendarDayCount(todayStart: number, events: ResetCalendarEvent[]): number {
	const lastReset = events.reduce((max, event) => Math.max(max, event.resetTime), todayStart);
	let neededDays = 1;
	let dayStart = todayStart;
	while (neededDays < RESET_CALENDAR_MAX_DAYS && lastReset >= addLocalDays(dayStart, 1)) {
		dayStart = addLocalDays(dayStart, 1);
		neededDays++;
	}
	return Math.max(RESET_CALENDAR_MIN_DAYS, neededDays);
}

function resetCalendarTimePosition(time: number, dayStarts: number[]): number {
	const dayCount = dayStarts.length - 1;
	if (time <= dayStarts[0]) {
		return 0;
	}
	for (let i = 0; i < dayCount; i++) {
		const start = dayStarts[i];
		const end = dayStarts[i + 1];
		if (time < end) {
			return ((i + (time - start) / (end - start)) / dayCount) * 100;
		}
	}
	return 100;
}

function getResetCalendarCategoryColor(category: string): string {
	if (category === CATEGORY_NAMES.GEMINI) { return 'var(--models-gemini)'; }
	if (category === CATEGORY_NAMES.OTHER) { return 'var(--models-other)'; }
	return 'var(--text-secondary)';
}

function formatShortWeekday(date: Date, locale?: string): string {
	return new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(date).replace('.', '');
}

function getMondayBasedWeekdayLabels(locale?: string): string[] {
	const monday = new Date(2024, 0, 1);
	return Array.from({ length: 7 }, (_, i) => {
		const date = new Date(monday);
		date.setDate(monday.getDate() + i);
		return formatShortWeekday(date, locale);
	});
}

function collectWeeklyResetEvents(statsData: UsageStatistics | null, now: number = Date.now()): ResetCalendarEvent[] {
	const groups = statsData?.groups ?? {};
	const events: ResetCalendarEvent[] = [];

	for (const category of CATEGORY_ORDER) {
		const group = groups[category];
		if (!group) {
			continue;
		}

		const weeklyBuckets = (group.buckets ?? []).filter(bucket => bucket.window.toLowerCase() === 'weekly');

		if (weeklyBuckets.length > 0) {
			for (const bucket of weeklyBuckets) {
				if (bucket.resetTime === null || !Number.isFinite(bucket.resetTime) || bucket.resetTime <= now) {
					continue;
				}
				const resetMs = bucket.resetTime - now;
				const bucketPct = formatQuotaPercent(bucket.quota);
				if (isNotStartedQuota(bucketPct, resetMs)) {
					continue;
				}
				const label = weeklyBuckets.length > 1
					? `${category} · ${bucket.displayName}`
					: category;
				events.push({
					label,
					category,
					resetTime: bucket.resetTime,
					colorVar: getResetCalendarCategoryColor(category),
				});
			}
			continue;
		}

		if (typeof group.resetTime !== 'number' || !Number.isFinite(group.resetTime) || group.resetTime <= now) {
			continue;
		}
		const resetMs = group.resetTime - now;
		if (resetMs <= RESET_CALENDAR_WEEKLY_FALLBACK_MS) {
			continue;
		}
		const pct = formatQuotaPercent(group.quota);
		if (isNotStartedQuota(pct, resetMs)) {
			continue;
		}
		events.push({
			label: category,
			category,
			resetTime: group.resetTime,
			colorVar: getResetCalendarCategoryColor(category),
		});
	}

	events.sort((a, b) => a.resetTime - b.resetTime);
	events.forEach((event, idx) => {
		event.id = `reset-evt-${idx}`;
	});
	return events;
}

interface CustomTooltipItem {
	label: string;
	color?: string;
}

interface CustomTooltipOptions {
	title?: string;
	badge?: string;
	badgeClass?: string;
	content?: string;
	items?: CustomTooltipItem[];
	color?: string;
}

function buildTooltipAttrs(options: CustomTooltipOptions): string {
	const attrs: string[] = ['data-custom-tooltip'];
	if (options.title) {
		attrs.push(`data-tooltip-title="${escapeHtml(options.title)}"`);
	}
	if (options.badge) {
		attrs.push(`data-tooltip-badge="${escapeHtml(options.badge)}"`);
	}
	if (options.badgeClass) {
		attrs.push(`data-tooltip-badge-class="${escapeHtml(options.badgeClass)}"`);
	}
	if (options.content) {
		attrs.push(`data-tooltip-content="${escapeHtml(options.content)}"`);
	}
	if (options.color) {
		attrs.push(`data-tooltip-color="${escapeHtml(options.color)}"`);
	}
	if (options.items && options.items.length > 0) {
		attrs.push(`data-tooltip-items="${escapeHtml(JSON.stringify(options.items))}"`);
	}
	return attrs.join(' ');
}

function buildCustomTooltipElement(): string {
	return '<div id="custom-tooltip" class="custom-tooltip" role="tooltip" aria-hidden="true"></div>';
}

function buildResetCalendarSection(statsData: UsageStatistics | null, locale?: string): string {
	const now = Date.now();
	const events = collectWeeklyResetEvents(statsData, now);
	if (events.length === 0) {
		return '';
	}

	const todayStart = getLocalDayStart(now);
	const dayCount = getResetCalendarDayCount(todayStart, events);
	const dayStarts = Array.from({ length: dayCount + 1 }, (_, i) => addLocalDays(todayStart, i));
	const nowPct = resetCalendarTimePosition(now, dayStarts);

	const whenFormat = new Intl.DateTimeFormat(locale, {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
	});

	const eventsByDay = dayStarts.slice(0, dayCount).map((dayStart, i) =>
		events.filter(event => event.resetTime >= dayStart && event.resetTime < dayStarts[i + 1])
	);

	const daysHtml = dayStarts.slice(0, dayCount).map((dayStart, i) => {
		const dayEvents = eventsByDay[i];
		const classes = ['reset-calendar-day'];
		if (i === 0) {
			classes.push('reset-calendar-day-today');
		}
		if (dayEvents.length > 0) {
			classes.push('reset-calendar-day-reset');
		}
		const date = new Date(dayStart);
		const name = formatShortWeekday(date, locale);
		return `
				<div class="${classes.join(' ')}">
					<span class="reset-calendar-day-name">${escapeHtml(name)}</span>
					<span class="reset-calendar-day-num">${date.getDate()}</span>
				</div>`;
	}).join('');

	const labelsHtml = eventsByDay.map(dayEvents => {
		const labels = dayEvents.map(event => {
			const timeStr = whenFormat.format(new Date(event.resetTime));
			const relStr = formatRelativeTime(event.resetTime - now);
			const tooltipAttrs = buildTooltipAttrs({
				title: event.label,
				badge: `in ${relStr}`,
				color: event.colorVar,
				content: `${timeStr} · Weekly reset`
			});
			const resetIdAttr = event.id ? ` data-reset-id="${escapeHtml(event.id)}"` : '';
			return `<span class="reset-calendar-label" style="color:${event.colorVar}"${resetIdAttr} ${tooltipAttrs} tabindex="0">${escapeHtml(event.label)}</span>`;
		}).join('');
		return `<div class="reset-calendar-label-cell">${labels}</div>`;
	}).join('');

	const separatorsHtml = Array.from({ length: dayCount - 1 }, (_, i) =>
		`<div class="reset-calendar-sep" style="left:${((i + 1) / dayCount) * 100}%"></div>`
	).join('');

	let clusterAnchor = -Infinity;
	let clusterIndex = 0;
	const dotsHtml = events.map(event => {
		const leftPct = resetCalendarTimePosition(event.resetTime, dayStarts);
		if (leftPct - clusterAnchor < RESET_CALENDAR_CLUSTER_PCT) {
			clusterIndex++;
		} else {
			clusterAnchor = leftPct;
			clusterIndex = 0;
		}
		const timeStr = whenFormat.format(new Date(event.resetTime));
		const relStr = formatRelativeTime(event.resetTime - now);
		const tooltipAttrs = buildTooltipAttrs({
			title: event.label,
			badge: `in ${relStr}`,
			color: event.colorVar,
			content: `${timeStr} · Weekly reset`
		});
		const resetIdAttr = event.id ? ` data-reset-id="${escapeHtml(event.id)}"` : '';
		const offset = clusterIndex * RESET_CALENDAR_CLUSTER_OFFSET_PX;
		return `<div class="reset-calendar-dot" style="left:${leftPct}%;--dot-offset:${offset}px;background:${event.colorVar}"${resetIdAttr} ${tooltipAttrs} tabindex="0"></div>`;
	}).join('');

	const nextText = formatRelativeTime(events[0].resetTime - now);
	const nowTooltipAttrs = buildTooltipAttrs({
		title: 'Current Time',
		badge: 'Now',
		badgeClass: 'badge-now',
		content: whenFormat.format(new Date(now))
	});

	return `
		<div class="reset-calendar-section">
			<div class="reset-calendar-header">
				<span class="reset-calendar-title">Reset timeline</span>
				<span class="reset-calendar-meta">Next in ${escapeHtml(nextText)}</span>
			</div>
			<div class="reset-calendar-timeline" style="--reset-calendar-days:${dayCount}">
				<div class="reset-calendar-days">
					${daysHtml}
				</div>
				<div class="reset-calendar-track">
					<div class="reset-calendar-bar">
						<div class="reset-calendar-bar-elapsed" style="width:${nowPct}%"></div>
					</div>
					${separatorsHtml}
					<div class="reset-calendar-now" style="left:${nowPct}%" ${nowTooltipAttrs} tabindex="0"></div>
					${dotsHtml}
				</div>
				<div class="reset-calendar-labels">
					${labelsHtml}
				</div>
			</div>
		</div>`;
}

function getHeatmapLevel(consumed: number, maxConsumed: number): number {
	if (consumed <= 0 || maxConsumed <= 0) { return 0; }
	const ratio = consumed / maxConsumed;
	if (ratio <= 0.25) { return 1; }
	if (ratio <= 0.5) { return 2; }
	if (ratio <= 0.75) { return 3; }
	return 4;
}

function buildHeatmapSection(dailyUsage: ReadonlyArray<DailyUsageEntry>, targetMonth: number, targetYear: number, locale?: string): string {
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const todayStr = formatLocalDate(today);

	const firstDay = new Date(targetYear, targetMonth, 1);
	const lastDay = new Date(targetYear, targetMonth + 1, 0);

	const firstDow = (firstDay.getDay() + 6) % 7;
	const startDate = new Date(firstDay);
	startDate.setDate(firstDay.getDate() - firstDow);

	const lastDow = (lastDay.getDay() + 6) % 7;
	const endDate = new Date(lastDay);
	endDate.setDate(lastDay.getDate() + (6 - lastDow));

	const totalDays = Math.round((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000)) + 1;
	const weeks = Math.ceil(totalDays / 7);

	const usageMap = new Map<string, number>();
	let maxConsumed = 0;
	for (const entry of dailyUsage) {
		const combined = (usageMap.get(entry.date) || 0) + entry.consumed;
		usageMap.set(entry.date, combined);
		maxConsumed = Math.max(maxConsumed, combined);
	}

	const dateFormat = new Intl.DateTimeFormat(locale, { weekday: 'long', month: 'short', day: 'numeric' });
	const dayLabels = getMondayBasedWeekdayLabels(locale);
	const labelsHtml = dayLabels.map(l =>
		`<div class="heatmap-label">${escapeHtml(l)}</div>`
	).join('');

	let weeksHtml = '';
	for (let w = 0; w < weeks; w++) {
		let cellsHtml = '';
		for (let d = 0; d < 7; d++) {
			const cellDate = new Date(startDate);
			cellDate.setDate(startDate.getDate() + w * 7 + d);
			const dateStr = formatLocalDate(cellDate);
			const consumed = usageMap.get(dateStr) || 0;
			const isFuture = dateStr > todayStr;
			const isToday = dateStr === todayStr;
			const isCurrentMonth = cellDate.getMonth() === targetMonth && cellDate.getFullYear() === targetYear;
			const level = isFuture ? 0 : getHeatmapLevel(consumed, maxConsumed);

			const classes = ['heatmap-cell'];
			if (isFuture) {
				classes.push('future');
			} else {
				classes.push(`level-${level}`);
			}
			if (isToday) { classes.push('today'); }
			if (!isCurrentMonth) { classes.push('other-month'); }

			let tooltipAttrs = '';
			if (!isFuture) {
				const tooltipDate = dateFormat.format(cellDate);
				tooltipAttrs = ` ${buildTooltipAttrs({
					title: tooltipDate,
					badge: isToday ? 'Today' : undefined,
					badgeClass: isToday ? 'badge-today' : undefined,
					content: consumed > 0 ? `${Math.round(consumed * 100)}% consumed` : 'No activity',
					color: consumed > 0 ? 'var(--success)' : undefined
				})} tabindex="0"`;
			}

			cellsHtml += `<div class="${classes.join(' ')}"${tooltipAttrs}><span class="heatmap-cell-num">${cellDate.getDate()}</span></div>`;
		}
		weeksHtml += `<div class="heatmap-week">${cellsHtml}</div>`;
	}

	const monthTitle = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(firstDay);

	return `
		<div class="heatmap-section">
			<div class="heatmap-header">
				<span class="heatmap-title">Usage Activity</span>
				<div class="heatmap-nav">
					<button class="nav-btn" data-action="prevMonth">
						<svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M11 1.5L4.5 8l6.5 6.5l.707-.707L5.914 8l5.793-5.793L11 1.5z"/></svg>
					</button>
					<span class="heatmap-month-title">${escapeHtml(monthTitle)}</span>
					<button class="nav-btn" data-action="nextMonth">
						<svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M5 1.5L11.5 8L5 14.5l-.707-.707L10.086 8L4.293 2.207L5 1.5z"/></svg>
					</button>
				</div>
			</div>
			<div class="heatmap-body">
				<div class="heatmap-grid">
					<div class="heatmap-labels">${labelsHtml}</div>
					<div class="heatmap-weeks">${weeksHtml}</div>
				</div>
				<div class="heatmap-legend">
					<span>More</span>
					<div class="heatmap-cell level-4" ${buildTooltipAttrs({ title: 'Activity Level 4', content: 'Highest activity (> 75%)', color: 'var(--success)' })} tabindex="0"></div>
					<div class="heatmap-cell level-3" ${buildTooltipAttrs({ title: 'Activity Level 3', content: 'High activity (51% – 75%)', color: 'var(--success)' })} tabindex="0"></div>
					<div class="heatmap-cell level-2" ${buildTooltipAttrs({ title: 'Activity Level 2', content: 'Moderate activity (26% – 50%)', color: 'var(--success)' })} tabindex="0"></div>
					<div class="heatmap-cell level-1" ${buildTooltipAttrs({ title: 'Activity Level 1', content: 'Low activity (1% – 25%)', color: 'var(--success)' })} tabindex="0"></div>
					<div class="heatmap-cell level-0" ${buildTooltipAttrs({ title: 'Activity Level 0', content: 'No activity' })} tabindex="0"></div>
					<span>Less</span>
				</div>
			</div>
		</div>`;
}

function getModelUsageBarFillClass(entry: ModelUsageEntry): string {
	const model = entry.model.toLowerCase();
	if (model.includes(MODEL_KEYWORDS.gemini) || model.includes(MODEL_KEYWORDS.flash)) {
		return 'model-usage-bar-fill--gemini';
	}
	return 'model-usage-bar-fill--other';
}

function buildModelUsageRowHtml(entry: ModelUsageEntry, totalGenerations: number): string {
	const share = totalGenerations > 0 ? Math.round((entry.count / totalGenerations) * 100) : 0;
	const fillClass = getModelUsageBarFillClass(entry);
	return `
		<div class="model-usage-row" title="${escapeHtml(`${entry.label}: ${entry.count} generations`)}">
			<div class="model-usage-row-top">
				<div class="model-usage-info">
					<span class="model-usage-name">${escapeHtml(entry.model)}</span>
					${entry.thinkingLevel ? `<span class="model-usage-level">${escapeHtml(entry.thinkingLevel)}</span>` : ''}
				</div>
				<span class="model-usage-count">${entry.count.toLocaleString()}<span class="model-usage-share">${share}%</span></span>
			</div>
			<div class="model-usage-bar"><div class="model-usage-bar-fill ${fillClass}" style="width:${share}%"></div></div>
		</div>`;
}

function buildModelUsageSection(modelUsage: ModelUsageSummary | null): string {
	const entries = modelUsage?.entries ?? [];
	if (entries.length === 0) { return ''; }

	const totalGenerations = modelUsage?.totalGenerations ?? 0;
	const visibleEntries = entries.slice(0, MODEL_USAGE_COLLAPSED_ROWS);
	const extraEntries = entries.slice(MODEL_USAGE_COLLAPSED_ROWS);

	const visibleRowsHtml = visibleEntries
		.map(entry => buildModelUsageRowHtml(entry, totalGenerations))
		.join('');

	let extraRowsHtml = '';
	if (extraEntries.length > 0) {
		extraRowsHtml = `
			<details class="model-usage-more">
				<summary class="model-usage-toggle">
					<span class="model-usage-show-more">Show all ${entries.length} models</span>
					<span class="model-usage-show-less">Show less</span>
					<svg class="model-usage-toggle-more-icon" width="14" height="14" viewBox="0 0 16 16"><path fill="currentColor" d="M8 11.5L2.5 6l.7-.7L8 10.1l4.8-4.8.7.7L8 11.5z"/></svg>
					<svg class="model-usage-toggle-less-icon" width="14" height="14" viewBox="0 0 16 16"><path fill="currentColor" d="M8 4.5l5.5 5.5-.7.7L8 5.9l-4.8 4.8-.7-.7L8 4.5z"/></svg>
				</summary>
				<div class="model-usage-extra-rows">
					${extraEntries.map(entry => buildModelUsageRowHtml(entry, totalGenerations)).join('')}
				</div>
			</details>`;
	}

	const conversationCount = modelUsage?.conversationCount ?? 0;
	const metaText = totalGenerations > 0
		? (conversationCount > 0
			? `${totalGenerations.toLocaleString()} ${totalGenerations === 1 ? 'generation' : 'generations'} · ${conversationCount.toLocaleString()} ${conversationCount === 1 ? 'chat' : 'chats'}`
			: `${totalGenerations.toLocaleString()} ${totalGenerations === 1 ? 'generation' : 'generations'}`)
		: '';

	return `
		<div class="model-usage-section">
			<div class="model-usage-header">
				<span class="model-usage-title">Most Used Models</span>
				${metaText ? `<div class="model-usage-meta"><span>${escapeHtml(metaText)}</span></div>` : ''}
			</div>
			${visibleRowsHtml}
			${extraRowsHtml}
		</div>`;
}

interface PanelBuildContext {
	statsData: UsageStatistics | null;
	history: QuotaHistory;
	heatmapMonth: number;
	heatmapYear: number;
	locale?: string;
	publicServiceStatus: PublicServiceStatus | null;
	modelUsage: ModelUsageSummary | null;
}

function getPanelSectionsUpdateTarget(): vscode.ConfigurationTarget {
	const inspect = vscode.workspace.getConfiguration(CONFIG_NAMESPACE).inspect<string[]>('panelSections');
	if (inspect?.workspaceFolderValue !== undefined || inspect?.workspaceFolderLanguageValue !== undefined) {
		return vscode.ConfigurationTarget.WorkspaceFolder;
	}
	if (inspect?.workspaceValue !== undefined || inspect?.workspaceLanguageValue !== undefined) {
		return vscode.ConfigurationTarget.Workspace;
	}
	return vscode.ConfigurationTarget.Global;
}

function buildPanelSectionContent(id: PanelSectionId, ctx: PanelBuildContext): string {
	switch (id) {
		case 'plan':
			return buildTopRow(ctx.statsData);
		case 'health':
			return buildPublicHealthChart(ctx.publicServiceStatus, ctx.locale);
		case 'quotas': {
			const cards = buildQuotaCards(ctx.statsData, ctx.history, ctx.locale);
			if (!cards) { return ''; }
			return `<div class="section"><div class="quota-grid">${cards}</div></div>`;
		}
		case 'resets':
			return buildResetCalendarSection(ctx.statsData, ctx.locale);
		case 'models':
			return buildModelUsageSection(ctx.modelUsage);
		case 'activity':
			return buildHeatmapSection(ctx.history.getDailyUsage(), ctx.heatmapMonth, ctx.heatmapYear, ctx.locale);
		default:
			return '';
	}
}

function panelSectionHasContent(id: PanelSectionId, ctx: PanelBuildContext): boolean {
	return buildPanelSectionContent(id, ctx).length > 0;
}

function buildPanelSectionToolbar(id: PanelSectionId, isFirst: boolean, isLast: boolean, hidden: boolean): string {
	const sectionId = escapeHtml(id);
	const label = escapeHtml(PANEL_SECTION_LABELS[id]);
	const upDisabled = isFirst ? ' disabled' : '';
	const downDisabled = isLast ? ' disabled' : '';
	const hiddenTag = hidden ? '<span class="panel-section-hidden-tag">Hidden</span>' : '';
	const visibilityButton = hidden
		? `<button type="button" class="panel-section-btn" data-action="showSection" data-section-id="${sectionId}" title="Show" aria-label="Show ${label}">
					<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M8 3.2C4.6 3.2 1.8 5.6 1 8c.8 2.4 3.6 4.8 7 4.8s6.2-2.4 7-4.8c-.8-2.4-3.6-4.8-7-4.8zm0 7.6a2.8 2.8 0 1 1 0-5.6 2.8 2.8 0 0 1 0 5.6zM8 6.4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2z"/></svg>
				</button>`
		: `<button type="button" class="panel-section-btn" data-action="hideSection" data-section-id="${sectionId}" title="Hide" aria-label="Hide ${label}">
					<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06z"/></svg>
				</button>`;
	return `
		<div class="panel-section-toolbar">
			<div class="panel-section-toolbar-main">
				<span class="panel-section-toolbar-label">${label}</span>
				${hiddenTag}
			</div>
			<div class="panel-section-toolbar-actions">
				<button type="button" class="panel-section-btn" data-action="moveSectionUp" data-section-id="${sectionId}" title="Move up"${upDisabled} aria-label="Move ${label} up">
					<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 4.5l5.5 5.5-.7.7L8 5.9l-4.8 4.8-.7-.7L8 4.5z"/></svg>
				</button>
				<button type="button" class="panel-section-btn" data-action="moveSectionDown" data-section-id="${sectionId}" title="Move down"${downDisabled} aria-label="Move ${label} down">
					<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 11.5L2.5 6l.7-.7L8 10.1l4.8-4.8.7.7L8 11.5z"/></svg>
				</button>
				${visibilityButton}
			</div>
		</div>`;
}

function buildOrderedPanelBody(ctx: PanelBuildContext, layout: PanelSectionSlot[], layoutEditing: boolean): string {
	const rendered = layout.filter(slot => {
		if (slot.hidden && !layoutEditing) { return false; }
		if (panelSectionHasContent(slot.id, ctx)) { return true; }
		return layoutEditing && slot.hidden;
	});
	return rendered.map((slot, index) => {
		const html = buildPanelSectionContent(slot.id, ctx);
		const toolbar = layoutEditing
			? buildPanelSectionToolbar(slot.id, index === 0, index === rendered.length - 1, slot.hidden)
			: '';
		const hiddenClass = slot.hidden ? ' is-hidden' : '';
		return `<div class="panel-section-block${hiddenClass}" data-section-id="${escapeHtml(slot.id)}">${toolbar}${html}</div>`;
	}).join('');
}

function buildPanelHtml(statsData: UsageStatistics | null, history: QuotaHistory, heatmapMonth: number, heatmapYear: number, locale?: string, serviceStatus: ServiceStatus = 'disconnected', refreshInterval: number = 60, publicServiceStatus: PublicServiceStatus | null = null, modelUsage: ModelUsageSummary | null = null, panelSections: PanelSectionSlot[] = PANEL_SECTION_IDS.map(id => ({ id, hidden: false })), layoutEditing: boolean = false, errorMessage: string | null = null): string {
	const nonce = crypto.randomBytes(16).toString('base64');
	const showInitialLoading = serviceStatus === 'loading' && !statsData;
	const showNotFound = serviceStatus === 'not-found' && !statsData;
	const showError = Boolean(errorMessage) && !statsData && !showInitialLoading && !showNotFound;
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
		const panelCtx: PanelBuildContext = {
			statsData,
			history,
			heatmapMonth,
			heatmapYear,
			locale,
			publicServiceStatus,
			modelUsage
		};
		const errorBanner = errorMessage ? buildErrorBanner(errorMessage) : '';
		bodyContent = `
${errorBanner}
${buildOrderedPanelBody(panelCtx, panelSections, layoutEditing)}
	<div class="panel-footer">
		<span id="lastUpdated">Updated just now</span>
		<span class="refresh-interval-info">• ${refreshInterval > 0 ? `Auto: ${Math.max(10, refreshInterval)}s` : 'Auto: Off'}</span>
	</div>`;
	}

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
${getPanelStyles()}
</style>
</head>
<body${bodyClass}>
	${bodyContent}
	${buildCustomTooltipElement()}
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const updatedAt = ${Date.now()};
const uiState = vscode.getState() || {};
function saveUiState() {
	vscode.setState(uiState);
}
function updateFooter() {
	const diff = Date.now() - updatedAt;
	const sec = Math.floor(diff / 1000);
	const el = document.getElementById('lastUpdated');
	if (!el) return;
	if (sec < 5) el.textContent = 'Updated just now';
	else if (sec < 60) el.textContent = 'Updated ' + sec + 's ago';
	else {
		const min = Math.floor(sec / 60);
		el.textContent = 'Updated ' + min + 'm ago';
	}
}
function scheduleFooter() {
	const age = Date.now() - updatedAt;
	const interval = age < 60000 ? 5000 : 15000;
	setTimeout(() => { updateFooter(); scheduleFooter(); }, interval);
}
scheduleFooter();

window.addEventListener('contextmenu', (event) => event.preventDefault());

(function initCustomTooltip() {
	const tooltip = document.getElementById('custom-tooltip');
	if (!tooltip) return;

	let currentTarget = null;
	let hoverTimer = null;
	let warmTimer = null;
	let isWarm = false;

	function showTooltip(target) {
		currentTarget = target;
		tooltip.innerHTML = '';

		const title = target.getAttribute('data-tooltip-title') || '';
		const badge = target.getAttribute('data-tooltip-badge') || '';
		const badgeClass = target.getAttribute('data-tooltip-badge-class') || '';
		const content = target.getAttribute('data-tooltip-content') || '';
		const color = target.getAttribute('data-tooltip-color') || '';
		const itemsRaw = target.getAttribute('data-tooltip-items') || '';

		if (!title && !content && !itemsRaw) {
			hideTooltip();
			return;
		}

		if (title || badge) {
			const header = document.createElement('div');
			header.className = 'custom-tooltip-header';

			const titleWrap = document.createElement('div');
			titleWrap.className = 'custom-tooltip-title-wrap';

			if (color && !itemsRaw) {
				const dot = document.createElement('span');
				dot.className = 'custom-tooltip-dot';
				dot.style.backgroundColor = color;
				titleWrap.appendChild(dot);
			}

			if (title) {
				const titleEl = document.createElement('span');
				titleEl.className = 'custom-tooltip-title';
				titleEl.textContent = title;
				titleWrap.appendChild(titleEl);
			}
			header.appendChild(titleWrap);

			if (badge) {
				const badgeEl = document.createElement('span');
				badgeEl.className = 'custom-tooltip-badge' + (badgeClass ? ' ' + badgeClass : '');
				badgeEl.textContent = badge;
				header.appendChild(badgeEl);
			}

			tooltip.appendChild(header);
		}

		const body = document.createElement('div');
		body.className = 'custom-tooltip-body';

		if (itemsRaw) {
			let parsed = false;
			try {
				const items = JSON.parse(itemsRaw);
				if (Array.isArray(items) && items.length > 0) {
					parsed = true;
					const list = document.createElement('div');
					list.className = 'custom-tooltip-list';
					for (const item of items) {
						const row = document.createElement('div');
						row.className = 'custom-tooltip-row';
						if (item.color) {
							const dot = document.createElement('span');
							dot.className = 'custom-tooltip-dot';
							dot.style.backgroundColor = item.color;
							row.appendChild(dot);
						}
						const text = document.createElement('span');
						text.textContent = item.label || '';
						row.appendChild(text);
						list.appendChild(row);
					}
					body.appendChild(list);
				}
			} catch (parseError) {
				body.textContent = itemsRaw;
			}
			if (!parsed && !body.textContent && content) {
				body.textContent = content;
			}
		} else if (content) {
			const contentEl = document.createElement('span');
			contentEl.textContent = content;
			body.appendChild(contentEl);
		}

		if (body.children.length > 0 || body.textContent) {
			tooltip.appendChild(body);
		}

		positionTooltip(target);
		tooltip.classList.add('visible');
		tooltip.setAttribute('aria-hidden', 'false');
		target.setAttribute('aria-describedby', 'custom-tooltip');
	}

	function positionTooltip(target) {
		const targetRect = target.getBoundingClientRect();
		const tipRect = tooltip.getBoundingClientRect();
		const margin = 8;

		let left = targetRect.left + (targetRect.width / 2) - (tipRect.width / 2);
		if (left < margin) {
			left = margin;
		} else if (left + tipRect.width > window.innerWidth - margin) {
			left = window.innerWidth - margin - tipRect.width;
		}
		if (left < margin) {
			left = margin;
		}

		let top = targetRect.top - tipRect.height - 6;
		let placement = 'top';
		if (top < margin) {
			top = targetRect.bottom + 6;
			placement = 'bottom';
			if (top + tipRect.height > window.innerHeight - margin) {
				top = window.innerHeight - margin - tipRect.height;
			}
		}

		tooltip.style.left = Math.round(left) + 'px';
		tooltip.style.top = Math.round(top) + 'px';
		tooltip.setAttribute('data-placement', placement);
	}

	function hideTooltip() {
		if (hoverTimer) {
			clearTimeout(hoverTimer);
			hoverTimer = null;
		}
		if (!currentTarget) return;
		currentTarget.removeAttribute('aria-describedby');
		currentTarget = null;
		tooltip.classList.remove('visible');
		tooltip.setAttribute('aria-hidden', 'true');
	}

	function scheduleShow(target, immediate) {
		if (hoverTimer) {
			clearTimeout(hoverTimer);
			hoverTimer = null;
		}
		if (warmTimer) {
			clearTimeout(warmTimer);
			warmTimer = null;
		}

		if (immediate || isWarm) {
			showTooltip(target);
			isWarm = true;
		} else {
			hoverTimer = setTimeout(() => {
				hoverTimer = null;
				showTooltip(target);
				isWarm = true;
			}, 100);
		}
	}

	function scheduleHide() {
		if (hoverTimer) {
			clearTimeout(hoverTimer);
			hoverTimer = null;
		}
		hideTooltip();
		if (warmTimer) {
			clearTimeout(warmTimer);
		}
		warmTimer = setTimeout(() => {
			warmTimer = null;
			isWarm = false;
		}, 250);
	}

	document.addEventListener('pointerover', (e) => {
		const target = e.target.closest('[data-custom-tooltip]');
		if (target) {
			scheduleShow(target, false);
		}
	});

	document.addEventListener('pointerout', (e) => {
		if (currentTarget && !currentTarget.contains(e.relatedTarget)) {
			const next = e.relatedTarget && e.relatedTarget.closest ? e.relatedTarget.closest('[data-custom-tooltip]') : null;
			if (!next) {
				scheduleHide();
			}
		}
	});

	document.addEventListener('focusin', (e) => {
		const target = e.target.closest('[data-custom-tooltip]');
		if (target) {
			scheduleShow(target, true);
		}
	});

	document.addEventListener('focusout', (e) => {
		if (currentTarget) {
			scheduleHide();
		}
	});

	document.addEventListener('scroll', hideTooltip, true);
	window.addEventListener('resize', hideTooltip);
	window.addEventListener('blur', hideTooltip);
	document.addEventListener('mouseleave', hideTooltip);
})();

(function initResetSyncHover() {
	let currentScaledId = null;

	function setResetScale(id) {
		if (currentScaledId === id) return;
		if (currentScaledId) {
			document.querySelectorAll('[data-reset-id="' + currentScaledId + '"]').forEach(el => el.classList.remove('scaled'));
			currentScaledId = null;
		}
		if (id) {
			currentScaledId = id;
			document.querySelectorAll('[data-reset-id="' + id + '"]').forEach(el => el.classList.add('scaled'));
		}
	}

	document.addEventListener('pointerover', (e) => {
		const el = e.target.closest('[data-reset-id]');
		setResetScale(el ? el.getAttribute('data-reset-id') : null);
	});

	document.addEventListener('pointerout', (e) => {
		if (currentScaledId) {
			const next = e.relatedTarget && e.relatedTarget.closest ? e.relatedTarget.closest('[data-reset-id]') : null;
			if (!next || next.getAttribute('data-reset-id') !== currentScaledId) {
				setResetScale(null);
			}
		}
	});

	document.addEventListener('focusin', (e) => {
		const el = e.target.closest('[data-reset-id]');
		if (el) setResetScale(el.getAttribute('data-reset-id'));
	});

	document.addEventListener('focusout', (e) => {
		if (currentScaledId) setResetScale(null);
	});
})();

function openAntigravitySettings() {
	vscode.postMessage({ command: 'openAntigravitySettings' });
}

function prevMonth() {
	vscode.postMessage({ command: 'prevMonth' });
}

function nextMonth() {
	vscode.postMessage({ command: 'nextMonth' });
}

function postSectionLayout(action, sectionId, direction) {
	vscode.postMessage({ command: action, sectionId, direction });
}

document.querySelectorAll('[data-action="moveSectionUp"]').forEach(el => {
	el.addEventListener('click', () => postSectionLayout('moveSection', el.getAttribute('data-section-id'), 'up'));
});
document.querySelectorAll('[data-action="moveSectionDown"]').forEach(el => {
	el.addEventListener('click', () => postSectionLayout('moveSection', el.getAttribute('data-section-id'), 'down'));
});
document.querySelectorAll('[data-action="hideSection"]').forEach(el => {
	el.addEventListener('click', () => postSectionLayout('hideSection', el.getAttribute('data-section-id')));
});
document.querySelectorAll('[data-action="showSection"]').forEach(el => {
	el.addEventListener('click', () => postSectionLayout('showSection', el.getAttribute('data-section-id')));
});

function clearCatHistory(event, el) {
	event.preventDefault();
	event.stopPropagation();
	vscode.postMessage({
		command: 'clearHistory',
		category: el.getAttribute('data-category')
	});
}

document.querySelectorAll('[data-action="retry"]').forEach(el => {
	el.addEventListener('click', () => {
		vscode.postMessage({ command: 'retry' });
	});
});

document.querySelectorAll('[data-action="copy-error"]').forEach(el => {
	el.addEventListener('click', () => {
		const errorText = el.closest('.panel-error-screen, .panel-error-banner')?.querySelector('.panel-error-message')?.textContent || '';
		vscode.postMessage({ command: 'copyError', text: errorText });
	});
});

document.querySelectorAll('[data-action="open-issues"]').forEach(el => {
	el.addEventListener('click', () => vscode.postMessage({ command: 'openIssues' }));
});

window.addEventListener('message', (event) => {
	if (event.data?.command !== 'copyErrorResult') return;
	document.querySelectorAll('[data-action="copy-error"]').forEach(el => {
		const originalLabel = el.getAttribute('data-copy-label') || 'Copy error';
		el.textContent = event.data.success ? 'Copied' : 'Copy failed';
		window.setTimeout(() => { el.textContent = originalLabel; }, 1800);
	});
});

document.querySelectorAll('[data-action="openModels"]').forEach(el => {
	el.addEventListener('click', openAntigravitySettings);
	el.addEventListener('keydown', (event) => {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			openAntigravitySettings();
		}
	});
});

document.querySelectorAll('[data-action="prevMonth"]').forEach(el => {
	el.addEventListener('click', prevMonth);
});

document.querySelectorAll('[data-action="nextMonth"]').forEach(el => {
	el.addEventListener('click', nextMonth);
});

document.querySelectorAll('.model-usage-more').forEach(details => {
	details.addEventListener('toggle', () => {
		uiState.modelUsageExpanded = details.open;
		saveUiState();
	});
});

document.querySelectorAll('.history-clear-row').forEach(row => {
	row.addEventListener('click', (event) => clearCatHistory(event, row));
	row.addEventListener('keydown', (event) => {
		if (event.key === 'Enter' || event.key === ' ') {
			clearCatHistory(event, row);
		}
	});
});

function closeDetails(d, syncCollapse = false) {
	const hl = d.querySelector('.history-list');
	const inner = d.querySelector('.history-list-inner');
	if (inner) inner.classList.remove('scrollable');
	if (syncCollapse || !hl) {
		if (hl) hl.classList.remove('expanded');
		d.open = false;
		return;
	}
	hl.classList.remove('expanded');
	let done = false;
	const finish = () => {
		if (done) return;
		done = true;
		hl.removeEventListener('transitionend', onEnd);
		d.open = false;
	};
	const onEnd = (e) => { if (e.target === hl) finish(); };
	hl.addEventListener('transitionend', onEnd);
	setTimeout(finish, 200);
}

document.querySelectorAll('.quota-grid .quota-card').forEach(card => {
	card.addEventListener('click', (e) => {
		if (e.target.closest('.info-button-container')) return;
		if (!card.classList.contains('minimized')) return;
		e.stopPropagation();
		document.querySelectorAll('.card-history-details[open]').forEach(d => closeDetails(d, true));
		document.querySelectorAll('.quota-grid .quota-card').forEach(c => c.classList.remove('minimized'));
		uiState.openDetails = null;
		saveUiState();
	});
});

document.querySelectorAll('.card-history-summary').forEach(summary => {
	summary.addEventListener('click', (e) => {
		e.preventDefault();
		const details = summary.closest('.card-history-details');
		if (!details) return;
		const thisCard = details.closest('.quota-card');
		const allCards = document.querySelectorAll('.quota-grid .quota-card');
		const willOpen = !details.open;
		if (willOpen) {
			allCards.forEach(card => {
				if (card !== thisCard) {
					card.classList.add('minimized');
					const otherDetails = card.querySelector('.card-history-details');
					if (otherDetails && otherDetails.open) {
						closeDetails(otherDetails, true);
					}
				}
			});
			details.open = true;
			requestAnimationFrame(() => { requestAnimationFrame(() => {
				const hl = details.querySelector('.history-list');
				if (hl) {
					hl.classList.add('expanded');
					let added = false;
					const addScroll = () => {
						if (added) return;
						added = true;
						hl.removeEventListener('transitionend', onEnd);
						const inner = hl.querySelector('.history-list-inner');
						if (inner) inner.classList.add('scrollable');
					};
					const onEnd = (e) => { if (e.target === hl) addScroll(); };
					hl.addEventListener('transitionend', onEnd);
					setTimeout(addScroll, 200);
				}
			}); });
		} else {
			closeDetails(details);
			allCards.forEach(card => {
				card.classList.remove('minimized');
			});
		}
		uiState.openDetails = willOpen ? (details.dataset.category || null) : null;
		saveUiState();
	});
});

let scrollSaveTimer = null;
document.addEventListener('scroll', () => {
	if (scrollSaveTimer) return;
	scrollSaveTimer = setTimeout(() => {
		scrollSaveTimer = null;
		uiState.scrollY = document.body.scrollTop;
		saveUiState();
	}, 150);
}, true);

(function restoreUiState() {
	if (uiState.modelUsageExpanded) {
		document.querySelectorAll('.model-usage-more').forEach(d => {
			d.open = true;
		});
	}
	if (uiState.openDetails) {
		document.querySelectorAll('.card-history-details').forEach(d => {
			if (d.dataset.category === uiState.openDetails && !d.open) {
				d.open = true;
				const hl = d.querySelector('.history-list');
				if (hl) hl.classList.add('expanded');
				const inner = d.querySelector('.history-list-inner');
				if (inner) inner.classList.add('scrollable');
				const thisCard = d.closest('.quota-card');
				document.querySelectorAll('.quota-grid .quota-card').forEach(card => {
					if (card !== thisCard) card.classList.add('minimized');
				});
			}
		});
	}
	if (typeof uiState.scrollY === 'number') {
		document.body.scrollTop = uiState.scrollY;
	}
})();
</script>
</body>
</html>`;
}
