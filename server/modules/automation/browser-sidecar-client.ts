import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isBrowserSessionState } from '../../../shared/browserSessionState.js';

import {
  BROWSER_PROTOCOL_VERSION,
  BrowserNdjsonDecoder,
  serializeBrowserFrame,
  type BrowserCommand,
  type BrowserEventFrame,
  type BrowserInput,
  type BrowserRequestFrame,
  type BrowserRequestMethod,
  type BrowserResponseFrame,
  type BrowserSessionState,
} from './browser-protocol.js';

type Pending = {
  method: BrowserRequestMethod;
  sessionId?: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type BrowserEventListener = (event: BrowserEventFrame) => void;

type BrowserSidecarClientOptions = {
  runtimePath?: string;
  sidecarPath?: string;
  recoveryAttempts?: number;
  recoveryDelayMs?: number;
};

type RecoverableSession = {
  state: BrowserSessionState;
  subscribed: boolean;
};

const LOG_PATH = join(homedir(), '.gajae-app', 'logs', 'browser-sidecar.log');
const LOG_MAX_BYTES = 4 * 1024 * 1024;

function logDiagnostic(message: string): void {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    if ((statSync(LOG_PATH, { throwIfNoEntry: false })?.size ?? 0) > LOG_MAX_BYTES) writeFileSync(LOG_PATH, '');
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message.trim()}\n`);
  } catch {
    // Diagnostics never participate in the automation control path.
  }
}

export class BrowserSidecarClient {
  private child?: ChildProcessWithoutNullStreams;
  private decoder = new BrowserNdjsonDecoder();
  private starting?: Promise<void>;
  private recovering?: Promise<void>;
  private shuttingDown = false;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<BrowserEventListener>();
  private readonly sessions = new Map<string, RecoverableSession>();
  private ownedBrowserPid?: number;

  constructor(private readonly options: BrowserSidecarClientOptions = {}) {}

  /** Pid of the Chromium process the sidecar currently owns, when known. */
  get browserPid(): number | undefined {
    return this.ownedBrowserPid;
  }

  subscribe(listener: BrowserEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  status(): Promise<unknown> {
    return this.request('status', undefined, {});
  }

  open(sessionId: string, payload: { url?: string; allowDownload?: boolean; waitUntil?: string }, signal?: AbortSignal): Promise<unknown> {
    return this.request('session.open', sessionId, payload, 45_000, signal);
  }

  state(sessionId: string, signal?: AbortSignal): Promise<unknown> {
    return this.request('session.state', sessionId, {}, 10_000, signal);
  }

  /** Reads the recovery snapshot without starting a sidecar or creating a session. */
  cachedState(sessionId: string): BrowserSessionState {
    const state = this.sessions.get(sessionId)?.state;
    return state
      ? { sessionId: state.sessionId, activeTabId: state.activeTabId, tabs: state.tabs.map((tab) => ({ ...tab })) }
      : { sessionId, activeTabId: null, tabs: [] };
  }

  close(sessionId: string, signal?: AbortSignal): Promise<unknown> {
    return this.request('session.close', sessionId, {}, 10_000, signal);
  }

  command(sessionId: string, command: BrowserCommand, signal?: AbortSignal): Promise<unknown> {
    return this.request('browser.command', sessionId, { command }, command.action === 'run' ? 305_000 : 45_000, signal);
  }

  input(sessionId: string, input: BrowserInput): Promise<unknown> {
    return this.request('browser.input', sessionId, { input }, 10_000);
  }

  subscribeFrames(sessionId: string): Promise<unknown> {
    return this.request('screencast.subscribe', sessionId, {});
  }

  unsubscribeFrames(sessionId: string): Promise<unknown> {
    return this.request('screencast.unsubscribe', sessionId, {});
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const child = this.child;
    if (!child) {
      this.sessions.clear();
      return;
    }
    try {
      await this.request('shutdown', undefined, {}, 2_000);
    } catch {
      this.killOwnedProcess(child);
    }
    this.child = undefined;
    this.sessions.clear();
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && this.child.exitCode === null) return;
    if (this.starting) return this.starting;
    if (this.shuttingDown) throw new Error('Browser automation is shutting down.');
    this.starting = (async () => {
      const compiled = !import.meta.url.endsWith('.ts');
      const sidecarPath = this.options.sidecarPath
        ?? fileURLToPath(new URL(compiled ? './browser-sidecar.js' : './browser-sidecar.ts', import.meta.url));
      const bundledBun = fileURLToPath(new URL(compiled ? '../../../../dist-native/bun' : '../../../dist-native/bun', import.meta.url));
      const bunPath = this.options.runtimePath
        ?? process.env.GAJAE_BROWSER_BUN_PATH
        ?? (existsSync(bundledBun) ? bundledBun : undefined)
        ?? (!compiled && process.env.GAJAE_ALLOW_DEVELOPMENT_BUN === '1' ? 'bun' : undefined);
      if (!bunPath) throw new Error('Bundled Bun runtime is unavailable.');
      const allowedEnv = [
        'HOME', 'PATH', 'TMPDIR', 'TMP', 'TEMP', 'USER', 'LOGNAME', 'LANG', 'LC_ALL',
        'XDG_CACHE_HOME', 'GAJAE_BROWSER_CACHE_DIR', 'GAJAE_BROWSER_PROFILE_DIR', 'GAJAE_BROWSER_EXECUTABLE_PATH',
      ];
      const env = Object.fromEntries(allowedEnv.flatMap((name) => process.env[name] ? [[name, process.env[name]]] : []));
      const child = spawn(bunPath, [sidecarPath], {
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });
      this.child = child;
      this.decoder = new BrowserNdjsonDecoder();
      child.stdout.on('data', (chunk: Buffer) => this.handleData(child, chunk));
      child.stderr.on('data', (chunk: Buffer) => logDiagnostic(chunk.toString()));
      child.stdin.on('error', (error) => this.fail(child, error));
      child.on('error', (error) => this.fail(child, error));
      child.on('close', () => this.fail(child, new Error('Browser sidecar exited.')));
      await this.requestStarted('initialize', undefined, {}, 10_000);
    })().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async request(
    method: BrowserRequestMethod,
    sessionId: string | undefined,
    payload: Record<string, unknown>,
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<unknown> {
    await this.ensureStarted();
    if (this.recovering && method !== 'status' && method !== 'shutdown') await this.recovering;
    return this.requestStarted(method, sessionId, payload, timeoutMs, signal);
  }

  private requestStarted(
    method: BrowserRequestMethod,
    sessionId: string | undefined,
    payload: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const child = this.child;
    if (!child || child.exitCode !== null) return Promise.reject(new Error('Browser sidecar is unavailable.'));
    const id = `browser-${randomUUID()}`;
    const frame: BrowserRequestFrame = {
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      kind: 'request',
      id,
      method,
      ...(sessionId ? { sessionId } : {}),
      payload,
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Browser sidecar request timed out.'));
      }, timeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('Browser request was cancelled.'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        method,
        ...(sessionId ? { sessionId } : {}),
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
        timer,
      });
      child.stdin.write(serializeBrowserFrame(frame));
    });
  }

  private handleData(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    if (child !== this.child) return;
    try {
      for (const frame of this.decoder.push(chunk)) {
        if (frame.kind === 'response') this.settle(frame);
        else if (frame.kind === 'event') {
          if (frame.method === 'async' && frame.payload.type === 'browser.process') {
            this.ownedBrowserPid = typeof frame.payload.pid === 'number'
              && Number.isSafeInteger(frame.payload.pid)
              && frame.payload.pid > 0
              ? frame.payload.pid
              : undefined;
          } else {
            this.emit(frame);
          }
        }
      }
    } catch (error) {
      this.fail(child, error instanceof Error ? error : new Error('Invalid browser sidecar output.'));
    }
  }

  private settle(frame: BrowserResponseFrame): void {
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    const responseSessionId = 'sessionId' in frame ? frame.sessionId : undefined;
    if (pending.method !== frame.method || pending.sessionId !== responseSessionId) {
      pending.reject(new Error('Browser sidecar returned a mismatched response.'));
      return;
    }
    if (!frame.ok) pending.reject(new Error(`${frame.error?.code ?? 'browser_error'}: ${frame.error?.message ?? 'Browser operation failed.'}`));
    else {
      this.remember(frame.method, responseSessionId, frame.result);
      pending.resolve(frame.result);
    }
  }

  private fail(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (child !== this.child) return;
    this.child = undefined;
    logDiagnostic(error.message);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Browser sidecar disconnected.'));
    }
    this.pending.clear();
    this.killOwnedProcess(child, this.ownedBrowserPid);
    this.ownedBrowserPid = undefined;
    if (this.shuttingDown || this.sessions.size === 0) return;

    const snapshots = [...this.sessions.entries()].map(([sessionId, session]) => ({
      sessionId,
      subscribed: session.subscribed,
      state: {
        sessionId,
        activeTabId: session.state.activeTabId,
        tabs: session.state.tabs.map((tab) => ({ ...tab })),
      },
    }));
    for (const snapshot of snapshots) {
      this.emit({
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        kind: 'event',
        method: 'error',
        sessionId: snapshot.sessionId,
        payload: { code: 'sidecar_disconnected', message: error.message, recovering: true },
      });
      this.emit({
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        kind: 'event',
        method: 'state',
        sessionId: snapshot.sessionId,
        payload: { sessionId: snapshot.sessionId, activeTabId: null, tabs: [] },
      });
    }
    this.startRecovery(snapshots);
  }

  private remember(method: BrowserRequestMethod, sessionId: string | undefined, value: unknown): void {
    if (!sessionId) return;
    if (method === 'session.close') {
      this.sessions.delete(sessionId);
      return;
    }
    const existing = this.sessions.get(sessionId) ?? {
      state: { sessionId, activeTabId: null, tabs: [] },
      subscribed: false,
    };
    if (method === 'screencast.subscribe') existing.subscribed = true;
    if (method === 'screencast.unsubscribe') existing.subscribed = false;
    const state = this.browserState(value, sessionId);
    if (state) existing.state = state;
    this.sessions.set(sessionId, existing);
  }

  private browserState(value: unknown, sessionId: string): BrowserSessionState | null {
    if (!isBrowserSessionState(value, sessionId)) return null;
    return { sessionId, activeTabId: value.activeTabId, tabs: value.tabs.map((tab) => ({ ...tab })) };
  }

  private emit(event: BrowserEventFrame): void {
    if (event.method === 'state' && event.sessionId) this.remember('session.state', event.sessionId, event.payload);
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* One consumer cannot break recovery fan-out. */ }
    }
  }

  private startRecovery(
    snapshots: Array<{ sessionId: string; state: BrowserSessionState; subscribed: boolean }>,
  ): void {
    if (this.recovering || this.shuttingDown) return;
    this.recovering = this.recoverSessions(snapshots).finally(() => {
      this.recovering = undefined;
    });
  }

  private async recoverSessions(
    snapshots: Array<{ sessionId: string; state: BrowserSessionState; subscribed: boolean }>,
  ): Promise<void> {
    const attempts = Math.max(1, this.options.recoveryAttempts ?? 3);
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts && !this.shuttingDown; attempt += 1) {
      try {
        await this.ensureStarted();
        for (const snapshot of snapshots) await this.restoreSession(snapshot);
        return;
      } catch (error) {
        lastError = error;
        if (attempt + 1 < attempts) {
          await new Promise((resolve) => setTimeout(resolve, (this.options.recoveryDelayMs ?? 150) * (attempt + 1)));
        }
      }
    }
    const message = lastError instanceof Error ? lastError.message : 'Browser sidecar recovery failed.';
    for (const snapshot of snapshots) {
      this.emit({
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        kind: 'event',
        method: 'error',
        sessionId: snapshot.sessionId,
        payload: { code: 'sidecar_recovery_failed', message, recovering: false },
      });
    }
  }

  private async restoreSession(snapshot: { sessionId: string; state: BrowserSessionState; subscribed: boolean }): Promise<void> {
    const urls = snapshot.state.tabs.map((tab) => tab.url);
    if (urls.length === 0) return;
    const activeIndex = Math.max(0, snapshot.state.tabs.findIndex((tab) => tab.id === snapshot.state.activeTabId));
    let state = await this.requestStarted('session.open', snapshot.sessionId, {
      ...(urls[0] && urls[0] !== 'about:blank' ? { url: urls[0] } : {}),
      allowDownload: false,
    }, 45_000) as BrowserSessionState;
    const restoredTabIds = [state.activeTabId];
    for (const url of urls.slice(1)) {
      state = await this.requestStarted('browser.command', snapshot.sessionId, {
        command: { action: 'newTab', ...(url && url !== 'about:blank' ? { url } : {}) },
      }, 45_000) as BrowserSessionState;
      restoredTabIds.push(state.activeTabId);
    }
    const activeTabId = restoredTabIds[activeIndex];
    if (activeTabId && state.activeTabId !== activeTabId) {
      state = await this.requestStarted('browser.command', snapshot.sessionId, {
        command: { action: 'selectTab', tabId: activeTabId },
      }, 45_000) as BrowserSessionState;
    }
    if (snapshot.subscribed) {
      state = await this.requestStarted('screencast.subscribe', snapshot.sessionId, {}, 30_000) as BrowserSessionState;
    }
    this.emit({
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      kind: 'event',
      method: 'state',
      sessionId: snapshot.sessionId,
      payload: state as unknown as Record<string, unknown>,
    });
    this.emit({
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      kind: 'event',
      method: 'async',
      sessionId: snapshot.sessionId,
      payload: { type: 'sidecar.recovered', tabs: state.tabs.length },
    });
  }

  private killOwnedProcess(child: ChildProcessWithoutNullStreams, browserPid = this.ownedBrowserPid): void {
    if (process.platform !== 'win32' && browserPid) {
      try { process.kill(-browserPid, 'SIGKILL'); } catch { /* The browser may already be gone. */ }
    }
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}
