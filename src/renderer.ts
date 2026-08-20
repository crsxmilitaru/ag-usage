import * as vscode from 'vscode';
import { BUCKET_OPACITY, CATEGORY_ORDER, EXTENSION_TITLE, OPEN_PANEL_COMMAND, SETTINGS_COMMAND, SVG_CONFIG, THEME_COLORS } from './constants';
import { isAntigravityIde } from './environment';
import { formatQuotaPercent, formatRemainingTimeSeparate, formatStatusBarText } from './formatter';
import { QuotaGroup, UsageStatistics } from './types';
import { escapeHtml, getProgressStopIndex, isNotStartedQuota, isWeeklyLimitReached, sortQuotaBuckets } from './utils';

const LAYOUT = {
	cardPadding: 6,
	cardRadius: 10,
	textStyleStart: 'text-anchor="start" dominant-baseline="middle" font-family="system-ui, sans-serif"',
	textStyleEnd: 'text-anchor="end" dominant-baseline="middle" font-family="system-ui, sans-serif"'
};

const CARD_METRICS = {
	cardHeight: 148,
	svgHeight: 164,
	paddingLeft: 12,
	paddingRight: 12,
	headerY: 22,
	bodyY: 72,
	barY: 120,
	barHeight: 5,
	barRadius: 2.5,
	bucketRowHeight: 50,
	bucketRowGap: 8
};

const FONT_SIZE = {
	xs: 10,
	md: 14,
	lg: 16,
	xl: 18,
	xxl: 24
};

const OPACITY = {
	low: 0.4,
	medium: 0.6,
	high: 0.8
};

const MAX_GROUPS_VALIDATION = 100;

interface ThemeColors {
	text: string;
	barBackground: string;
	cardFill: string;
	cardBorder: string;
	success: string;
	warning: string;
	error: string;
	progress: string[];
}

interface CategorySvgOptions {
	category: string;
	group: QuotaGroup;
	xPosition: number;
	colors: ThemeColors;
	plan: string | undefined;
}

function getThemeColors(): ThemeColors {
	const { kind } = vscode.window.activeColorTheme;
	const isLight = kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight;
	return isLight ? THEME_COLORS.light : THEME_COLORS.dark;
}

function getBarColor(percentage: number, colors: ThemeColors): string {
	return colors.progress[getProgressStopIndex(percentage)];
}

function isValidQuotaGroup(value: unknown): value is QuotaGroup {
	if (!value || typeof value !== 'object') { return false; }
	const g = value as Record<string, unknown>;
	return typeof g.quota === 'number' && Number.isFinite(g.quota) &&
		(g.resetTime === null || (typeof g.resetTime === 'number' && Number.isFinite(g.resetTime)));
}

function buildProgressBarSvg(
	barX: number,
	barW: number,
	percentage: number,
	barColor: string,
	colors: ThemeColors,
	customBarY?: number,
	customBarHeight?: number
): string {
	const { barY: defaultBarY, barHeight: defaultBarHeight, barRadius } = CARD_METRICS;
	const barY = customBarY ?? defaultBarY;
	const barHeight = customBarHeight ?? defaultBarHeight;
	const elements: string[] = [];

	elements.push(`<rect x="${barX.toFixed(1)}" y="${barY.toFixed(1)}" rx="${barRadius}" width="${barW.toFixed(1)}" height="${barHeight}" fill="${colors.barBackground}"/>`);

	if (percentage > 0) {
		const fillWidth = ((percentage / 100) * barW).toFixed(1);
		elements.push(`<rect x="${barX.toFixed(1)}" y="${barY.toFixed(1)}" rx="${barRadius}" width="${fillWidth}" height="${barHeight}" fill="${barColor}"/>`);
	}

	return elements.join('\n\t\t');
}

function isValidUsageStatistics(data: unknown): data is UsageStatistics {
	if (!data || typeof data !== 'object') { return false; }
	const d = data as Record<string, unknown>;
	if (!d.groups || typeof d.groups !== 'object') { return false; }
	const groupValues = Object.values(d.groups);
	return groupValues.length <= MAX_GROUPS_VALIDATION && groupValues.every(isValidQuotaGroup);
}

function buildCategorySvg(options: CategorySvgOptions): string {
	const { category, group, xPosition, colors, plan } = options;
	const { columnWidth } = SVG_CONFIG;
	const { cardPadding, cardRadius, textStyleStart, textStyleEnd } = LAYOUT;
	const { cardHeight, paddingLeft, paddingRight, headerY, bodyY } = CARD_METRICS;

	const percentage = formatQuotaPercent(group.quota);
	const barColor = getBarColor(percentage, colors);
	const label = escapeHtml(category).toUpperCase();
	const resetMs = group.resetTime ? group.resetTime - Date.now() : 0;
	const weeklyLimitReached = typeof group.resetTime === 'number' && isWeeklyLimitReached(percentage, resetMs, plan);

	const cardX = xPosition + cardPadding;
	const cardW = columnWidth - (cardPadding * 2);
	const contentX = cardX + paddingLeft;
	const contentXEnd = cardX + cardW - paddingRight;
	const contentW = cardW - paddingLeft - paddingRight;

	let svg = `
		<rect x="${cardX}" y="${cardPadding}" rx="${cardRadius}" width="${cardW}" height="${cardHeight}" fill="${colors.cardFill}" stroke="${colors.cardBorder}" stroke-width="1"/>
		<text x="${contentX}" y="${headerY}" fill="${colors.text}" fill-opacity="${OPACITY.medium}" ${textStyleStart} font-size="${FONT_SIZE.xs}" font-weight="700" letter-spacing="1px">${label}</text>`;

	if (group.buckets?.length) {
		const sortedBuckets = sortQuotaBuckets(group.buckets);
		const weeklyBucket = sortedBuckets.find(b => b.window.toLowerCase() === 'weekly');
		const isWeeklyDepleted = weeklyBucket !== undefined && formatQuotaPercent(weeklyBucket.quota) === 0;

		sortedBuckets.slice(0, 2).forEach((bucket, index) => {
			const bucketPercentage = formatQuotaPercent(bucket.quota);
			const bucketColor = getBarColor(bucketPercentage, colors);
			const isWeekly = bucket.window.toLowerCase() === 'weekly';
			const bucketLabel = isWeekly ? 'Weekly' : bucket.window.toLowerCase() === '5h' ? '5h' : bucket.displayName;

			const { bucketRowHeight, bucketRowGap } = CARD_METRICS;
			const boxX = cardX + 6;
			const boxW = cardW - 12;
			const boxY = 32 + index * (bucketRowHeight + bucketRowGap);

			const labelY = boxY + 13;
			const percentY = boxY + 28;
			const barY = boxY + 39;
			const barHeight = 5;

			const itemInset = 4;
			const itemX = contentX + itemInset;
			const itemXEnd = contentXEnd - itemInset;
			const itemW = contentW - (itemInset * 2);

			const fillOpacity = isWeekly ? BUCKET_OPACITY.weeklyBg : BUCKET_OPACITY.defaultBg;
			const strokeOpacity = isWeekly ? BUCKET_OPACITY.weeklyBorder : BUCKET_OPACITY.defaultBorder;
			const isDisabled = !isWeekly && isWeeklyDepleted;

			if (isDisabled) {
				svg += `
		<g opacity="0.4">`;
			}

			svg += `
		<rect x="${boxX}" y="${boxY}" rx="6" width="${boxW}" height="${bucketRowHeight}" fill="${colors.text}" fill-opacity="${fillOpacity}" stroke="${colors.cardBorder}" stroke-opacity="${strokeOpacity}" stroke-width="1"/>`;

			svg += `
		<text x="${itemX}" y="${percentY}" fill="${bucketColor}" ${textStyleStart} font-size="${FONT_SIZE.xl}" font-weight="800">${bucketPercentage}%</text>`;

			svg += `
		<text x="${itemXEnd}" y="${labelY}" fill="${colors.text}" fill-opacity="${OPACITY.medium}" ${textStyleEnd} font-size="11" font-weight="650">${escapeHtml(bucketLabel)}</text>`;

			if (bucket.resetTime) {
				const bucketResetMs = bucket.resetTime - Date.now();
				let resetSvg: string;
				if (isNotStartedQuota(bucketPercentage, bucketResetMs)) {
					resetSvg = `<tspan fill-opacity="${OPACITY.medium}">Not started</tspan>`;
				} else {
					const timer = formatRemainingTimeSeparate(bucket.resetTime);
					const relText = escapeHtml(timer.relativeText);
					const absText = timer.absoluteText ? escapeHtml(timer.absoluteText) : null;

					if (absText) {
						resetSvg = `<tspan fill-opacity="${OPACITY.high}">${relText}</tspan><tspan fill-opacity="${OPACITY.medium}"> (${absText})</tspan>`;
					} else {
						resetSvg = `<tspan fill-opacity="${OPACITY.high}">${relText}</tspan>`;
					}
				}

				svg += `
		<text x="${itemXEnd}" y="${percentY}" fill="${colors.text}" ${textStyleEnd} font-size="11" font-weight="600">${resetSvg}</text>`;
			}

			svg += '\n\t\t' + buildProgressBarSvg(itemX, itemW, bucketPercentage, bucketColor, colors, barY, barHeight);

			if (isDisabled) {
				svg += `
		</g>`;
			}
		});
		return svg;
	}

	const isDepleted = percentage === 0;

	if (isDepleted) {
		if (typeof group.resetTime === 'number') {
			const timer = formatRemainingTimeSeparate(group.resetTime);
			const textColor = weeklyLimitReached ? colors.error : colors.text;
			svg += `
		<text x="${contentX}" y="${bodyY + 6}" fill="${textColor}" fill-opacity="${OPACITY.high}" ${textStyleStart} font-size="${FONT_SIZE.xl}" font-weight="700">~${escapeHtml(timer.relativeText)}</text>`;
			if (timer.absoluteText) {
				const parts = timer.absoluteText.split(/,\s*/);
				const dateText = parts.length > 1 ? parts[0] : null;
				const timeText = parts.length > 1 ? parts[parts.length - 1] : timer.absoluteText;
				svg += `
		<text x="${contentXEnd}" y="${bodyY}" fill="${textColor}" fill-opacity="${OPACITY.medium}" ${textStyleEnd} font-size="${FONT_SIZE.xs}" font-weight="500">${escapeHtml(timeText)}</text>`;
				if (dateText) {
					svg += `
		<text x="${contentXEnd}" y="${bodyY + 13}" fill="${textColor}" fill-opacity="${OPACITY.medium}" ${textStyleEnd} font-size="${FONT_SIZE.xs}" font-weight="500">${escapeHtml(dateText)}</text>`;
				}
			}
		} else {
			svg += `
		<text x="${contentX}" y="${bodyY + 6}" fill="${colors.text}" fill-opacity="${OPACITY.low}" ${textStyleStart} font-size="${FONT_SIZE.lg}" font-weight="700">Depleted</text>`;
		}
	} else {
		svg += `
		<text x="${contentX}" y="${bodyY + 6}" fill="${barColor}" ${textStyleStart} font-size="${FONT_SIZE.xxl}" font-weight="800">${percentage}%</text>`;

		if (typeof group.resetTime === 'number') {
			if (isNotStartedQuota(percentage, resetMs)) {
				svg += `
		<text x="${contentXEnd}" y="${bodyY}" fill="${colors.text}" fill-opacity="${OPACITY.medium}" ${textStyleEnd} font-size="${FONT_SIZE.md}" font-weight="600">Not started</text>`;
			} else {
				const timer = formatRemainingTimeSeparate(group.resetTime);
				const textColor = weeklyLimitReached ? colors.error : colors.text;
				svg += `
		<text x="${contentXEnd}" y="${bodyY}" fill="${textColor}" fill-opacity="${OPACITY.high}" ${textStyleEnd} font-size="${FONT_SIZE.md}" font-weight="600">~${escapeHtml(timer.relativeText)}</text>`;

				if (timer.absoluteText) {
					svg += `
		<text x="${contentXEnd}" y="${bodyY + 13}" fill="${textColor}" fill-opacity="${OPACITY.medium}" ${textStyleEnd} font-size="${FONT_SIZE.xs}" font-weight="500">${escapeHtml(timer.absoluteText)}</text>`;
				}
			}
		}
	}

	svg += '\n\t\t' + buildProgressBarSvg(contentX, contentW, percentage, barColor, colors);

	return svg;
}

function buildSvgContent(categories: string[], groups: Record<string, QuotaGroup>, plan: string | undefined): string {
	const { columnWidth, columnPadding } = SVG_CONFIG;
	const colors = getThemeColors();

	const totalWidth = categories.length > 0
		? categories.length * columnWidth + (categories.length - 1) * columnPadding
		: columnWidth;

	let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${totalWidth}" height="${CARD_METRICS.svgHeight}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${EXTENSION_TITLE} Statistics">`;

	categories.forEach((category, index) => {
		const group = groups[category];
		if (group) {
			const xPosition = index * (columnWidth + columnPadding);
			svg += buildCategorySvg({
				category,
				group,
				xPosition,
				colors,
				plan
			});
		}
	});

	svg += '</svg>';
	return svg;
}

export function renderStats(data: UsageStatistics): { text: string; tooltip: vscode.MarkdownString } {
	if (!isValidUsageStatistics(data)) {
		return {
			text: `$(warning) ${EXTENSION_TITLE}`,
			tooltip: new vscode.MarkdownString('Invalid data received from server.')
		};
	}

	const { groups } = data;
	const categories = CATEGORY_ORDER.filter(category => groups[category]);
	const weeklyPlanLabel = `${data.plan ?? ''} ${data.planName ?? ''}`.trim() || undefined;

	const svgContent = buildSvgContent(categories, groups, weeklyPlanLabel);

	const rawPlanDisplay = data.planName ?? data.plan ?? 'Plan unavailable';
	const planDisplay = escapeHtml(rawPlanDisplay);

	const tooltip = new vscode.MarkdownString();
	tooltip.appendMarkdown(`<img src="data:image/svg+xml;base64,${Buffer.from(svgContent).toString('base64')}"/>\n\n`);
	const modelsLink = isAntigravityIde() ? ' · <a href="command:ag-usage.openModelsSettings">Models</a>' : '';
	tooltip.appendMarkdown(`<div align="center"><strong>${planDisplay}</strong> · <a href="command:${OPEN_PANEL_COMMAND}">Dashboard</a>${modelsLink} · <a href="command:${SETTINGS_COMMAND}">Settings</a></div>`);
	tooltip.isTrusted = true;
	tooltip.supportHtml = true;

	return {
		text: formatStatusBarText(groups, categories),
		tooltip
	};
}
