import * as vscode from 'vscode';
import { CONFIG_NAMESPACE, DISPLAY_MODE_TO_CATEGORY, MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from './constants';
import { AbsoluteTimeFormat, QuotaGroup, ResetTimeDisplayMode, StatusBarDisplayItem, StatusBarDisplayMode, StatusBarLimitDisplayMode } from './types';

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

export function formatFullTimestamp(ts: number, locale?: string): string {
  const date = new Date(ts);
  const options: Intl.DateTimeFormatOptions = {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  };
  return new Intl.DateTimeFormat(locale, options).format(date);
}

export function formatRelativeTime(diffMs: number): string {
  if (diffMs <= 0) { return '<1m'; }
  const days = Math.floor(diffMs / MS_PER_DAY);
  const hours = Math.floor((diffMs % MS_PER_DAY) / MS_PER_HOUR);
  const minutes = Math.floor((diffMs % MS_PER_HOUR) / MS_PER_MINUTE);

  if (days > 0) return `${days}d${hours > 0 ? ` ${hours}h` : ''}`;
  if (hours > 0) return `${hours}h${minutes > 0 ? ` ${minutes}m` : ''}`;
  return minutes > 0 ? `${minutes}m` : '<1m';
}

export function formatRemainingTimeSeparate(targetTime: number, now: number = Date.now()): { relativeText: string; absoluteText: string | null; diffMs: number } {
  const diffMs = targetTime - now;

  if (diffMs <= 0) {
    return { relativeText: 'Soon', absoluteText: null, diffMs: 0 };
  }

  const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  const displayMode = config.get<ResetTimeDisplayMode>('resetTimeDisplay', 'both');
  const timeFormat = config.get<AbsoluteTimeFormat>('absoluteTimeFormat', '24h');
  const locale = resolveLocale(config.get<string>('dateFormatLocale', 'default'));

  const relativeText = formatRelativeTime(diffMs);

  if (displayMode === 'relative') {
    return { relativeText, absoluteText: null, diffMs };
  }

  const absoluteText = formatAbsoluteTime(targetTime, timeFormat, diffMs, locale);

  if (displayMode === 'absolute') {
    return { relativeText: absoluteText, absoluteText: null, diffMs };
  }

  return { relativeText, absoluteText, diffMs };
}

function getCountdownSuffix(groups: Record<string, QuotaGroup>, categories: string[], showCountdown: boolean): string {
  if (!showCountdown) {
    return '';
  }

  if (!categories.some(cat => formatQuotaPercent(groups[cat].quota) === 0)) {
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

  const diffMs = Math.max(0, earliestResetTime - Date.now());
  const text = formatRelativeTime(diffMs);
  return ` ~${text}`;
}

function getQuotaBucket(group: QuotaGroup, window: 'weekly' | '5h'): NonNullable<QuotaGroup['buckets']>[number] | undefined {
  return group.buckets?.find(bucket => bucket.window.toLowerCase() === window);
}

function formatBucketCountdown(resetTime: number): string {
  const diffMs = Math.max(0, resetTime - Date.now());
  return `~${formatRelativeTime(diffMs)}`;
}

function formatWeeklyQuota(weekly: NonNullable<QuotaGroup['buckets']>[number], showWeeklyReset: boolean): string {
  const percent = `${formatQuotaPercent(weekly.quota)}%`;
  if (!showWeeklyReset || typeof weekly.resetTime !== 'number' || !Number.isFinite(weekly.resetTime) || weekly.resetTime <= 0) {
    return percent;
  }
  const diffMs = Math.max(0, weekly.resetTime - Date.now());
  return `${percent} ${formatRelativeTime(diffMs)}`;
}

function normalizeStatusBarItems(rawDisplay: unknown): StatusBarDisplayItem[] {
  const rawItems = Array.isArray(rawDisplay)
    ? rawDisplay
    : typeof rawDisplay === 'string'
      ? rawDisplay.split(',')
      : ['gemini', 'other', 'argon'];

  const items: StatusBarDisplayItem[] = [];
  for (const rawItem of rawItems) {
    if (typeof rawItem !== 'string') { continue; }
    const normalized = rawItem.trim().toLowerCase();
    if (normalized === 'all') {
      for (const item of ['gemini', 'other', 'argon'] as const) {
        if (!items.includes(item)) {
          items.push(item);
        }
      }
      continue;
    }
    if ((normalized === 'gemini' || normalized === 'other' || normalized === 'argon' || normalized === 'average') && !items.includes(normalized)) {
      items.push(normalized);
    }
  }
  return items;
}

export function formatStatusBarText(
  groups: Record<string, QuotaGroup>,
  categories: string[]
): string {
  const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  const rawDisplay = config.get<StatusBarDisplayItem[] | StatusBarDisplayMode>('statusBarDisplay', ['gemini', 'other', 'argon']);
  const displayItems = normalizeStatusBarItems(rawDisplay);
  const showCountdown = config.get<boolean>('statusBarCountdown', true);
  const showWeeklyReset = config.get<boolean>('statusBarWeeklyReset', false);
  const countdownSuffix = getCountdownSuffix(groups, categories, showCountdown);

  const formatGroup = (name: string, group: QuotaGroup) => {
    const limitDisplay = config.get<StatusBarLimitDisplayMode>('statusBarLimitDisplay', 'both');
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
          return `${name} ${formatBucketCountdown(weeklyResetTime)}`;
        }
        return `${name} ${formatWeeklyQuota(weekly, showWeeklyReset)}`;
      }

      if (limitDisplay === '5h' || limitDisplay === 'only5h') {
        if (!fiveHour) {
          return null;
        }
        if (showCountdown && isWeeklyDepleted && typeof weeklyResetTime === 'number') {
          return `${name} ${formatBucketCountdown(weeklyResetTime)}`;
        }
        if (showCountdown && isFiveHourDepleted && typeof fiveHourResetTime === 'number') {
          return `${name} ${formatBucketCountdown(fiveHourResetTime)}`;
        }
        return `${name} ${formatQuotaPercent(fiveHour.quota)}%`;
      }

      if (showCountdown && isWeeklyDepleted && typeof weeklyResetTime === 'number') {
        const countdownText = formatBucketCountdown(weeklyResetTime);
        return !fiveHour ? `${name} (${countdownText})` : `${name} ${countdownText}`;
      }
      if (showCountdown && isFiveHourDepleted && typeof fiveHourResetTime === 'number') {
        const weeklySuffix = weekly
          ? ` (${formatWeeklyQuota(weekly, showWeeklyReset)})`
          : '';
        return `${name} ${formatBucketCountdown(fiveHourResetTime)}${weeklySuffix}`;
      }
      if (weekly && fiveHour) {
        return `${name} ${formatQuotaPercent(fiveHour.quota)}% (${formatWeeklyQuota(weekly, showWeeklyReset)})`;
      }
      if (fiveHour) {
        return `${name} ${formatQuotaPercent(fiveHour.quota)}%`;
      }
      if (weekly) {
        return `${name} (${formatWeeklyQuota(weekly, showWeeklyReset)})`;
      }
    }

    if (showCountdown && formatQuotaPercent(group.quota) === 0 && typeof group.resetTime === 'number') {
      const diffMs = Math.max(0, group.resetTime - Date.now());
      const shortTime = formatRelativeTime(diffMs);
      return `${name} ~${shortTime}`;
    }
    return `${name} ${formatQuotaPercent(group.quota)}%`;
  };

  const formatStatusBarParts = (parts: string[]): string => {
    return `$(rocket) ${parts.join('   ')}`;
  };

  const formatAverageValue = (withLabel: boolean): string => {
    if (categories.length === 0) {
      return withLabel ? 'Average 0%' : '0%';
    }
    const totalQuota = categories.reduce((sum, cat) => sum + groups[cat].quota, 0);
    const percentage = Math.round((totalQuota / categories.length) * 100);
    if (percentage === 0 && countdownSuffix) {
      return withLabel ? `Average${countdownSuffix}` : countdownSuffix.trimStart();
    }
    return withLabel ? `Average ${percentage}%` : `${percentage}%`;
  };

  if (displayItems.length === 0) {
    return '$(rocket)';
  }

  if (displayItems.length === 1 && displayItems[0] === 'average') {
    return `$(rocket) ${formatAverageValue(false)}`;
  }

  const parts: string[] = [];
  for (const item of displayItems) {
    if (item === 'average') {
      parts.push(formatAverageValue(true));
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
