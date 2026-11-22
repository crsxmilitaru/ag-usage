import * as vscode from 'vscode';
import {
	CONFIG_NAMESPACE,
	DEFAULT_LIVE_SYNC,
	DEFAULT_MAX_HISTORY_ITEMS,
	DEFAULT_REFRESH_INTERVAL,
	DEFAULT_STATUS_BAR_DISPLAY,
	DISPLAY_MODE_TO_CATEGORY,
	MAX_MAX_HISTORY_ITEMS,
	MAX_REFRESH_INTERVAL_SECONDS,
	MIN_MAX_HISTORY_ITEMS,
	MIN_REFRESH_INTERVAL_SECONDS,
	PANEL_SECTION_IDS,
	PANEL_SECTION_LABELS,
	STATUS_BAR_DISPLAY_ITEMS,
	STATUS_BAR_PRIORITY
} from '../constants';
import { AbsoluteTimeFormat, ResetTimeDisplayMode, StatusBarDisplayItem } from '../types';
import {
	escapeHtml,
	normalizeMaxHistoryItems,
	normalizePanelSectionLayout,
	normalizeRefreshIntervalSeconds,
	normalizeStatusBarItems,
	PanelSectionSlot,
	serializePanelSectionLayout
} from '../utils';
import { CHEVRON_DOWN_SVG, CHEVRON_UP_SVG, ERROR_CIRCLE_PATH } from './screens';

export const PANEL_SETTING_KEYS = [
	'liveSync',
	'refreshInterval',
	'pauseWhenUnfocused',
	'statusBarDisplay',
	'statusBarLimitDisplay',
	'statusBarCountdown',
	'statusBarWeeklyReset',
	'statusBarAlignment',
	'statusBarPriority',
	'notifyOnFullQuota',
	'lowQuotaNotificationThreshold',
	'resetTimeDisplay',
	'absoluteTimeFormat',
	'dateFormatLocale',
	'enableHistoryTracking',
	'maxHistoryItems',
	'enablePublicStatus',
	'panelSections'
] as const;

export type PanelSettingKey = typeof PANEL_SETTING_KEYS[number];

export type PanelStatusBarLimitDisplay = '5h' | 'weekly' | 'both';
export type PanelStatusBarAlignment = 'Left' | 'Right';

export interface PanelSettingsState {
	liveSync: boolean;
	refreshInterval: number;
	pauseWhenUnfocused: boolean;
	statusBarDisplay: StatusBarDisplayItem[];
	statusBarLimitDisplay: PanelStatusBarLimitDisplay;
	statusBarCountdown: boolean;
	statusBarWeeklyReset: boolean;
	statusBarAlignment: PanelStatusBarAlignment;
	statusBarPriority: number;
	notifyOnFullQuota: boolean;
	lowQuotaNotificationThreshold: number;
	resetTimeDisplay: ResetTimeDisplayMode;
	absoluteTimeFormat: AbsoluteTimeFormat;
	dateFormatLocale: string;
	enableHistoryTracking: boolean;
	maxHistoryItems: number;
	enablePublicStatus: boolean;
	panelSections: PanelSectionSlot[];
	modifiedKeys: PanelSettingKey[];
}

const MIN_PRIORITY = -100000;
const MAX_PRIORITY = 100000;
const MAX_LOCALE_LENGTH = 64;

const COMMON_LOCALES = [
	'default',
	'en-US',
	'en-GB',
	'de-DE',
	'fr-FR',
	'es-ES',
	'it-IT',
	'pt-BR',
	'ro-RO',
	'ja-JP',
	'ko-KR',
	'zh-CN'
] as const;

const RESET_ICON_SVG = '<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M3.5 8a4.5 4.5 0 1 1 1.32 3.18l-.88.88A5.75 5.75 0 1 0 2.25 8H.5l2.38 2.5L5.25 8H3.5z"/></svg>';
const BACK_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M10.5 2.5L5 8l5.5 5.5-.7.7L3.6 8l6.2-6.2.7.7z"/></svg>';
const EXTERNAL_SETTINGS_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M9.5 2H14v4.5h-1.2V4.05L7.65 9.2l-.85-.85L11.95 3.2H9.5V2zM3 4.5A1.5 1.5 0 0 1 4.5 3H8v1.2H4.5a.3.3 0 0 0-.3.3v7a.3.3 0 0 0 .3.3h7a.3.3 0 0 0 .3-.3V8H13v3.5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 11.5v-7z"/></svg>';
const ERROR_ICON_SVG = `<svg width="12" height="12" viewBox="0 0 16 16" role="img" aria-label="Error"><path fill="currentColor" d="${ERROR_CIRCLE_PATH}"/></svg>`;

export function isPanelSettingKey(key: string): key is PanelSettingKey {
	return (PANEL_SETTING_KEYS as readonly string[]).includes(key);
}

export function getSettingUpdateTarget(key: PanelSettingKey): vscode.ConfigurationTarget {
	const inspect = vscode.workspace.getConfiguration(CONFIG_NAMESPACE).inspect(key);
	if (inspect?.workspaceValue !== undefined || inspect?.workspaceLanguageValue !== undefined) {
		return vscode.ConfigurationTarget.Workspace;
	}
	return vscode.ConfigurationTarget.Global;
}

function normalizeStatusBarLimitDisplay(value: unknown): PanelStatusBarLimitDisplay {
	if (value === '5h' || value === 'only5h') { return '5h'; }
	if (value === 'weekly') { return 'weekly'; }
	return 'both';
}

function normalizeResetTimeDisplay(value: unknown): ResetTimeDisplayMode {
	if (value === 'relative' || value === 'absolute') { return value; }
	return 'both';
}

function normalizeAbsoluteTimeFormat(value: unknown): AbsoluteTimeFormat {
	return value === '12h' ? '12h' : '24h';
}

function normalizeStatusBarAlignment(value: unknown): PanelStatusBarAlignment {
	return value === 'Left' ? 'Left' : 'Right';
}

function normalizeLowQuotaThreshold(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) { return 0; }
	return Math.min(100, Math.max(0, Math.round(value)));
}

function normalizePriority(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) { return STATUS_BAR_PRIORITY; }
	return Math.min(MAX_PRIORITY, Math.max(MIN_PRIORITY, Math.round(value)));
}

function normalizeDateFormatLocale(value: unknown): string {
	if (typeof value !== 'string') { return 'default'; }
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : 'default';
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((item, index) => item === b[index]);
}

function collectModifiedKeys(state: Omit<PanelSettingsState, 'modifiedKeys'>): PanelSettingKey[] {
	const modified: PanelSettingKey[] = [];
	if (state.liveSync !== DEFAULT_LIVE_SYNC) { modified.push('liveSync'); }
	if (state.refreshInterval !== DEFAULT_REFRESH_INTERVAL) { modified.push('refreshInterval'); }
	if (state.pauseWhenUnfocused !== true) { modified.push('pauseWhenUnfocused'); }
	if (!arraysEqual(state.statusBarDisplay, DEFAULT_STATUS_BAR_DISPLAY)) { modified.push('statusBarDisplay'); }
	if (state.statusBarLimitDisplay !== 'both') { modified.push('statusBarLimitDisplay'); }
	if (state.statusBarCountdown !== true) { modified.push('statusBarCountdown'); }
	if (state.statusBarWeeklyReset !== false) { modified.push('statusBarWeeklyReset'); }
	if (state.statusBarAlignment !== 'Right') { modified.push('statusBarAlignment'); }
	if (state.statusBarPriority !== STATUS_BAR_PRIORITY) { modified.push('statusBarPriority'); }
	if (state.notifyOnFullQuota !== false) { modified.push('notifyOnFullQuota'); }
	if (state.lowQuotaNotificationThreshold !== 0) { modified.push('lowQuotaNotificationThreshold'); }
	if (state.resetTimeDisplay !== 'both') { modified.push('resetTimeDisplay'); }
	if (state.absoluteTimeFormat !== '24h') { modified.push('absoluteTimeFormat'); }
	if (state.dateFormatLocale !== 'default') { modified.push('dateFormatLocale'); }
	if (state.enableHistoryTracking !== true) { modified.push('enableHistoryTracking'); }
	if (state.maxHistoryItems !== DEFAULT_MAX_HISTORY_ITEMS) { modified.push('maxHistoryItems'); }
	if (state.enablePublicStatus !== true) { modified.push('enablePublicStatus'); }
	if (!arraysEqual(serializePanelSectionLayout(state.panelSections), PANEL_SECTION_IDS)) { modified.push('panelSections'); }
	return modified;
}

export function readPanelSettings(): PanelSettingsState {
	const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
	const values: Omit<PanelSettingsState, 'modifiedKeys'> = {
		liveSync: config.get<boolean>('liveSync', DEFAULT_LIVE_SYNC),
		refreshInterval: normalizeRefreshIntervalSeconds(config.get<number>('refreshInterval', DEFAULT_REFRESH_INTERVAL)),
		pauseWhenUnfocused: config.get<boolean>('pauseWhenUnfocused', true),
		statusBarDisplay: normalizeStatusBarItems(config.get<unknown>('statusBarDisplay', [...DEFAULT_STATUS_BAR_DISPLAY])),
		statusBarLimitDisplay: normalizeStatusBarLimitDisplay(config.get<unknown>('statusBarLimitDisplay', 'both')),
		statusBarCountdown: config.get<boolean>('statusBarCountdown', true),
		statusBarWeeklyReset: config.get<boolean>('statusBarWeeklyReset', false),
		statusBarAlignment: normalizeStatusBarAlignment(config.get<unknown>('statusBarAlignment', 'Right')),
		statusBarPriority: normalizePriority(config.get<number>('statusBarPriority', STATUS_BAR_PRIORITY)),
		notifyOnFullQuota: config.get<boolean>('notifyOnFullQuota', false),
		lowQuotaNotificationThreshold: normalizeLowQuotaThreshold(config.get<number>('lowQuotaNotificationThreshold', 0)),
		resetTimeDisplay: normalizeResetTimeDisplay(config.get<unknown>('resetTimeDisplay', 'both')),
		absoluteTimeFormat: normalizeAbsoluteTimeFormat(config.get<unknown>('absoluteTimeFormat', '24h')),
		dateFormatLocale: normalizeDateFormatLocale(config.get<unknown>('dateFormatLocale', 'default')),
		enableHistoryTracking: config.get<boolean>('enableHistoryTracking', true),
		maxHistoryItems: normalizeMaxHistoryItems(config.get<number>('maxHistoryItems', DEFAULT_MAX_HISTORY_ITEMS)),
		enablePublicStatus: config.get<boolean>('enablePublicStatus', true),
		panelSections: normalizePanelSectionLayout(config.get<unknown>('panelSections'))
	};

	return {
		...values,
		modifiedKeys: collectModifiedKeys(values)
	};
}

function validatePanelSettingValue(key: PanelSettingKey, rawValue: unknown): { value: unknown } | null {
	switch (key) {
		case 'liveSync':
		case 'pauseWhenUnfocused':
		case 'statusBarCountdown':
		case 'statusBarWeeklyReset':
		case 'notifyOnFullQuota':
		case 'enableHistoryTracking':
		case 'enablePublicStatus':
			return typeof rawValue === 'boolean' ? { value: rawValue } : null;
		case 'refreshInterval': {
			if (typeof rawValue !== 'number' || !Number.isFinite(rawValue) || !Number.isInteger(rawValue)) { return null; }
			if (rawValue < 0 || rawValue > MAX_REFRESH_INTERVAL_SECONDS || (rawValue > 0 && rawValue < MIN_REFRESH_INTERVAL_SECONDS)) { return null; }
			return { value: rawValue };
		}
		case 'statusBarDisplay': {
			if (!Array.isArray(rawValue)) { return null; }
			const validSet = new Set<string>(STATUS_BAR_DISPLAY_ITEMS);
			if (rawValue.some(item => typeof item !== 'string' || !validSet.has(item))) { return null; }
			return { value: normalizeStatusBarItems(rawValue) };
		}
		case 'statusBarLimitDisplay':
			return rawValue === '5h' || rawValue === 'weekly' || rawValue === 'both' ? { value: rawValue } : null;
		case 'statusBarAlignment':
			return rawValue === 'Left' || rawValue === 'Right' ? { value: rawValue } : null;
		case 'statusBarPriority': {
			if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) { return null; }
			if (rawValue < MIN_PRIORITY || rawValue > MAX_PRIORITY) { return null; }
			return { value: Math.round(rawValue) };
		}
		case 'lowQuotaNotificationThreshold': {
			if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) { return null; }
			if (rawValue < 0 || rawValue > 100) { return null; }
			return { value: Math.round(rawValue) };
		}
		case 'resetTimeDisplay':
			return rawValue === 'relative' || rawValue === 'absolute' || rawValue === 'both' ? { value: rawValue } : null;
		case 'absoluteTimeFormat':
			return rawValue === '24h' || rawValue === '12h' ? { value: rawValue } : null;
		case 'dateFormatLocale': {
			if (typeof rawValue !== 'string') { return null; }
			const trimmed = rawValue.trim();
			if (trimmed.length === 0 || trimmed.toLowerCase() === 'default') {
				return { value: 'default' };
			}
			if (trimmed.length > MAX_LOCALE_LENGTH) { return null; }
			try {
				new Intl.DateTimeFormat(trimmed);
				return { value: trimmed };
			} catch {
				return null;
			}
		}
		case 'maxHistoryItems': {
			if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) { return null; }
			if (rawValue < MIN_MAX_HISTORY_ITEMS || rawValue > MAX_MAX_HISTORY_ITEMS) { return null; }
			return { value: normalizeMaxHistoryItems(rawValue) };
		}
		case 'panelSections': {
			if (!Array.isArray(rawValue)) { return null; }
			return { value: serializePanelSectionLayout(normalizePanelSectionLayout(rawValue)) };
		}
	}
}

export async function updatePanelSetting(key: string, rawValue: unknown): Promise<boolean> {
	if (!isPanelSettingKey(key)) { return false; }
	const validated = validatePanelSettingValue(key, rawValue);
	if (!validated) { return false; }
	const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
	await config.update(key, validated.value, getSettingUpdateTarget(key));
	return true;
}

export async function resetPanelSetting(key: string): Promise<boolean> {
	if (!isPanelSettingKey(key)) { return false; }
	const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
	const inspect = config.inspect(key);
	let updated = false;
	if (inspect?.workspaceValue !== undefined) {
		await config.update(key, undefined, vscode.ConfigurationTarget.Workspace);
		updated = true;
	}
	if (inspect?.globalValue !== undefined || !updated) {
		await config.update(key, undefined, vscode.ConfigurationTarget.Global);
	}
	return true;
}

export async function resetAllPanelSettings(): Promise<void> {
	const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
	for (const key of PANEL_SETTING_KEYS) {
		const inspect = config.inspect(key);
		if (inspect?.workspaceValue !== undefined) {
			await config.update(key, undefined, vscode.ConfigurationTarget.Workspace);
		}
		if (inspect?.globalValue !== undefined) {
			await config.update(key, undefined, vscode.ConfigurationTarget.Global);
		}
	}
}

function buildResetButton(key: PanelSettingKey, label: string, modified: boolean): string {
	const hiddenAttr = modified ? '' : ' hidden';
	return `<button type="button" class="setting-reset-btn" data-reset-key="${key}" title="Reset to default" aria-label="Reset ${escapeHtml(label)} to default"${hiddenAttr}>${RESET_ICON_SVG}</button>`;
}

function buildToggleRow(options: {
	key: PanelSettingKey;
	label: string;
	hint: string;
	checked: boolean;
	modified: boolean;
	disabled?: boolean;
}): string {
	const { key, label, hint, checked, modified, disabled = false } = options;
	const checkedAttr = checked ? ' checked' : '';
	const disabledAttr = disabled ? ' disabled' : '';
	const disabledClass = disabled ? ' is-disabled' : '';
	return `<div class="setting-item setting-item--inline${disabledClass}" data-setting-row="${key}"><div class="setting-copy"><label for="setting-${key}" class="setting-label">${escapeHtml(label)}</label><p id="hint-${key}" class="setting-hint">${escapeHtml(hint)}</p></div><div class="setting-control-inline"><input type="checkbox" role="switch" id="setting-${key}" name="${key}" class="setting-switch" aria-describedby="hint-${key}"${checkedAttr}${disabledAttr}>${buildResetButton(key, label, modified)}</div></div>`;
}

function buildSegmentedRow(options: {
	key: PanelSettingKey;
	label: string;
	hint: string;
	value: string;
	modified: boolean;
	choices: ReadonlyArray<{ value: string; label: string }>;
}): string {
	const { key, label, hint, value, modified, choices } = options;
	const optionsHtml = choices.map(choice => {
		const id = `setting-${key}-${choice.value}`;
		const checkedAttr = choice.value === value ? ' checked' : '';
		return `<div class="segmented-option"><input type="radio" id="${id}" name="${key}" value="${escapeHtml(choice.value)}" class="visually-hidden" aria-describedby="hint-${key}"${checkedAttr}><label for="${id}">${escapeHtml(choice.label)}</label></div>`;
	}).join('');

	return `<fieldset class="setting-item setting-fieldset" data-setting-row="${key}"><legend class="setting-label">${escapeHtml(label)}</legend><p id="hint-${key}" class="setting-hint">${escapeHtml(hint)}</p><div class="setting-control-row"><div class="segmented-control">${optionsHtml}</div>${buildResetButton(key, label, modified)}</div></fieldset>`;
}

function buildNumberRow(options: {
	key: PanelSettingKey;
	label: string;
	hint: string;
	value: number;
	min: number;
	max: number;
	unit?: string;
	errorText: string;
	modified: boolean;
	disabled?: boolean;
}): string {
	const { key, label, hint, value, min, max, unit, errorText, modified, disabled = false } = options;
	const disabledAttr = disabled ? ' disabled' : '';
	const disabledClass = disabled ? ' is-disabled' : '';
	const unitHtml = unit ? `<span class="setting-unit" aria-hidden="true">${escapeHtml(unit)}</span>` : '';
	return `<div class="setting-item${disabledClass}" data-setting-row="${key}"><div class="setting-inline-head"><div class="setting-copy"><label for="setting-${key}" class="setting-label">${escapeHtml(label)}</label><p id="hint-${key}" class="setting-hint">${escapeHtml(hint)}</p></div><div class="setting-control-inline"><div class="setting-input-wrap"><input type="number" id="setting-${key}" name="${key}" value="${value}" min="${min}" max="${max}" step="1" inputmode="numeric" enterkeyhint="done" class="setting-number-input" aria-describedby="hint-${key}" aria-invalid="false" data-error="error-${key}"${disabledAttr}>${unitHtml}</div>${buildResetButton(key, label, modified)}</div></div><p id="error-${key}" class="setting-error">${ERROR_ICON_SVG}<span>${escapeHtml(errorText)}</span></p></div>`;
}

function buildOrderItemHtml(options: {
	settingKey: 'statusBarDisplay' | 'panelSections';
	id: string;
	label: string;
	checked: boolean;
	canMoveUp: boolean;
	canMoveDown: boolean;
}): string {
	const { settingKey, id, label, checked, canMoveUp, canMoveDown } = options;
	const escapedId = escapeHtml(id);
	const escapedLabel = escapeHtml(label);
	const checkedAttr = checked ? ' checked' : '';
	const inactiveClass = checked ? '' : ' is-inactive';
	const upDisabled = canMoveUp ? '' : ' disabled';
	const downDisabled = canMoveDown ? '' : ' disabled';

	return `<div class="setting-order-item${inactiveClass}" data-item-id="${escapedId}"><input type="checkbox" id="setting-${settingKey}-${escapedId}" name="${settingKey}" value="${escapedId}" class="setting-checkbox"${checkedAttr}><label for="setting-${settingKey}-${escapedId}" class="setting-order-label">${escapedLabel}</label><div class="setting-order-actions"><button type="button" class="panel-section-btn" data-order-move="up" data-order-setting="${settingKey}" data-item-id="${escapedId}" title="Move up" aria-label="Move ${escapedLabel} up"${upDisabled}>${CHEVRON_UP_SVG}</button><button type="button" class="panel-section-btn" data-order-move="down" data-order-setting="${settingKey}" data-item-id="${escapedId}" title="Move down" aria-label="Move ${escapedLabel} down"${downDisabled}>${CHEVRON_DOWN_SVG}</button></div></div>`;
}

function buildStatusBarItemsFieldset(items: StatusBarDisplayItem[], modified: boolean): string {
	const activeSet = new Set(items);
	const inactiveItems = STATUS_BAR_DISPLAY_ITEMS.filter(item => !activeSet.has(item));
	const activeRows = items.map((item, index) => buildOrderItemHtml({
		settingKey: 'statusBarDisplay',
		id: item,
		label: DISPLAY_MODE_TO_CATEGORY[item] ?? item,
		checked: true,
		canMoveUp: index > 0,
		canMoveDown: index < items.length - 1
	}));
	const inactiveRows = inactiveItems.map(item => buildOrderItemHtml({
		settingKey: 'statusBarDisplay',
		id: item,
		label: DISPLAY_MODE_TO_CATEGORY[item] ?? item,
		checked: false,
		canMoveUp: false,
		canMoveDown: false
	}));
	const hiddenAttr = modified ? '' : ' hidden';

	return `<fieldset class="setting-item setting-fieldset" data-setting-row="statusBarDisplay"><legend class="setting-label">Status bar items</legend><p id="hint-statusBarDisplay" class="setting-hint">Choose and order items shown in the status bar</p><div class="setting-order-list" data-order-list="statusBarDisplay" aria-describedby="hint-statusBarDisplay">${activeRows.join('')}${inactiveRows.join('')}</div><button type="button" class="setting-inline-reset" data-reset-key="statusBarDisplay" aria-label="Reset Status bar items to default"${hiddenAttr}>${RESET_ICON_SVG}<span>Reset order</span></button></fieldset>`;
}

function buildPanelSectionsFieldset(sections: PanelSectionSlot[], modified: boolean): string {
	const rows = sections.map((slot, index) => buildOrderItemHtml({
		settingKey: 'panelSections',
		id: slot.id,
		label: PANEL_SECTION_LABELS[slot.id],
		checked: !slot.hidden,
		canMoveUp: index > 0,
		canMoveDown: index < sections.length - 1
	}));
	const hiddenAttr = modified ? '' : ' hidden';

	return `<fieldset class="setting-item setting-fieldset" data-setting-row="panelSections"><legend class="setting-label">Dashboard sections</legend><p id="hint-panelSections" class="setting-hint">Show, hide, and reorder dashboard cards</p><div class="setting-order-list" data-order-list="panelSections" aria-describedby="hint-panelSections">${rows.join('')}</div><button type="button" class="setting-inline-reset" data-reset-key="panelSections" aria-label="Reset Dashboard sections to default"${hiddenAttr}>${RESET_ICON_SVG}<span>Reset layout</span></button></fieldset>`;
}

function buildLocaleRow(localeValue: string, modified: boolean): string {
	const locales = (COMMON_LOCALES as readonly string[]).includes(localeValue) ? COMMON_LOCALES : [localeValue, ...COMMON_LOCALES];
	const formatLabel = (locale: string): string => (locale === 'default' ? 'default (System)' : locale);
	const optionsHtml = locales.map(locale => {
		const selected = locale === localeValue;
		return `<li role="option" class="setting-dropdown-option${selected ? ' is-selected' : ''}" data-value="${escapeHtml(locale)}" aria-selected="${selected}">${escapeHtml(formatLabel(locale))}</li>`;
	}).join('');
	const chevronSvg = '<svg class="setting-dropdown-chevron" width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z"/></svg>';
	return `<div class="setting-item" data-setting-row="dateFormatLocale"><label id="label-dateFormatLocale" for="setting-dateFormatLocale" class="setting-label">Date locale</label><p id="hint-dateFormatLocale" class="setting-hint">Region / locale format for dates and times</p><div class="setting-control-row"><div class="setting-dropdown" data-dropdown="dateFormatLocale"><button type="button" id="setting-dateFormatLocale" class="setting-select setting-dropdown-trigger" aria-haspopup="listbox" aria-expanded="false" aria-describedby="hint-dateFormatLocale"><span class="setting-dropdown-value">${escapeHtml(formatLabel(localeValue))}</span>${chevronSvg}</button><ul class="setting-dropdown-menu" role="listbox" aria-labelledby="label-dateFormatLocale" hidden>${optionsHtml}</ul></div>${buildResetButton('dateFormatLocale', 'Date locale', modified)}</div></div>`;
}

function buildRefreshIntervalRangeRow(refreshInterval: number, modified: boolean): string {
	const displayValue = refreshInterval > 0 ? `${refreshInterval}s` : 'None';
	return `<div class="setting-item" data-setting-row="refreshInterval"><div class="setting-row-top"><label for="setting-refreshInterval" class="setting-label">Refresh interval</label><output for="setting-refreshInterval" id="output-refreshInterval" class="setting-range-value">${escapeHtml(displayValue)}</output></div><p id="hint-refreshInterval" class="setting-hint">Periodic timer in seconds</p><div class="setting-control-row"><input type="range" id="setting-refreshInterval" name="refreshInterval" min="0" max="${MAX_REFRESH_INTERVAL_SECONDS}" step="10" value="${refreshInterval}" class="setting-range" aria-describedby="hint-refreshInterval">${buildResetButton('refreshInterval', 'Refresh interval', modified)}</div></div>`;
}

function buildThresholdRangeRow(threshold: number, modified: boolean): string {
	const displayValue = threshold > 0 ? `${threshold}%` : 'Off';
	return `<div class="setting-item" data-setting-row="lowQuotaNotificationThreshold"><div class="setting-row-top"><label for="setting-lowQuotaNotificationThreshold" class="setting-label">Low quota alert</label><output for="setting-lowQuotaNotificationThreshold" id="output-lowQuotaNotificationThreshold" class="setting-range-value">${escapeHtml(displayValue)}</output></div><p id="hint-lowQuotaNotificationThreshold" class="setting-hint">Warn when quota drops below this threshold</p><div class="setting-control-row"><input type="range" id="setting-lowQuotaNotificationThreshold" name="lowQuotaNotificationThreshold" min="0" max="100" step="1" value="${threshold}" class="setting-range" aria-describedby="hint-lowQuotaNotificationThreshold">${buildResetButton('lowQuotaNotificationThreshold', 'Low quota alert', modified)}</div></div>`;
}

function buildSettingsSection(title: string, rows: string[]): string {
	return `<section class="settings-card"><h2 class="settings-card-title">${title}</h2><div class="settings-group-list">${rows.join('')}</div></section>`;
}

export function buildSettingsView(settings: PanelSettingsState): string {
	const modified = new Set<PanelSettingKey>(settings.modifiedKeys);
	const resetAllDisabled = modified.size === 0 ? ' disabled' : '';

	const sections = [
		buildSettingsSection('Sync &amp; Refresh', [
			buildToggleRow({
				key: 'liveSync',
				label: 'Live Sync',
				hint: 'Sync after AI turns, quota resets, and window focus',
				checked: settings.liveSync,
				modified: modified.has('liveSync')
			}),
			buildToggleRow({
				key: 'pauseWhenUnfocused',
				label: 'Pause when unfocused',
				hint: 'Pause background refreshes while the window is unfocused',
				checked: settings.pauseWhenUnfocused,
				modified: modified.has('pauseWhenUnfocused')
			}),
			buildRefreshIntervalRangeRow(settings.refreshInterval, modified.has('refreshInterval'))
		]),
		buildSettingsSection('Status Bar', [
			buildStatusBarItemsFieldset(settings.statusBarDisplay, modified.has('statusBarDisplay')),
			buildSegmentedRow({
				key: 'statusBarLimitDisplay',
				label: 'Quota limits',
				hint: 'Which quota windows to show in the status bar',
				value: settings.statusBarLimitDisplay,
				modified: modified.has('statusBarLimitDisplay'),
				choices: [
					{ value: '5h', label: '5h' },
					{ value: 'weekly', label: 'Weekly' },
					{ value: 'both', label: 'Both' }
				]
			}),
			buildToggleRow({
				key: 'statusBarCountdown',
				label: 'Depleted countdown',
				hint: 'Show time until reset in the status bar at 0%',
				checked: settings.statusBarCountdown,
				modified: modified.has('statusBarCountdown')
			}),
			buildToggleRow({
				key: 'statusBarWeeklyReset',
				label: 'Weekly reset timer',
				hint: 'Show weekly reset countdown next to the percentage',
				checked: settings.statusBarWeeklyReset,
				modified: modified.has('statusBarWeeklyReset'),
				disabled: settings.statusBarLimitDisplay === '5h'
			}),
			buildSegmentedRow({
				key: 'statusBarAlignment',
				label: 'Alignment',
				hint: 'Side of the status bar where the item appears',
				value: settings.statusBarAlignment,
				modified: modified.has('statusBarAlignment'),
				choices: [
					{ value: 'Left', label: 'Left' },
					{ value: 'Right', label: 'Right' }
				]
			}),
			buildNumberRow({
				key: 'statusBarPriority',
				label: 'Priority',
				hint: 'Higher values place the item closer to the center',
				value: settings.statusBarPriority,
				min: MIN_PRIORITY,
				max: MAX_PRIORITY,
				errorText: `Enter a whole number between ${MIN_PRIORITY} and ${MAX_PRIORITY}.`,
				modified: modified.has('statusBarPriority')
			})
		]),
		buildSettingsSection('Display &amp; Format', [
			buildSegmentedRow({
				key: 'resetTimeDisplay',
				label: 'Reset time',
				hint: 'How quota reset times are formatted',
				value: settings.resetTimeDisplay,
				modified: modified.has('resetTimeDisplay'),
				choices: [
					{ value: 'relative', label: 'Relative' },
					{ value: 'absolute', label: 'Absolute' },
					{ value: 'both', label: 'Both' }
				]
			}),
			buildSegmentedRow({
				key: 'absoluteTimeFormat',
				label: 'Clock format',
				hint: 'Clock style for absolute reset timestamps',
				value: settings.absoluteTimeFormat,
				modified: modified.has('absoluteTimeFormat'),
				choices: [
					{ value: '24h', label: '24h' },
					{ value: '12h', label: '12h' }
				]
			}),
			buildLocaleRow(settings.dateFormatLocale, modified.has('dateFormatLocale'))
		]),
		buildSettingsSection('Notifications', [
			buildToggleRow({
				key: 'notifyOnFullQuota',
				label: 'Full quota refill',
				hint: 'Notify when a model category refills to 100%',
				checked: settings.notifyOnFullQuota,
				modified: modified.has('notifyOnFullQuota')
			}),
			buildThresholdRangeRow(settings.lowQuotaNotificationThreshold, modified.has('lowQuotaNotificationThreshold'))
		]),
		buildSettingsSection('Dashboard &amp; Data', [
			buildToggleRow({
				key: 'enableHistoryTracking',
				label: 'History tracking',
				hint: 'Record quota changes and activity (turning off clears saved history)',
				checked: settings.enableHistoryTracking,
				modified: modified.has('enableHistoryTracking')
			}),
			buildNumberRow({
				key: 'maxHistoryItems',
				label: 'Max history items',
				hint: `Entries persisted per group (${MIN_MAX_HISTORY_ITEMS}–${MAX_MAX_HISTORY_ITEMS})`,
				value: settings.maxHistoryItems,
				min: MIN_MAX_HISTORY_ITEMS,
				max: MAX_MAX_HISTORY_ITEMS,
				errorText: `Enter a whole number between ${MIN_MAX_HISTORY_ITEMS} and ${MAX_MAX_HISTORY_ITEMS}.`,
				modified: modified.has('maxHistoryItems'),
				disabled: !settings.enableHistoryTracking
			}),
			buildToggleRow({
				key: 'enablePublicStatus',
				label: 'Service health',
				hint: 'Fetch public Google Antigravity status from StatusGator',
				checked: settings.enablePublicStatus,
				modified: modified.has('enablePublicStatus')
			}),
			buildPanelSectionsFieldset(settings.panelSections, modified.has('panelSections'))
		])
	].join('');

	return `<header class="settings-header"><button type="button" class="settings-back-btn" data-action="closeSettings" aria-label="Back to dashboard">${BACK_ICON_SVG}<span>Dashboard</span></button><h1 id="settings-title" class="settings-title">Settings</h1><button type="button" class="settings-icon-btn" data-action="openVsCodeSettings" title="Open in VS Code Settings" aria-label="Open in VS Code Settings">${EXTERNAL_SETTINGS_ICON_SVG}</button></header><main class="settings-main"><form id="settings-form" class="settings-form" aria-labelledby="settings-title" novalidate>${sections}</form></main><footer class="settings-footer"><button type="button" class="settings-btn" data-action="openVsCodeSettings">VS Code Settings</button><button type="button" class="settings-btn" data-action="resetAllSettings"${resetAllDisabled}>Reset defaults</button></footer><div id="settings-announcer" class="visually-hidden" role="status" aria-live="polite"></div>`;
}
