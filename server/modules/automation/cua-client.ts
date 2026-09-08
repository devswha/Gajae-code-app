import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';

import type { DesktopWorkAdmission } from '@/shared/interfaces.js';

import type { DesktopOwnerActivity } from '../../../shared/desktopUpdateProtocol.js';

export const CUA_SAFE_TOOLS = [
  'start_session',
  'end_session',
  'list_apps',
  'list_windows',
  'get_window_state',
  'get_accessibility_tree',
  'launch_app',
  'set_window_frame',
  'move_cursor',
  'click',
  'type_text',
  'press_key',
  'hotkey',
  'scroll',
  'invoke_menu',
] as const;

export type CuaSafeTool = (typeof CUA_SAFE_TOOLS)[number];

export type CuaStatus = {
  installed: boolean;
  version?: string;
  daemon: 'running' | 'stopped' | 'unknown';
  accessibility?: boolean;
  screenRecording?: boolean;
  error?: string;
};

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id?: string | number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type Pending = {
  child: ChildProcessWithoutNullStreams;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  tool?: string;
  session?: string;
  uncertain?: boolean;
  retained?: boolean;
};

type CuaDriverClientOptions = {
  desktopRestartAdmission?: DesktopWorkAdmission;
  onSessionClosed?: (label: string) => void;
};

function executableCandidates(): string[] {
  return [
    process.env.CUA_DRIVER_PATH,
    join(homedir(), '.local', 'bin', 'cua-driver'),
    '/opt/homebrew/bin/cua-driver',
    '/usr/local/bin/cua-driver',
  ].filter((value): value is string => Boolean(value));
}

async function findExecutable(): Promise<string | null> {
  for (const candidate of executableCandidates()) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through the small, explicit set of supported install paths.
    }
  }
  return null;
}

async function runInspection(
  executable: string, args: string[], changed: () => void, uncertainty: (delta: number) => void,
  timeoutMs = 3_000,
): Promise<{ ok: boolean; output: string }> {
  return new Promise<{ ok: boolean; output: string }>((resolve) => {
    changed();
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let output = '';
    let settled = false;
    let uncertain = false;
    const markUncertain = () => {
      if (uncertain || settled) return;
      uncertain = true;
      uncertainty(1);
    };
    const finish = (result: { ok: boolean; output: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (uncertain) uncertainty(-1);
      changed();
      resolve(result);
    };
    const timer = setTimeout(() => {
      markUncertain();
      changed();
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('error', markUncertain);
    child.on('close', (code) => {
      finish({ ok: code === 0, output: output.trim() });
    });
  }).catch(() => ({ ok: false, output: 'Unable to start CUA Driver inspection.' }));
}

function permissionValue(output: string, names: string[]): boolean | undefined {
  const line = output.split(/\r?\n/u).find((entry) => names.some((name) => entry.toLowerCase().includes(name)));
  if (!line) return undefined;
  if (/granted|authorized|enabled|yes|true|✅/iu.test(line)) return true;
  if (/denied|not granted|disabled|no|false|❌/iu.test(line)) return false;
  return undefined;
}

export class CuaDriverClient {
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private sequence = 0;
  private readonly pending = new Map<string | number, Pending>();
  private admission?: DesktopWorkAdmission;
  private readonly activityEpoch = randomUUID();
  private activityRevision = 0;
  private dispatching = 0;
  private inspecting = 0;
  private uncertainInspections = 0;
  private closing = 0;
  private shuttingDown = false;
  private transportUncertain = false;

  constructor(private readonly options: CuaDriverClientOptions = {}) {
    this.admission = options.desktopRestartAdmission;
  }

  configureDesktopRestartAdmission(admission?: DesktopWorkAdmission): void {
    this.admission = admission;
    this.activityRevision++;
  }

  getGeneration(): string { return `${this.activityEpoch}:${this.activityRevision}`; }

  snapshotActivity(): DesktopOwnerActivity {
    const requests = [...this.pending.values()];
    const unknown: string[] = [];
    if (requests.some((request) => request.uncertain)) unknown.push('cua_request_unconfirmed');
    if (this.transportUncertain) unknown.push('cua_transport_unconfirmed');
    if (this.uncertainInspections) unknown.push('cua_inspection_unconfirmed');
    return {
      owner: 'computer', generation: this.getGeneration(), complete: unknown.length === 0,
      starting: Number(Boolean(this.starting)), queued: this.dispatching,
      running: requests.filter((request) => !request.retained).length + this.inspecting,
      settling: this.closing, approvals: 0,
      retained: requests.filter((request) => request.retained).length, unknown,
    };
  }

  async status(): Promise<CuaStatus> {
    const release = this.admission?.enter('automation.computer.status');
    this.inspecting++;
    this.activityRevision++;
    try {
      const executable = await findExecutable();
      if (!executable) return { installed: false, daemon: 'unknown' };
      const inspect = (args: string[]) => runInspection(executable, args,
        () => { this.activityRevision++; },
        (delta) => { this.uncertainInspections += delta; this.activityRevision++; });
      const [version, daemon, permissions] = await Promise.all([
        inspect(['--version']),
        inspect(['status']),
        process.platform === 'darwin'
          ? inspect(['permissions', 'status'])
          : Promise.resolve({ ok: true, output: '' }),
      ]);
      return {
        installed: true,
        version: version.output.split(/\r?\n/u)[0]?.slice(0, 120),
        daemon: daemon.ok ? 'running' : /not running|stopped|unavailable/iu.test(daemon.output) ? 'stopped' : 'unknown',
        accessibility: permissionValue(permissions.output, ['accessibility']),
        screenRecording: permissionValue(permissions.output, ['screen recording', 'screen capture']),
        ...(!version.ok ? { error: version.output || 'Unable to inspect CUA Driver.' } : {}),
      };
    } finally {
      this.inspecting--;
      this.activityRevision++;
      release?.();
    }
  }

  async call(tool: CuaSafeTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (!CUA_SAFE_TOOLS.includes(tool)) throw new Error('CUA Driver tool is not allowed.');
    const release = this.admission?.enter(`automation.computer.${tool}`);
    this.dispatching++;
    this.activityRevision++;
    try {
      if (signal?.aborted) throw new Error('CUA Driver request was cancelled.');
      await this.ensureStarted();
      return await this.request('tools/call', { name: tool, arguments: args }, 60_000, signal);
    } finally {
      this.dispatching--;
      this.activityRevision++;
      release?.();
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.activityRevision++;
    if (this.starting) await this.starting.catch(() => {});
    const child = this.child;
    if (!child) return;
    this.closing++;
    this.activityRevision++;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        this.transportUncertain = true;
        this.activityRevision++;
        resolve();
      }, 2_000);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.closing--;
    this.activityRevision++;
  }

  private async ensureStarted(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.shuttingDown) throw new Error('CUA Driver is shutting down.');
    if (this.transportUncertain) throw new Error('CUA Driver closure is unconfirmed.');
    if (this.child && this.child.exitCode === null) return;
    this.activityRevision++;
    this.starting = (async () => {
      const executable = await findExecutable();
      if (!executable) throw new Error('CUA Driver is not installed.');
      if (this.shuttingDown) throw new Error('CUA Driver is shutting down.');
      const child = spawn(executable, ['mcp'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
      this.child = child;
      this.activityRevision++;
      const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on('line', (line) => { if (child === this.child) this.handleLine(line); });
      child.stderr.on('data', () => {});
      child.stdin.on('error', (error) => this.failAll(child, error));
      child.on('close', () => this.failAll(child, new Error('CUA Driver disconnected.'), true));
      child.on('error', (error) => this.failAll(child, error));
      await this.request('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'gajae-code-app', version: '0.1.0' },
      }, 10_000);
      this.notify('notifications/initialized', {});
    })().finally(() => {
      this.starting = undefined;
      this.activityRevision++;
    });
    return this.starting;
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const child = this.child;
    if (!child || child.exitCode !== null) return Promise.reject(new Error('CUA Driver is unavailable.'));
    if (signal?.aborted) return Promise.reject(new Error('CUA Driver request was cancelled.'));
    const id = `${++this.sequence}-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        abandon(new Error('CUA Driver request timed out.'));
      }, timeoutMs);
      const abandon = (error: Error) => {
        const pending = this.pending.get(id);
        if (!pending || pending.uncertain) return;
        clearTimeout(timer);
        pending.uncertain = true;
        this.activityRevision++;
        pending.reject(error);
      };
      const onAbort = () => {
        abandon(new Error('CUA Driver request was cancelled.'));
        this.notify('notifications/cancelled', { requestId: id, reason: 'Client request cancelled.' });
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        child,
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
        timer,
        ...(method === 'tools/call' ? {
          tool: String(params.name),
          session: typeof (params.arguments as Record<string, unknown>)?.session === 'string'
            ? String((params.arguments as Record<string, unknown>).session) : 'default',
        } : {}),
      });
      this.activityRevision++;
      try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); }
      catch (error) { abandon(error instanceof Error ? error : new Error('CUA Driver write failed.')); }
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.activityRevision++;
    const child = this.child;
    if (!child) return;
    try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); }
    catch (error) { this.failAll(child, error instanceof Error ? error : new Error('CUA Driver write failed.')); }
  }

  private handleLine(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending || pending.retained) return;
    if (message.jsonrpc !== '2.0' || (!Object.hasOwn(message, 'result') && !message.error)
      || (pending.tool && !message.error && (!message.result || typeof message.result !== 'object' || Array.isArray(message.result)))) {
      clearTimeout(pending.timer);
      pending.uncertain = true;
      this.activityRevision++;
      pending.reject(new Error('CUA Driver returned an invalid response.'));
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    this.activityRevision++;
    const succeeded = !message.error && Boolean(message.result && typeof message.result === 'object'
      && (message.result as { isError?: unknown }).isError !== true
      && (message.result as { ok?: unknown }).ok !== false
      && (message.result as { ended?: unknown }).ended !== false);
    if (pending.tool === 'start_session' && succeeded) {
      // Keep the original request as the named transport-session owner until
      // end_session acknowledgment; no independent reservation registry.
      for (const [id, entry] of this.pending) {
        if (entry.retained && entry.child === pending.child && entry.session === pending.session) this.pending.delete(id);
      }
      pending.retained = true;
      pending.uncertain = false;
      this.pending.set(message.id, pending);
    }
    if (pending.tool === 'end_session' && succeeded) {
      for (const [id, entry] of this.pending) {
        if (entry.retained && entry.child === pending.child && entry.session === pending.session) this.pending.delete(id);
      }
      if (pending.session) this.options.onSessionClosed?.(pending.session);
    }
    if (message.error) pending.reject(new Error(message.error.message || 'CUA Driver request failed.'));
    else pending.resolve(message.result);
  }

  private failAll(child: ChildProcessWithoutNullStreams, error: Error, closed = false): void {
    if (child !== this.child) return;
    this.transportUncertain = !closed;
    this.activityRevision++;
    if (closed) this.child = undefined;
    for (const [id, pending] of this.pending) {
      if (pending.child !== child) continue;
      clearTimeout(pending.timer);
      // MCP transport exit does not prove completion in the external daemon.
      // Initialization is local to the dead transport; tools/sessions are not.
      if (closed && !pending.tool) this.pending.delete(id);
      else pending.uncertain = true;
      pending.reject(error);
    }
  }
}

export function isCuaSafeTool(value: unknown): value is CuaSafeTool {
  return typeof value === 'string' && (CUA_SAFE_TOOLS as readonly string[]).includes(value);
}
