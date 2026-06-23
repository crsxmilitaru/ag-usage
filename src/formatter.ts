import * as vscode from 'vscode';
import { CONFIG_NAMESPACE, DISPLAY_MODE_TO_CATEGORY, MAX_STATUS_TEXT_LENGTH, MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from './constants';
import { AbsoluteTimeFormat, QuotaGroup, ResetTimeDisplayMode, StatusBarDisplayMode, StatusBarLimitDisplayMode } from './types';

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

  if (!categories.some(cat => groups[cat]?.quota <= 0)) {
    return '';
  }

  let earliestResetTime: number | null = null;
  for (const cat of categories) {
    const group = groups[cat];
    if (group.quota <= 0 && typeof group.resetTime === 'number') {
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

export function formatStatusBarText(
  groups: Record<string, QuotaGroup>,
  categories: string[]
): string {
  const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  const displayMode = config.get<StatusBarDisplayMode>('statusBarDisplay', 'all');
  const showCountdown = config.get<boolean>('statusBarCountdown', true);
  const countdownSuffix = getCountdownSuffix(groups, categories, showCountdown);

  const formatGroup = (name: string, group: QuotaGroup) => {
    const limitDisplay = config.get<StatusBarLimitDisplayMode>('statusBarLimitDisplay', 'both');
    const weekly = getQuotaBucket(group, 'weekly');
    const fiveHour = getQuotaBucket(group, '5h');
    if (weekly || fiveHour) {
      if (showCountdown && weekly?.quota === 0 && typeof weekly.resetTime === 'number') {
        return `${name} ${formatBucketCountdown(weekly.resetTime)}`;
      }
      if (showCountdown && fiveHour?.quota === 0 && typeof fiveHour.resetTime === 'number') {
        const weeklySuffix = limitDisplay === 'both' && weekly
          ? ` (${formatQuotaPercent(weekly.quota)}%)`
          : '';
        return `${name} ${formatBucketCountdown(fiveHour.resetTime)}${weeklySuffix}`;
      }
      if (limitDisplay === 'both' && weekly && fiveHour) {
        return `${name} ${formatQuotaPercent(fiveHour.quota)}% (${formatQuotaPercent(weekly.quota)}%)`;
      }
      if (fiveHour) {
        return `${name} ${formatQuotaPercent(fiveHour.quota)}%`;
      }
      if (weekly) {
        return `${name} ${formatQuotaPercent(weekly.quota)}%`;
      }
    }

    if (showCountdown && group.quota <= 0 && typeof group.resetTime === 'number') {
      const diffMs = Math.max(0, group.resetTime - Date.now());
      const shortTime = formatRelativeTime(diffMs);
      return `${name} ~${shortTime}`;
    }
    return `${name} ${formatQuotaPercent(group.quota)}%`;
  };

  if (displayMode === 'all') {
    const parts = categories.map(cat => formatGroup(cat, groups[cat]));
    const text = parts.join('   ');
    const truncated = text.length > MAX_STATUS_TEXT_LENGTH
      ? text.slice(0, MAX_STATUS_TEXT_LENGTH - 1) + '…'
      : text;
    return `$(rocket) ${truncated}`;
  }

  if (displayMode !== 'average') {
    const category = DISPLAY_MODE_TO_CATEGORY[displayMode];
    if (category && groups[category]) {
      const group = groups[category];
      return `$(rocket) ${formatGroup(category, group)}`;
    }
  }

  if (categories.length === 0) {
    if (countdownSuffix) {
      return `$(rocket)${countdownSuffix}`;
    }
    return '$(rocket) 0%';
  }

  const totalQuota = categories.reduce((sum, cat) => sum + groups[cat].quota, 0);
  const averageQuota = totalQuota / categories.length;
  const percentage = Math.round(averageQuota * 100);

  if (percentage === 0 && countdownSuffix) {
    return `$(rocket)${countdownSuffix}`;
  }

  return `$(rocket) ${percentage}%`;
}

const ERROR_PATTERNS: Array<{ pattern: RegExp; tooltip: string }> = [
  { pattern: /process not found|not found.*process/i, tooltip: 'Antigravity process not found. Make sure Antigravity is running.' },
  { pattern: /csrf[_\s]?token/i, tooltip: 'Could not extract CSRF token from process. The process may have started incorrectly.' },
  { pattern: /no listening ports|ports? (not )?found/i, tooltip: 'No listening ports found for the Antigravity process.' },
  { pattern: /timed? ?out|timeout/i, tooltip: 'Connection timed out. The server may not be responding.' },
  { pattern: /econnrefused|connection refused/i, tooltip: 'Connection refused. The server may not be running.' },
  { pattern: /enotfound|dns/i, tooltip: 'Could not resolve host. Check your network connection.' },
  { pattern: /not found.*installed|not found.*PATH/i, tooltip: 'A required system command was not found. Ensure your OS tools (PowerShell, ps, ss, lsof, or netstat) are installed and in your PATH.' }
];

export function createErrorTooltip(error: Error): string {
  const message = error.message;
  for (const { pattern, tooltip } of ERROR_PATTERNS) {
    if (pattern.test(message)) {
      return tooltip;
    }
  }
  return `Connection failed: ${message}. Click to retry.`;
}
