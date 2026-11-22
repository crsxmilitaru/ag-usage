import { ANTIGRAVITY_PLANS_URL, CATEGORY_ORDER, MS_PER_MINUTE, PROGRESS_STOPS } from '../constants';
import { isAntigravityIde } from '../environment';
import { formatFullTimestamp, formatQuotaPercent, formatRelativeTime, formatRemainingTimeSeparate } from '../formatter';
import { QuotaHistory, QuotaHistoryEntry } from '../history';
import { AbsoluteTimeFormat, QuotaGroup, UsageStatistics } from '../types';
import { escapeHtml, getProgressStopIndex, isNotStartedQuota, isWeeklyLimitReached, normalizeModelName, sortQuotaBuckets } from '../utils';
import { ARROW_RIGHT_SVG } from './screens';

const HISTORY_RESTORE_ROUND_MS = 15 * MS_PER_MINUTE;

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

export function buildTopRow(statsData: UsageStatistics | null): string {
	const planDisplay = statsData?.planName ?? statsData?.plan ?? '';
	const credits = statsData?.credits;

	let planCard = '';
	if (planDisplay) {
		planCard = `<a class="quota-card clickable-card" href="${escapeHtml(ANTIGRAVITY_PLANS_URL)}"><div class="plan-value">${escapeHtml(planDisplay)}</div><div class="card-action-overlay"><span>Plans info</span>${ARROW_RIGHT_SVG}</div></a>`;
	}

	let creditsCard = '';
	if (credits) {
		const isLow = credits.creditAmount <= credits.minimumCreditAmountForUsage;
		const colorClass = isLow ? 'credits-low' : 'credits-ok';
		const innerHtml = `<div class="credits-info"><span class="credits-label">Extra Credits</span><span class="credits-amount ${colorClass}">${credits.creditAmount.toLocaleString()}</span></div>`;

		creditsCard = isAntigravityIde()
			? `<button type="button" class="quota-card clickable-card" data-action="openModels">${innerHtml}<div class="card-action-overlay"><span>Models</span>${ARROW_RIGHT_SVG}</div></button>`
			: `<div class="quota-card">${innerHtml}</div>`;
	}

	if (!planCard && !creditsCard) { return ''; }
	return `<div class="top-row">${planCard}${creditsCard}</div>`;
}

function buildHistoryItemHtml(
	entry: QuotaHistoryEntry,
	previousEntry: QuotaHistoryEntry | undefined,
	locale: string | undefined,
	timeFormat: AbsoluteTimeFormat
): string {
	const deltaClass = getDeltaClass(entry.delta);
	const isFullyRestored = entry.currentQuota >= 1 && entry.previousQuota < 1;
	const detailsHtml = entry.isInitial
		? `<div class="history-item-change"><span class="cell-value">Started at ${escapeHtml(formatPercent(entry.currentQuota))}</span></div>`
		: isFullyRestored
			? '<div class="history-item-change"><span class="cell-delta delta-positive">✓ Fully restored</span></div>'
			: `<div class="history-item-change"><span class="cell-value">${escapeHtml(formatPercent(entry.previousQuota))} → ${escapeHtml(formatPercent(entry.currentQuota))}</span><span class="cell-delta ${deltaClass}">${escapeHtml(formatDelta(entry.delta))}</span></div>`;

	let resetHtml = '—';
	if (entry.resetTime !== null) {
		if (entry.resetTime > entry.timestamp) {
			let rt = entry.resetTime;
			let ts = entry.timestamp;
			if (isFullyRestored) {
				const roundedRt = Math.round(rt / HISTORY_RESTORE_ROUND_MS) * HISTORY_RESTORE_ROUND_MS;
				const roundedTs = Math.round(ts / HISTORY_RESTORE_ROUND_MS) * HISTORY_RESTORE_ROUND_MS;
				if (roundedRt > roundedTs) {
					rt = roundedRt;
					ts = roundedTs;
				}
			}
			const timer = formatRemainingTimeSeparate(rt, ts);
			resetHtml = timer.absoluteText
				? `${escapeHtml(timer.absoluteText)} <span class="reset-interval">(${escapeHtml(timer.relativeText)})</span>`
				: escapeHtml(timer.relativeText);
		} else {
			resetHtml = escapeHtml(formatFullTimestamp(entry.resetTime, locale, timeFormat));
		}
	}

	const tsDate = new Date(entry.timestamp);
	const dateStr = new Intl.DateTimeFormat(locale, { month: '2-digit', day: '2-digit' }).format(tsDate);
	const timeStr = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: timeFormat === '12h' }).format(tsDate);

	let lapseHtml = '';
	if (previousEntry !== undefined) {
		let diffMs = Math.max(0, entry.timestamp - previousEntry.timestamp);
		if (isFullyRestored) {
			const roundedDiff = Math.round(diffMs / HISTORY_RESTORE_ROUND_MS) * HISTORY_RESTORE_ROUND_MS;
			if (roundedDiff > 0) {
				diffMs = roundedDiff;
			}
		}
		lapseHtml = `<div class="history-lapsed">↑ ${escapeHtml(formatRelativeTime(diffMs))}</div>`;
	}

	return `<div class="history-row"><div class="history-date"><span class="history-date-day">${escapeHtml(dateStr)}</span><span class="history-date-time">${escapeHtml(timeStr)}</span>${lapseHtml}</div><div class="history-content">${detailsHtml}<div class="cell-reset">Reset: ${resetHtml}</div></div></div>`;
}

function buildHistorySparkline(entries: QuotaHistoryEntry[], locale: string | undefined, timeFormat: AbsoluteTimeFormat): string {
	if (entries.length < 2) { return ''; }

	const chartEntries: QuotaHistoryEntry[] = [];
	entries.forEach((entry, idx) => {
		if (idx === 0 || idx === entries.length - 1) {
			chartEntries.push(entry);
		} else {
			const lastKept = chartEntries[chartEntries.length - 1];
			if (Math.abs(entry.currentQuota - lastKept.currentQuota) >= 0.05 || entry.timestamp - lastKept.timestamp >= 30 * MS_PER_MINUTE) {
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

		const tooltip = `Quota: ${Math.round(pct)}%\nTime: ${formatFullTimestamp(entry.timestamp, locale, timeFormat)}`;
		const dotColor = pct >= 100 ? 'var(--success)' : pct < 20 ? 'var(--error)' : lineColor;
		dotsHtml += `<circle cx="${x}" cy="${y}" r="3" fill="${dotColor}" stroke="var(--card-bg)" stroke-width="1.5"><title>${escapeHtml(tooltip)}</title></circle>`;
	});

	const y100 = scaleY(100);
	const y0 = scaleY(0);

	return `<div class="history-chart"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><line x1="${padding}" y1="${y100}" x2="${width - padding}" y2="${y100}" class="chart-guide" vector-effect="non-scaling-stroke"/><line x1="${padding}" y1="${y0}" x2="${width - padding}" y2="${y0}" class="chart-guide" vector-effect="non-scaling-stroke"/><path d="${pathD}" fill="none" stroke="${lineColor}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>${dotsHtml}</svg></div>`;
}

function buildHistorySectionHtml(
	category: string,
	categoryEntries: QuotaHistoryEntry[],
	locale: string | undefined,
	timeFormat: AbsoluteTimeFormat
): string {
	if (categoryEntries.length === 0) { return ''; }

	const sparklineHtml = buildHistorySparkline(categoryEntries.slice(0, 20).reverse(), locale, timeFormat);
	const rowsHtml = categoryEntries.map((entry, index) => buildHistoryItemHtml(entry, categoryEntries[index + 1], locale, timeFormat)).join('');

	return `<details class="card-history-details" data-category="${escapeHtml(category)}"><summary class="card-history-summary">${sparklineHtml}<div class="card-action-overlay"><span class="expand-text">Expand</span><svg class="expand-icon" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 11.5L2.5 6l.7-.7L8 10.1l4.8-4.8.7.7L8 11.5z"/></svg><span class="collapse-text">Collapse</span><svg class="collapse-icon" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 4.5l5.5 5.5-.7.7L8 5.9l-4.8 4.8-.7-.7L8 4.5z"/></svg></div></summary><div class="history-list"><div class="history-list-inner">${rowsHtml}<button type="button" class="history-clear-row" data-category="${escapeHtml(category)}"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M10 3h3v1h-1v9l-1 1H4l-1-1V4H2V3h3V2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1zM6 2v1h3V2H6zm4 11V4H5v9h5z"/></svg><span>Clear History</span></button></div></div></details>`;
}

function buildCardHeaderHtml(
	category: string,
	group: QuotaGroup | undefined,
	locale: string | undefined,
	timeFormat: AbsoluteTimeFormat,
	plan: string | undefined,
	now: number
): string {
	if (!group) {
		return `<div class="quota-card-header"><div class="quota-card-title"><span class="quota-label">${escapeHtml(category)}</span></div><div class="quota-value">—</div></div>`;
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
		infoButtonHtml = `<div class="info-button-container"><button type="button" class="info-button" aria-label="Models in this group: ${modelsSummary}"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM2.5 8a5.5 5.5 0 1 1 11 0 5.5 5.5 0 0 1-11 0zM8 4a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zM8 7a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5a.75.75 0 0 1 .75-.75z"/></svg></button><div role="tooltip" class="info-tooltip"><div class="tooltip-title">Models in this group</div><div class="tooltip-models-list">${tooltipContent}</div></div></div>`;
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
			if (typeof bucket.resetTime === 'number') {
				const resetMs = bucket.resetTime - now;
				if (!isNotStartedQuota(bucketPct, resetMs)) {
					if (resetMs > 0) {
						const timer = formatRemainingTimeSeparate(bucket.resetTime, now);
						const primaryHtml = timer.isAbsolute
							? `<span>${escapeHtml(timer.relativeText)}</span>`
							: `<span data-countdown-target="${bucket.resetTime}">${escapeHtml(timer.relativeText)}</span>`;
						resetValueHtml = timer.absoluteText
							? `${primaryHtml}<span class="abs-time"> (${escapeHtml(timer.absoluteText)})</span>`
							: primaryHtml;
					} else {
						resetValueHtml = `<span>${escapeHtml(formatFullTimestamp(bucket.resetTime, locale, timeFormat))}</span>`;
					}
				} else {
					resetValueHtml = '<span>Not started</span>';
				}
			}

			const bucketLabel = isWeeklyBucket ? 'Weekly' : bucket.window.toLowerCase() === '5h' ? '5h' : bucket.displayName;
			const isDisabled = !isWeeklyBucket && isWeeklyDepleted;

			return `<div class="quota-bucket-row${isWeeklyBucket ? ' weekly-bucket' : ''}${isDisabled ? ' disabled-bucket' : ''}"><div class="quota-bucket-row-body"><span class="bucket-value ${bucketColorClass}">${bucketPct}%</span><div class="bucket-meta"><span class="bucket-label">${escapeHtml(bucketLabel)}</span>${resetValueHtml ? `<span class="bucket-reset-time">${resetValueHtml}</span>` : ''}</div></div><div class="quota-bar-track bucket-bar"><div class="quota-bar-continuous-bg"><div class="quota-bar-continuous-fill ${bucketColorClass}" style="width:${bucketPct}%"></div></div></div></div>`;
		}).join('');

		return `<div class="quota-card-header"><div class="quota-card-title"><span class="quota-label">${escapeHtml(category)}</span></div>${infoButtonHtml ? `<div class="quota-header-actions">${infoButtonHtml}</div>` : ''}</div><div class="quota-card-inner-wrap"><div class="quota-card-inner-content quota-buckets">${bucketRows}</div></div>`;
	}

	let resetLabel = 'Resets at';
	let resetValueHtml = 'Not started';
	if (typeof group.resetTime === 'number') {
		const resetMs = group.resetTime - now;
		const isNotStarted = isNotStartedQuota(pct, resetMs);
		const weeklyLimitReached = isWeeklyLimitReached(pct, resetMs, plan);
		if (weeklyLimitReached) {
			resetLabel = 'Weekly limit resets at';
			const timer = formatRemainingTimeSeparate(group.resetTime, now);
			const primaryHtml = timer.isAbsolute
				? escapeHtml(timer.relativeText)
				: `<span data-countdown-target="${group.resetTime}">${escapeHtml(timer.relativeText)}</span>`;
			resetValueHtml = timer.absoluteText
				? `${primaryHtml} <span class="reset-interval">(${escapeHtml(timer.absoluteText)})</span>`
				: primaryHtml;
		} else if (!isNotStarted) {
			if (resetMs > 0) {
				const timer = formatRemainingTimeSeparate(group.resetTime, now);
				if (timer.absoluteText) {
					resetValueHtml = `${escapeHtml(timer.absoluteText)} <span class="reset-interval">(<span data-countdown-target="${group.resetTime}">${escapeHtml(timer.relativeText)}</span>)</span>`;
				} else if (timer.isAbsolute) {
					resetValueHtml = escapeHtml(timer.relativeText);
				} else {
					resetValueHtml = `<span data-countdown-target="${group.resetTime}">${escapeHtml(timer.relativeText)}</span>`;
				}
			} else {
				resetValueHtml = escapeHtml(formatFullTimestamp(group.resetTime, locale, timeFormat));
			}
		}
	}

	const segmentsHtml = Array.from({ length: 5 }, (_, i) => {
		const fillPct = Math.max(0, Math.min(100, (pct - i * 20) * 5));
		return `<div class="quota-bar-segment-bg"><div class="quota-bar-segment-fill ${colorClass}" style="width:${fillPct}%"></div></div>`;
	}).join('');

	return `<div class="quota-card-header"><div class="quota-card-title"><span class="quota-label">${escapeHtml(category)}</span></div><div class="quota-header-actions"><span class="quota-value ${colorClass}">${pct}%</span>${infoButtonHtml}</div></div><div class="quota-card-inner-wrap"><div class="quota-card-inner-content"><div class="quota-bar-track">${segmentsHtml}</div><div class="quota-reset"><span class="reset-label">${resetLabel}</span><span class="reset-value">${resetValueHtml}</span></div></div></div>`;
}

export function buildQuotaCards(
	statsData: UsageStatistics | null,
	history: QuotaHistory,
	locale: string | undefined,
	timeFormat: AbsoluteTimeFormat
): string {
	const now = Date.now();
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
		const headerHtml = buildCardHeaderHtml(category, group, locale, timeFormat, plan, now);
		const historyHtml = buildHistorySectionHtml(category, categoryEntries, locale, timeFormat);
		const historyBlock = historyHtml
			? `<div class="quota-card-inner-wrap"><div class="quota-card-inner-content">${historyHtml}</div></div>`
			: '';
		return `<div class="quota-card">${headerHtml}${historyBlock}</div>`;
	}).join('');
}
