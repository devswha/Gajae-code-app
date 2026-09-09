import { spawn as spawnChild } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { DesktopWorkAdmission } from '@/shared/interfaces.js';

const MAX_FRAME_BYTES = 64 * 1024;
const MAX_QUEUED_PATHS = 4096;
const FAILURE_MESSAGE = 'GJC session watcher failed.';
const CALLBACK_FAILURE_MESSAGE = 'GJC session watcher callback failed.';
const STDERR_MESSAGE = 'GJC session watcher emitted diagnostics.';

export type GjcSessionWatchEvent = {
  kind: 'add' | 'change';
  path: string;
};

type Child = {
  stdin: {
    end(): void;
    on?(event: string, listener: (...args: unknown[]) => void): unknown;
  };
  stdout: {
    on(event: 'data', listener: (chunk: Buffer | Uint8Array) => void): unknown;
  };
  stderr?: {
    on(event: 'data', listener: (chunk: Buffer | Uint8Array) => void): unknown;
  };
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'error' | 'exit' | 'close', listener: (...args: unknown[]) => void): unknown;
};

type Spawn = (
  command: string,
  args: string[],
  options: {
    detached: false;
    env: NodeJS.ProcessEnv;
    stdio: ['pipe', 'pipe', 'pipe'];
    windowsHide: boolean;
  },
) => Child;

export type GjcSessionWatcherOptions = {
  roots: readonly string[];
  onEvent: (event: GjcSessionWatchEvent, signal: AbortSignal) => unknown;
  onFailure: (error: Error) => unknown;
  corePath?: string;
  spawn?: Spawn;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  readyTimeoutMs?: number;
  closeDrainTimeoutMs?: number;
  closeExitTimeoutMs?: number;
  diagnostic?: (message: string) => void;
  compiled?: boolean;
  desktopAdmission?: DesktopWorkAdmission;
  onActivityChange?: () => void;
};

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function timeout(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Watches GJC transcript files through the mandatory native Protocol v1 host. */
export class GjcSessionWatcher {
  private readonly options: Required<Pick<GjcSessionWatcherOptions, 'spawn' | 'platform' | 'environment' | 'readyTimeoutMs' | 'closeDrainTimeoutMs' | 'closeExitTimeoutMs' | 'diagnostic'>> & Pick<GjcSessionWatcherOptions, 'corePath' | 'compiled' | 'roots' | 'onEvent' | 'onFailure'>;
  private child?: Child;
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private readonly started = deferred();
  private readonly exited = deferred();
  private ready = false;
  private closed = false;
  private failed = false;
  private exitedOnce = false;
  private input = Buffer.alloc(0);
  private readonly pending = new Map<string, GjcSessionWatchEvent>();
  private draining = false;
  private drainDone = deferred();
  private drainCancelled = false;
  private readonly drainAbort = new AbortController();
  private readonly desktopAdmission?: DesktopWorkAdmission;
  private readonly onActivityChange: () => void;
  private callbacks = 0;
  private admissionRetry?: ReturnType<typeof setTimeout>;

  constructor(options: GjcSessionWatcherOptions) {
    this.desktopAdmission = options.desktopAdmission;
    this.onActivityChange = options.onActivityChange ?? (() => {});
    this.options = {
      roots: options.roots,
      onEvent: options.onEvent,
      onFailure: options.onFailure,
      corePath: options.corePath,
      compiled: options.compiled,
      spawn: options.spawn ?? spawnChild as unknown as Spawn,
      platform: options.platform ?? process.platform,
      environment: options.environment ?? process.env,
      readyTimeoutMs: options.readyTimeoutMs ?? 5_000,
      closeDrainTimeoutMs: options.closeDrainTimeoutMs ?? 5_000,
      closeExitTimeoutMs: options.closeExitTimeoutMs ?? 5_000,
      diagnostic: options.diagnostic ?? (() => {}),
    };
  }

  snapshotActivity() {
    return { starting: this.starting && !this.ready && !this.closed ? 1 : 0,
      queued: this.pending.size, running: Number(this.draining) + this.callbacks,
      settling: this.closed && this.child && !this.exitedOnce ? 1 : 0,
      unknown: this.failed && !this.exitedOnce ? ['watcher_exit_unconfirmed'] : [] };
  }
  private changed(): void { this.onActivityChange(); }
  private callback(work: () => unknown): void {
    this.callbacks++; this.changed();
    const done = () => { this.callbacks--; this.changed(); };
    try { void Promise.resolve(work()).then(done, done); } catch { done(); }
  }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error(FAILURE_MESSAGE));
    if (this.starting) return this.starting;
    const executable = this.options.platform === 'win32' ? 'gajae-core.exe' : 'gajae-core';
    const compiled = this.options.compiled ?? !import.meta.url.endsWith('.ts');
    const corePath = this.options.corePath ?? fileURLToPath(new URL(
      compiled ? `../../../../../dist-native/${executable}` : `../../../../dist-native/${executable}`,
      import.meta.url,
    ));
    const args = ['watch', ...this.options.roots.flatMap((root) => ['--root', root])];
    this.starting = this.waitForReady();
    this.changed();
    try {
      const child = this.options.spawn(corePath, args, {
        detached: false,
        env: this.options.environment,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;
      this.changed();
      child.stdout.on('data', (chunk) => this.onStdout(chunk));
      child.stderr?.on('data', () => this.diagnose(STDERR_MESSAGE));
      child.stdin.on?.('error', () => this.fail());
      child.on('error', () => this.fail());
      child.on('exit', () => this.onExit());
      child.on('close', () => this.onExit());
    } catch {
      this.fail();
    }
    return this.starting;
  }

  private async waitForReady(): Promise<void> {
    await Promise.race([this.started.promise, timeout(this.options.readyTimeoutMs).then(() => {
      if (!this.ready) {
        this.fail();
        throw new Error(FAILURE_MESSAGE);
      }
    })]);
  }

  private onStdout(chunk: Buffer | Uint8Array): void {
    if (this.failed || this.closed) return;
    this.input = Buffer.concat([this.input, Buffer.from(chunk)]);
    for (;;) {
      const newline = this.input.indexOf(0x0a);
      if (newline < 0) break;
      const frame = this.input.subarray(0, newline);
      this.input = this.input.subarray(newline + 1);
      if (frame.length > MAX_FRAME_BYTES) {
        this.fail();
        return;
      }
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(frame).replace(/\r$/u, '');
      } catch {
        this.fail();
        return;
      }
      this.decode(text);
      if (this.failed) return;
    }
    if (this.input.length > MAX_FRAME_BYTES) this.fail();
  }

  private decode(text: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      this.fail();
      return;
    }
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) return this.fail();
    const record = frame as Record<string, unknown>;
    const keys = Object.keys(record);
    if (record.protocolVersion !== 1 || typeof record.kind !== 'string') return this.fail();
    if (record.kind === 'ready') {
      if (this.ready || keys.length !== 2 || !keys.includes('protocolVersion') || !keys.includes('kind')) return this.fail();
      this.ready = true;
      this.changed();
      this.started.resolve();
      return;
    }
    if (
      record.kind !== 'event' ||
      (record.event !== 'add' && record.event !== 'change') ||
      !this.ready ||
      keys.length !== 4 ||
      !keys.includes('protocolVersion') ||
      !keys.includes('kind') ||
      !keys.includes('event') ||
      !keys.includes('path') ||
      typeof record.path !== 'string' ||
      record.path.length === 0 ||
      record.path.includes('\0')
    ) {
      return this.fail();
    }
    if (!this.pending.has(record.path) && this.pending.size >= MAX_QUEUED_PATHS) return this.fail();
    this.pending.set(record.path, { kind: record.event, path: record.path });
    this.changed();
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.drainDone = deferred();
    this.draining = true;
    this.changed();
    try {
      while (!this.failed && !this.drainCancelled && this.pending.size > 0) {
        const event = this.pending.values().next().value as GjcSessionWatchEvent;
        let release: (() => void) | undefined;
        try { release = this.desktopAdmission?.enter('watcher:synchronize'); }
        catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'DESKTOP_RESTART_FENCED') {
            // Retain the accepted path. It invalidates an idle proof and can
            // resume after cancellation; it is never silently discarded.
            if (!this.admissionRetry) this.admissionRetry = setTimeout(() => { this.admissionRetry = undefined; if (!this.closed) void this.drain(); }, 25);
            return;
          }
          throw error;
        }
        this.pending.delete(event.path);
        this.changed();
        try {
          await this.options.onEvent(event, this.drainAbort.signal);
        } catch {
          if (!this.drainCancelled) this.diagnose(CALLBACK_FAILURE_MESSAGE);
        } finally {
          release?.();
        }
      }
    } finally {
      this.draining = false;
      this.changed();
      if (this.pending.size === 0 || this.drainCancelled) this.drainDone.resolve();
    }
  }

  private diagnose(message: string): void {
    this.callback(() => this.options.diagnostic(message));
  }

  private fail(): void {
    if (this.failed || this.closed) return;
    this.failed = true;
    this.changed();
    this.drainCancelled = true;
    this.pending.clear();
    this.drainAbort.abort();
    this.drainDone.resolve();
    this.started.reject(new Error(FAILURE_MESSAGE));
    this.diagnose(FAILURE_MESSAGE);
    this.callback(() => this.options.onFailure(new Error(FAILURE_MESSAGE)));
    try {
      this.child?.kill('SIGKILL');
    } catch {
      // The process may already be gone.
    }
  }

  private onExit(): void {
    if (this.exitedOnce) return;
    this.exitedOnce = true;
    this.changed();
    this.exited.resolve();
    if (!this.closed) this.fail();
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    if (!this.ready && !this.failed) this.started.reject(new Error(FAILURE_MESSAGE));
    this.closed = true;
    if (this.admissionRetry) clearTimeout(this.admissionRetry);
    this.admissionRetry = undefined;
    this.changed();
    this.closing = (async () => {
      try {
        this.child?.stdin.end();
      } catch {
        // Closing an already-closed stdin still permits bounded shutdown.
      }
      if (this.pending.size > 0 || this.draining) {
        const drained = await Promise.race([
          this.drainDone.promise.then(() => true),
          timeout(this.options.closeDrainTimeoutMs).then(() => false),
        ]);
        if (!drained) {
          this.drainCancelled = true;
          this.pending.clear();
          this.drainAbort.abort();
          this.drainDone.resolve();
        }
      }
      if (this.child && !this.exitedOnce) {
        await Promise.race([this.exited.promise, timeout(this.options.closeExitTimeoutMs)]);
        if (!this.exitedOnce) {
          try {
            this.child.kill('SIGKILL');
          } catch {
            // A concurrently exited child needs no further action.
          }
          await Promise.race([this.exited.promise, timeout(this.options.closeExitTimeoutMs)]);
        }
      }
      if ((this.child && !this.exitedOnce) || this.draining) throw new Error('GJC watcher shutdown is unconfirmed.');
    })();
    return this.closing;
  }
}
