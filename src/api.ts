import * as https from 'https';
import * as http from 'http';
import {
  CATEGORY_NAMES,
  IDE_INFO,
  MAX_PORT_VALIDATION_ATTEMPTS,
  MODEL_KEYWORDS,
  PROCESS_IDENTIFIERS,
  REQUEST_TIMEOUT_MS,
  RETRY_DELAY_MS
} from './constants';
import { getPlatformStrategy } from './platform';
import { ProcessId, ProcessInfo, QuotaBucket, QuotaGroup, ServerQuotaSummaryResponse, ServerUserStatusResponse, UsageStatistics } from './types';
import { delay, getErrorMessage, MAX_BUFFER_SIZE, sortQuotaBuckets, validatePid, validatePort } from './utils';

export function extractCsrfToken(cmd: string): string | undefined {
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

const LOCALHOST = '127.0.0.1';

const API_ENDPOINTS = {
  GET_UNLEASH_DATA: '/exa.language_server_pb.LanguageServerService/GetUnleashData',
  RETRIEVE_USER_QUOTA_SUMMARY: '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
  GET_USER_STATUS: '/exa.language_server_pb.LanguageServerService/GetUserStatus'
};

export async function findAntigravityProcess(): Promise<ProcessInfo> {
  const strategy = getPlatformStrategy();
  const processes = await strategy.getProcesses();

  const matchingProcesses = processes.filter((p: ProcessInfo) => {
    const cmd = p.cmd.toLowerCase();
    return extractCsrfToken(p.cmd) !== undefined &&
      (cmd.includes(PROCESS_IDENTIFIERS.ANTIGRAVITY.toLowerCase()) ||
        cmd.includes(PROCESS_IDENTIFIERS.CSRF_TOKEN.toLowerCase()));
  });

  if (matchingProcesses.length === 0) {
    throw new Error('Antigravity process with CSRF token not found. Make sure Antigravity is running.');
  }

  const scoreProcess = (process: ProcessInfo): number => {
    const cmd = process.cmd.toLowerCase();
    let score = 0;
    if (cmd.includes('--standalone')) { score += 8; }
    if (cmd.includes('--override_ide_name antigravity')) { score += 6; }
    if (cmd.includes('\\antigravity\\resources\\bin\\language_server.exe')) { score += 6; }
    if (cmd.includes('--app_data_dir antigravity')) { score += 4; }
    if (cmd.includes('--app_data_dir antigravity-ide')) { score -= 2; }
    return score;
  };

  matchingProcesses.sort((a, b) => {
    const scoreDiff = scoreProcess(b) - scoreProcess(a);
    return scoreDiff !== 0 ? scoreDiff : b.pid - a.pid;
  });
  return matchingProcesses[0];
}

export async function findListeningPorts(pid: ProcessId): Promise<number[]> {
  if (!validatePid(pid)) {
    throw new Error(`Invalid process ID: ${pid}`);
  }

  const strategy = getPlatformStrategy();
  const rawPorts = await strategy.getPorts(pid);

  return Array.from(new Set(rawPorts));
}

async function checkLegacyPort(port: number, csrfToken: string): Promise<void> {
  await makeRequest(port, csrfToken, API_ENDPOINTS.GET_UNLEASH_DATA, {
    context: { properties: { ide: IDE_INFO.NAME, ideVersion: IDE_INFO.VERSION } }
  });
}

async function checkQuotaSummaryPort(port: number, csrfToken: string): Promise<void> {
  await fetchQuotaSummaryGroups(port, csrfToken);
}

const NON_RETRIABLE_PATTERNS = [
  /unauthorized|forbidden|401|403/i,
  /invalid.*token|token.*invalid/i,
  /certificate|ssl|tls/i
];

function isNonRetriableError(message: string): boolean {
  return NON_RETRIABLE_PATTERNS.some(pattern => pattern.test(message));
}

export async function findValidPort(ports: number[], csrfToken: string): Promise<number> {
  if (ports.length === 0) {
    throw new Error('No listening ports found for the Antigravity process');
  }

  const errors: Map<number, string> = new Map();
  const maxAttempts = MAX_PORT_VALIDATION_ATTEMPTS;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await delay(RETRY_DELAY_MS);
    }

    errors.clear();

    try {
      return await Promise.any(ports.map(async (port) => {
        try {
          await checkQuotaSummaryPort(port, csrfToken);
          return port;
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

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await delay(RETRY_DELAY_MS);
    }

    errors.clear();

    try {
      return await Promise.any(ports.map(async (port) => {
        try {
          await checkLegacyPort(port, csrfToken);
          return port;
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

type LocalProtocol = 'https' | 'http';

function makeLocalRequest<T>(
  protocol: LocalProtocol,
  port: number,
  csrfToken: string,
  path: string,
  body: object,
  signal?: AbortSignal
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!validatePort(port)) {
      return reject(new Error(`Invalid port: ${port}`));
    }

    if (signal?.aborted) {
      return reject(new Error('Request aborted'));
    }

    const payload = JSON.stringify(body);

    let cleanedUp = false;
    let request: ReturnType<typeof https.request> | ReturnType<typeof http.request> | null = null;

    const abortHandler = signal ? () => {
      cleanup();
      request?.destroy();
      reject(new Error('Request aborted'));
    } : null;

    const cleanup = () => {
      if (cleanedUp) { return; }
      cleanedUp = true;
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    if (signal && abortHandler) {
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const options = {
      hostname: LOCALHOST,
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-Codeium-Csrf-Token': csrfToken,
        'x-codeium-csrf-token': csrfToken,
        'Connect-Protocol-Version': '1'
      },
      timeout: REQUEST_TIMEOUT_MS
    };
    const handleResponse = (response: http.IncomingMessage) => {
      response.setEncoding('utf8');
      let responseData = '';
      let byteCount = 0;

      response.on('data', chunk => {
        byteCount += Buffer.byteLength(chunk);
        if (byteCount > MAX_BUFFER_SIZE) {
          cleanup();
          request?.destroy();
          return reject(new Error(`Response exceeded ${MAX_BUFFER_SIZE} bytes`));
        }
        responseData += chunk;
      });

      response.on('end', () => {
        cleanup();
        const statusCode = response.statusCode ?? 0;

        if (statusCode < 200 || statusCode >= 300) {
          return reject(new Error(`HTTP ${statusCode} on ${path}`));
        }
        try {
          resolve(JSON.parse(responseData));
        } catch {
          reject(new Error(`Invalid JSON response from ${path}`));
        }
      });

      response.on('error', (err) => {
        cleanup();
        reject(err);
      });
    };

    request = protocol === 'https'
      ? https.request({ ...options, rejectUnauthorized: false }, handleResponse)
      : http.request(options, handleResponse);

    request.on('error', (err) => {
      cleanup();
      reject(err);
    });

    request.on('timeout', () => {
      cleanup();
      request.destroy();
      reject(new Error('Request timed out'));
    });

    request.write(payload);
    request.end();
  });
}

export function makeRequest<T>(port: number, csrfToken: string, path: string, body: object, signal?: AbortSignal): Promise<T> {
  return makeLocalRequest<T>('https', port, csrfToken, path, body, signal);
}

async function makeProtocolRequest<T>(port: number, csrfToken: string, path: string, body: object): Promise<T> {
  const errors: string[] = [];
  for (const protocol of ['https', 'http'] as const) {
    try {
      return await makeLocalRequest<T>(protocol, port, csrfToken, path, body);
    } catch (error) {
      errors.push(`${protocol}: ${getErrorMessage(error)}`);
    }
  }
  throw new Error(errors.join('; '));
}

function determineCategory(label: string): string {
  const lowerLabel = label.toLowerCase();
  if (lowerLabel.includes(MODEL_KEYWORDS.gemini) || lowerLabel.includes(MODEL_KEYWORDS.flash)) {
    return CATEGORY_NAMES.GEMINI;
  }
  return CATEGORY_NAMES.OTHER;
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

function parseQuotaSummary(response: ServerQuotaSummaryResponse): Record<string, QuotaGroup> {
  const groups: Record<string, QuotaGroup> = {};

  for (const rawGroup of response.response?.groups ?? []) {
    const displayName = rawGroup.displayName ?? '';
    const category = determineCategory(displayName);
    const buckets: QuotaBucket[] = [];

    for (const rawBucket of rawGroup.buckets ?? []) {
      const quota = parseQuotaFraction(rawBucket.remainingFraction);
      if (quota === null) {
        continue;
      }
      buckets.push({
        window: rawBucket.window ?? rawBucket.bucketId ?? rawBucket.displayName ?? 'unknown',
        displayName: normalizeBucketDisplayName(rawBucket.window, rawBucket.displayName),
        quota,
        resetTime: parseResetTime(rawBucket.resetTime)
      });
    }

    if (buckets.length === 0) {
      continue;
    }

    const sortedBuckets = sortQuotaBuckets(buckets);

    const effectiveBucket = sortedBuckets.reduce((lowest, bucket) => bucket.quota < lowest.quota ? bucket : lowest, sortedBuckets[0]);
    const group = groups[category] ??= { quota: 1, resetTime: null, buckets: [] };
    group.buckets = [...(group.buckets ?? []), ...sortedBuckets];

    if (effectiveBucket.quota < group.quota) {
      group.quota = effectiveBucket.quota;
      group.resetTime = effectiveBucket.resetTime;
    }
  }

  return groups;
}

async function requestQuotaSummary(port: number, csrfToken: string): Promise<ServerQuotaSummaryResponse> {
  return makeProtocolRequest<ServerQuotaSummaryResponse>(
    port,
    csrfToken,
    API_ENDPOINTS.RETRIEVE_USER_QUOTA_SUMMARY,
    {}
  );
}

async function fetchQuotaSummaryGroups(port: number, csrfToken: string): Promise<Record<string, QuotaGroup>> {
  const response = await requestQuotaSummary(port, csrfToken);
  const groups = parseQuotaSummary(response);
  if (Object.keys(groups).length === 0) {
    throw new Error('Quota summary response did not include any quota groups');
  }
  return groups;
}

export async function fetchStats(port: number, csrfToken: string): Promise<UsageStatistics> {
  let summaryGroups: Record<string, QuotaGroup> | null;
  try {
    summaryGroups = await fetchQuotaSummaryGroups(port, csrfToken);
  } catch {
    summaryGroups = null;
  }

  let response: ServerUserStatusResponse = {};
  try {
    response = await makeProtocolRequest<ServerUserStatusResponse>(
      port,
      csrfToken,
      API_ENDPOINTS.GET_USER_STATUS,
      { metadata: { ideName: IDE_INFO.NAME } }
    );
  } catch (error) {
    if (!summaryGroups) {
      throw error;
    }
  }

  const models = response.userStatus?.cascadeModelConfigData?.clientModelConfigs ?? [];
  const groups: Record<string, QuotaGroup> = summaryGroups ?? {};

  if (!summaryGroups) {
    for (const model of models) {
      const { quotaInfo, label } = model;

      const modelQuota = parseQuotaFraction(quotaInfo?.remainingFraction);
      if (modelQuota === null) {
        continue;
      }
      const category = determineCategory(label);
      const group = groups[category] ??= { quota: 1, resetTime: null };

      if (modelQuota < group.quota) {
        group.quota = modelQuota;
      }

      const resetTimestamp = parseResetTime(quotaInfo?.resetTime);
      if (resetTimestamp !== null && (group.resetTime === null || resetTimestamp < group.resetTime)) {
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
      if (!group.models.includes(label)) {
        group.models.push(label);
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
    minimumCreditAmountForUsage: parseCreditAmount(rawCredit.minimumCreditAmountForUsage) ?? 0,
  } : undefined;

  return { groups, plan, planName, credits };
}
