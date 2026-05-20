import { spawn } from 'child_process';
import { CATEGORY_ORDER, MAX_PID_32BIT_SIGNED, MAX_PORT, MIN_PORT, MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE, SERVER_STARTUP_DELAY } from './constants';
import { QuotaGroup } from './types';

export const MAX_BUFFER_SIZE = 1024 * 1024;

export function validatePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0 && pid <= MAX_PID_32BIT_SIGNED;
}

export function validatePort(port: number): boolean {
  return Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT;
}

const COMMAND_TIMEOUT_MS = 10000;

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

export function isNotStartedQuota(percentage: number, resetMs: number): boolean {
  const toleranceMs = SERVER_STARTUP_DELAY * MS_PER_MINUTE;
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
  return CATEGORY_ORDER.every(category => {
    const group = groups[category];
    return group !== undefined &&
      group.quota === 0 &&
      typeof group.resetTime === 'number' &&
      group.resetTime <= now;
  });
}
