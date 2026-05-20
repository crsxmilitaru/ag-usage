import * as fs from 'fs';
import * as os from 'os';
import { PROCESS_IDENTIFIERS } from './constants';
import { ProcessId, ProcessInfo } from './types';
import { executeCommand, getErrorMessage, validatePid, validatePort } from './utils';

export interface PlatformStrategy {
  getProcesses(): Promise<ProcessInfo[]>;
  getPorts(pid: ProcessId): Promise<number[]>;
}

class WindowsPlatform implements PlatformStrategy {
  async getProcesses(): Promise<ProcessInfo[]> {
    let stdout: string;
    const escapedIdentifier = this.escapeLikePattern(PROCESS_IDENTIFIERS.LANGUAGE_SERVER);
    try {
      stdout = await executeCommand('powershell', [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%${escapedIdentifier}%'" | Select-Object ProcessId, CommandLine | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }`
      ]);
    } catch {
      try {
        stdout = await executeCommand('wmic', [
          'process',
          'where',
          `CommandLine like '%${escapedIdentifier}%'`,
          'get',
          'CommandLine,ProcessId',
          '/format:csv'
        ]);
        return this.parseWmicOutput(stdout);
      } catch (wmicError) {
        throw new Error(`Failed to query Windows processes. Neither 'powershell' nor 'wmic' are available: ${getErrorMessage(wmicError)}`, { cause: wmicError });
      }
    }

    const processes: ProcessInfo[] = [];
    const lines = stdout.trim().split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) { continue; }

      const separatorIndex = trimmed.indexOf('|');
      if (separatorIndex === -1) { continue; }

      const pidStr = trimmed.substring(0, separatorIndex).trim();
      const pid = parseInt(pidStr, 10);
      const cmd = trimmed.substring(separatorIndex + 1).trim();

      if (validatePid(pid) && cmd) {
        processes.push({ pid, cmd });
      }
    }

    return processes;
  }

  async getPorts(pid: ProcessId): Promise<number[]> {
    let stdout: string;
    try {
      stdout = await executeCommand('powershell', [
        '-NoProfile',
        '-Command',
        `Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort`
      ]);
    } catch {
      try {
        stdout = await executeCommand('netstat', ['-ano', '-p', 'tcp']);
        return this.parseNetstatOutput(stdout, pid);
      } catch (error) {
        throw new Error(`Failed to query Windows ports. Neither 'powershell' nor 'netstat' are available: ${getErrorMessage(error)}`, { cause: error });
      }
    }

    const ports: number[] = [];
    for (const line of stdout.trim().split(/\r?\n/)) {
      const port = parseInt(line.trim(), 10);
      if (validatePort(port)) {
        ports.push(port);
      }
    }
    return ports;
  }

  private escapeLikePattern(value: string): string {
    return value.replace(/[%_[\]]/g, '[$&]').replace(/'/g, "''");
  }

  private parseWmicOutput(stdout: string): ProcessInfo[] {
    const lines = stdout.trim().split(/\r?\n/);
    const processes: ProcessInfo[] = [];

    for (const line of lines) {
      if (!line || line.startsWith('Node,')) { continue; }
      const lastCommaIndex = line.lastIndexOf(',');
      if (lastCommaIndex === -1) { continue; }

      const pidStr = line.substring(lastCommaIndex + 1).trim();
      const pid = parseInt(pidStr, 10);
      const firstCommaIndex = line.indexOf(',');
      if (firstCommaIndex === -1 || firstCommaIndex === lastCommaIndex) { continue; }

      const cmd = line.substring(firstCommaIndex + 1, lastCommaIndex).trim();

      if (validatePid(pid)) {
        processes.push({ pid, cmd });
      }
    }

    return processes;
  }

  private parseNetstatOutput(stdout: string, pid: ProcessId): number[] {
    const ports: number[] = [];
    const lines = stdout.split(/\r?\n/);
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) { continue; }

      const linePid = parseInt(parts[parts.length - 1], 10);
      if (linePid !== pid) { continue; }

      const localAddress = parts[1];
      const lastColon = localAddress.lastIndexOf(':');
      if (lastColon !== -1) {
        const port = parseInt(localAddress.substring(lastColon + 1), 10);
        if (validatePort(port)) {
          ports.push(port);
        }
      }
    }
    return ports;
  }
}

class UnixPlatform implements PlatformStrategy {
  async getProcesses(): Promise<ProcessInfo[]> {
    let stdout: string;
    try {
      stdout = await executeCommand('ps', ['-eo', 'pid,args']);
    } catch (error) {
      throw new Error(`Failed to query Unix processes: ${getErrorMessage(error)}`, { cause: error });
    }

    const currentUserUid = os.platform() === 'linux' ? os.userInfo().uid : -1;
    const currentHome = os.homedir();

    const candidates = stdout
      .split('\n')
      .filter(line => line.includes(PROCESS_IDENTIFIERS.LANGUAGE_SERVER))
      .map(line => {
        const trimmed = line.trim();
        const match = trimmed.match(/^(\d+)\s+(.+)$/);
        if (!match) { return null; }
        const pid = parseInt(match[1], 10);
        const cmdText = match[2].trim();
        return cmdText && validatePid(pid) ? { pid, cmd: cmdText } : null;
      })
      .filter((p): p is ProcessInfo => p !== null);

    const validated: ProcessInfo[] = [];
    for (const p of candidates) {
      if (await this.isValidProcess(p.pid, currentUserUid, currentHome)) {
        validated.push(p);
      }
    }
    return validated;
  }

  async getPorts(pid: ProcessId): Promise<number[]> {
    const platform = os.platform();

    if (platform === 'darwin') {
      try {
        const stdout = await executeCommand('lsof', ['-iTCP', '-sTCP:LISTEN', '-n', '-P', '-p', String(pid)]);
        return this.parseUnixLsofOutput(stdout);
      } catch (error) {
        throw new Error(`Failed to query Unix ports calling lsof: ${getErrorMessage(error)}`, { cause: error });
      }
    }

    const queries = [
      { type: 'ss', cmd: 'ss', args: ['-tlnp'] },
      { type: 'lsof', cmd: 'lsof', args: ['-iTCP', '-sTCP:LISTEN', '-n', '-P', '-p', String(pid)] },
      { type: 'netstat', cmd: 'netstat', args: ['-tlnp'] }
    ];

    const errors: string[] = [];

    for (const { type, cmd, args } of queries) {
      try {
        const stdout = await executeCommand(cmd, args);
        if (type === 'ss') return this.parseUnixSsOutput(stdout, pid);
        if (type === 'lsof') return this.parseUnixLsofOutput(stdout);
        if (type === 'netstat') return this.parseUnixNetstatOutput(stdout, pid);
      } catch (error) {
        errors.push(`${cmd}: ${getErrorMessage(error)}`);
      }
    }

    throw new Error(`Failed to query Unix ports. None of 'ss', 'lsof', or 'netstat' succeeded: ${errors.join('; ')}`);
  }

  private getEnvValue(environ: Buffer, keyToFind: string): string | undefined {
    return environ.toString().split('\0')
      .find(line => line.startsWith(keyToFind + '='))
      ?.substring(keyToFind.length + 1);
  }

  private async isValidProcess(pid: number, expectedUid: number, expectedHome: string): Promise<boolean> {
    if (os.platform() !== 'linux') { return true; }
    try {
      const procPath = `/proc/${pid}`;
      const stat = await fs.promises.stat(procPath);
      if (stat.uid !== expectedUid) { return false; }

      const environ = await fs.promises.readFile(`${procPath}/environ`);
      return this.getEnvValue(environ, 'HOME') === expectedHome;
    } catch {
      return false;
    }
  }

  private parseUnixLsofOutput(stdout: string): number[] {
    const ports: number[] = [];
    const regex = /:(\d+)\s+\(LISTEN\)/g;
    let match;
    while ((match = regex.exec(stdout)) !== null) {
      const port = parseInt(match[1], 10);
      if (validatePort(port)) {
        ports.push(port);
      }
    }
    return ports;
  }

  private parseUnixSsOutput(stdout: string, pid: number): number[] {
    const ports: number[] = [];
    const lines = stdout.split('\n');
    const pidPattern = new RegExp(`pid=${pid}\\b`);
    for (const line of lines) {
      if (!pidPattern.test(line)) { continue; }
      const portMatch = line.match(/:(\d+)\s/);
      if (portMatch) {
        const port = parseInt(portMatch[1], 10);
        if (validatePort(port)) {
          ports.push(port);
        }
      }
    }
    return ports;
  }

  private parseUnixNetstatOutput(stdout: string, pid: number): number[] {
    const ports: number[] = [];
    const lines = stdout.split('\n');
    const pidPattern = new RegExp(`\\b${pid}/`);
    for (const line of lines) {
      if (!pidPattern.test(line)) { continue; }
      const portMatch = line.match(/:(\d+)\s/);
      if (portMatch) {
        const port = parseInt(portMatch[1], 10);
        if (validatePort(port)) {
          ports.push(port);
        }
      }
    }
    return ports;
  }
}

let cachedStrategy: PlatformStrategy | null = null;

export function getPlatformStrategy(): PlatformStrategy {
  if (!cachedStrategy) {
    cachedStrategy = os.platform() === 'win32' ? new WindowsPlatform() : new UnixPlatform();
  }
  return cachedStrategy;
}
