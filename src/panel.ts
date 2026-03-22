import * as vscode from 'vscode';
import { CATEGORY_ORDER, CONFIG_NAMESPACE } from './constants';
import { formatFullTimestamp, formatLocalDate, formatQuotaPercent, formatRelativeTime, formatRemainingTimeSeparate, resolveLocale } from './formatter';
import { QuotaHistory, QuotaHistoryEntry } from './history';
import { DailyUsageEntry, QuotaGroup, UsageStatistics } from './types';
import { isNotStartedQuota } from './utils';

export class UsageViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'ag-usage.sidebarPanel';
	private view?: vscode.WebviewView;
	private lastStatsData: UsageStatistics | null = null;
	private quotaHistory: QuotaHistory | null = null;
	private heatmapMonth: number = new Date().getMonth();
	private heatmapYear: number = new Date().getFullYear();
	private disposables: vscode.Disposable[] = [];
	public onHistoryChanged?: (history: QuotaHistory) => void;

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

		webviewView.webview.onDidReceiveMessage((message) => {
			if (message.command === 'clearHistory') {
				if (this.quotaHistory && typeof message.category === 'string' && message.category.length < 100) {
					this.quotaHistory.clearCategory(message.category);
					this.onHistoryChanged?.(this.quotaHistory);
					this.updateView();
				}
			} else if (message.command === 'openAntigravitySettings') {
				vscode.commands.executeCommand('workbench.action.openAntigravitySettingsWithId', undefined, 'Models');
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
	}

	public update(statsData: UsageStatistics | null, history: QuotaHistory) {
		this.lastStatsData = statsData;
		this.quotaHistory = history;
		if (this.view) {
			this.updateView();
		}
	}

	private updateView() {
		if (!this.view || !this.quotaHistory) { return; }
		const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
		const locale = resolveLocale(config.get<string>('dateFormatLocale', 'default'));
		this.view.webview.html = buildPanelHtml(this.lastStatsData, this.quotaHistory, this.heatmapMonth, this.heatmapYear, locale);
	}

	dispose() {
		this.disposables.forEach(d => d.dispose());
		this.disposables = [];
	}
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatPercent(fraction: number): string {
	return `${formatQuotaPercent(fraction)}%`;
}

function getBarColorClass(fraction: number): string {
	const pct = fraction * 100;
	if (pct >= 65) { return 'bar-success'; }
	if (pct >= 25) { return 'bar-warning'; }
	return 'bar-error';
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

	const width = 200;
	const height = 44;
	const padding = 8;
	const chartWidth = width - padding * 2;
	const chartHeight = height - padding * 2;

	const scaleX = (i: number) => padding + (entries.length > 1 ? i / (entries.length - 1) : 0.5) * chartWidth;
	const scaleY = (val: number) => padding + chartHeight - (val / 100) * chartHeight;

	const lineColor = 'var(--text-secondary)';

	let pathD = '';
	let dotsHtml = '';
	entries.forEach((entry, i) => {
		const pct = entry.currentQuota * 100;
		const x = scaleX(i);
		const y = scaleY(pct);
		pathD += (i === 0 ? 'M' : 'L') + `${x},${y}`;

		const timeStr = formatFullTimestamp(entry.timestamp, locale);
		const tooltip = `Quota: ${Math.round(pct)}%\nTime: ${timeStr}`;

		const dotColor = pct >= 100 ? 'var(--success)' : pct < 20 ? 'var(--error)' : lineColor;
		dotsHtml += `<circle cx="${x}" cy="${y}" r="3" fill="${dotColor}" stroke="var(--card-bg)" stroke-width="1.5"><title>${tooltip}</title></circle>`;
	});

	const y100 = scaleY(100);
	const y0 = scaleY(0);

	return `
		<div class="history-chart">
			<svg viewBox="0 0 ${width} ${height}">
				<line x1="${padding}" y1="${y100}" x2="${width - padding}" y2="${y100}" class="chart-guide"/>
				<line x1="${padding}" y1="${y0}" x2="${width - padding}" y2="${y0}" class="chart-guide"/>
				<path d="${pathD}" fill="none" stroke="${lineColor}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
				${dotsHtml}
			</svg>
		</div>`;
}

function buildHistorySectionHtml(category: string, categoryEntries: QuotaHistoryEntry[], locale?: string): string {
	if (categoryEntries.length === 0) { return ''; }

	const sparklineHtml = buildHistorySparkline([...categoryEntries].reverse(), locale);

	return `
		<details class="card-history-details">
			<summary class="card-history-summary">
				${sparklineHtml}
			</summary>
			<div class="history-list">
				<div class="history-list-inner">
					${categoryEntries.map((entry, index) => {
		const previousEntry = categoryEntries[index + 1];
		return buildHistoryItemHtml(entry, previousEntry, locale);
	}).join('')}
					<div class="history-clear-row" role="button" tabindex="0" data-category="${escapeHtml(category)}" onclick="clearCatHistory(event, this)" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();clearCatHistory(event,this)}">
						<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M10 3h3v1h-1v9l-1 1H4l-1-1V4H2V3h3V2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1zM6 2v1h3V2H6zm4 11V4H5v9h5z" /></svg>
						<span>Clear History</span>
					</div>
				</div>
			</div>
		</details>`;
}

function buildCardHeaderHtml(category: string, group: QuotaGroup | undefined, locale?: string): string {
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
	let resetValueHtml = 'Not started';
	if (group.resetTime) {
		const resetMs = group.resetTime - Date.now();
		const isNotStarted = isNotStartedQuota(pct, resetMs);
		if (!isNotStarted) {
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
			<div class="quota-value ${colorClass}">${pct}%</div>
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
					<span class="reset-label">Resets at</span>
					<span class="reset-value">${resetValueHtml}</span>
				</div>
			</div>
		</div>`;
}

function buildQuotaCards(statsData: UsageStatistics | null, history: QuotaHistory, locale?: string): string {
	const groups = statsData?.groups || {};
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

		const headerHtml = buildCardHeaderHtml(category, group, locale);
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
	--success: #10b981;
	--warning: #f59e0b;
	--error: #ef4444;
	--radius-sm: 6px;
	--radius-lg: 14px;
}

html, body { height: 100%; }

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
@keyframes pulse {
	0%, 100% { opacity: 0.4; }
	50% { opacity: 1; }
}

.quota-card {
	background: var(--card-bg);
	border: 1px solid var(--card-border);
	border-radius: var(--radius-lg);
	padding: 16px;
	flex: 0 0 auto;
	display: flex;
	flex-direction: column;
	overflow: hidden;
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
	margin-bottom: 12px;
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
.quota-value { font-size: 20px; font-weight: 700; letter-spacing: -0.5px; }
.quota-value.bar-success { color: var(--success); }
.quota-value.bar-warning { color: var(--warning); }
.quota-value.bar-error { color: var(--error); }

.quota-bar-track { display: flex; gap: 2px; height: 6px; margin-bottom: 14px; }
.quota-bar-segment-bg { flex: 1; background: var(--table-border); border-radius: 3px; overflow: hidden; }
.quota-bar-segment-fill { height: 100%; border-radius: 3px; transition: width 0.3s ease; }
.quota-bar-segment-fill.bar-success { background: var(--success); }
.quota-bar-segment-fill.bar-warning { background: var(--warning); }
.quota-bar-segment-fill.bar-error { background: var(--error); }

.quota-reset { display: flex; justify-content: space-between; align-items: center; }
.reset-label { font-size: 11px; color: var(--text-muted); }
.reset-value { font-size: 11px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.reset-interval { color: var(--text-muted); opacity: 0.8; }

.top-row {
	display: flex;
	flex-direction: column;
	gap: 12px;
	flex-shrink: 0;
}
.top-row .quota-card {
	padding: 12px 16px;
}
.top-row .quota-card-header { margin-bottom: 0; }
.plan-value {
	font-size: 13px;
	font-weight: 600;
	letter-spacing: 0.5px;
	color: var(--text-primary);
	text-transform: uppercase;
}

.credits-info { display: flex; align-items: center; gap: 8px; }
.credits-label { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.6px; color: var(--text-secondary); }
.credits-amount { font-size: 18px; font-weight: 700; line-height: 1; }
.credits-ok { color: var(--success); }
.credits-low { color: var(--error); }
.button {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	height: 24px;
	padding: 0 8px;
	background: var(--vscode-button-background);
	color: var(--vscode-button-foreground);
	border: none;
	border-radius: var(--radius-sm);
	text-decoration: none;
	font-family: inherit;
	font-size: 11px;
	line-height: 1;
	font-weight: 600;
	cursor: pointer;
	text-transform: uppercase;
}
.button:hover { background: var(--vscode-button-hoverBackground); }
.button-secondary {
	background: var(--vscode-button-secondaryBackground);
	color: var(--vscode-button-secondaryForeground);
}
.button-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }

.card-history-details { margin-top: 6px; position: relative; }

.card-history-summary {
	cursor: pointer;
	user-select: none;
	list-style: none;
	flex-shrink: 0;
	padding-top: 4px;
	border-radius: var(--radius-sm);
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

.history-chart { margin-top: 8px; background: var(--panel-bg); border-radius: var(--radius-sm); padding: 4px; transition: opacity 0.15s ease; opacity: 0.7; }
.history-chart:hover { opacity: 1; }
.history-chart svg { display: block; width: 100%; height: auto; }
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
.heatmap-range {
	font-size: 10px;
	color: var(--text-muted);
	display: none;
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

`;
}

function buildTopRow(statsData: UsageStatistics | null): string {
	if (!statsData) { return ''; }

	const planDisplay = statsData.planName ?? statsData.plan ?? '';
	const credits = statsData.credits;

	if (!planDisplay && !credits) { return ''; }

	let planCard = '';
	if (planDisplay) {
		planCard = `
			<div class="quota-card">
				<div class="quota-card-header">
					<div class="plan-value">${escapeHtml(planDisplay)}</div>
					<a class="button button-secondary" href="https://antigravity.google/docs/plans">Plans info</a>
				</div>
			</div>`;
	}

	let creditsCard = '';
	if (credits) {
		const isLow = credits.creditAmount <= credits.minimumCreditAmountForUsage;
		const colorClass = isLow ? 'credits-low' : 'credits-ok';
		creditsCard = `
			<div class="quota-card">
				<div class="quota-card-header">
					<div class="credits-info">
						<span class="credits-label">Extra Credits</span>
						<span class="credits-amount ${colorClass}">${credits.creditAmount.toLocaleString()}</span>
					</div>
					<button class="button" onclick="openAntigravitySettings()">Models</button>
				</div>
			</div>`;
	}

	return `<div class="top-row">${planCard}${creditsCard}</div>`;
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
					<button class="nav-btn" onclick="prevMonth()">
						<svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M11 1.5L4.5 8l6.5 6.5l.707-.707L5.914 8l5.793-5.793L11 1.5z"/></svg>
					</button>
					<span class="heatmap-month-title">${escapeHtml(monthName)} ${targetYear}</span>
					<button class="nav-btn" onclick="nextMonth()">
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

function buildPanelHtml(statsData: UsageStatistics | null, history: QuotaHistory, heatmapMonth: number, heatmapYear: number, locale?: string): string {
	const topRow = buildTopRow(statsData);
	const heatmap = buildHeatmapSection(history.getDailyUsage(), heatmapMonth, heatmapYear, locale);
	const quotaCards = buildQuotaCards(statsData, history, locale);

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
${getPanelStyles()}
</style>
</head>
<body>
	${topRow}
	<div class="section">
		<div class="quota-grid">${quotaCards}</div>
	</div>
	${heatmap}
	<div class="panel-footer" id="lastUpdated">Updated just now</div>
<script>
const vscode = acquireVsCodeApi();
const updatedAt = ${Date.now()};
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
		if (!card.classList.contains('minimized')) return;
		e.stopPropagation();
		document.querySelectorAll('.card-history-details[open]').forEach(d => closeDetails(d, true));
		document.querySelectorAll('.quota-grid .quota-card').forEach(c => c.classList.remove('minimized'));
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
	});
});
</script>
</body>
</html>`;
}
