import * as http from 'http';
import * as https from 'https';
import {
	IDE_INFO,
	MAX_PORT_VALIDATION_ATTEMPTS,
	PROCESS_IDENTIFIERS,
	REQUEST_TIMEOUT_MS,
	RETRY_DELAY_MS
} from './constants';
import { getPlatformStrategy } from './platform';
import {
	LocalProtocol,
	ProcessId,
	ProcessInfo,
	QuotaBucket,
	QuotaGroup,
	ServerQuotaSummaryResponse,
	ServerUserStatusResponse,
	UsageStatistics
} from './types';
import {
	delay,
	determineCategory,
	getErrorMessage,
	MAX_BUFFER_SIZE,
	normalizeModelName,
	sortQuotaBuckets,
	validatePid,
	validatePort
} from './utils';

type DiscoveryLogger = (message: string) => void;

const LOCALHOST = '127.0.0.1';
const NOT_FOUND_ERROR = 'Antigravity process not found. Make sure the Antigravity IDE or the Google Antigravity extension is running.';
const PORT_DISCOVERY_ATTEMPTS = 3;

const API_ENDPOINTS = {
	GET_UNLEASH_DATA: '/exa.language_server_pb.LanguageServerService/GetUnleashData',
	RETRIEVE_USER_QUOTA_SUMMARY: '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
	GET_USER_STATUS: '/exa.language_server_pb.LanguageServerService/GetUserStatus'
} as const;

const NON_RETRIABLE_PATTERNS = [
	/unauthorized|forbidden|401|403/i,
	/invalid.*token|token.*invalid/i,
	/certificate|ssl|tls/i
];

const IDE_APP_DATA_DIR_REGEX = /--app_data_dir[=\s]+["']?antigravity(?:-ide)?(?:["']|\s|$)/;
const OVERRIDE_IDE_NAME_REGEX = /--override_ide_name[=\s]+["']?antigravity(?:["']|\s|$)/;
const HUB_APP_DATA_DIR_REGEX = new RegExp(`--app_data_dir[=\\s]+["']?${PROCESS_IDENTIFIERS.ANTIGRAVITY}(?:["']|\\s|$)`);

const forceRefreshUnsupportedPorts = new Set<number>();

export interface DiscoveredConnection {
	port: number;
	csrfToken: string;
	protocol: LocalProtocol;
}

export interface ConnectionHint {
	port?: number;
	csrfToken?: string;
}

export interface DiscoveryOptions {
	isAntigravityIde?: boolean;
	extensionHint?: ConnectionHint | null;
}

interface HostProcessContext {
	isAntigravityIde: boolean;
	currentPid: number;
	parentPid: number;
	grandparentPid?: number;
}

class LocalHttpError extends Error {
	constructor(readonly statusCode: number, path: string) {
		super(`HTTP ${statusCode} on ${path}`);
	}
}

function extractCsrfToken(cmd: string): string | undefined {
	const patterns = [
		/--csrf_token[=\s]+"([^"]+)"/i,
		/--csrf_token[=\s]+'([^']+)'/i,
		/--csrf_token[=\s]+([^\s"']+)/i
	];
	for (const pattern of patterns) {
		const match = cmd.match(pattern);
		if (match?.[1]) {
			return match[1].trim();
		}
	}
	return undefined;
}

function extractHubPort(cmd: string): number | undefined {
	const match = cmd.match(/--hub[-_]port(?:=|\s+)(?:"(\d{1,5})"|'(\d{1,5})'|(\d{1,5}))/i);
	if (!match) {
		return undefined;
	}
	const port = parseInt(match[1] ?? match[2] ?? match[3], 10);
	return validatePort(port) ? port : undefined;
}

function extractBalancedJsonObject(source: string, openBraceIndex: number): string | undefined {
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = openBraceIndex; i < source.length; i++) {
		const ch = source[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === '\\') {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
		} else if (ch === '{') {
			depth++;
		} else if (ch === '}') {
			depth--;
			if (depth === 0) {
				return source.slice(openBraceIndex, i + 1);
			}
		}
	}
	return undefined;
}

function extractAppConfigCsrfToken(html: string, log: DiscoveryLogger): string | undefined {
	const markerMatch = html.match(/__APP_CONFIG__\s*=\s*\{/);
	if (!markerMatch || markerMatch.index === undefined) {
		return undefined;
	}
	const openBraceIndex = markerMatch.index + markerMatch[0].length - 1;
	const jsonObject = extractBalancedJsonObject(html, openBraceIndex);
	if (!jsonObject) {
		return undefined;
	}
	try {
		const config = JSON.parse(jsonObject) as { csrfToken?: unknown };
		const token = config.csrfToken;
		return typeof token === 'string' && token.trim().length > 0 ? token.trim() : undefined;
	} catch (error) {
		log(`Failed to parse the Antigravity hub configuration: ${getErrorMessage(error)}`);
		return undefined;
	}
}

function isHubProcessCommand(cmd: string): boolean {
	const lowerCmd = cmd.toLowerCase();
	return extractHubPort(cmd) !== undefined &&
		(lowerCmd.includes(PROCESS_IDENTIFIERS.ANTIGRAVITY) || lowerCmd.includes(PROCESS_IDENTIFIERS.GEMINI_DIR));
}

function isMatchingProcess(processInfo: ProcessInfo): boolean {
	return extractCsrfToken(processInfo.cmd) !== undefined || isHubProcessCommand(processInfo.cmd);
}

function rankMatchingProcesses(matchingProcesses: ProcessInfo[], context: HostProcessContext): ProcessInfo[] {
	const scoreProcess = (processInfo: ProcessInfo): number => {
		const cmd = processInfo.cmd.toLowerCase();
		let score = 0;
		if (processInfo.parentPid !== undefined) {
			if (processInfo.parentPid === context.currentPid) {
				score += 30;
			} else if (processInfo.parentPid === context.parentPid) {
				score += 20;
			} else if (context.grandparentPid !== undefined && processInfo.parentPid === context.grandparentPid) {
				score += 10;
			}
		}
		if (!context.isAntigravityIde && isHubProcessCommand(cmd)) { score += 10; }
		if (context.isAntigravityIde && (
			IDE_APP_DATA_DIR_REGEX.test(cmd) ||
			cmd.includes('\\antigravity\\resources\\bin\\language_server') ||
			cmd.includes('/antigravity/resources/bin/language_server')
		)) {
			score += 6;
		}
		if (cmd.includes('--standalone')) { score += 4; }
		if (OVERRIDE_IDE_NAME_REGEX.test(cmd)) { score += 4; }
		if (isHubProcessCommand(cmd) && HUB_APP_DATA_DIR_REGEX.test(cmd)) { score += 5; }
		return score;
	};

	return [...matchingProcesses].sort((a, b) => {
		const scoreDiff = scoreProcess(b) - scoreProcess(a);
		return scoreDiff !== 0 ? scoreDiff : b.pid - a.pid;
	});
}

async function findListeningPorts(pid: ProcessId, maxAttempts: number = PORT_DISCOVERY_ATTEMPTS): Promise<number[]> {
	if (!validatePid(pid)) {
		throw new Error(`Invalid process ID: ${pid}`);
	}

	const strategy = getPlatformStrategy();
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (attempt > 0) {
			await delay(RETRY_DELAY_MS * 2);
		}
		const rawPorts = await strategy.getPorts(pid);
		if (rawPorts.length > 0) {
			return Array.from(new Set(rawPorts));
		}
	}

	return [];
}

function fetchHubPageWithProtocol(protocol: LocalProtocol, port: number): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		if (!validatePort(port)) {
			return reject(new Error(`Invalid port: ${port}`));
		}

		let settled = false;
		const settle = (fn: () => void) => {
			if (settled) { return; }
			settled = true;
			fn();
		};

		const handleResponse = (response: http.IncomingMessage) => {
			const statusCode = response.statusCode ?? 0;
			if (statusCode < 200 || statusCode >= 300) {
				response.resume();
				settle(() => reject(new LocalHttpError(statusCode, '/')));
				return;
			}

			response.setEncoding('utf8');
			let pageData = '';
			let byteCount = 0;

			response.on('data', (chunk: string) => {
				if (settled) { return; }
				byteCount += Buffer.byteLength(chunk);
				if (byteCount > MAX_BUFFER_SIZE) {
					request.destroy();
					settle(() => reject(new Error(`Response exceeded ${MAX_BUFFER_SIZE} bytes`)));
					return;
				}
				pageData += chunk;
			});
			response.on('end', () => settle(() => resolve(pageData)));
			response.on('error', (err) => settle(() => reject(err)));
		};

		const options = {
			hostname: LOCALHOST,
			port,
			path: '/',
			method: 'GET',
			timeout: REQUEST_TIMEOUT_MS
		};

		const request = protocol === 'https'
			? https.get({ ...options, rejectUnauthorized: false }, handleResponse)
			: http.get(options, handleResponse);

		request.on('error', (err) => settle(() => reject(err)));

		request.on('timeout', () => {
			request.destroy();
			settle(() => reject(new Error('Request timed out')));
		});
	});
}

async function fetchHubRootPage(port: number): Promise<string> {
	const errors: string[] = [];
	for (const protocol of ['http', 'https'] as const) {
		try {
			return await fetchHubPageWithProtocol(protocol, port);
		} catch (error) {
			errors.push(`${protocol}: ${getErrorMessage(error)}`);
		}
	}
	throw new Error(errors.join('; '));
}

async function fetchHubCsrfToken(port: number, log: DiscoveryLogger): Promise<string> {
	const maxAttempts = 3;
	let lastFailure = new Error(`CSRF token not found on the Antigravity hub page (port ${port})`);
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (attempt > 0) {
			await delay(RETRY_DELAY_MS * 4);
		}
		try {
			const csrfToken = extractAppConfigCsrfToken(await fetchHubRootPage(port), log);
			if (csrfToken) {
				return csrfToken;
			}
			log(`Hub page on port ${port} did not contain a usable CSRF token`);
		} catch (error) {
			lastFailure = error instanceof Error ? error : new Error(String(error));
		}
	}
	throw lastFailure;
}

async function resolveConnectionHint(hint: ConnectionHint, log: DiscoveryLogger): Promise<DiscoveredConnection | null> {
	if (hint.port === undefined || !validatePort(hint.port)) {
		return null;
	}

	const candidatePort = hint.port;
	if (hint.csrfToken) {
		try {
			const validated = await findValidPort([candidatePort], hint.csrfToken);
			log(`Validated exported extension connection on port: ${validated.port} (${validated.protocol})`);
			return { port: validated.port, csrfToken: hint.csrfToken, protocol: validated.protocol };
		} catch (error) {
			log(`Exported extension CSRF token validation failed on port ${candidatePort}: ${getErrorMessage(error)}`);
		}
	}

	try {
		const hubCsrfToken = await fetchHubCsrfToken(candidatePort, log);
		const validated = await findValidPort([candidatePort], hubCsrfToken);
		log(`Validated exported hub connection on port: ${validated.port} (${validated.protocol})`);
		return { port: validated.port, csrfToken: hubCsrfToken, protocol: validated.protocol };
	} catch (error) {
		log(`Exported extension port ${candidatePort} validation failed: ${getErrorMessage(error)}`);
		return null;
	}
}

async function resolveProcessConnection(processInfo: ProcessInfo, log: DiscoveryLogger): Promise<DiscoveredConnection> {
	const csrfToken = extractCsrfToken(processInfo.cmd);
	const hubPort = extractHubPort(processInfo.cmd);

	if (!csrfToken && hubPort === undefined) {
		throw new Error('Process has neither a CSRF token nor a hub port in its command line');
	}

	let listeningPorts: number[] = [];
	try {
		listeningPorts = await findListeningPorts(processInfo.pid, hubPort !== undefined ? 1 : PORT_DISCOVERY_ATTEMPTS);
	} catch (error) {
		if (hubPort === undefined) {
			throw error;
		}
		log(`Listening port lookup failed for PID ${processInfo.pid}, falling back to hub port ${hubPort}: ${getErrorMessage(error)}`);
	}

	const ports = Array.from(new Set([
		...(hubPort !== undefined ? [hubPort] : []),
		...listeningPorts
	]));

	if (ports.length === 0) {
		throw new Error('No listening ports found for the Antigravity process');
	}

	log(`Found ${ports.length} listening port(s): ${ports.join(', ')}`);

	if (csrfToken) {
		try {
			const validated = await findValidPort(ports, csrfToken);
			log(`Validated port: ${validated.port} (${validated.protocol})`);
			return { port: validated.port, csrfToken, protocol: validated.protocol };
		} catch (error) {
			if (hubPort === undefined) {
				throw error;
			}
			log(`Command-line CSRF token validation failed on PID ${processInfo.pid}, trying hub page CSRF token: ${getErrorMessage(error)}`);
		}
	}

	if (hubPort === undefined) {
		throw new Error('No hub port available for CSRF token fallback');
	}

	const hubCsrfToken = await fetchHubCsrfToken(hubPort, log);
	const validated = await findValidPort(ports, hubCsrfToken);
	log(`Validated hub port: ${validated.port} (${validated.protocol})`);
	return { port: validated.port, csrfToken: hubCsrfToken, protocol: validated.protocol };
}

export async function discoverConnection(log: DiscoveryLogger, options: DiscoveryOptions = {}): Promise<DiscoveredConnection> {
	forceRefreshUnsupportedPorts.clear();

	if (options.extensionHint) {
		const hinted = await resolveConnectionHint(options.extensionHint, log);
		if (hinted) {
			return hinted;
		}
	}

	const strategy = getPlatformStrategy();
	const processes = await strategy.getProcesses();
	const initialMatches = processes.filter(isMatchingProcess);

	if (initialMatches.length === 0) {
		throw new Error(NOT_FOUND_ERROR);
	}

	const grandparentPid = initialMatches.length > 1
		? await strategy.getParentPid(process.ppid)
		: undefined;
	const candidates = rankMatchingProcesses(initialMatches, {
		isAntigravityIde: options.isAntigravityIde === true,
		currentPid: process.pid,
		parentPid: process.ppid,
		grandparentPid
	});

	const failures: string[] = [];
	for (const processInfo of candidates) {
		log(`Found candidate process with PID: ${processInfo.pid}`);
		try {
			return await resolveProcessConnection(processInfo, log);
		} catch (error) {
			failures.push(`PID ${processInfo.pid}: ${getErrorMessage(error)}`);
		}
	}

	throw new Error(`Could not connect to any Antigravity process. ${failures.join(' | ')}`);
}

async function checkLegacyPort(port: number, csrfToken: string): Promise<LocalProtocol> {
	const result = await makeProtocolRequestWithResult(port, csrfToken, API_ENDPOINTS.GET_UNLEASH_DATA, {
		context: { properties: { ide: IDE_INFO.NAME, ideVersion: IDE_INFO.VERSION } }
	});
	return result.protocol;
}

async function checkQuotaSummaryPort(port: number, csrfToken: string): Promise<LocalProtocol> {
	const result = await fetchQuotaSummaryGroups(port, csrfToken, undefined, false);
	return result.protocol;
}

function isNonRetriableError(message: string): boolean {
	return NON_RETRIABLE_PATTERNS.some(pattern => pattern.test(message));
}

async function findValidPort(ports: number[], csrfToken: string): Promise<{ port: number; protocol: LocalProtocol }> {
	if (ports.length === 0) {
		throw new Error('No listening ports found for the Antigravity process');
	}

	const errors: Map<number, string> = new Map();
	const maxAttempts = MAX_PORT_VALIDATION_ATTEMPTS;

	const tryPorts = async (
		checkPort: (port: number, token: string) => Promise<LocalProtocol>
	): Promise<{ port: number; protocol: LocalProtocol } | null> => {
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			if (attempt > 0) {
				await delay(RETRY_DELAY_MS);
			}

			errors.clear();

			try {
				return await Promise.any(ports.map(async (port) => {
					try {
						const protocol = await checkPort(port, csrfToken);
						return { port, protocol };
					} catch (error) {
						errors.set(port, getErrorMessage(error));
						throw error;
					}
				}));
			} catch {
				const allNonRetriable = errors.size === ports.length &&
					Array.from(errors.values()).every(isNonRetriableError);

				if (allNonRetriable) {
					break;
				}
			}
		}
		return null;
	};

	const summaryPort = await tryPorts(checkQuotaSummaryPort);
	if (summaryPort !== null) {
		return summaryPort;
	}

	const legacyPort = await tryPorts(checkLegacyPort);
	if (legacyPort !== null) {
		return legacyPort;
	}

	const uniqueErrors = new Set(errors.values());
	if (uniqueErrors.size === 1) {
		throw new Error(`All ${ports.length} ports failed: ${[...uniqueErrors][0]}`);
	}
	const errorSummary = Array.from(errors.entries())
		.slice(0, 5)
		.map(([port, msg]) => `${port}: ${msg}`)
		.join('; ');
	throw new Error(`All port checks failed. [${errorSummary}]`);
}

function makeLocalRequest<T>(
	protocol: LocalProtocol,
	port: number,
	csrfToken: string,
	path: string,
	body: object
): Promise<T> {
	return new Promise((resolve, reject) => {
		if (!validatePort(port)) {
			return reject(new Error(`Invalid port: ${port}`));
		}

		const payload = JSON.stringify(body);
		let settled = false;
		const settle = (fn: () => void) => {
			if (settled) { return; }
			settled = true;
			fn();
		};

		const options = {
			hostname: LOCALHOST,
			port,
			path,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(payload),
				'X-Codeium-Csrf-Token': csrfToken,
				'Connect-Protocol-Version': '1'
			},
			timeout: REQUEST_TIMEOUT_MS
		};

		const handleResponse = (response: http.IncomingMessage) => {
			const statusCode = response.statusCode ?? 0;
			if (statusCode < 200 || statusCode >= 300) {
				response.resume();
				settle(() => reject(new LocalHttpError(statusCode, path)));
				return;
			}

			response.setEncoding('utf8');
			let responseData = '';
			let byteCount = 0;

			response.on('data', chunk => {
				if (settled) { return; }
				byteCount += Buffer.byteLength(chunk);
				if (byteCount > MAX_BUFFER_SIZE) {
					request.destroy();
					settle(() => reject(new Error(`Response exceeded ${MAX_BUFFER_SIZE} bytes`)));
					return;
				}
				responseData += chunk;
			});

			response.on('end', () => {
				try {
					const parsed = JSON.parse(responseData) as T;
					settle(() => resolve(parsed));
				} catch {
					settle(() => reject(new Error(`Invalid JSON response from ${path}`)));
				}
			});

			response.on('error', (err) => settle(() => reject(err)));
		};

		const request = protocol === 'https'
			? https.request({ ...options, rejectUnauthorized: false }, handleResponse)
			: http.request(options, handleResponse);

		request.on('error', (err) => settle(() => reject(err)));

		request.on('timeout', () => {
			request.destroy();
			settle(() => reject(new Error('Request timed out')));
		});

		request.write(payload);
		request.end();
	});
}

async function makeProtocolRequestWithResult<T>(
	port: number,
	csrfToken: string,
	path: string,
	body: object,
	preferredProtocol?: LocalProtocol
): Promise<{ data: T; protocol: LocalProtocol }> {
	const protocols: readonly LocalProtocol[] = preferredProtocol === 'http'
		? ['http', 'https']
		: ['https', 'http'];
	const errors: string[] = [];
	let fallbackHttpError: LocalHttpError | null = null;

	for (const protocol of protocols) {
		try {
			const data = await makeLocalRequest<T>(protocol, port, csrfToken, path, body);
			return { data, protocol };
		} catch (error) {
			if (error instanceof LocalHttpError) {
				if (protocol === 'https' || error.statusCode !== 400) {
					throw error;
				}
				fallbackHttpError = error;
				errors.push(`${protocol}: ${error.message}`);
				continue;
			}
			errors.push(`${protocol}: ${getErrorMessage(error)}`);
		}
	}

	if (fallbackHttpError) {
		throw fallbackHttpError;
	}
	throw new Error(errors.join('; '));
}

function parseResetTime(value: string | number | undefined): number | null {
	if (value == null) {
		return null;
	}
	const resetTimestamp = typeof value === 'number'
		? value
		: new Date(value).getTime();
	return Number.isFinite(resetTimestamp) ? resetTimestamp : null;
}

function parseQuotaFraction(value: number | string | undefined): number | null {
	const parsed = parseFloat(String(value ?? ''));
	return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : null;
}

function parseQuotaFractionOrExhausted(
	remainingFraction: number | string | undefined,
	resetTime: number | null
): number | null {
	const parsed = parseQuotaFraction(remainingFraction);
	if (parsed !== null) {
		return parsed;
	}
	const isOmitted = remainingFraction == null || String(remainingFraction).trim() === '';
	return isOmitted && resetTime !== null ? 0 : null;
}

function parseCreditAmount(value: number | string | undefined): number | undefined {
	const parsed = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
	return Number.isFinite(parsed) ? Math.max(0, parsed) : undefined;
}

function firstNonEmptyString(...values: Array<string | undefined>): string | undefined {
	return values.find(value => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function normalizeBucketDisplayName(window: string | undefined, displayName: string | undefined): string {
	const normalizedWindow = window?.toLowerCase();
	if (normalizedWindow === 'weekly') {
		return 'Weekly Limit';
	}
	if (normalizedWindow === '5h') {
		return 'Five Hour Limit';
	}
	return displayName || window || 'Limit';
}

function normalizeBucketWindow(window: string | undefined, bucketId: string | undefined, displayName: string | undefined): string {
	const candidates = [window, bucketId, displayName].filter((value): value is string => typeof value === 'string');
	const normalizedCandidates = candidates.map(value => value.toLowerCase());
	if (normalizedCandidates.some(value => value.includes('week'))) {
		return 'weekly';
	}
	if (normalizedCandidates.some(value => value.includes('5h') || /five[\s_-]*hour/.test(value))) {
		return '5h';
	}
	return window ?? bucketId ?? displayName ?? 'unknown';
}

function isMoreRestrictiveQuota(
	candidate: { quota: number; resetTime: number | null },
	current: { quota: number; resetTime: number | null }
): boolean {
	if (candidate.quota < current.quota) {
		return true;
	}
	if (candidate.quota > current.quota) {
		return false;
	}
	return candidate.resetTime !== null && (current.resetTime === null || candidate.resetTime < current.resetTime);
}

function mergeQuotaBuckets(existing: QuotaBucket[], incoming: QuotaBucket[]): QuotaBucket[] {
	const byWindow = new Map<string, QuotaBucket>();
	for (const bucket of [...existing, ...incoming]) {
		const key = bucket.window.toLowerCase();
		const current = byWindow.get(key);
		if (!current || isMoreRestrictiveQuota(bucket, current)) {
			byWindow.set(key, bucket);
		}
	}
	return sortQuotaBuckets([...byWindow.values()]);
}

function pickEffectiveBucket(buckets: QuotaBucket[]): QuotaBucket {
	return buckets.reduce((lowest, bucket) => {
		if (bucket.quota === 0 && lowest.quota === 0) {
			if (bucket.resetTime !== null && (lowest.resetTime === null || bucket.resetTime > lowest.resetTime)) {
				return bucket;
			}
			return lowest;
		}
		return isMoreRestrictiveQuota(bucket, lowest) ? bucket : lowest;
	}, buckets[0]);
}

function parseQuotaSummary(response: ServerQuotaSummaryResponse): Record<string, QuotaGroup> {
	const groups: Record<string, QuotaGroup> = {};
	const rawGroups = response.response?.groups ?? response.groups ?? [];

	for (const rawGroup of rawGroups) {
		const displayName = rawGroup.displayName ?? rawGroup.groupId ?? '';
		const category = determineCategory(displayName);
		const buckets: QuotaBucket[] = [];

		for (const rawBucket of rawGroup.buckets ?? []) {
			const resetTime = parseResetTime(rawBucket.resetTime);
			const quota = parseQuotaFractionOrExhausted(rawBucket.remainingFraction, resetTime);
			if (quota === null) {
				continue;
			}
			const window = normalizeBucketWindow(rawBucket.window, rawBucket.bucketId, rawBucket.displayName);
			buckets.push({
				window,
				displayName: normalizeBucketDisplayName(window, rawBucket.displayName),
				quota,
				resetTime
			});
		}

		if (buckets.length === 0) {
			continue;
		}

		const group = groups[category] ??= { quota: 1, resetTime: null, buckets: [] };
		group.buckets = mergeQuotaBuckets(group.buckets ?? [], buckets);

		const effectiveBucket = pickEffectiveBucket(group.buckets);
		group.quota = effectiveBucket.quota;
		group.resetTime = effectiveBucket.resetTime;
	}

	return groups;
}

function isForceRefreshRejectedError(error: unknown): boolean {
	return error instanceof LocalHttpError &&
		(error.statusCode === 400 || error.statusCode === 422 || error.statusCode === 500 || error.statusCode === 501);
}

async function requestQuotaSummary(
	port: number,
	csrfToken: string,
	preferredProtocol?: LocalProtocol,
	forceRefresh: boolean = false
): Promise<{ data: ServerQuotaSummaryResponse; protocol: LocalProtocol }> {
	if (forceRefresh && !forceRefreshUnsupportedPorts.has(port)) {
		try {
			return await makeProtocolRequestWithResult<ServerQuotaSummaryResponse>(
				port,
				csrfToken,
				API_ENDPOINTS.RETRIEVE_USER_QUOTA_SUMMARY,
				{ forceRefresh: true },
				preferredProtocol
			);
		} catch (error) {
			if (!isForceRefreshRejectedError(error)) {
				throw error;
			}
			const fallbackResult = await makeProtocolRequestWithResult<ServerQuotaSummaryResponse>(
				port,
				csrfToken,
				API_ENDPOINTS.RETRIEVE_USER_QUOTA_SUMMARY,
				{},
				preferredProtocol
			);
			forceRefreshUnsupportedPorts.add(port);
			return fallbackResult;
		}
	}

	return makeProtocolRequestWithResult<ServerQuotaSummaryResponse>(
		port,
		csrfToken,
		API_ENDPOINTS.RETRIEVE_USER_QUOTA_SUMMARY,
		{},
		preferredProtocol
	);
}

async function fetchQuotaSummaryGroups(
	port: number,
	csrfToken: string,
	preferredProtocol?: LocalProtocol,
	forceRefresh: boolean = false
): Promise<{ groups: Record<string, QuotaGroup>; protocol: LocalProtocol }> {
	const result = await requestQuotaSummary(port, csrfToken, preferredProtocol, forceRefresh);
	const groups = parseQuotaSummary(result.data);
	if (Object.keys(groups).length === 0) {
		throw new Error('Quota summary response did not include any quota groups');
	}
	return { groups, protocol: result.protocol };
}

export async function fetchStats(
	port: number,
	csrfToken: string,
	preferredProtocol?: LocalProtocol,
	log?: DiscoveryLogger
): Promise<UsageStatistics> {
	const [summaryResult, statusResult] = await Promise.allSettled([
		fetchQuotaSummaryGroups(port, csrfToken, preferredProtocol, true),
		makeProtocolRequestWithResult<ServerUserStatusResponse>(
			port,
			csrfToken,
			API_ENDPOINTS.GET_USER_STATUS,
			{ metadata: { ideName: IDE_INFO.NAME } },
			preferredProtocol
		)
	]);

	let summaryGroups: Record<string, QuotaGroup> | null = null;
	if (summaryResult.status === 'fulfilled') {
		summaryGroups = summaryResult.value.groups;
	} else {
		log?.(`RetrieveUserQuotaSummary failed, falling back to GetUserStatus: ${getErrorMessage(summaryResult.reason)}`);
	}

	let response: ServerUserStatusResponse = {};
	if (statusResult.status === 'fulfilled') {
		response = statusResult.value.data;
	} else if (!summaryGroups) {
		throw statusResult.reason;
	} else {
		log?.(`GetUserStatus failed while quota summary succeeded: ${getErrorMessage(statusResult.reason)}`);
	}

	const models = response.userStatus?.cascadeModelConfigData?.clientModelConfigs ?? [];
	const groups: Record<string, QuotaGroup> = summaryGroups ?? {};

	if (!summaryGroups) {
		for (const model of models) {
			const { quotaInfo, label } = model;
			const resetTimestamp = parseResetTime(quotaInfo?.resetTime);
			const modelQuota = parseQuotaFractionOrExhausted(quotaInfo?.remainingFraction, resetTimestamp);
			if (modelQuota === null) {
				continue;
			}
			const category = determineCategory(label);
			const group = groups[category] ??= { quota: 1, resetTime: null };

			if (isMoreRestrictiveQuota({ quota: modelQuota, resetTime: resetTimestamp }, group)) {
				group.quota = modelQuota;
				group.resetTime = resetTimestamp;
			}
		}
	}

	for (const model of models) {
		const { label } = model;
		if (!label) {
			continue;
		}
		const category = determineCategory(label);
		const group = groups[category];
		if (group) {
			group.models ??= [];
			const modelName = normalizeModelName(label);
			if (modelName && !group.models.includes(modelName)) {
				group.models.push(modelName);
			}
		}
	}

	const plan = firstNonEmptyString(
		response.userStatus?.planStatus?.planInfo?.planName,
		response.userStatus?.plan,
		response.plan
	);
	const planName = firstNonEmptyString(
		response.userStatus?.userTier?.name,
		response.userStatus?.planName,
		response.planName
	);

	const rawCredit = response.userStatus?.userTier?.availableCredits?.[0];
	const credits = rawCredit ? {
		creditType: rawCredit.creditType ?? 'PLAN_CREDITS',
		creditAmount: parseCreditAmount(rawCredit.creditAmount) ?? 0,
		minimumCreditAmountForUsage: parseCreditAmount(rawCredit.minimumCreditAmountForUsage) ?? 0
	} : undefined;

	return { groups, plan, planName, credits };
}
