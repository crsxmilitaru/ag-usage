import {
	CATEGORY_NAMES,
	CATEGORY_ORDER,
	MODEL_USAGE_COLLAPSED_ROWS,
	MS_PER_DAY,
	MS_PER_HOUR,
	STATUSGATOR_SERVICE_URL
} from '../constants';
import { formatFullTimestamp, formatLocalDate, formatQuotaPercent, formatRelativeTime } from '../formatter';
import { AbsoluteTimeFormat, DailyUsageEntry, ModelUsageEntry, ModelUsageSummary, PublicServiceStatus, UsageStatistics } from '../types';
import { determineCategory, escapeHtml, isNotStartedQuota } from '../utils';
import { ARROW_RIGHT_SVG, buildTooltipAttrs } from './screens';

const RESET_CALENDAR_MAX_DAYS = 8;
const RESET_CALENDAR_CLUSTER_PCT = 3;
const RESET_CALENDAR_CLUSTER_OFFSET_PX = 7;
const RESET_CALENDAR_RIGHT_CLUSTER_STEP_PCT = 5;
const RESET_CALENDAR_WEEKLY_FALLBACK_MS = 18 * MS_PER_HOUR;

interface ResetCalendarEvent {
	id?: string;
	label: string;
	category: string;
	resetTime: number;
	colorVar: string;
	categoryClass: string;
}

interface ResetCalendarLabelCell {
	events: ResetCalendarEvent[];
	span: number;
	align: 'center' | 'start' | 'end';
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

export function buildPublicHealthChart(
	publicServiceStatus: PublicServiceStatus | null,
	locale: string | undefined,
	timeFormat: AbsoluteTimeFormat
): string {
	if (!publicServiceStatus?.healthPoints?.length) { return ''; }
	const points = publicServiceStatus.healthPoints;

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
		const label = `${formatFullTimestamp(point.timestamp, locale, timeFormat)}: ${getPublicHealthLabel(point.status)} (${point.value.toLocaleString()})`;
		return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" fill="${getPublicHealthColor(point.status)}"><title>${escapeHtml(label)}</title></rect>`;
	}).join('');

	const statusUrl = publicServiceStatus.url || STATUSGATOR_SERVICE_URL;

	return `<div class="public-health-section"><div class="public-health-header"><div class="public-health-title">Service health</div><div class="public-health-time">24h</div></div><div class="public-health-chart"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Google Antigravity service health over the last 24 hours">${gridHtml}${barsHtml}</svg><a class="public-health-chart-overlay card-action-overlay" href="${escapeHtml(statusUrl)}"><span>Public status</span>${ARROW_RIGHT_SVG}</a></div><div class="public-health-legend"><span><i class="health-dot health-up"></i>Service up</span><span><i class="health-dot health-warn"></i>Possible outage</span><span><i class="health-dot health-down"></i>Likely outage</span></div></div>`;
}

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
	while (neededDays < RESET_CALENDAR_MAX_DAYS && lastReset >= addLocalDays(todayStart, neededDays)) {
		neededDays++;
	}
	return neededDays;
}

function buildResetCalendarLabelCells(eventsByDay: ResetCalendarEvent[][]): ResetCalendarLabelCell[] {
	const dayCount = eventsByDay.length;
	const spans = new Map<number, { events: ResetCalendarEvent[]; end: number; align: 'center' | 'start' | 'end' }>();

	for (let d = 0; d < dayCount; d++) {
		if (eventsByDay[d].length <= 1) {
			continue;
		}

		let leftEmpty = 0;
		let leftIdx = d - 1;
		while (leftIdx >= 0 && eventsByDay[leftIdx].length === 0) {
			leftEmpty++;
			leftIdx--;
		}
		if (leftIdx >= 0 && eventsByDay[leftIdx].length > 1) {
			leftEmpty = Math.ceil(leftEmpty / 2);
		}

		let rightEmpty = 0;
		let rightIdx = d + 1;
		while (rightIdx < dayCount && eventsByDay[rightIdx].length === 0) {
			rightEmpty++;
			rightIdx++;
		}
		if (rightIdx < dayCount && eventsByDay[rightIdx].length > 1) {
			rightEmpty = Math.floor(rightEmpty / 2);
		}

		const symReach = Math.min(leftEmpty, rightEmpty);
		const symSpan = 1 + 2 * symReach;
		const rightSpan = 1 + rightEmpty;
		const leftSpan = 1 + leftEmpty;

		if (symReach > 0 && symSpan >= rightSpan && symSpan >= leftSpan) {
			spans.set(d - symReach, { events: eventsByDay[d], end: d + symReach, align: 'center' });
		} else if (rightEmpty > 0 && rightSpan >= leftSpan) {
			spans.set(d, { events: eventsByDay[d], end: d + rightEmpty, align: 'start' });
		} else if (leftEmpty > 0) {
			spans.set(d - leftEmpty, { events: eventsByDay[d], end: d, align: 'end' });
		}
	}

	const labelCells: ResetCalendarLabelCell[] = [];
	for (let d = 0; d < dayCount; d++) {
		const expanded = spans.get(d);
		if (expanded) {
			labelCells.push({ events: expanded.events, span: expanded.end - d + 1, align: expanded.align });
			d = expanded.end;
		} else {
			labelCells.push({ events: eventsByDay[d], span: 1, align: 'center' });
		}
	}
	return labelCells;
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

function getCategoryStyleMeta(category: string): { colorVar: string; categoryClass: string } {
	if (category === CATEGORY_NAMES.GEMINI) {
		return { colorVar: 'var(--models-gemini)', categoryClass: 'category-gemini' };
	}
	if (category === CATEGORY_NAMES.OTHER) {
		return { colorVar: 'var(--models-other)', categoryClass: 'category-other' };
	}
	if (category === CATEGORY_NAMES.ARGON) {
		return { colorVar: 'var(--models-argon)', categoryClass: 'category-argon' };
	}
	return { colorVar: 'var(--text-secondary)', categoryClass: 'category-default' };
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

		const styleMeta = getCategoryStyleMeta(category);
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
					...styleMeta
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
			...styleMeta
		});
	}

	events.sort((a, b) => a.resetTime - b.resetTime);
	events.forEach((event, idx) => {
		event.id = `reset-evt-${idx}`;
	});
	return events;
}

export function buildResetCalendarSection(
	statsData: UsageStatistics | null,
	locale: string | undefined,
	timeFormat: AbsoluteTimeFormat
): string {
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
		hour12: timeFormat === '12h'
	});

	const eventsByDay: ResetCalendarEvent[][] = Array.from({ length: dayCount }, () => []);
	for (const event of events) {
		let dayIndex = dayCount - 1;
		for (let i = 0; i < dayCount; i++) {
			if (event.resetTime >= dayStarts[i] && event.resetTime < dayStarts[i + 1]) {
				dayIndex = i;
				break;
			}
		}
		eventsByDay[dayIndex].push(event);
	}

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
		return `<div class="${classes.join(' ')}"><span class="reset-calendar-day-name">${escapeHtml(name)}</span><span class="reset-calendar-day-num">${date.getDate()}</span></div>`;
	}).join('');

	const labelCells = buildResetCalendarLabelCells(eventsByDay);

	const labelsHtml = labelCells.map(({ events: cellEvents, span, align }) => {
		const labels = cellEvents.map(event => {
			const timeStr = whenFormat.format(new Date(event.resetTime));
			const relStr = formatRelativeTime(event.resetTime - now);
			const tooltipAttrs = buildTooltipAttrs({
				title: event.label,
				badge: `in ${relStr}`,
				color: event.colorVar,
				content: `${timeStr} · Weekly reset`
			});
			const resetIdAttr = event.id ? ` data-reset-id="${escapeHtml(event.id)}"` : '';
			return `<span class="reset-calendar-label ${event.categoryClass}"${resetIdAttr} data-reset-time="${event.resetTime}" ${tooltipAttrs} tabindex="0">${escapeHtml(event.label)}</span>`;
		}).join('');
		const alignClass = align === 'start'
			? ' reset-calendar-label-cell-start'
			: align === 'end'
				? ' reset-calendar-label-cell-end'
				: '';
		const spanStyle = span > 1 ? ` style="grid-column:span ${span}"` : '';
		return `<div class="reset-calendar-label-cell${alignClass}"${spanStyle}>${labels}</div>`;
	}).join('');

	const separatorsHtml = Array.from({ length: dayCount - 1 }, (_, i) =>
		`<div class="reset-calendar-sep" style="left:${((i + 1) / dayCount) * 100}%"></div>`
	).join('');

	const dotClusters: Array<Array<{ event: ResetCalendarEvent; leftPct: number }>> = [];
	for (const event of events) {
		const leftPct = resetCalendarTimePosition(event.resetTime, dayStarts);
		const currentCluster = dotClusters[dotClusters.length - 1];
		if (currentCluster && leftPct - currentCluster[0].leftPct < RESET_CALENDAR_CLUSTER_PCT) {
			currentCluster.push({ event, leftPct });
		} else {
			dotClusters.push([{ event, leftPct }]);
		}
	}

	const dotsHtml = dotClusters.flatMap(cluster => {
		const growLeft = cluster.length > 1 && cluster[0].leftPct > 100 - (cluster.length - 1) * RESET_CALENDAR_RIGHT_CLUSTER_STEP_PCT;
		return cluster.map(({ event, leftPct }, clusterIndex) => {
			const timeStr = whenFormat.format(new Date(event.resetTime));
			const relStr = formatRelativeTime(event.resetTime - now);
			const tooltipAttrs = buildTooltipAttrs({
				title: event.label,
				badge: `in ${relStr}`,
				color: event.colorVar,
				content: `${timeStr} · Weekly reset`
			});
			const resetIdAttr = event.id ? ` data-reset-id="${escapeHtml(event.id)}"` : '';
			const offsetIndex = growLeft ? clusterIndex - (cluster.length - 1) : clusterIndex;
			const offset = offsetIndex * RESET_CALENDAR_CLUSTER_OFFSET_PX;
			return `<div class="reset-calendar-dot ${event.categoryClass}" style="left:${leftPct}%;--dot-offset:${offset}px"${resetIdAttr} data-reset-time="${event.resetTime}" ${tooltipAttrs} tabindex="0"></div>`;
		});
	}).join('');

	const nextText = formatRelativeTime(events[0].resetTime - now);
	const nowTooltipAttrs = buildTooltipAttrs({
		title: 'Current Time',
		badge: 'Now',
		badgeClass: 'badge-now',
		content: whenFormat.format(new Date(now))
	});

	return `<div class="reset-calendar-section"><div class="reset-calendar-header"><span class="reset-calendar-title">Reset timeline</span><span class="reset-calendar-meta">Next in <span data-countdown-target="${events[0].resetTime}" data-countdown-expired="&lt;1m">${escapeHtml(nextText)}</span></span></div><div class="reset-calendar-timeline" style="--reset-calendar-days:${dayCount}" data-day-starts="${dayStarts.join(',')}" data-locale="${escapeHtml(locale ?? '')}" data-hour12="${timeFormat === '12h'}"><div class="reset-calendar-days">${daysHtml}</div><div class="reset-calendar-track"><div class="reset-calendar-bar"><div class="reset-calendar-bar-elapsed" style="width:${nowPct}%"></div></div>${separatorsHtml}<div class="reset-calendar-now" style="left:${nowPct}%" ${nowTooltipAttrs} tabindex="0"></div>${dotsHtml}</div><div class="reset-calendar-labels">${labelsHtml}</div></div></div>`;
}

function getHeatmapLevel(consumed: number, maxConsumed: number): number {
	if (consumed <= 0 || maxConsumed <= 0) { return 0; }
	const ratio = consumed / maxConsumed;
	if (ratio <= 0.25) { return 1; }
	if (ratio <= 0.5) { return 2; }
	if (ratio <= 0.75) { return 3; }
	return 4;
}

export function buildHeatmapSection(
	dailyUsage: ReadonlyArray<DailyUsageEntry>,
	targetMonth: number,
	targetYear: number,
	locale?: string
): string {
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

	const totalDays = Math.round((endDate.getTime() - startDate.getTime()) / MS_PER_DAY) + 1;
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

	return `<div class="heatmap-section"><div class="heatmap-header"><span class="heatmap-title">Usage Activity</span><div class="heatmap-nav"><button type="button" class="nav-btn" data-action="prevMonth" aria-label="Previous month"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M11 1.5L4.5 8l6.5 6.5l.707-.707L5.914 8l5.793-5.793L11 1.5z"/></svg></button><span class="heatmap-month-title">${escapeHtml(monthTitle)}</span><button type="button" class="nav-btn" data-action="nextMonth" aria-label="Next month"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M5 1.5L11.5 8L5 14.5l-.707-.707L10.086 8L4.293 2.207L5 1.5z"/></svg></button></div></div><div class="heatmap-body"><div class="heatmap-grid"><div class="heatmap-labels">${labelsHtml}</div><div class="heatmap-weeks">${weeksHtml}</div></div><div class="heatmap-legend"><span>More</span><div class="heatmap-cell level-4" ${buildTooltipAttrs({ title: 'Activity Level 4', content: 'Highest activity (> 75%)', color: 'var(--success)' })} tabindex="0"></div><div class="heatmap-cell level-3" ${buildTooltipAttrs({ title: 'Activity Level 3', content: 'High activity (51% – 75%)', color: 'var(--success)' })} tabindex="0"></div><div class="heatmap-cell level-2" ${buildTooltipAttrs({ title: 'Activity Level 2', content: 'Moderate activity (26% – 50%)', color: 'var(--success)' })} tabindex="0"></div><div class="heatmap-cell level-1" ${buildTooltipAttrs({ title: 'Activity Level 1', content: 'Low activity (1% – 25%)', color: 'var(--success)' })} tabindex="0"></div><div class="heatmap-cell level-0" ${buildTooltipAttrs({ title: 'Activity Level 0', content: 'No activity' })} tabindex="0"></div><span>Less</span></div></div></div>`;
}

function getModelUsageBarFillClass(entry: ModelUsageEntry): string {
	const category = determineCategory(entry.model);
	if (category === CATEGORY_NAMES.ARGON) {
		return 'model-usage-bar-fill--argon';
	}
	if (category === CATEGORY_NAMES.GEMINI) {
		return 'model-usage-bar-fill--gemini';
	}
	return 'model-usage-bar-fill--other';
}

function buildModelUsageRowHtml(entry: ModelUsageEntry, totalGenerations: number): string {
	const share = totalGenerations > 0 ? Math.round((entry.count / totalGenerations) * 100) : 0;
	const fillClass = getModelUsageBarFillClass(entry);
	return `<div class="model-usage-row" title="${escapeHtml(`${entry.label}: ${entry.count} generations`)}"><div class="model-usage-row-top"><div class="model-usage-info"><span class="model-usage-name">${escapeHtml(entry.model)}</span>${entry.thinkingLevel ? `<span class="model-usage-level">${escapeHtml(entry.thinkingLevel)}</span>` : ''}</div><span class="model-usage-count">${entry.count.toLocaleString()}<span class="model-usage-share">${share}%</span></span></div><div class="model-usage-bar"><div class="model-usage-bar-fill ${fillClass}" style="width:${share}%"></div></div></div>`;
}

export function buildModelUsageSection(modelUsage: ModelUsageSummary | null): string {
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
		extraRowsHtml = `<details class="model-usage-more"><summary class="model-usage-toggle"><span class="model-usage-show-more">Show all ${entries.length} models</span><span class="model-usage-show-less">Show less</span><svg class="model-usage-toggle-more-icon" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 11.5L2.5 6l.7-.7L8 10.1l4.8-4.8.7.7L8 11.5z"/></svg><svg class="model-usage-toggle-less-icon" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 4.5l5.5 5.5-.7.7L8 5.9l-4.8 4.8-.7-.7L8 4.5z"/></svg></summary><div class="model-usage-extra-rows">${extraEntries.map(entry => buildModelUsageRowHtml(entry, totalGenerations)).join('')}</div></details>`;
	}

	const conversationCount = modelUsage?.conversationCount ?? 0;
	const metaText = totalGenerations > 0
		? (conversationCount > 0
			? `${totalGenerations.toLocaleString()} ${totalGenerations === 1 ? 'generation' : 'generations'} · ${conversationCount.toLocaleString()} ${conversationCount === 1 ? 'chat' : 'chats'}`
			: `${totalGenerations.toLocaleString()} ${totalGenerations === 1 ? 'generation' : 'generations'}`)
		: '';

	return `<div class="model-usage-section"><div class="model-usage-header"><span class="model-usage-title">Most Used Models</span>${metaText ? `<div class="model-usage-meta"><span>${escapeHtml(metaText)}</span></div>` : ''}</div>${visibleRowsHtml}${extraRowsHtml}</div>`;
}
