import * as vscode from 'vscode';
import { CATEGORY_ORDER, CONFIG_NAMESPACE, EXTENSION_TITLE } from './constants';
import { UsageStatistics } from './types';

export class NotificationManager {
	private fullQuotaNotifiedCategories = new Set<string>();
	private lowQuotaNotifiedCategories = new Set<string>();

	public clear(): void {
		this.fullQuotaNotifiedCategories.clear();
		this.lowQuotaNotifiedCategories.clear();
	}

	public checkQuotaNotifications(statsData: UsageStatistics, previousStatsData: UsageStatistics | null = null): void {
		const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
		if (config.get<boolean>('notifyOnFullQuota')) {
			const { groups } = statsData;
			for (const category of CATEGORY_ORDER) {
				const group = groups[category];
				if (group) {
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
			}
		}

		const threshold = config.get<number>('lowQuotaNotificationThreshold', 0);
		if (threshold > 0) {
			const { groups } = statsData;
			for (const category of CATEGORY_ORDER) {
				const group = groups[category];
				if (group) {
					const percentage = group.quota * 100;
					if (percentage < threshold) {
						if (!this.lowQuotaNotifiedCategories.has(category)) {
							vscode.window.showWarningMessage(`${EXTENSION_TITLE}: ${category} has less than ${threshold}% quota remaining.`);
							this.lowQuotaNotifiedCategories.add(category);
						}
					} else {
						this.lowQuotaNotifiedCategories.delete(category);
					}
				}
			}
		}
	}
}
