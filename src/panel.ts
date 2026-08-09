import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { BUCKET_OPACITY, CATEGORY_ORDER, CONFIG_NAMESPACE, PROGRESS_STOPS, STATUSGATOR_SERVICE_URL, THEME_COLORS } from './constants';
import { formatFullTimestamp, formatLocalDate, formatQuotaPercent, formatRelativeTime, formatRemainingTimeSeparate, resolveLocale } from './formatter';
import { QuotaHistory, QuotaHistoryEntry } from './history';
import { DailyUsageEntry, PublicServiceStatus, QuotaGroup, ServiceStatus, UsageStatistics } from './types';
import { escapeHtml, getProgressStopIndex, isNotStartedQuota, isWeeklyLimitReached, sortQuotaBuckets } from './utils';

export class UsageViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'ag-usage.sidebarPanel';
	private view?: vscode.WebviewView;
	private lastStatsData: UsageStatistics | null = null;
	private quotaHistory: QuotaHistory | null = null;
	private lastServiceStatus: ServiceStatus = 'disconnected';
	private publicServiceStatus: PublicServiceStatus | null = null;
	private heatmapMonth: number = new Date().getMonth();
	private heatmapYear: number = new Date().getFullYear();
	private notifiedVisible = false;
	private disposables: vscode.Disposable[] = [];
	public onHistoryChanged?: (history: QuotaHistory) => void;
	public onDidBecomeVisible?: () => void;

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

	public update(statsData: UsageStatistics | null, history: QuotaHistory, serviceStatus: ServiceStatus = 'disconnected', publicServiceStatus: PublicServiceStatus | null = null) {
		this.lastStatsData = statsData;
		this.quotaHistory = history;
		this.lastServiceStatus = serviceStatus;
		this.publicServiceStatus = publicServiceStatus;
		if (this.view) {
			this.updateView();
		}
	}

	public updateView() {
		if (!this.view || !this.quotaHistory) { return; }
		const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
		const locale = resolveLocale(config.get<string>('dateFormatLocale', 'default'));
		const refreshInterval = config.get<number>('refreshInterval', 60);
		this.view.webview.html = buildPanelHtml(this.lastStatsData, this.quotaHistory, this.heatmapMonth, this.heatmapYear, locale, this.lastServiceStatus, refreshInterval, this.publicServiceStatus);
	}

	dispose() {
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

	const modelsList = group.models?.filter(Boolean) ?? [];
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
	--metric-row-bg: color-mix(in srgb, #000 ${BUCKET_OPACITY.defaultBg * 100}%, var(--card-bg));
	--metric-row-border: color-mix(in srgb, var(--card-border) ${BUCKET_OPACITY.defaultBorder * 100}%, transparent);
${buildProgressVars(THEME_COLORS.dark.progress)}
	--radius-sm: 6px;
	--radius-lg: 10px;
}

body.vscode-light {
${buildProgressVars(THEME_COLORS.light.progress)}
}

html { container-type: inline-size; height: 100%; }
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
	display: flex;
	flex-direction: column;
	gap: 6px;
}
.heatmap-labels {
	display: flex;
	gap: 3px;
	padding-right: 0;
	margin-left: 0;
}
.heatmap-label {
	width: 14px;
	font-size: 9px;
	line-height: 14px;
	color: var(--text-muted);
	text-align: center;
}
.heatmap-columns {
	display: flex;
	gap: 3px;
}
.heatmap-column {
	display: flex;
	flex-direction: column;
	gap: 3px;
}
.heatmap-cell {
	width: 14px;
	height: 14px;
	border-radius: 2px;
	transition: opacity 0.15s ease;
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
.heatmap-cell.level-4 { background: var(--success); }
.heatmap-cell.future { opacity: 0.15; }
.heatmap-cell.other-month { opacity: 0.1 !important; }
.heatmap-cell.today { outline: 1.5px solid var(--text-muted); outline-offset: -0.5px; }
.heatmap-body {
	display: flex;
	justify-content: center;
	align-items: flex-end;
	gap: 18px;
}
.heatmap-legend {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 3px;
	font-size: 9px;
	color: var(--text-muted);
}
.heatmap-legend .heatmap-cell {
	width: 10px;
	height: 10px;
}
.heatmap-legend span {
	margin: 1px 0;
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

@container (max-width: 400px) {
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
	.quota-label, .heatmap-title, .public-health-title {
		font-size: clamp(9px, 3cqw, 12px);
	}
	.bucket-label, .bucket-reset-time, .reset-label, .reset-value {
		font-size: clamp(8px, 2.75cqw, 11px);
	}
	.heatmap-section, .public-health-section {
		padding: clamp(8px, 3.5cqw, 14px);
	}
	.heatmap-cell {
		width: clamp(8px, 3.5cqw, 14px);
		height: clamp(8px, 3.5cqw, 14px);
	}
	.heatmap-label {
		width: clamp(8px, 3.5cqw, 14px);
		font-size: clamp(7px, 2.25cqw, 9px);
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
		creditsCard = `
			<div class="quota-card clickable-card" role="button" tabindex="0" data-action="openModels">
				<div class="credits-info">
					<span class="credits-label">Extra Credits</span>
					<span class="credits-amount ${colorClass}">${credits.creditAmount.toLocaleString()}</span>
				</div>
				<div class="card-action-overlay">
					<span>Models</span>
					<svg width="14" height="14" viewBox="0 0 16 16"><path fill="currentColor" d="M8.2 3.2l5.4 5.4-5.4 5.4-.7-.7 4.2-4.2H2v-1h9.7L7.5 3.9l.7-.7z"/></svg>
				</div>
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

	const dayLabels = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
	const labelsHtml = dayLabels.map(l =>
		`<div class="heatmap-label">${l}</div>`
	).join('');

	let gridHtml = '';
	for (let d = 0; d < 7; d++) {
		let cellsHtml = '';
		for (let w = 0; w < weeks; w++) {
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

			let tooltip = '';
			if (!isFuture) {
				const tooltipDate = new Intl.DateTimeFormat(locale, { weekday: 'short', month: 'short', day: 'numeric' }).format(cellDate);
				tooltip = consumed > 0
					? `${tooltipDate}\n${Math.round(consumed * 100)}% consumed`
					: `${tooltipDate}\nNo activity`;
			}

			cellsHtml += `<div class="${classes.join(' ')}"${tooltip ? ` title="${escapeHtml(tooltip)}"` : ''}></div>`;
		}
		gridHtml += `<div class="heatmap-column">${cellsHtml}</div>`;
	}

	const monthName = new Intl.DateTimeFormat(locale, { month: 'long' }).format(firstDay);

	return `
		<div class="heatmap-section">
			<div class="heatmap-header">
				<span class="heatmap-title">Usage Activity</span>
				<div class="heatmap-nav">
					<button class="nav-btn" data-action="prevMonth">
						<svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M11 1.5L4.5 8l6.5 6.5l.707-.707L5.914 8l5.793-5.793L11 1.5z"/></svg>
					</button>
					<span class="heatmap-month-title">${escapeHtml(monthName)} ${targetYear}</span>
					<button class="nav-btn" data-action="nextMonth">
						<svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M5 1.5L11.5 8L5 14.5l-.707-.707L10.086 8L4.293 2.207L5 1.5z"/></svg>
					</button>
				</div>
			</div>
			<div class="heatmap-body">
				<div class="heatmap-grid">
					<div class="heatmap-labels">${labelsHtml}</div>
					<div class="heatmap-columns">${gridHtml}</div>
				</div>
				<div class="heatmap-legend">
					<span>More</span>
					<div class="heatmap-cell level-4"></div>
					<div class="heatmap-cell level-3"></div>
					<div class="heatmap-cell level-2"></div>
					<div class="heatmap-cell level-1"></div>
					<div class="heatmap-cell level-0"></div>
					<span>Less</span>
				</div>
			</div>
		</div>`;
}

function buildPanelHtml(statsData: UsageStatistics | null, history: QuotaHistory, heatmapMonth: number, heatmapYear: number, locale?: string, serviceStatus: ServiceStatus = 'disconnected', refreshInterval: number = 60, publicServiceStatus: PublicServiceStatus | null = null): string {
	const nonce = crypto.randomBytes(16).toString('base64');
	const showInitialLoading = serviceStatus === 'loading' && !statsData;
	const bodyClass = showInitialLoading ? ' class="panel-loading-body"' : '';
	const bodyContent = showInitialLoading
		? buildInitialLoadingScreen()
		: `
	${buildTopRow(statsData)}
	${buildPublicHealthChart(publicServiceStatus, locale)}
	<div class="section">
		<div class="quota-grid">${buildQuotaCards(statsData, history, locale)}</div>
	</div>
	${buildHeatmapSection(history.getDailyUsage(), heatmapMonth, heatmapYear, locale)}
	<div class="panel-footer">
		<span id="lastUpdated">Updated just now</span>
		<span class="refresh-interval-info">• ${refreshInterval > 0 ? `Auto: ${Math.max(10, refreshInterval)}s` : 'Auto: Off'}</span>
	</div>`;

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

function openAntigravitySettings() {
	vscode.postMessage({ command: 'openAntigravitySettings' });
}

function prevMonth() {
	vscode.postMessage({ command: 'prevMonth' });
}

function nextMonth() {
	vscode.postMessage({ command: 'nextMonth' });
}

function clearCatHistory(event, el) {
	event.preventDefault();
	event.stopPropagation();
	vscode.postMessage({
		command: 'clearHistory',
		category: el.getAttribute('data-category')
	});
}

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
