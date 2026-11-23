import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import {
	CATEGORY_NAMES,
	DEFAULT_MAX_HISTORY_ITEMS,
	DEFAULT_REFRESH_INTERVAL,
	DEFAULT_STATUS_BAR_DISPLAY,
	MAX_MAX_HISTORY_ITEMS,
	MAX_PID_32BIT_SIGNED,
	MAX_PORT,
	MAX_REFRESH_INTERVAL_SECONDS,
	MIN_MAX_HISTORY_ITEMS,
	MIN_PORT,
	MIN_REFRESH_INTERVAL_SECONDS,
	MODEL_KEYWORDS,
	MS_PER_DAY,
	MS_PER_HOUR,
	MS_PER_MINUTE,
	PANEL_SECTION_IDS,
	PanelSectionId,
	PROCESS_IDENTIFIERS,
	PROGRESS_BUCKET_BOUNDARIES,
	PROGRESS_STOPS,
	SERVER_STARTUP_TOLERANCE_MINUTES,
	STATUS_BAR_DISPLAY_ITEMS
} from './constants';
import { QuotaBucket, QuotaGroup, StatusBarDisplayItem } from './types';

export const MAX_BUFFER_SIZE = 1024 * 1024;

const COMMAND_TIMEOUT_MS = 10000;
const HIDDEN_SECTION_PREFIX = '!';

export function validatePid(pid: number): boolean {
	return Number.isInteger(pid) && pid > 0 && pid <= MAX_PID_32BIT_SIGNED;
}

export function validatePort(port: number): boolean {
	return Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT;
}

export function normalizeRefreshIntervalSeconds(rawInterval: unknown): number {
	if (typeof rawInterval !== 'number' || !Number.isFinite(rawInterval)) {
		return DEFAULT_REFRESH_INTERVAL;
	}
	if (rawInterval <= 0) {
		return 0;
	}
	return Math.min(MAX_REFRESH_INTERVAL_SECONDS, Math.max(MIN_REFRESH_INTERVAL_SECONDS, Math.round(rawInterval)));
}

export function normalizeMaxHistoryItems(rawMax: unknown): number {
	if (typeof rawMax !== 'number' || !Number.isFinite(rawMax)) {
		return DEFAULT_MAX_HISTORY_ITEMS;
	}
	return Math.min(MAX_MAX_HISTORY_ITEMS, Math.max(MIN_MAX_HISTORY_ITEMS, Math.floor(rawMax)));
}

export function normalizeStatusBarItems(rawDisplay: unknown): StatusBarDisplayItem[] {
	const rawItems = Array.isArray(rawDisplay)
		? rawDisplay
		: typeof rawDisplay === 'string'
			? rawDisplay.split(',')
			: DEFAULT_STATUS_BAR_DISPLAY;

	const items: StatusBarDisplayItem[] = [];
	for (const rawItem of rawItems) {
		if (typeof rawItem !== 'string') { continue; }
		const normalized = rawItem.trim().toLowerCase();
		if (normalized === 'all') {
			for (const item of DEFAULT_STATUS_BAR_DISPLAY) {
				if (!items.includes(item)) {
					items.push(item);
				}
			}
			continue;
		}
		const matchedItem = (STATUS_BAR_DISPLAY_ITEMS as readonly StatusBarDisplayItem[]).find(item => item === normalized);
		if (matchedItem && !items.includes(matchedItem)) {
			items.push(matchedItem);
		}
	}
	return items;
}

export function getGeminiDir(): string {
	return path.join(os.homedir(), PROCESS_IDENTIFIERS.GEMINI_DIR);
}

export function isMissingPathError(error: unknown): boolean {
	if (!error || typeof error !== 'object' || !('code' in error)) {
		return false;
	}
	const code = error.code;
	return code === 'ENOENT' || code === 'ENOTDIR';
}

export function executeCommand(command: string, args: string[], timeoutMs: number = COMMAND_TIMEOUT_MS): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = spawn(command, args, { shell: false });
		let stdout = '';
		let stderr = '';
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let settled = false;

		const settle = (fn: () => void) => {
			if (settled) { return; }
			settled = true;
			clearTimeout(timeout);
			fn();
		};

		const timeout = setTimeout(() => {
			proc.kill();
			settle(() => reject(new Error(`Command '${command}' timed out after ${timeoutMs}ms`)));
		}, timeoutMs);

		proc.stdout.on('data', (data: Buffer) => {
			if (settled) { return; }
			stdoutBytes += data.length;
			if (stdoutBytes > MAX_BUFFER_SIZE) {
				proc.kill();
				settle(() => reject(new Error(`Command '${command}' output exceeded ${MAX_BUFFER_SIZE} bytes`)));
				return;
			}
			stdout += data.toString();
		});

		proc.stderr.on('data', (data: Buffer) => {
			stderrBytes += data.length;
			if (stderrBytes > MAX_BUFFER_SIZE) {
				return;
			}
			stderr += data.toString();
		});

		proc.on('error', (err) => {
			settle(() => {
				if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
					reject(new Error(`'${command}' not found. Make sure it is installed and available in your PATH.`));
				} else {
					reject(err);
				}
			});
		});

		proc.on('close', (code) => {
			if (code === 0) {
				settle(() => resolve(stdout));
			} else {
				settle(() => reject(new Error(stderr.trim() || `Command '${command}' exited with code ${code}`)));
			}
		});
	});
}

export function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

export function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function determineCategory(label: string): string {
	const lowerLabel = label.toLowerCase();
	if (lowerLabel.includes(MODEL_KEYWORDS.gemini) || lowerLabel.includes(MODEL_KEYWORDS.flash)) {
		return CATEGORY_NAMES.GEMINI;
	}
	return CATEGORY_NAMES.OTHER;
}

export function isNotStartedQuota(percentage: number, resetMs: number): boolean {
	const toleranceMs = SERVER_STARTUP_TOLERANCE_MINUTES * MS_PER_MINUTE;
	const nearFiveHours = Math.abs(resetMs - 5 * MS_PER_HOUR) < toleranceMs;
	const nearSevenDays = Math.abs(resetMs - 7 * MS_PER_DAY) < toleranceMs;
	return percentage >= 100 && (nearFiveHours || nearSevenDays);
}

export function isWeeklyLimitReached(percentage: number, resetMs: number, plan: string | undefined): boolean {
	const normalizedPlan = plan?.toLowerCase() ?? '';
	const isPaidWeeklyPlan = normalizedPlan.includes('pro') || normalizedPlan.includes('ultra');
	return percentage < 100 && isPaidWeeklyPlan && resetMs > 18 * MS_PER_HOUR;
}

export function isLikelyServerGlitch(groups: Record<string, QuotaGroup>): boolean {
	const now = Date.now();
	return [CATEGORY_NAMES.GEMINI, CATEGORY_NAMES.OTHER].every(category => {
		const group = groups[category];
		return group !== undefined &&
			group.quota === 0 &&
			typeof group.resetTime === 'number' &&
			group.resetTime <= now;
	});
}

export function escapeHtml(text: string): string {
	return text.replace(/[<>&"']/g, char => {
		switch (char) {
			case '<': return '&lt;';
			case '>': return '&gt;';
			case '&': return '&amp;';
			case '"': return '&quot;';
			case "'": return '&apos;';
			default: return char;
		}
	});
}

export function getProgressStopIndex(percentage: number): number {
	const idx = PROGRESS_BUCKET_BOUNDARIES.findIndex(boundary => percentage < boundary);
	return idx === -1 ? PROGRESS_STOPS.length - 1 : idx;
}

export function sortQuotaBuckets(buckets: QuotaBucket[]): QuotaBucket[] {
	const order = (window: string) => {
		const w = window.toLowerCase();
		if (w === '5h') { return 0; }
		if (w === 'weekly') { return 1; }
		return 2;
	};
	return [...buckets].sort((a, b) => order(a.window) - order(b.window));
}

export function normalizeModelName(label: string): string {
	return label.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

export interface PanelSectionSlot {
	id: PanelSectionId;
	hidden: boolean;
}

function isPanelSectionId(value: string): value is PanelSectionId {
	return (PANEL_SECTION_IDS as readonly string[]).includes(value);
}

function insertLegacyHiddenSection(layout: PanelSectionSlot[], id: PanelSectionId): void {
	const defaultIndex = PANEL_SECTION_IDS.indexOf(id);
	for (let i = defaultIndex - 1; i >= 0; i--) {
		const after = layout.findIndex(slot => slot.id === PANEL_SECTION_IDS[i]);
		if (after >= 0) {
			layout.splice(after + 1, 0, { id, hidden: true });
			return;
		}
	}
	let before = layout.length;
	for (let i = defaultIndex + 1; i < PANEL_SECTION_IDS.length; i++) {
		const index = layout.findIndex(slot => slot.id === PANEL_SECTION_IDS[i]);
		if (index >= 0) {
			before = index;
			break;
		}
	}
	layout.splice(before, 0, { id, hidden: true });
}

export function normalizePanelSectionLayout(value: unknown): PanelSectionSlot[] {
	if (!Array.isArray(value)) {
		return PANEL_SECTION_IDS.map(id => ({ id, hidden: false }));
	}
	const seen = new Set<PanelSectionId>();
	const result: PanelSectionSlot[] = [];
	for (const item of value) {
		if (typeof item !== 'string') {
			continue;
		}
		const hidden = item.startsWith(HIDDEN_SECTION_PREFIX);
		const raw = hidden ? item.slice(HIDDEN_SECTION_PREFIX.length) : item;
		if (!isPanelSectionId(raw) || seen.has(raw)) {
			continue;
		}
		seen.add(raw);
		result.push({ id: raw, hidden });
	}
	for (const id of PANEL_SECTION_IDS) {
		if (seen.has(id)) {
			continue;
		}
		insertLegacyHiddenSection(result, id);
		seen.add(id);
	}
	return result;
}

export function serializePanelSectionLayout(layout: PanelSectionSlot[]): string[] {
	return layout.map(slot => slot.hidden ? `${HIDDEN_SECTION_PREFIX}${slot.id}` : slot.id);
}
