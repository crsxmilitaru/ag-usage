import * as vscode from 'vscode';
import { CATEGORY_ORDER, EXTENSION_TITLE, OPEN_PANEL_COMMAND, PROGRESS_BUCKET_BOUNDARIES, SETTINGS_COMMAND, SVG_CONFIG, THEME_COLORS } from './constants';
import { formatQuotaPercent, formatRemainingTimeSeparate, formatStatusBarText } from './formatter';
import { QuotaGroup, UsageStatistics } from './types';
import { isNotStartedQuota, isWeeklyLimitReached } from './utils';

const LAYOUT = {
	cardPadding: 6,
	cardRadius: 10,
	textStyleStart: 'text-anchor="start" dominant-baseline="middle" font-family="system-ui, sans-serif"',
	textStyleEnd: 'text-anchor="end" dominant-baseline="middle" font-family="system-ui, sans-serif"'
};

const CARD_METRICS = {
	cardHeight: 84,
	svgHeight: 100,
	paddingLeft: 12,
	paddingRight: 12,
	headerY: 22,
	bodyY: 46,
	barY: 74,
	barHeight: 4,
	barRadius: 2,
	segments: 5,
	segmentGap: 3
};

const FONT_SIZE = {
	xs: 10,
	sm: 12,
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

const XML_ESCAPES: Record<string, string> = {
	'<': '&lt;',
	'>': '&gt;',
	'&': '&amp;',
	'"': '&quot;',
	"'": '&apos;'
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
	const idx = PROGRESS_BUCKET_BOUNDARIES.findIndex(b => percentage < b);
	return colors.progress[idx === -1 ? colors.progress.length - 1 : idx];
}

function escapeXml(text: string): string {
	return text.replace(/[<>&"']/g, char => XML_ESCAPES[char] ?? char);
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
	colors: ThemeColors
): string {
	const { barY, barHeight, barRadius, segments, segmentGap } = CARD_METRICS;
	const segmentWidth = (barW - (segmentGap * (segments - 1))) / segments;
	const elements: string[] = [];

	for (let i = 0; i < segments; i++) {
		const segX = (barX + i * (segmentWidth + segmentGap)).toFixed(1);
		const sw = segmentWidth.toFixed(1);
		elements.push(`<rect x="${segX}" y="${barY}" rx="${barRadius}" width="${sw}" height="${barHeight}" fill="${colors.barBackground}"/>`);

		const startPct = i * 20;
		const fillPct = Math.max(0, Math.min(100, (percentage - startPct) * 5));
		if (fillPct > 0) {
			const fillWidth = ((fillPct / 100) * segmentWidth).toFixed(1);
			elements.push(`<rect x="${segX}" y="${barY}" rx="${barRadius}" width="${fillWidth}" height="${barHeight}" fill="${barColor}"/>`);
		}
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
	const label = escapeXml(category).toUpperCase();
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

	const isDepleted = percentage === 0;

	if (isDepleted) {
		if (typeof group.resetTime === 'number') {
			const timer = formatRemainingTimeSeparate(group.resetTime);
			const textColor = weeklyLimitReached ? colors.error : colors.text;
			svg += `
		<text x="${contentX}" y="${bodyY + 6}" fill="${textColor}" fill-opacity="${OPACITY.high}" ${textStyleStart} font-size="${FONT_SIZE.xl}" font-weight="700">~${escapeXml(timer.relativeText)}</text>`;
			if (timer.absoluteText) {
				const parts = timer.absoluteText.split(/,\s*/);
				const dateText = parts.length > 1 ? parts[0] : null;
				const timeText = parts.length > 1 ? parts[parts.length - 1] : timer.absoluteText;
				svg += `
		<text x="${contentXEnd}" y="${bodyY}" fill="${textColor}" fill-opacity="${OPACITY.medium}" ${textStyleEnd} font-size="${FONT_SIZE.xs}" font-weight="500">${escapeXml(timeText)}</text>`;
				if (dateText) {
					svg += `
		<text x="${contentXEnd}" y="${bodyY + 13}" fill="${textColor}" fill-opacity="${OPACITY.medium}" ${textStyleEnd} font-size="${FONT_SIZE.xs}" font-weight="500">${escapeXml(dateText)}</text>`;
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
			const timer = formatRemainingTimeSeparate(group.resetTime);
			const textColor = weeklyLimitReached ? colors.error : colors.text;
			svg += `
		<text x="${contentXEnd}" y="${bodyY}" fill="${textColor}" fill-opacity="${OPACITY.high}" ${textStyleEnd} font-size="${FONT_SIZE.md}" font-weight="600">~${escapeXml(timer.relativeText)}</text>`;

			if (timer.absoluteText) {
				svg += `
		<text x="${contentXEnd}" y="${bodyY + 13}" fill="${textColor}" fill-opacity="${OPACITY.medium}" ${textStyleEnd} font-size="${FONT_SIZE.xs}" font-weight="500">${escapeXml(timer.absoluteText)}</text>`;
			}
		} else if (isNotStartedQuota(percentage, resetMs)) {
			svg += `
		<text x="${contentXEnd}" y="${bodyY}" fill="${colors.text}" fill-opacity="${OPACITY.medium}" ${textStyleEnd} font-size="${FONT_SIZE.sm}" font-weight="500">Not started</text>`;
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
	const plan = data.plan?.toLowerCase() ?? 'free';
	const weeklyPlanLabel = `${data.plan ?? ''} ${data.planName ?? ''}`.trim() || plan;

	const svgContent = buildSvgContent(categories, groups, weeklyPlanLabel);

	const rawPlanDisplay = data.planName ?? plan.replace(/\b\w/g, c => c.toUpperCase());
	const planDisplay = escapeXml(rawPlanDisplay);

	const tooltip = new vscode.MarkdownString();
	tooltip.appendMarkdown(`<img src="data:image/svg+xml;base64,${Buffer.from(svgContent).toString('base64')}"/>\n\n`);
	tooltip.appendMarkdown(`<div align="center"><strong>${planDisplay}</strong> · <a href="command:${OPEN_PANEL_COMMAND}">Dashboard</a> · <a href="command:ag-usage.openModelsSettings">Models</a> · <a href="command:${SETTINGS_COMMAND}">Settings</a></div>`);
	tooltip.isTrusted = true;
	tooltip.supportHtml = true;

	return {
		text: formatStatusBarText(groups, categories),
		tooltip
	};
}
