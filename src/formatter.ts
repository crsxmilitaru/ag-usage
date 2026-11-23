import * as vscode from 'vscode';
import { CONFIG_NAMESPACE, DEFAULT_STATUS_BAR_DISPLAY, DISPLAY_MODE_TO_CATEGORY, MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from './constants';
import { AbsoluteTimeFormat, QuotaBucket, QuotaGroup, ResetTimeDisplayMode, StatusBarDisplayItem, StatusBarDisplayMode, StatusBarLimitDisplayMode } from './types';
import { isNotStartedQuota, normalizeStatusBarItems } from './utils';

export function formatQuotaPercent(fraction: number): number {
	return Math.round(Math.max(0, Math.min(1, fraction)) * 100);
}

export function formatLocalDate(d: Date): string {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function resolveLocale(localeSetting: string): string | undefined {
	if (localeSetting === 'default') { return undefined; }
	try {
		new Intl.DateTimeFormat(localeSetting);
		return localeSetting;
	} catch {
		return undefined;
	}
}

export function getAbsoluteTimeFormat(): AbsoluteTimeFormat {
	const format = vscode.workspace.getConfiguration(CONFIG_NAMESPACE).get<string>('absoluteTimeFormat', '24h');
	return format === '12h' ? '12h' : '24h';
}

function formatAbsoluteTime(targetTime: number, format: AbsoluteTimeFormat, diffMs: number, locale?: string): string {
	const date = new Date(targetTime);
	const includeDate = diffMs >= MS_PER_DAY;

	const options: Intl.DateTimeFormatOptions = {
		hour: '2-digit',
		minute: '2-digit',
		hour12: format === '12h'
	};

	if (includeDate) {
		options.month = '2-digit';
		options.day = '2-digit';
	}

	return new Intl.DateTimeFormat(locale, options).format(date);
}

export function formatFullTimestamp(ts: number, locale?: string, timeFormat: AbsoluteTimeFormat = getAbsoluteTimeFormat()): string {
	const date = new Date(ts);
	const options: Intl.DateTimeFormatOptions = {
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hour12: timeFormat === '12h'
	};
	return new Intl.DateTimeFormat(locale, options).format(date);
}

export function formatRelativeTime(diffMs: number): string {
	if (diffMs <= 0) { return '<1m'; }
	const days = Math.floor(diffMs / MS_PER_DAY);
	const hours = Math.floor((diffMs % MS_PER_DAY) / MS_PER_HOUR);
	const minutes = Math.floor((diffMs % MS_PER_HOUR) / MS_PER_MINUTE);

	if (days > 0) { return `${days}d${hours > 0 ? ` ${hours}h` : ''}`; }
	if (hours > 0) { return `${hours}h${minutes > 0 ? ` ${minutes}m` : ''}`; }
	return minutes > 0 ? `${minutes}m` : '<1m';
}

export function formatRemainingTimeSeparate(
	targetTime: number,
	now: number = Date.now()
): { relativeText: string; absoluteText: string | null; diffMs: number; isAbsolute: boolean } {
	const diffMs = targetTime - now;

	if (diffMs <= 0) {
		return { relativeText: 'Soon', absoluteText: null, diffMs: 0, isAbsolute: false };
	}

	const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
	const displayMode = config.get<ResetTimeDisplayMode>('resetTimeDisplay', 'both');
	const timeFormat = getAbsoluteTimeFormat();
	const locale = resolveLocale(config.get<string>('dateFormatLocale', 'default'));

	const relativeText = formatRelativeTime(diffMs);

	if (displayMode === 'relative') {
		return { relativeText, absoluteText: null, diffMs, isAbsolute: false };
	}

	const absoluteText = formatAbsoluteTime(targetTime, timeFormat, diffMs, locale);

	if (displayMode === 'absolute') {
		return { relativeText: absoluteText, absoluteText: null, diffMs, isAbsolute: true };
	}

	return { relativeText, absoluteText, diffMs, isAbsolute: false };
}

function getCountdownSuffix(groups: Record<string, QuotaGroup>, categories: string[], showCountdown: boolean, now: number): string {
	if (!showCountdown) {
		return '';
	}

	let earliestResetTime: number | null = null;
	for (const cat of categories) {
		const group = groups[cat];
		if (formatQuotaPercent(group.quota) === 0 && typeof group.resetTime === 'number') {
			if (earliestResetTime === null || group.resetTime < earliestResetTime) {
				earliestResetTime = group.resetTime;
			}
		}
	}

	if (earliestResetTime === null) {
		return '';
	}

	const diffMs = Math.max(0, earliestResetTime - now);
	return ` ~${formatRelativeTime(diffMs)}`;
}

function getQuotaBucket(group: QuotaGroup, window: 'weekly' | '5h'): QuotaBucket | undefined {
	return group.buckets?.find(bucket => bucket.window.toLowerCase() === window);
}

function formatBucketCountdown(resetTime: number, now: number): string {
	const diffMs = Math.max(0, resetTime - now);
	return `~${formatRelativeTime(diffMs)}`;
}

function formatWeeklyQuota(weekly: QuotaBucket, showWeeklyReset: boolean, now: number): string {
	const percentValue = formatQuotaPercent(weekly.quota);
	const percent = `${percentValue}%`;
	if (!showWeeklyReset || typeof weekly.resetTime !== 'number' || !Number.isFinite(weekly.resetTime) || weekly.resetTime <= 0) {
		return percent;
	}
	const diffMs = Math.max(0, weekly.resetTime - now);
	if (isNotStartedQuota(percentValue, diffMs)) {
		return percent;
	}
	return `${percent} ${formatRelativeTime(diffMs)}`;
}

export function formatStatusBarText(
	groups: Record<string, QuotaGroup>,
	categories: string[]
): string {
	const now = Date.now();
	const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
	const rawDisplay = config.get<StatusBarDisplayItem[] | StatusBarDisplayMode>('statusBarDisplay', [...DEFAULT_STATUS_BAR_DISPLAY]);
	const displayItems = normalizeStatusBarItems(rawDisplay);
	const limitDisplay = config.get<StatusBarLimitDisplayMode>('statusBarLimitDisplay', 'both');
	const showCountdown = config.get<boolean>('statusBarCountdown', true);
	const showWeeklyReset = config.get<boolean>('statusBarWeeklyReset', false);

	const formatGroup = (name: string, group: QuotaGroup): string | null => {
		const weekly = getQuotaBucket(group, 'weekly');
		const fiveHour = getQuotaBucket(group, '5h');
		if (weekly || fiveHour) {
			const weeklyResetTime = weekly?.resetTime ?? group.resetTime;
			const fiveHourResetTime = fiveHour?.resetTime ?? group.resetTime;
			const isWeeklyDepleted = weekly !== undefined && formatQuotaPercent(weekly.quota) === 0;
			const isFiveHourDepleted = fiveHour !== undefined && formatQuotaPercent(fiveHour.quota) === 0;

			if (limitDisplay === 'weekly') {
				if (!weekly) {
					return null;
				}
				if (showCountdown && isWeeklyDepleted && typeof weeklyResetTime === 'number') {
					return `${name} ${formatBucketCountdown(weeklyResetTime, now)}`;
				}
				return `${name} ${formatWeeklyQuota(weekly, showWeeklyReset, now)}`;
			}

			if (limitDisplay === '5h' || limitDisplay === 'only5h') {
				if (!fiveHour) {
					return null;
				}
				if (showCountdown && isWeeklyDepleted && typeof weeklyResetTime === 'number') {
					return `${name} ${formatBucketCountdown(weeklyResetTime, now)}`;
				}
				if (showCountdown && isFiveHourDepleted && typeof fiveHourResetTime === 'number') {
					return `${name} ${formatBucketCountdown(fiveHourResetTime, now)}`;
				}
				return `${name} ${formatQuotaPercent(fiveHour.quota)}%`;
			}

			if (showCountdown && isWeeklyDepleted && typeof weeklyResetTime === 'number') {
				const countdownText = formatBucketCountdown(weeklyResetTime, now);
				return !fiveHour ? `${name} (${countdownText})` : `${name} ${countdownText}`;
			}
			if (showCountdown && isFiveHourDepleted && typeof fiveHourResetTime === 'number') {
				const weeklySuffix = weekly
					? ` (${formatWeeklyQuota(weekly, showWeeklyReset, now)})`
					: '';
				return `${name} ${formatBucketCountdown(fiveHourResetTime, now)}${weeklySuffix}`;
			}
			if (weekly && fiveHour) {
				return `${name} ${formatQuotaPercent(fiveHour.quota)}% (${formatWeeklyQuota(weekly, showWeeklyReset, now)})`;
			}
			if (fiveHour) {
				return `${name} ${formatQuotaPercent(fiveHour.quota)}%`;
			}
			if (weekly) {
				return `${name} (${formatWeeklyQuota(weekly, showWeeklyReset, now)})`;
			}
		}

		if (showCountdown && formatQuotaPercent(group.quota) === 0 && typeof group.resetTime === 'number') {
			return `${name} ${formatBucketCountdown(group.resetTime, now)}`;
		}
		return `${name} ${formatQuotaPercent(group.quota)}%`;
	};

	const formatStatusBarParts = (parts: string[]): string => {
		return `$(rocket) ${parts.join('   ')}`;
	};

	let cachedCountdownSuffix: string | undefined;
	const getAggregateCountdownSuffix = (): string => {
		if (cachedCountdownSuffix === undefined) {
			cachedCountdownSuffix = getCountdownSuffix(groups, categories, showCountdown, now);
		}
		return cachedCountdownSuffix;
	};

	const formatAggregateValue = (mode: 'average' | 'total', withLabel: boolean): string => {
		const label = mode === 'average' ? 'Average' : 'Total';
		if (categories.length === 0) {
			return withLabel ? `${label} 0%` : '0%';
		}
		const totalQuota = categories.reduce((sum, cat) => sum + Math.max(0, Math.min(1, groups[cat].quota)), 0);
		const divisor = mode === 'average' ? categories.length : 1;
		const percentage = Math.round((totalQuota / divisor) * 100);
		const countdownSuffix = percentage === 0 ? getAggregateCountdownSuffix() : '';
		if (countdownSuffix) {
			return withLabel ? `${label}${countdownSuffix}` : countdownSuffix.trimStart();
		}
		return withLabel ? `${label} ${percentage}%` : `${percentage}%`;
	};

	if (displayItems.length === 0) {
		return '$(rocket)';
	}

	if (displayItems.length === 1 && (displayItems[0] === 'average' || displayItems[0] === 'total')) {
		return `$(rocket) ${formatAggregateValue(displayItems[0], false)}`;
	}

	const parts: string[] = [];
	for (const item of displayItems) {
		if (item === 'average' || item === 'total') {
			parts.push(formatAggregateValue(item, true));
			continue;
		}
		const category = DISPLAY_MODE_TO_CATEGORY[item];
		if (!category) { continue; }
		if (groups[category]) {
			const formatted = formatGroup(category, groups[category]);
			if (formatted !== null) {
				parts.push(formatted);
			}
		} else if (displayItems.length === 1) {
			parts.push(`${category} —`);
		}
	}

	if (parts.length === 0) {
		if (categories.length === 0) {
			return '$(rocket) 0%';
		}
		return formatStatusBarParts(
			displayItems.map(item => `${DISPLAY_MODE_TO_CATEGORY[item] ?? item} —`)
		);
	}

	return formatStatusBarParts(parts);
}

const ERROR_PATTERNS: Array<{ pattern: RegExp; tooltip: string }> = [
	{ pattern: /not found.*installed|not found.*PATH/i, tooltip: 'A required system command was not found. Ensure your OS tools (PowerShell, ps, ss, lsof, or netstat) are installed and in your PATH.' },
	{ pattern: /process not found|not found.*process/i, tooltip: 'Antigravity process not found. Make sure Antigravity is running.' },
	{ pattern: /csrf[_\s]?token/i, tooltip: 'Could not extract CSRF token from process. The process may have started incorrectly.' },
	{ pattern: /no listening ports|ports? (not )?found/i, tooltip: 'No listening ports found for the Antigravity process.' },
	{ pattern: /timed? ?out|timeout/i, tooltip: 'Connection timed out. The server may not be responding.' },
	{ pattern: /econnrefused|connection refused/i, tooltip: 'Connection refused. The server may not be running.' },
	{ pattern: /enotfound|dns/i, tooltip: 'Could not resolve host. Check your network connection.' }
];

export function getConnectionErrorDetail(error: Error): string {
	const message = error.message;
	for (const { pattern, tooltip } of ERROR_PATTERNS) {
		if (pattern.test(message)) {
			return tooltip;
		}
	}
	return message;
}

export function createErrorTooltip(error: Error): string {
	const detail = getConnectionErrorDetail(error);
	if (detail !== error.message) {
		return detail;
	}
	return `Connection failed: ${detail}. Click to retry.`;
}
