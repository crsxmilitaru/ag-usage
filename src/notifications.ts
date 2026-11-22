import * as vscode from 'vscode';
import { CATEGORY_ORDER, CONFIG_NAMESPACE, EXTENSION_TITLE, LOW_QUOTA_REARM_MARGIN_PERCENT } from './constants';
import { formatQuotaPercent } from './formatter';
import { UsageStatistics } from './types';

export class NotificationManager {
	private fullQuotaNotifiedCategories = new Set<string>();
	private lowQuotaNotifiedCategories = new Set<string>();

	public clear(): void {
		this.fullQuotaNotifiedCategories.clear();
		this.lowQuotaNotifiedCategories.clear();
	}

	public clearLowQuotaNotifications(): void {
		this.lowQuotaNotifiedCategories.clear();
	}

	public checkQuotaNotifications(statsData: UsageStatistics, previousStatsData: UsageStatistics | null = null): void {
		const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
		const { groups } = statsData;

		if (config.get<boolean>('notifyOnFullQuota', false)) {
			for (const category of CATEGORY_ORDER) {
				const group = groups[category];
				if (!group) { continue; }
				const previousQuota = previousStatsData?.groups[category]?.quota;
				const crossedToFull = typeof previousQuota === 'number' && previousQuota < 1 && group.quota >= 1;

				if (crossedToFull) {
					if (!this.fullQuotaNotifiedCategories.has(category)) {
						vscode.window.showInformationMessage(`${EXTENSION_TITLE}: Your quota for ${category} has been refilled to 100%.`);
						this.fullQuotaNotifiedCategories.add(category);
					}
				} else if (group.quota < 1) {
					this.fullQuotaNotifiedCategories.delete(category);
				}
			}
		} else {
			this.fullQuotaNotifiedCategories.clear();
		}

		const rawThreshold = config.get<number>('lowQuotaNotificationThreshold', 0);
		const threshold = typeof rawThreshold === 'number' && Number.isFinite(rawThreshold) ? rawThreshold : 0;
		if (threshold > 0) {
			for (const category of CATEGORY_ORDER) {
				const group = groups[category];
				if (!group) { continue; }
				const percentage = formatQuotaPercent(group.quota);
				if (percentage < threshold) {
					if (!this.lowQuotaNotifiedCategories.has(category)) {
						vscode.window.showWarningMessage(`${EXTENSION_TITLE}: ${category} has less than ${threshold}% quota remaining.`);
						this.lowQuotaNotifiedCategories.add(category);
					}
				} else if (percentage >= Math.min(100, threshold + LOW_QUOTA_REARM_MARGIN_PERCENT)) {
					this.lowQuotaNotifiedCategories.delete(category);
				}
			}
		} else {
			this.lowQuotaNotifiedCategories.clear();
		}
	}
}
