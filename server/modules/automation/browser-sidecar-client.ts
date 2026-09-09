import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DesktopWorkAdmission } from '@/shared/interfaces.js';

import { isBrowserSessionState } from '../../../shared/browserSessionState.js';
import type { DesktopOwnerActivity } from '../../../shared/desktopUpdateProtocol.js';

import {
  BROWSER_PROTOCOL_VERSION,
  BrowserNdjsonDecoder,
  serializeBrowserFrame,
  isBrowserChildActivity,
  type BrowserChildActivity,
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
  uncertain?: boolean;
};

export type BrowserEventListener = (event: BrowserEventFrame) => void;

type BrowserSidecarClientOptions = {
  runtimePath?: string;
  sidecarPath?: string;
  recoveryAttempts?: number;
  recoveryDelayMs?: number;
  desktopRestartAdmission?: DesktopWorkAdmission;
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
  private recoveryDeferred = false;
  private shuttingDown = false;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<BrowserEventListener>();
  private readonly sessions = new Map<string, RecoverableSession>();
  private ownedBrowserPid?: number;
  private admission?: DesktopWorkAdmission;
  private readonly activityEpoch = randomUUID();
  private activityRevision = 0;
  private dispatching = 0;
  private closing = 0;
  private transportUncertain = false;
  private browserClosureUncertain = false;
  private browserWorkDispatched = false;
  private childRequestSequence = 0;
  private childActivityEpoch?: string;
  private childActivity?: BrowserChildActivity;
  private childActivityInvalid = false;

  constructor(private readonly options: BrowserSidecarClientOptions = {}) {
    this.admission = options.desktopRestartAdmission;
  }

  configureDesktopRestartAdmission(admission?: DesktopWorkAdmission): void {
    this.admission = admission;
    this.activityRevision++;
  }

  getGeneration(): string { return `${this.activityEpoch}:${this.activityRevision}`; }

  /** Pure observation of the existing request/recovery/session owners. */
  snapshotActivity(): DesktopOwnerActivity {
    const unknown: string[] = [];
    if ([...this.pending.values()].some((request) => request.uncertain)) unknown.push('browser_request_unconfirmed');
    if (this.transportUncertain) unknown.push('browser_transport_unconfirmed');
    if (this.browserClosureUncertain) unknown.push('browser_closure_unconfirmed');
    const child = this.childActivity;
    const current = child && child.epoch === this.childActivityEpoch && child.requestSequence === this.childRequestSequence;
    if (this.childActivityInvalid || (this.childActivityEpoch && !current)) unknown.push('browser_child_activity_unconfirmed');
    if (this.browserWorkDispatched && this.sessions.size === 0 && !current) unknown.push('browser_child_quiescence_unconfirmed');
    if (current) unknown.push(...child.unknown);
    return {
      owner: 'browser', generation: this.getGeneration(), complete: unknown.length === 0,
      starting: Number(Boolean(this.starting)) + (current ? child.starting : 0),
      queued: this.dispatching + Number(this.recoveryDeferred) + (current ? child.queued : 0),
      running: this.pending.size + (current ? child.running + child.callbacks : 0),
      settling: this.closing + Number(Boolean(this.recovering)) + Number(this.shuttingDown && Boolean(this.child))
        + (current ? child.settling : 0),
      approvals: 0, retained: this.sessions.size + (current ? child.retained + Number(child.browserAlive) : 0), unknown,
    };
  }

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
    this.activityRevision++;
    const child = this.child;
    if (!child) return;
    this.closing++;
    this.activityRevision++;
    try {
      // Shutdown is lifecycle-owned, not an idle query or a new producer.
      await this.requestStarted('shutdown', undefined, {}, 2_000);
    } catch {
      this.killOwnedProcess(child);
    } finally {
      // A response/kill request is not process-exit evidence. fail(..., true)
      // owns transport closure and clears requests only on the close event.
      this.closing--;
      this.activityRevision++;
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.shuttingDown) throw new Error('Browser automation is shutting down.');
    if (this.transportUncertain) throw new Error('Browser sidecar closure is unconfirmed.');
    if (this.child && this.child.exitCode === null) return;
    this.activityRevision++;
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
      this.childRequestSequence = 0;
      this.childActivityEpoch = undefined;
      this.childActivity = undefined;
      this.childActivityInvalid = false;
      this.activityRevision++;
      this.decoder = new BrowserNdjsonDecoder();
      child.stdout.on('data', (chunk: Buffer) => this.handleData(child, chunk));
      child.stderr.on('data', (chunk: Buffer) => logDiagnostic(chunk.toString()));
      child.stdin.on('error', (error) => this.fail(child, error));
      child.on('error', (error) => this.fail(child, error));
      child.on('close', () => this.fail(child, new Error('Browser sidecar exited.'), true));
      await this.requestStarted('initialize', undefined, {}, 10_000);
    })().finally(() => {
      this.starting = undefined;
      this.activityRevision++;
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
    // Includes lazy status/state, preview subscription, open/command/input and
    // cleanup requests: none of these is a cached read.
    const release = this.admission?.enter(`automation.browser.${method}`);
    this.dispatching++;
    this.activityRevision++;
    try {
      if (signal?.aborted) throw new Error('Browser request was cancelled.');
      if (this.recoveryDeferred) this.startRecovery(this.recoverySnapshots());
      await this.ensureStarted();
      if (this.recovering && method !== 'status' && method !== 'shutdown') await this.recovering;
      return await this.requestStarted(method, sessionId, payload, timeoutMs, signal);
    } finally {
      this.dispatching--;
      this.activityRevision++;
      release?.();
    }
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
    if (signal?.aborted) return Promise.reject(new Error('Browser request was cancelled.'));
    const id = `browser-${randomUUID()}`;
    const frame: BrowserRequestFrame = {
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      kind: 'request',
      id,
      method,
      sequence: ++this.childRequestSequence,
      ...(sessionId ? { sessionId } : {}),
      payload,
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        abandon(new Error('Browser sidecar request timed out.'));
      }, timeoutMs);
      const abandon = (error: Error) => {
        const pending = this.pending.get(id);
        if (!pending || pending.uncertain) return;
        clearTimeout(timer);
        pending.uncertain = true;
        this.activityRevision++;
        pending.reject(error);
      };
      const onAbort = () => abandon(new Error('Browser request was cancelled.'));
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
      if (method === 'session.open') this.browserWorkDispatched = true;
      this.activityRevision++;
      try { child.stdin.write(serializeBrowserFrame(frame)); }
      catch (error) { abandon(error instanceof Error ? error : new Error('Browser request write failed.')); }
    });
  }

  private handleData(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    if (child !== this.child) return;
    try {
      for (const frame of this.decoder.push(chunk)) {
        if (frame.kind === 'response') this.settle(frame);
        else if (frame.kind === 'event') {
          if (frame.method === 'async' && frame.payload.type === 'browser.runtime.activity') {
            const activity = frame.payload.activity;
            if (!isBrowserChildActivity(activity)
              || (this.childActivityEpoch && activity.epoch !== this.childActivityEpoch)
              || (this.childActivity && (activity.epoch !== this.childActivity.epoch || activity.revision <= this.childActivity.revision))) {
              this.childActivityInvalid = true;
            } else {
              this.childActivity = { ...activity, unknown: [...activity.unknown] };
              this.childActivityInvalid = false;
            }
            this.activityRevision++;
          } else if (frame.method === 'async' && frame.payload.type === 'browser.process') {
            this.activityRevision++;
            if (frame.payload.pid === null && this.ownedBrowserPid && !this.childActivityEpoch) this.browserClosureUncertain = true;
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
    const responseSessionId = 'sessionId' in frame ? frame.sessionId : undefined;
    if (pending.method !== frame.method || pending.sessionId !== responseSessionId) {
      clearTimeout(pending.timer);
      pending.uncertain = true;
      this.activityRevision++;
      pending.reject(new Error('Browser sidecar returned a mismatched response.'));
      return;
    }
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    this.activityRevision++;
    if (!frame.ok) pending.reject(new Error(`${frame.error?.code ?? 'browser_error'}: ${frame.error?.message ?? 'Browser operation failed.'}`));
    else {
      if (frame.method === 'initialize' && frame.result && typeof frame.result === 'object') {
        const result = frame.result as Record<string, unknown>;
        if (result.activityProtocol === 1 && typeof result.activityEpoch === 'string'
          && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(result.activityEpoch)) {
          this.childActivityEpoch = result.activityEpoch;
        }
      }
      this.remember(frame.method, responseSessionId, frame.result);
      pending.resolve(frame.result);
    }
  }

  private fail(child: ChildProcessWithoutNullStreams, error: Error, closed = false): void {
    if (child !== this.child) return;
    this.transportUncertain = !closed;
    this.activityRevision++;
    logDiagnostic(error.message);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.uncertain = true;
      pending.reject(new Error('Browser sidecar disconnected.'));
    }
    this.killOwnedProcess(child, this.ownedBrowserPid);
    if (!closed) return;
    // The sidecar and Chromium have separate process groups. Sidecar exit
    // alone must not turn a lost browser (or a half-finished launch) into idle.
    const provedBrowserExit = this.childActivity && this.childActivity.epoch === this.childActivityEpoch
      && this.childActivity.requestSequence === this.childRequestSequence && !this.childActivity.browserAlive
      && !this.childActivity.starting && !this.childActivity.unknown.length && !this.childActivityInvalid;
    if (!provedBrowserExit && (this.ownedBrowserPid || this.browserWorkDispatched)) {
      this.browserClosureUncertain = true;
    }
    this.child = undefined;
    this.pending.clear();
    this.ownedBrowserPid = undefined;
    if (provedBrowserExit && !this.browserClosureUncertain) {
      // The child transport is now closed too: no queued JS callback can
      // launch a new browser after its final, sequence-bound absence proof.
      this.childActivity = undefined;
      this.childActivityEpoch = undefined;
      this.childActivityInvalid = false;
      this.browserWorkDispatched = false;
    }
    if (this.shuttingDown || this.sessions.size === 0) return;

    this.recoveryDeferred = true;
    const snapshots = this.recoverySnapshots();
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
      }, false);
    }
    this.startRecovery(snapshots);
  }

  private remember(method: BrowserRequestMethod, sessionId: string | undefined, value: unknown): void {
    if (!sessionId) return;
    this.activityRevision++;
    if (method === 'session.close') {
      // Legacy children close best-effort. Upgraded children supply independent
      // epoch/sequence-bound activity; their close reply alone is not idle proof.
      if (!this.childActivityEpoch && this.browserWorkDispatched && this.sessions.has(sessionId)) this.browserClosureUncertain = true;
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
    // Unsubscribe/state for an unknown session must not manufacture retained
    // ownership. Empty *existing* sessions stay retained until explicit close.
    if (this.sessions.has(sessionId) || method === 'session.open' || method === 'screencast.subscribe' || state?.tabs.length) {
      this.sessions.set(sessionId, existing);
    }
  }

  private browserState(value: unknown, sessionId: string): BrowserSessionState | null {
    if (!isBrowserSessionState(value, sessionId)) return null;
    return { sessionId, activeTabId: value.activeTabId, tabs: value.tabs.map((tab) => ({ ...tab })) };
  }

  private emit(event: BrowserEventFrame, remember = true): void {
    // Delayed title/history callbacks from a closed session are replayable
    // metadata, not evidence that a new session was opened.
    if (remember && event.method === 'state' && event.sessionId && (this.sessions.has(event.sessionId)
      || [...this.pending.values()].some((pending) => pending.sessionId === event.sessionId
        && (pending.method === 'session.open' || pending.method === 'screencast.subscribe')))) {
      this.remember('session.state', event.sessionId, event.payload);
    }
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* One consumer cannot break recovery fan-out. */ }
    }
  }

  private recoverySnapshots() {
    return [...this.sessions.entries()].map(([sessionId, session]) => ({
      sessionId, subscribed: session.subscribed,
      state: { sessionId, activeTabId: session.state.activeTabId, tabs: session.state.tabs.map((tab) => ({ ...tab })) },
    }));
  }

  private startRecovery(
    snapshots: Array<{ sessionId: string; state: BrowserSessionState; subscribed: boolean }>,
  ): void {
    if (this.recovering || this.shuttingDown) return;
    let release: (() => void) | undefined;
    try { release = this.admission?.enter('automation.browser.recovery'); }
    catch { return; } // Retained recovery snapshots remain busy; no hidden spawn.
    this.recoveryDeferred = false;
    this.activityRevision++;
    this.recovering = this.recoverSessions(snapshots).finally(() => {
      this.recovering = undefined;
      this.activityRevision++;
      release?.();
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
