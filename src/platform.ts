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
    const escapedLanguageServer = this.escapeLikePattern(PROCESS_IDENTIFIERS.LANGUAGE_SERVER);
    const escapedHubPort = this.escapeLikePattern(PROCESS_IDENTIFIERS.HUB_PORT);
    const escapedHubPortUnderscore = this.escapeLikePattern(PROCESS_IDENTIFIERS.HUB_PORT_UNDERSCORE);
    const escapedCsrfToken = this.escapeLikePattern(PROCESS_IDENTIFIERS.CSRF_TOKEN);
    const processFilter = `CommandLine LIKE '%${escapedLanguageServer}%' OR CommandLine LIKE '%${escapedHubPort}%' OR CommandLine LIKE '%${escapedHubPortUnderscore}%' OR CommandLine LIKE '%${escapedCsrfToken}%'`;
    try {
      stdout = await executeCommand('powershell', [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "${processFilter}" | Where-Object { $_.ProcessId -ne $PID } | Select-Object ProcessId, CommandLine | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }`
      ]);
    } catch {
      try {
        stdout = await executeCommand('wmic', [
          'process',
          'where',
          `CommandLine like '%${escapedLanguageServer}%' or CommandLine like '%${escapedHubPort}%' or CommandLine like '%${escapedHubPortUnderscore}%' or CommandLine like '%${escapedCsrfToken}%'`,
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

      if (validatePid(pid) && pid !== process.pid && cmd) {
        processes.push({ pid, cmd });
      }
    }

    return processes;
  }

  async getPorts(pid: ProcessId): Promise<number[]> {
    const directPorts = await this.getDirectPorts(pid);
    if (directPorts.length > 0) {
      return directPorts;
    }

    const childPids = await this.getChildPids(pid);
    const childPorts: number[] = [];
    for (const childPid of childPids) {
      const ports = await this.getDirectPorts(childPid);
      childPorts.push(...ports);
    }
    return childPorts;
  }

  private async getDirectPorts(pid: ProcessId): Promise<number[]> {
    try {
      const stdout = await executeCommand('powershell', [
        '-NoProfile',
        '-Command',
        `Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort`
      ]);
      return this.parsePortLines(stdout);
    } catch (powershellError) {
      try {
        const stdout = await executeCommand('netstat', ['-ano']);
        return this.parseNetstatOutput(stdout, pid);
      } catch (netstatError) {
        throw new Error(`Failed to query Windows ports. Neither 'powershell' nor 'netstat' are available: powershell: ${getErrorMessage(powershellError)}; netstat: ${getErrorMessage(netstatError)}`, { cause: netstatError });
      }
    }
  }

  private async getChildPids(pid: ProcessId): Promise<ProcessId[]> {
    try {
      const stdout = await executeCommand('powershell', [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${pid}" | Select-Object -ExpandProperty ProcessId`
      ]);
      return stdout
        .trim()
        .split(/\r?\n/)
        .map(line => parseInt(line.trim(), 10))
        .filter(childPid => validatePid(childPid) && childPid !== pid && childPid !== process.pid);
    } catch {
      return [];
    }
  }

  private parsePortLines(stdout: string): number[] {
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

      if (validatePid(pid) && pid !== process.pid && cmd) {
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
      if (parts[0].toUpperCase() !== 'TCP') { continue; }

      const linePid = parseInt(parts[parts.length - 1], 10);
      if (linePid !== pid) { continue; }

      const foreignAddress = parts[2];
      const state = parts[3].toUpperCase();
      const isListening = state === 'LISTENING' ||
        (state !== 'BOUND' && (foreignAddress === '0.0.0.0:0' || foreignAddress === '[::]:0' || foreignAddress === '*:*'));
      if (!isListening) { continue; }

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
      .filter(line =>
        line.includes(PROCESS_IDENTIFIERS.LANGUAGE_SERVER) ||
        line.includes(PROCESS_IDENTIFIERS.HUB_PORT) ||
        line.includes(PROCESS_IDENTIFIERS.HUB_PORT_UNDERSCORE) ||
        line.includes(PROCESS_IDENTIFIERS.CSRF_TOKEN)
      )
      .map(line => {
        const trimmed = line.trim();
        const match = trimmed.match(/^(\d+)\s+(.+)$/);
        if (!match) { return null; }
        const pid = parseInt(match[1], 10);
        const cmdText = match[2].trim();
        return cmdText && validatePid(pid) && pid !== process.pid ? { pid, cmd: cmdText } : null;
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
    const directPorts = await this.getDirectPorts(pid);
    if (directPorts.length > 0) {
      return directPorts;
    }

    const childPids = await this.getChildPids(pid);
    const childPorts: number[] = [];
    for (const childPid of childPids) {
      const ports = await this.getDirectPorts(childPid);
      childPorts.push(...ports);
    }
    return childPorts;
  }

  private async getDirectPorts(pid: ProcessId): Promise<number[]> {
    const platform = os.platform();

    if (platform === 'darwin') {
      return this.getDarwinPorts(pid);
    }

    if (platform === 'linux') {
      const procPorts = await this.getLinuxProcPorts(pid);
      if (procPorts.length > 0) {
        return procPorts;
      }
    }

    const queries = [
      { type: 'ss', cmd: 'ss', args: ['-tlnp'] },
      { type: 'lsof', cmd: 'lsof', args: ['-a', '-iTCP', '-sTCP:LISTEN', '-n', '-P', '-p', String(pid)] },
      { type: 'netstat', cmd: 'netstat', args: ['-tlnp'] }
    ] as const;

    const errors: string[] = [];
    let anySucceeded = false;

    for (const { type, cmd, args } of queries) {
      try {
        const stdout = await executeCommand(cmd, [...args]);
        anySucceeded = true;
        const ports = type === 'ss'
          ? this.parseUnixSsOutput(stdout, pid)
          : type === 'lsof'
            ? this.parseUnixLsofOutput(stdout)
            : this.parseUnixNetstatOutput(stdout, pid);
        if (ports.length > 0) {
          return ports;
        }
      } catch (error) {
        if (type === 'lsof' && getErrorMessage(error).includes('exited with code 1')) {
          anySucceeded = true;
          continue;
        }
        errors.push(`${cmd}: ${getErrorMessage(error)}`);
      }
    }

    if (anySucceeded) {
      return [];
    }

    throw new Error(`Failed to query Unix ports. None of 'ss', 'lsof', or 'netstat' succeeded: ${errors.join('; ')}`);
  }

  private async getDarwinPorts(pid: ProcessId): Promise<number[]> {
    const lsofArgs = ['-a', '-iTCP', '-sTCP:LISTEN', '-n', '-P', '-p', String(pid)];
    const errors: string[] = [];
    let anySucceeded = false;

    for (const cmd of ['lsof', '/usr/sbin/lsof']) {
      try {
        const stdout = await executeCommand(cmd, lsofArgs);
        anySucceeded = true;
        const ports = this.parseUnixLsofOutput(stdout);
        if (ports.length > 0) {
          return ports;
        }
        break;
      } catch (error) {
        const message = getErrorMessage(error);
        if (message.includes('exited with code 1')) {
          anySucceeded = true;
          break;
        }
        errors.push(`${cmd}: ${message}`);
      }
    }

    for (const cmd of ['netstat', '/usr/sbin/netstat']) {
      try {
        const stdout = await executeCommand(cmd, ['-anv', '-p', 'tcp']);
        anySucceeded = true;
        const ports = this.parseDarwinNetstatOutput(stdout, pid);
        if (ports.length > 0) {
          return ports;
        }
        break;
      } catch (error) {
        errors.push(`${cmd}: ${getErrorMessage(error)}`);
      }
    }

    if (anySucceeded) {
      return [];
    }

    throw new Error(`Failed to query Unix ports. Neither 'lsof' nor 'netstat' succeeded: ${errors.join('; ')}`);
  }

  private async getLinuxProcPorts(pid: ProcessId): Promise<number[]> {
    try {
      const fdDir = `/proc/${pid}/fd`;
      const fds = await fs.promises.readdir(fdDir);
      const socketInodes = new Set<string>();

      await Promise.all(fds.map(async (fd) => {
        try {
          const target = await fs.promises.readlink(`${fdDir}/${fd}`);
          const match = target.match(/^(?:socket:\[(\d+)\]|\[0000\]:(\d+))$/);
          const inode = match?.[1] ?? match?.[2];
          if (inode) {
            socketInodes.add(inode);
          }
        } catch {
          return;
        }
      }));

      if (socketInodes.size === 0) {
        return [];
      }

      const ports: number[] = [];
      for (const tablePath of [`/proc/${pid}/net/tcp`, `/proc/${pid}/net/tcp6`]) {
        try {
          const content = await fs.promises.readFile(tablePath, 'utf8');
          for (const line of content.split('\n').slice(1)) {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 10) { continue; }
            if (parts[3].toUpperCase() !== '0A' || !socketInodes.has(parts[9])) { continue; }
            const localAddress = parts[1];
            const colonIndex = localAddress.lastIndexOf(':');
            if (colonIndex === -1) { continue; }
            const port = parseInt(localAddress.substring(colonIndex + 1), 16);
            if (validatePort(port)) {
              ports.push(port);
            }
          }
        } catch {
          continue;
        }
      }

      return ports;
    } catch {
      return [];
    }
  }

  private async getChildPids(pid: ProcessId): Promise<ProcessId[]> {
    try {
      const stdout = await executeCommand('ps', ['-eo', 'pid,ppid']);
      const childPids: ProcessId[] = [];
      for (const line of stdout.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(\d+)$/);
        if (!match) { continue; }
        const childPid = parseInt(match[1], 10);
        const parentPid = parseInt(match[2], 10);
        if (parentPid === pid && validatePid(childPid) && childPid !== pid && childPid !== process.pid) {
          childPids.push(childPid);
        }
      }
      return childPids;
    } catch {
      return [];
    }
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

  private parseDarwinNetstatOutput(stdout: string, pid: number): number[] {
    const ports: number[] = [];
    const pidStr = String(pid);
    for (const line of stdout.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 9) { continue; }
      if (!parts[0].toLowerCase().startsWith('tcp')) { continue; }
      if (parts[5] !== 'LISTEN') { continue; }
      const matchesOwner = parts[8] === pidStr || parts.slice(8).some(field => field.endsWith(`:${pidStr}`));
      if (!matchesOwner) { continue; }
      const localAddress = parts[3];
      const portMatch = localAddress.match(/[.:](\d+)$/);
      if (portMatch) {
        const port = parseInt(portMatch[1], 10);
        if (validatePort(port)) {
          ports.push(port);
        }
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
