import * as fs from 'fs';
import * as path from 'path';
import { MODEL_USAGE_CONVERSATION_DIRS, MODEL_USAGE_REFRESH_INTERVAL_MS } from './constants';
import { ModelUsageEntry, ModelUsageSummary } from './types';
import { getGeminiDir, isMissingPathError } from './utils';

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
	['-extra-high', 'Extra High'],
	['-xhigh', 'XHigh'],
	['-minimal', 'Minimal'],
	['-low', 'Low'],
	['-medium', 'Medium'],
	['-high', 'High'],
	['-max', 'Max'],
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

// eslint-disable-next-line no-control-regex
const METADATA_LABEL_REGEX = /\xaa\x01[\x01-\x7f]([A-Za-z0-9. -]+\((?:Minimal|Extra Low|Low|Medium|High|Extra High|XHigh|Max|Thinking)\))/;
// eslint-disable-next-line no-control-regex
const METADATA_LABEL_GLOBAL_REGEX = /\xaa\x01[\x01-\x7f]([A-Za-z0-9. -]+\((?:Minimal|Extra Low|Low|Medium|High|Extra High|XHigh|Max|Thinking)\))/g;
// eslint-disable-next-line no-control-regex
const METADATA_SLUG_REGEX = /\x9a\x01[\x01-\x7f]((?:gemini|claude|gpt-oss|gpt)-[a-z0-9]+(?:[-.][a-z0-9]+)*)/;
const FALLBACK_SLUG_REGEX = /\b((?:gemini|claude|gpt-oss|gpt)-[a-z0-9]+(?:[-.][a-z0-9]+)*)/;
// eslint-disable-next-line no-control-regex
const HASHED_SLUG_GLOBAL_REGEX = /([0-9a-f]{16}).{0,4}?\x9a\x01[\x01-\x7f]?((?:gemini|claude|gpt-oss|gpt)-[a-z0-9]+(?:[-.][a-z0-9]+)*)/g;

interface FileCacheEntry {
	mtimeMs: number;
	size: number;
	walMtimeMs: number;
	walSize: number;
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

function parseLabelString(rawLabel: string): { model: string; thinkingLevel: string } | null {
	const splitMatch = rawLabel.trim().match(/^(.*?)\s*\((.*?)\)$/);
	if (!splitMatch) {
		return null;
	}
	return { model: splitMatch[1].trim(), thinkingLevel: splitMatch[2].trim() };
}

function parseGenMetadataRow(data: Buffer | Uint8Array): { model: string; thinkingLevel: string } | null {
	const text = Buffer.isBuffer(data) ? data.toString('latin1') : Buffer.from(data).toString('latin1');
	const labelMatch = text.match(METADATA_LABEL_REGEX);
	if (labelMatch) {
		const parsed = parseLabelString(labelMatch[1]);
		if (parsed) {
			return parsed;
		}
	}
	const slugMatch = text.match(METADATA_SLUG_REGEX);
	if (slugMatch) {
		return parseModelSlug(slugMatch[1]);
	}
	const fallbackMatch = text.match(FALLBACK_SLUG_REGEX);
	if (fallbackMatch) {
		return parseModelSlug(fallbackMatch[1]);
	}
	return null;
}

function extractModelUsagesFromBuffer(buffer: Buffer): Array<{ model: string; thinkingLevel: string }> {
	const text = buffer.toString('latin1');
	const usages: Array<{ model: string; thinkingLevel: string }> = [];

	for (const match of text.matchAll(METADATA_LABEL_GLOBAL_REGEX)) {
		const parsed = parseLabelString(match[1]);
		if (parsed) {
			usages.push(parsed);
		}
	}

	if (usages.length === 0) {
		const slugByRequestHash = new Map<string, string>();
		for (const match of text.matchAll(HASHED_SLUG_GLOBAL_REGEX)) {
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

const SQLITE_HEADER_MAGIC = 'SQLite format 3\0';
const SQLITE_WAL_HEADER_SIZE = 32;
const SQLITE_WAL_FRAME_HEADER_SIZE = 24;
const SQLITE_WAL_MAGIC_LE = 0x377f0682;
const SQLITE_WAL_MAGIC_BE = 0x377f0683;

function readSqlitePageSize(dbBuffer: Buffer): number | null {
	if (dbBuffer.length < 100 || dbBuffer.subarray(0, 16).toString('latin1') !== SQLITE_HEADER_MAGIC) {
		return null;
	}
	const rawSize = dbBuffer.readUInt16BE(16);
	const pageSize = rawSize === 1 ? 65536 : rawSize;
	if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) {
		return null;
	}
	return pageSize;
}

function applyWalToDatabaseBuffer(dbBuffer: Buffer, walBuffer: Buffer): Buffer {
	const pageSize = readSqlitePageSize(dbBuffer);
	if (!pageSize || walBuffer.length < SQLITE_WAL_HEADER_SIZE) {
		return dbBuffer;
	}

	const magic = walBuffer.readUInt32BE(0);
	if (magic !== SQLITE_WAL_MAGIC_LE && magic !== SQLITE_WAL_MAGIC_BE) {
		return dbBuffer;
	}

	const walPageSize = walBuffer.readUInt32BE(8);
	if (walPageSize !== pageSize) {
		return dbBuffer;
	}

	const salt1 = walBuffer.readUInt32BE(16);
	const salt2 = walBuffer.readUInt32BE(20);
	const frameSize = SQLITE_WAL_FRAME_HEADER_SIZE + pageSize;
	const maxFrames = Math.floor((walBuffer.length - SQLITE_WAL_HEADER_SIZE) / frameSize);
	const dbPageCount = Math.ceil(dbBuffer.length / pageSize);
	const maxReasonablePages = dbPageCount + maxFrames;

	const committedPages = new Map<number, number>();
	let pendingPages = new Map<number, number>();
	let committedPageCount = dbPageCount;

	for (let offset = SQLITE_WAL_HEADER_SIZE; offset + frameSize <= walBuffer.length; offset += frameSize) {
		const frameSalt1 = walBuffer.readUInt32BE(offset + 8);
		const frameSalt2 = walBuffer.readUInt32BE(offset + 12);
		if (frameSalt1 !== salt1 || frameSalt2 !== salt2) {
			break;
		}
		const pageNumber = walBuffer.readUInt32BE(offset);
		const dbSizeAfterCommit = walBuffer.readUInt32BE(offset + 4);
		if (pageNumber < 1) {
			break;
		}
		pendingPages.set(pageNumber, offset + SQLITE_WAL_FRAME_HEADER_SIZE);
		if (dbSizeAfterCommit > 0 && dbSizeAfterCommit <= maxReasonablePages) {
			for (const [page, dataOffset] of pendingPages) {
				committedPages.set(page, dataOffset);
			}
			pendingPages = new Map();
			committedPageCount = dbSizeAfterCommit;
		}
	}

	if (committedPages.size === 0 || committedPageCount === 0) {
		return dbBuffer;
	}

	const logicalBuffer = Buffer.alloc(committedPageCount * pageSize);
	const baseCopyBytes = Math.min(dbBuffer.length, logicalBuffer.length);
	dbBuffer.copy(logicalBuffer, 0, 0, baseCopyBytes);

	for (const [pageNumber, dataOffset] of committedPages) {
		if (pageNumber > committedPageCount) {
			continue;
		}
		walBuffer.copy(logicalBuffer, (pageNumber - 1) * pageSize, dataOffset, dataOffset + pageSize);
	}

	return logicalBuffer;
}

async function getWalStats(filePath: string): Promise<{ mtimeMs: number; size: number }> {
	try {
		const walStats = await fs.promises.stat(`${filePath}-wal`);
		return { mtimeMs: walStats.mtimeMs, size: walStats.size };
	} catch (error) {
		if (!isMissingPathError(error)) {
			return { mtimeMs: -1, size: -1 };
		}
		return { mtimeMs: 0, size: 0 };
	}
}

async function readFileUsages(filePath: string, log: ScanLogger): Promise<Array<{ model: string; thinkingLevel: string }>> {
	const [stats, walStats] = await Promise.all([
		fs.promises.stat(filePath),
		getWalStats(filePath)
	]);
	const cached = fileCache.get(filePath);
	if (
		cached &&
		walStats.mtimeMs >= 0 &&
		cached.mtimeMs === stats.mtimeMs &&
		cached.size === stats.size &&
		cached.walMtimeMs === walStats.mtimeMs &&
		cached.walSize === walStats.size
	) {
		return cached.usages;
	}

	let usages: Array<{ model: string; thinkingLevel: string }> = [];
	let sqliteReadSucceeded = false;
	let fallbackReadSucceeded = false;

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
				sqliteReadSucceeded = true;
			} finally {
				db.close();
			}
		} catch (error) {
			log(`Failed to read SQLite conversation database: ${path.basename(filePath)}`, error);
			usages = [];
		}
	}

	if (!sqliteReadSucceeded) {
		try {
			const dbBuffer = await fs.promises.readFile(filePath);
			let targetBuffer: Buffer = dbBuffer;
			let walReadComplete = true;
			if (walStats.size > 0) {
				try {
					const walBuffer = await fs.promises.readFile(`${filePath}-wal`);
					targetBuffer = applyWalToDatabaseBuffer(dbBuffer, walBuffer);
				} catch (error) {
					if (!isMissingPathError(error)) {
						walReadComplete = false;
						log(`Failed to read WAL file: ${path.basename(filePath)}-wal`, error);
					}
				}
			}
			usages = extractModelUsagesFromBuffer(targetBuffer);
			fallbackReadSucceeded = walReadComplete;
		} catch (error) {
			log(`Failed to read conversation file: ${path.basename(filePath)}`, error);
			usages = [];
		}
	}

	if ((sqliteReadSucceeded || fallbackReadSucceeded) && walStats.mtimeMs >= 0) {
		fileCache.set(filePath, {
			mtimeMs: stats.mtimeMs,
			size: stats.size,
			walMtimeMs: walStats.mtimeMs,
			walSize: walStats.size,
			usages
		});
	}
	return usages;
}

async function listConversationFiles(log: ScanLogger): Promise<string[]> {
	const conversationsRoot = getGeminiDir();
	const files: string[] = [];
	for (const dirName of MODEL_USAGE_CONVERSATION_DIRS) {
		const dir = path.join(conversationsRoot, dirName, 'conversations');
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch (error) {
			if (!isMissingPathError(error)) {
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
