import * as https from 'https';
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
import { ProcessId, ProcessInfo, QuotaGroup, ServerUserStatusResponse, UsageStatistics } from './types';
import { delay, getErrorMessage, MAX_BUFFER_SIZE, validatePid, validatePort } from './utils';

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
  GET_USER_STATUS: '/exa.language_server_pb.LanguageServerService/GetUserStatus'
};

export async function findAntigravityProcess(): Promise<ProcessInfo> {
  const strategy = getPlatformStrategy();
  const processes = await strategy.getProcesses();

  const matchingProcesses = processes.filter((p: ProcessInfo) =>
    p.cmd.includes(PROCESS_IDENTIFIERS.ANTIGRAVITY) || p.cmd.includes(PROCESS_IDENTIFIERS.CSRF_TOKEN)
  );

  if (matchingProcesses.length === 0) {
    throw new Error('Antigravity process not found. Make sure Antigravity is running.');
  }

  matchingProcesses.sort((a, b) => b.pid - a.pid);
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

async function checkPort(port: number, csrfToken: string): Promise<void> {
  await makeRequest(port, csrfToken, API_ENDPOINTS.GET_UNLEASH_DATA, {
    context: { properties: { ide: IDE_INFO.NAME, ideVersion: IDE_INFO.VERSION } }
  });
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
          await checkPort(port, csrfToken);
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

export function makeRequest<T>(port: number, csrfToken: string, path: string, body: object, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!validatePort(port)) {
      return reject(new Error(`Invalid port: ${port}`));
    }

    if (signal?.aborted) {
      return reject(new Error('Request aborted'));
    }

    const payload = JSON.stringify(body);

    let cleanedUp = false;
    let request: ReturnType<typeof https.request> | null = null;

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

    request = https.request({
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
      timeout: REQUEST_TIMEOUT_MS,
      rejectUnauthorized: false
    }, response => {
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
    });

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

function determineCategory(label: string): string {
  const lowerLabel = label.toLowerCase();
  if (lowerLabel.includes(MODEL_KEYWORDS.flash)) { return CATEGORY_NAMES.GEMINI_FLASH; }
  if (lowerLabel.includes(MODEL_KEYWORDS.gemini)) { return CATEGORY_NAMES.GEMINI_PRO; }
  return CATEGORY_NAMES.CLAUDE_GPT;
}

export async function fetchStats(port: number, csrfToken: string): Promise<UsageStatistics> {
  const response = await makeRequest<ServerUserStatusResponse>(
    port,
    csrfToken,
    API_ENDPOINTS.GET_USER_STATUS,
    { metadata: { ideName: IDE_INFO.NAME } }
  );

  const models = response.userStatus?.cascadeModelConfigData?.clientModelConfigs ?? [];
  const groups: Record<string, QuotaGroup> = {};

  for (const model of models) {
    const { quotaInfo, label } = model;

    const parsed = parseFloat(String(quotaInfo?.remainingFraction ?? ''));
    const modelQuota = Number.isFinite(parsed) ? parsed : 0;
    const category = determineCategory(label);
    const group = groups[category] ??= { quota: 1, resetTime: null };

    if (modelQuota < group.quota) {
      group.quota = modelQuota;
    }

    const rawResetTime = quotaInfo?.resetTime;
    if (rawResetTime != null) {
      const resetTimestamp = typeof rawResetTime === 'number'
        ? rawResetTime
        : new Date(rawResetTime).getTime();
      if (Number.isFinite(resetTimestamp) && (group.resetTime === null || resetTimestamp < group.resetTime)) {
        group.resetTime = resetTimestamp;
      }
    }
  }

  const plan = response.userStatus?.planStatus?.planInfo?.planName;
  const planName = response.userStatus?.userTier?.name;

  const rawCredit = response.userStatus?.userTier?.availableCredits?.[0];
  const credits = rawCredit ? {
    creditType: rawCredit.creditType ?? 'GOOGLE_ONE_AI',
    creditAmount: parseInt(rawCredit.creditAmount ?? '0', 10) || 0,
    minimumCreditAmountForUsage: parseInt(rawCredit.minimumCreditAmountForUsage ?? '0', 10) || 0,
  } : undefined;

  return { groups, plan, planName, credits };
}
