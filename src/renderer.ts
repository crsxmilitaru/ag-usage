import * as vscode from 'vscode';
import { CATEGORY_ORDER, COLOR_THRESHOLDS, EXTENSION_TITLE, MS_PER_HOUR, MS_PER_MINUTE, OPEN_PANEL_COMMAND, SETTINGS_COMMAND, SVG_CONFIG, THEME_COLORS } from './constants';
import { formatQuotaPercent, formatRemainingTimeSeparate, formatStatusBarText } from './formatter';
import { QuotaGroup, UsageStatistics } from './types';
import { isNotStartedQuota } from './utils';

const PLAN = {
  FREE: 'free',
  PRO: 'pro',
  ULTRA: 'ultra'
} as const;

type PlanType = typeof PLAN[keyof typeof PLAN];

const LAYOUT = {
  cardPadding: 5,
  cardRadius: 10,
  textYCategory: 20,
  textYPercent: 46,
  barY: 65,
  barHeight: 5,
  barRadius: 2.5,
  textStyle: 'text-anchor="middle" dominant-baseline="middle" font-family="system-ui, sans-serif"'
};

const LAYOUT_COMPACT = {
  cardHeight: 116,
  svgHeight: 126,
  separatorY: 82,
  textYTime: 98
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
}

interface CategorySvgOptions {
  category: string;
  group: QuotaGroup;
  xPosition: number;
  colors: ThemeColors;
  plan: PlanType;
}

function getThemeColors(): ThemeColors {
  const { kind } = vscode.window.activeColorTheme;
  const isLight = kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight;
  return isLight ? THEME_COLORS.light : THEME_COLORS.dark;
}

function getBarColor(percentage: number, colors: ThemeColors): string {
  const { high, medium } = COLOR_THRESHOLDS;
  if (percentage >= high.value) return colors.success;
  if (percentage >= medium.value) return colors.warning;
  return colors.error;
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

function buildClockSvg(centerX: number, clockY: number, color: string, opacity: number): string {
  return `
    <circle cx="${centerX}" cy="${clockY}" r="7" stroke="${color}" stroke-width="1.5" fill="none" opacity="${opacity}"/>
    <line x1="${centerX}" y1="${clockY}" x2="${centerX}" y2="${clockY - 4.5}" stroke="${color}" stroke-width="1.5" stroke-linecap="round" opacity="${opacity}">
      <animateTransform attributeName="transform" type="rotate" from="0 ${centerX} ${clockY}" to="360 ${centerX} ${clockY}" dur="12s" repeatCount="indefinite" />
    </line>
    <line x1="${centerX}" y1="${clockY}" x2="${centerX + 3}" y2="${clockY}" stroke="${color}" stroke-width="1.5" stroke-linecap="round" opacity="${opacity}">
      <animateTransform attributeName="transform" type="rotate" from="0 ${centerX} ${clockY}" to="360 ${centerX} ${clockY}" dur="144s" repeatCount="indefinite" />
    </line>`;
}

function buildCountdownSvg(centerX: number, y: number, relative: string, absolute: string | null, color: string): string {
  if (!absolute) {
    return `<text x="${centerX}" y="${y}" fill="${color}" fill-opacity="${OPACITY.high}" ${LAYOUT.textStyle} font-size="14" font-weight="600">${relative}</text>`;
  }
  return `
    <text x="${centerX}" y="${y - 5}" fill="${color}" fill-opacity="${OPACITY.high}" ${LAYOUT.textStyle} font-size="14" font-weight="600">${relative}</text>
    <text x="${centerX}" y="${y + 11}" fill="${color}" fill-opacity="${OPACITY.medium}" ${LAYOUT.textStyle} font-size="10" font-weight="500">${absolute}</text>`;
}

function buildTimeLeftSvg(centerX: number, y: number, timer: ReturnType<typeof formatRemainingTimeSeparate>, colors: ThemeColors, isWeeklyQuotaTriggered: boolean, showLabel: boolean): string {
  const color = isWeeklyQuotaTriggered && !showLabel ? colors.error : (timer.diffMs < 10 * MS_PER_MINUTE ? colors.success : colors.text);
  const countdown = buildCountdownSvg(centerX, y, escapeXml(timer.relativeText), timer.absoluteText ? escapeXml(timer.absoluteText) : null, color);

  if (isWeeklyQuotaTriggered && showLabel) {
    const textY1 = LAYOUT_COMPACT.textYTime;
    const textY2 = textY1 + 10;

    return countdown +
      `<text x="${centerX}" y="${textY1}" fill="${colors.error}" ${LAYOUT.textStyle} font-size="9" font-weight="600">WEEKLY QUOTA</text>` +
      `<text x="${centerX}" y="${textY2}" fill="${colors.error}" ${LAYOUT.textStyle} font-size="9" font-weight="600">EXCEEDED</text>`;
  }

  return countdown;
}

function buildZeroPercentState(centerX: number, centerY: number, resetTime: number, colors: ThemeColors, isWeeklyQuotaTriggered: boolean): string {
  const timer = formatRemainingTimeSeparate(resetTime);
  const color = timer.diffMs < 10 * MS_PER_MINUTE ? colors.success : colors.text;
  const clockY = isWeeklyQuotaTriggered ? centerY - 24 : centerY - 15;
  const timeY = isWeeklyQuotaTriggered ? centerY + 6 : centerY + 15;
  return buildClockSvg(centerX, clockY, color, OPACITY.medium) + buildTimeLeftSvg(centerX, timeY, timer, colors, isWeeklyQuotaTriggered, true);
}

function buildProgressBarSvg(centerX: number, textYPercent: number, percentage: number, barColor: string, barY: number, barWidth: number, barHeight: number, barRadius: number, barBackground: string): string {
  const barX = centerX - (barWidth / 2);
  const segments = 5;
  const gap = 2;
  const segmentWidth = (barWidth - (gap * (segments - 1))) / segments;

  const elements = [
    `<text x="${centerX}" y="${textYPercent}" fill="${barColor}" ${LAYOUT.textStyle} font-size="18" font-weight="700">${percentage}%</text>`
  ];

  for (let i = 0; i < segments; i++) {
    const segX = (barX + i * (segmentWidth + gap)).toFixed(1);
    const sw = segmentWidth.toFixed(1);
    elements.push(`<rect x="${segX}" y="${barY}" rx="${barRadius}" width="${sw}" height="${barHeight}" fill="${barBackground}"/>`);

    const startPct = i * 20;
    const fillPct = Math.max(0, Math.min(100, (percentage - startPct) * 5));
    if (fillPct > 0) {
      const fillWidth = ((fillPct / 100) * segmentWidth).toFixed(1);
      elements.push(`<rect x="${segX}" y="${barY}" rx="${barRadius}" width="${fillWidth}" height="${barHeight}" fill="${barColor}"/>`);
    }
  }

  return '\n    ' + elements.join('\n    ');
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
  const { columnWidth, barWidth } = SVG_CONFIG;
  const { cardPadding, cardRadius, textYCategory, textYPercent, barY, barHeight, barRadius } = LAYOUT;

  const centerX = xPosition + columnWidth / 2;
  const percentage = formatQuotaPercent(group.quota);
  const barColor = getBarColor(percentage, colors);
  const label = escapeXml(category).toUpperCase();
  const resetMs = group.resetTime ? group.resetTime - Date.now() : 0;
  const isWeeklyQuotaTriggered = (plan === PLAN.PRO || plan === PLAN.ULTRA) && resetMs > 18 * MS_PER_HOUR;

  const cardX = xPosition + cardPadding;
  const cardW = columnWidth - (cardPadding * 2);

  let svg = `
    <rect x="${cardX}" y="${cardPadding}" rx="${cardRadius}" width="${cardW}" height="${LAYOUT_COMPACT.cardHeight}" fill="${colors.cardFill}" stroke="${colors.cardBorder}" stroke-width="1"/>
    <text x="${centerX}" y="${textYCategory}" fill="${colors.text}" fill-opacity="${OPACITY.high}" ${LAYOUT.textStyle} font-size="9" font-weight="500" letter-spacing="0.5">${label}</text>`;

  if (percentage === 0 && typeof group.resetTime === 'number') {
    return svg + buildZeroPercentState(centerX, cardPadding + LAYOUT_COMPACT.cardHeight / 2, group.resetTime, colors, isWeeklyQuotaTriggered);
  }

  svg += buildProgressBarSvg(centerX, textYPercent, percentage, barColor, barY, barWidth, barHeight, barRadius, colors.barBackground);

  if (isNotStartedQuota(percentage, resetMs)) {
    const notStartedY = (barY + barHeight + cardPadding + LAYOUT_COMPACT.cardHeight) / 2 + 4;
    svg += `<text x="${centerX}" y="${notStartedY}" fill="${colors.text}" fill-opacity="${OPACITY.low}" ${LAYOUT.textStyle} font-size="11" font-weight="500">Not started</text>`;
    return svg;
  }

  if (typeof group.resetTime === 'number') {
    svg += buildTimeLeftSvg(centerX, LAYOUT_COMPACT.textYTime, formatRemainingTimeSeparate(group.resetTime), colors, isWeeklyQuotaTriggered, false);
  }

  return svg;
}

function buildSvgContent(categories: string[], groups: Record<string, QuotaGroup>, plan: PlanType): string {
  const { columnWidth, columnPadding } = SVG_CONFIG;
  const colors = getThemeColors();

  const totalWidth = categories.length > 0
    ? categories.length * columnWidth + (categories.length - 1) * columnPadding
    : columnWidth;

  let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${totalWidth}" height="${LAYOUT_COMPACT.svgHeight}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${EXTENSION_TITLE} Statistics">`;

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
  const plan = (data.plan?.toLowerCase() as PlanType) ?? PLAN.FREE;

  const svgContent = buildSvgContent(categories, groups, plan);

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
