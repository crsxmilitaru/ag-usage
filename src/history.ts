import * as vscode from 'vscode';
import { CONFIG_NAMESPACE, HEATMAP_MAX_DAYS } from './constants';
import { formatLocalDate } from './formatter';
import { DailyUsageEntry } from './types';

export interface QuotaHistoryEntry {
  category: string;
  previousQuota: number;
  currentQuota: number;
  delta: number;
  timestamp: number;
  resetTime: number | null;
  isInitial?: boolean;
}

export class QuotaHistory {
  private entries: QuotaHistoryEntry[] = [];
  private previousQuotas: Record<string, number> = {};
  private dailyUsage: DailyUsageEntry[] = [];

  constructor(initialEntries: QuotaHistoryEntry[] = [], initialDailyUsage: DailyUsageEntry[] = []) {
    this.entries = [...initialEntries];
    this.dailyUsage = [...initialDailyUsage];

    this.prune();
    this.pruneDailyUsage();

    const entriesByCategory: Record<string, QuotaHistoryEntry> = {};
    for (const entry of this.entries) {
      if (!entriesByCategory[entry.category] || entry.timestamp > entriesByCategory[entry.category].timestamp) {
        entriesByCategory[entry.category] = entry;
      }
    }

    for (const [category, entry] of Object.entries(entriesByCategory)) {
      this.previousQuotas[category] = entry.currentQuota;
    }
  }

  getEntries(): ReadonlyArray<QuotaHistoryEntry> {
    return this.entries;
  }

  getRawEntries(): QuotaHistoryEntry[] {
    return [...this.entries];
  }

  getDailyUsage(): ReadonlyArray<DailyUsageEntry> {
    return this.dailyUsage;
  }

  getRawDailyUsage(): DailyUsageEntry[] {
    return [...this.dailyUsage];
  }

  clear(): void {
    this.entries = [];
    this.previousQuotas = {};
    this.dailyUsage = [];
  }

  clearCategory(category: string): void {
    this.entries = this.entries.filter(e => e.category !== category);
    delete this.previousQuotas[category];
  }

  public prune() {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    const maxHistoryItems = config.get<number>('maxHistoryItems', 50);
    const enableHistoryTracking = config.get<boolean>('enableHistoryTracking', true);

    if (!enableHistoryTracking) {
      this.entries = [];
      return;
    }

    const counts: Record<string, number> = {};
    const filteredEntries: QuotaHistoryEntry[] = [];

    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      counts[entry.category] = (counts[entry.category] || 0) + 1;
      if (counts[entry.category] <= maxHistoryItems) {
        filteredEntries.unshift(entry);
      }
    }

    this.entries = filteredEntries;
  }

  recordSnapshot(groups: Record<string, { quota: number; resetTime: number | null }>): QuotaHistoryEntry[] {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    const enableHistoryTracking = config.get<boolean>('enableHistoryTracking', true);

    const newEntries: QuotaHistoryEntry[] = [];
    const now = Date.now();

    for (const [category, group] of Object.entries(groups)) {
      const previous = this.previousQuotas[category];

      if (previous === group.quota) {
        continue;
      }

      const isInitial = previous === undefined;
      const delta = isInitial ? 0 : group.quota - previous;

      if (enableHistoryTracking) {
        const categoryEntries = this.entries.filter(e => e.category === category);
        const lastEntry = categoryEntries[categoryEntries.length - 1];
        const timeLimit = 5 * 60 * 1000;

        if (lastEntry && !lastEntry.isInitial && lastEntry.delta < 0 && delta < 0 && (now - lastEntry.timestamp) < timeLimit) {
          lastEntry.currentQuota = group.quota;
          lastEntry.delta = group.quota - lastEntry.previousQuota;
          lastEntry.timestamp = now;
          lastEntry.resetTime = group.resetTime;

          this.recordDailyConsumption(category, Math.abs(delta));
        } else {
          const entry: QuotaHistoryEntry = {
            category,
            previousQuota: isInitial ? group.quota : previous,
            currentQuota: group.quota,
            delta,
            timestamp: now,
            resetTime: group.resetTime,
            isInitial: isInitial ? true : undefined
          };
          newEntries.push(entry);

          if (isInitial) {
            const consumed = 1 - group.quota;
            const hasExistingUsage = this.dailyUsage.some(e => e.category === category);
            if (consumed > 0 && !hasExistingUsage) {
              this.recordDailyConsumption(category, consumed);
            }
          } else if (delta < 0) {
            this.recordDailyConsumption(category, Math.abs(delta));
          }
        }
      }
      this.previousQuotas[category] = group.quota;
    }

    if (newEntries.length > 0) {
      this.entries.push(...newEntries);
    }

    this.prune();
    this.pruneDailyUsage();

    return newEntries;
  }

  private recordDailyConsumption(category: string, consumed: number): void {
    const today = formatLocalDate(new Date());
    const existing = this.dailyUsage.find(e => e.date === today && e.category === category);
    if (existing) {
      existing.consumed = Math.round((existing.consumed + consumed) * 10000) / 10000;
    } else {
      this.dailyUsage.push({ date: today, category, consumed: Math.round(consumed * 10000) / 10000 });
    }
  }

  private pruneDailyUsage(): void {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - HEATMAP_MAX_DAYS);
    const cutoffStr = formatLocalDate(cutoff);
    this.dailyUsage = this.dailyUsage.filter(e => e.date >= cutoffStr);
  }
}
