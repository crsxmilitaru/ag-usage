import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MODEL_USAGE_CONVERSATION_DIRS, MODEL_USAGE_REFRESH_INTERVAL_MS } from './constants';
import { ModelUsageEntry, ModelUsageSummary } from './types';

type ScanLogger = (message: string, error?: unknown) => void;

interface SqliteDatabaseSync {
	prepare(sql: string): { all(): Array<{ data: Buffer | Uint8Array }> };
	close(): void;
}

type DatabaseSyncConstructor = new (path: string, options?: { readOnly?: boolean }) => SqliteDatabaseSync;

let SqliteDatabase: DatabaseSyncConstructor | null = null;
let sqliteLoadError: unknown;
let hasLoggedSqliteLoadError = false;
try {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	SqliteDatabase = require('node:sqlite').DatabaseSync;
} catch (error) {
	SqliteDatabase = null;
	sqliteLoadError = error;
}

const SLUG_LEVEL_SUFFIXES: ReadonlyArray<readonly [suffix: string, level: string]> = [
	['-extra-low', 'Extra Low'],
	['-low', 'Low'],
	['-medium', 'Medium'],
	['-high', 'High'],
	['-thinking', 'Thinking']
];
const STRIPPED_SLUG_SUFFIXES = ['-tiered'];
const EXCLUDED_SLUG_BODY_PATTERN = /agent|forced|teamwork|disable|enable|experiment|flag/;
const SINGLE_LETTER_SLUG_SUFFIX_PATTERN = /-[a-z]$/;
const UPPERCASE_SLUG_TOKENS = new Set(['gpt', 'oss']);
const SLUG_DEFAULT_LEVELS: Record<string, string> = {
	claude: 'Thinking',
	gemini: 'High'
};

interface FileCacheEntry {
	mtimeMs: number;
	size: number;
	usages: Array<{ model: string; thinkingLevel: string }>;
}

const fileCache = new Map<string, FileCacheEntry>();
let cachedSummary: ModelUsageSummary | null = null;
let lastScanTimestamp = 0;
let inFlightScan: Promise<ModelUsageSummary | null> | null = null;

function formatSlugToken(token: string): string {
	if (UPPERCASE_SLUG_TOKENS.has(token)) {
		return token.toUpperCase();
	}
	return token.charAt(0).toUpperCase() + token.slice(1);
}

function parseModelSlug(slug: string): { model: string; thinkingLevel: string } | null {
	let base = slug;
	let thinkingLevel: string | undefined;
	for (const [suffix, level] of SLUG_LEVEL_SUFFIXES) {
		if (base.endsWith(suffix)) {
			base = base.slice(0, -suffix.length);
			thinkingLevel = level;
			break;
		}
	}
	for (const suffix of STRIPPED_SLUG_SUFFIXES) {
		if (base.endsWith(suffix)) {
			base = base.slice(0, -suffix.length);
		}
	}
	if (EXCLUDED_SLUG_BODY_PATTERN.test(base) || SINGLE_LETTER_SLUG_SUFFIX_PATTERN.test(base)) {
		return null;
	}
	const tokens = base.split('-').filter(Boolean).map(formatSlugToken);
	const model = tokens.join(' ').replace(/(\d)\s+(\d)/g, (_, a, b) => `${a}.${b}`);
	const family = base.split('-')[0];
	const resolvedLevel = thinkingLevel ?? SLUG_DEFAULT_LEVELS[family] ?? 'Standard';
	return { model, thinkingLevel: resolvedLevel };
}

function parseGenMetadataRow(data: Buffer | Uint8Array): { model: string; thinkingLevel: string } | null {
	const text = Buffer.isBuffer(data) ? data.toString('latin1') : Buffer.from(data).toString('latin1');
	// eslint-disable-next-line no-control-regex
	const labelMatch = text.match(/\xaa\x01[\x01-\x7f]([A-Za-z0-9. -]+\((?:Low|Medium|High|Thinking|Extra Low)\))/);
	if (labelMatch) {
		const full = labelMatch[1].trim();
		const splitMatch = full.match(/^(.*?)\s*\((.*?)\)$/);
		if (splitMatch) {
			return { model: splitMatch[1].trim(), thinkingLevel: splitMatch[2].trim() };
		}
	}
	// eslint-disable-next-line no-control-regex
	const slugMatch = text.match(/\x9a\x01[\x01-\x7f]((?:gemini|claude|gpt-oss|gpt)-[a-z0-9]+(?:[-.][a-z0-9]+)*)/);
	if (slugMatch) {
		return parseModelSlug(slugMatch[1]);
	}
	const fallbackMatch = text.match(/\b((?:gemini|claude|gpt-oss|gpt)-[a-z0-9]+(?:[-.][a-z0-9]+)*)/);
	if (fallbackMatch) {
		return parseModelSlug(fallbackMatch[1]);
	}
	return null;
}

function extractModelUsagesFromBuffer(buffer: Buffer): Array<{ model: string; thinkingLevel: string }> {
	const text = buffer.toString('latin1');
	const usages: Array<{ model: string; thinkingLevel: string }> = [];

	// eslint-disable-next-line no-control-regex
	for (const match of text.matchAll(/\xaa\x01[\x01-\x7f]([A-Za-z0-9. -]+\((?:Low|Medium|High|Thinking|Extra Low)\))/g)) {
		const full = match[1].trim();
		const splitMatch = full.match(/^(.*?)\s*\((.*?)\)$/);
		if (splitMatch) {
			usages.push({ model: splitMatch[1].trim(), thinkingLevel: splitMatch[2].trim() });
		}
	}

	if (usages.length === 0) {
		const slugByRequestHash = new Map<string, string>();
		// eslint-disable-next-line no-control-regex
		for (const match of text.matchAll(/([0-9a-f]{16}).{0,4}?\x9a\x01[\x01-\x7f]?((?:gemini|claude|gpt-oss|gpt)-[a-z0-9]+(?:[-.][a-z0-9]+)*)/g)) {
			if (!slugByRequestHash.has(match[1])) {
				slugByRequestHash.set(match[1], match[2]);
			}
		}
		for (const slug of slugByRequestHash.values()) {
			const parsed = parseModelSlug(slug);
			if (parsed) {
				usages.push(parsed);
			}
		}
	}

	return usages;
}

async function readFileUsages(filePath: string, log: ScanLogger): Promise<Array<{ model: string; thinkingLevel: string }>> {
	const stats = await fs.promises.stat(filePath);
	const cached = fileCache.get(filePath);
	if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
		return cached.usages;
	}

	let usages: Array<{ model: string; thinkingLevel: string }> = [];
	if (SqliteDatabase) {
		try {
			const db = new SqliteDatabase(filePath, { readOnly: true });
			try {
				const rows = db.prepare('SELECT data FROM gen_metadata').all();
				for (const row of rows) {
					const parsed = parseGenMetadataRow(row.data);
					if (parsed) {
						usages.push(parsed);
					}
				}
			} finally {
				db.close();
			}
		} catch (error) {
			log(`Failed to read SQLite conversation database: ${path.basename(filePath)}`, error);
			usages = [];
		}
	}

	if (usages.length === 0) {
		try {
			const buffer = await fs.promises.readFile(filePath);
			usages = extractModelUsagesFromBuffer(buffer);
		} catch (error) {
			log(`Failed to read conversation file: ${path.basename(filePath)}`, error);
			usages = [];
		}
	}

	fileCache.set(filePath, { mtimeMs: stats.mtimeMs, size: stats.size, usages });
	return usages;
}

function isExpectedMissingDirectoryError(error: unknown): boolean {
	if (!error || typeof error !== 'object' || !('code' in error)) {
		return false;
	}
	const code = error.code;
	return code === 'ENOENT' || code === 'ENOTDIR';
}

async function listConversationFiles(log: ScanLogger): Promise<string[]> {
	const conversationsRoot = path.join(os.homedir(), '.gemini');
	const files: string[] = [];
	for (const dirName of MODEL_USAGE_CONVERSATION_DIRS) {
		const dir = path.join(conversationsRoot, dirName, 'conversations');
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch (error) {
			if (!isExpectedMissingDirectoryError(error)) {
				log(`Failed to list conversation directory: ${dir}`, error);
			}
			continue;
		}
		for (const entry of entries) {
			if (entry.isFile() && entry.name.endsWith('.db')) {
				files.push(path.join(dir, entry.name));
			}
		}
	}
	return files;
}

async function scanConversations(log: ScanLogger): Promise<ModelUsageSummary> {
	const files = await listConversationFiles(log);
	const seenFiles = new Set<string>();
	const usageCounts = new Map<string, { model: string; thinkingLevel: string; count: number }>();
	let conversationCount = 0;
	let totalGenerations = 0;

	for (const file of files) {
		seenFiles.add(file);
		try {
			const usages = await readFileUsages(file, log);
			if (usages.length === 0) {
				continue;
			}
			conversationCount++;
			for (const usage of usages) {
				const key = `${usage.model}|${usage.thinkingLevel}`;
				const entry = usageCounts.get(key) ?? { model: usage.model, thinkingLevel: usage.thinkingLevel, count: 0 };
				entry.count++;
				usageCounts.set(key, entry);
			}
		} catch (error) {
			log(`Failed to scan conversation file: ${path.basename(file)}`, error);
		}
	}

	for (const staleFile of [...fileCache.keys()]) {
		if (!seenFiles.has(staleFile)) {
			fileCache.delete(staleFile);
		}
	}

	const entries: ModelUsageEntry[] = [...usageCounts.values()]
		.map(entry => ({ ...entry, label: entry.thinkingLevel ? `${entry.model} (${entry.thinkingLevel})` : entry.model }))
		.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
	for (const entry of entries) {
		totalGenerations += entry.count;
	}

	return { entries, totalGenerations, conversationCount, scannedAt: Date.now() };
}

export async function fetchModelUsage(log: ScanLogger, forceRefresh: boolean = false): Promise<ModelUsageSummary | null> {
	if (sqliteLoadError && !hasLoggedSqliteLoadError) {
		log('The node:sqlite module is unavailable; using raw conversation file parsing instead', sqliteLoadError);
		hasLoggedSqliteLoadError = true;
	}
	if (!forceRefresh && cachedSummary && Date.now() - lastScanTimestamp < MODEL_USAGE_REFRESH_INTERVAL_MS) {
		return cachedSummary;
	}
	if (inFlightScan) {
		return inFlightScan;
	}
	inFlightScan = scanConversations(log)
		.then(summary => {
			cachedSummary = summary;
			lastScanTimestamp = Date.now();
			return summary;
		})
		.catch(error => {
			log('Failed to scan Antigravity conversations for model usage', error);
			return cachedSummary;
		})
		.finally(() => {
			inFlightScan = null;
		});
	return inFlightScan;
}
