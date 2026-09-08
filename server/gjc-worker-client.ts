import { randomUUID } from 'node:crypto';
import { spawn as spawnChild } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Writable } from 'node:stream';

import type { DesktopOwnerActivity } from '../shared/desktopUpdateProtocol.js';
import type { GjcGoalCommand, GjcGoalSnapshot, GjcGoalScope } from '../shared/gjc-goal.js';

import {
  GJC_CLEANUP_UNCONFIRMED_CODE,
  GJC_AGENT_TOOL_NAMES,
  GJC_INVALID_PERMISSIONS_CODE,
  GJC_INVALID_PERMISSIONS_MESSAGE,
  GJC_MODEL_UNRESOLVED_CODE,
  GJC_MODEL_UNRESOLVED_MESSAGE,
  GJC_WORKER_PROTOCOL_VERSION,
  GJC_WINDOWS_JOB_GUARD_ACK,
  GJC_WINDOWS_JOB_GUARD_READY,
  GjcWorkerNdjsonDecoder,
  GjcWorkerProtocolError,
  GjcWorkerRequestTracker,
  createWindowsJobLaunch,
  serializeGjcWorkerFrame,
  type GjcWorkerEventFrame,
  type GjcWorkerGlobalEventMethod,
  type GjcWorkerRequestFrame,
  type GjcWorkerRequestMethod,
  type GjcWorkerResponsePayload,
  type GjcWorkerResponseFrame,
  type JsonObject,
} from './gjc-engine.js';
import { notifyRunFailed, notifyRunStopped } from './modules/notifications/index.js';
import {
  createCompleteMessage,
  createNormalizedMessage,
  getGjcLiveSessionRoot,
  registerGjcRuntimeModelCatalogLoader,
} from './shared/utils.js';

type RunStoppedNotification = {
  userId: string | number | null;
  provider: string;
  sessionId: string | null;
  sessionName: string | null;
  stopReason: string;
};

type RunFailedNotification = {
  userId: string | number | null;
  provider: string;
  sessionId: string | null;
  sessionName: string | null;
  error: string;
};

type RunStoppedNotifier = (notification: RunStoppedNotification) => unknown;
type RunFailedNotifier = (notification: RunFailedNotification) => unknown;
export type GjcApprovalDecision = { allow: boolean; always?: boolean; updatedInput?: unknown; message?: string; rememberEntry?: unknown };
export type GjcWorkerOptions = Record<string, unknown> & {
  sessionId?: string | null;
  cwd?: string;
  projectPath?: string;
  sessionSummary?: string;
  notificationOwner?: 'terminal-adapter';
};
type GjcOptionsEnricher = (options: GjcWorkerOptions) => Promise<GjcWorkerOptions>;
export type GjcWorkerWriter = { send(value: unknown): void; setSessionId?(id: string): void; getAppSessionId?(): string | undefined; userId?: string | number | null };
type Child = {
  pid?: number;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  stdin: Writable;
  stdout: NodeJS.ReadableStream;
  stderr?: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
};

export type GjcWorkerSpawnRun = {
  runId: string;
  appSessionId: string;
  message: string;
  options?: GjcWorkerOptions;
  writer: GjcWorkerWriter;
};
export type GjcWorkerOutcome = 'not_started' | 'aborted' | 'completed' | 'reaped' | 'unconfirmed';
export type GjcWorkerAbortOutcome = 'not_started' | 'aborted' | 'unconfirmed';
export type GjcWorkerReapOutcome = 'not_started' | 'reaped' | 'unconfirmed';
export type GjcWorkerRun = {
  started: Promise<void>;
  completion: Promise<void>;
  /** The terminal run outcome. `reaped` proves OS process-tree termination only. */
  outcome?: Promise<GjcWorkerOutcome>;
  phase?: () => 'registered' | 'request_issued' | 'run_terminal';
  abortHandle: string;
};

type Spawn = (
  command: string,
  args: string[],
  options: {
    cwd?: string;
    detached?: boolean;
    env?: NodeJS.ProcessEnv;
    stdio: ['pipe', 'pipe', 'pipe'];
    windowsHide?: boolean;
  },
) => Child;

export type GjcWorkerSupervisorRuntime = {
  spawn?: Spawn;
  workerPath?: string;
  corePath?: string;
  compiled?: boolean;
  /** Explicit test/development override; production resolves the bundled Bun first. */
  bunPath?: string;
  /** Allows PATH lookup only for uncompiled development workers. */
  allowDevelopmentBun?: boolean;
  /**
   * Bound on `worker.initialize` (and the Windows launch guard). The Bun worker
   * bootstraps the SDK inside this request — model registry build plus online
   * model discovery — which has been measured at 4-8 s on a loaded developer
   * machine, so the bound has to sit well above a single network round trip.
   */
  initializeTimeoutMs?: number;
  /** Bound on `worker.shutdown` before the process tree is reaped regardless. */
  shutdownTimeoutMs?: number;
  requestTimeoutMs?: number;
  notifyRunStopped?: RunStoppedNotifier;
  notifyRunFailed?: RunFailedNotifier;
  createScope?: () => string;
  diagnostic?: (message: string) => void;
  /** Fulfillment must prove owned process-tree termination, not merely send a signal. */
  killTree?: (child: Child) => void | Promise<void>;
  /** Same proof contract for separately reported run processes. */
  killProcessTree?: (processId: number) => void | Promise<void>;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  enrichOptions?: GjcOptionsEnricher;
};

type RunPhase = 'registered' | 'request_issued' | 'run_terminal';
type Run = {
  runId: string;
  appScope: string;
  writer: GjcWorkerWriter;
  options: GjcWorkerOptions;
  aborted: boolean;
  runtimeAborted?: boolean;
  cleanupUnconfirmed?: boolean;
  abortPromise?: Promise<boolean>;
  phase: RunPhase;
  terminalForwarded: boolean;
  terminalFailed: boolean;
  processId?: number;
  providerSessionId?: string;
  resolve: () => void;
  reject: (error: Error) => void;
  resolveOutcome: (outcome: GjcWorkerOutcome) => void;
  resolveStarted: () => void;
  rejectStarted: (error: Error) => void;
  started: boolean;
};

type PendingApproval = {
  runId: string;
  appScope: string;
  message: unknown;
  inFlight: boolean;
};

type ExpiredRequest = {
  method: GjcWorkerRequestMethod;
  sessionId?: string;
};
type GjcWorkerOAuthRequestMethod = Extract<GjcWorkerRequestMethod, `oauth.${string}`>;
export type GjcWorkerOAuthEvent = {
  method: GjcWorkerGlobalEventMethod;
  payload: JsonObject;
};
type GjcWorkerOAuthListener = (event: GjcWorkerOAuthEvent) => void;
const GJC_OAUTH_SUBMIT_MAX_LENGTH = 16 * 1024;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_FAILURE = 'GJC worker failed.';
const REQUEST_TIMEOUT = 'GJC worker request timed out.';
/**
 * `worker.initialize` covers the whole SDK bootstrap (model registry build and
 * online model discovery), measured at 4-8 s on a loaded developer machine. The
 * previous 5 s bound killed a healthy worker mid-bootstrap, and every tab that
 * had reconnected saw only "GJC worker failed.".
 */
export const DEFAULT_INITIALIZE_TIMEOUT_MS = 60_000;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
class GjcConfigurationError extends Error {}

/**
 * Fixed client-facing text for a failed start/resume response. Worker responses
 * are sanitized, so only codes the app itself can cause map to something more
 * specific than the generic failure.
 */
function runFailureMessage(response: GjcWorkerResponsePayload): string {
  if (!response.ok && response.error.code === GJC_INVALID_PERMISSIONS_CODE) return GJC_INVALID_PERMISSIONS_MESSAGE;
  if (!response.ok && response.error.code === GJC_MODEL_UNRESOLVED_CODE) return GJC_MODEL_UNRESOLVED_MESSAGE;
  return SAFE_FAILURE;
}

function oauthIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function oauthFailure(code: string): GjcWorkerResponsePayload {
  return { ok: false, error: { code, message: 'OAuth request failed.' } };
}

function safeId(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeJsonObject(value: unknown): JsonObject | undefined {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return undefined;
    const parsed: unknown = JSON.parse(serialized);
    return object(parsed) as JsonObject | undefined;
  } catch {
    return undefined;
  }
}

function safeOptions(options: GjcWorkerOptions): JsonObject | undefined {
  const { sessionId: _sessionId, ...rest } = options;
  return safeJsonObject(rest);
}
function containedBy(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === '' || (!!pathFromRoot && !pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot));
}

type GjcSessionPathLookup = (sessionId: string) => Promise<string | undefined>;

async function sessionJsonlPath(sessionId: string): Promise<string | undefined> {
  const { sessionsDb } = await import('./modules/database/index.js');
  const session = sessionsDb.getSessionByProviderSessionId('gjc', sessionId)
    ?? sessionsDb.getSessionById(sessionId);
  return session?.provider === 'gjc' ? session.jsonl_path ?? undefined : undefined;
}

export async function resolveGjcResumeSessionRoot(
  sessionId: string,
  liveSessionRoot: string,
  lookup: GjcSessionPathLookup = sessionJsonlPath,
): Promise<string | undefined> {
  try {
    const sessionPath = await realpath(await lookup(sessionId) ?? '');
    const sessionDirectory = dirname(sessionPath);
    const roots = [
      join(homedir(), '.gjc', 'agent', 'sessions'),
      liveSessionRoot,
    ];
    for (const root of roots) {
      try {
        const canonicalRoot = await realpath(root);
        // SessionManager.list() scans only the supplied directory. Managed
        // sessions live one level below the global sessions root, so returning
        // that global root makes every historical resume look missing.
        if (containedBy(canonicalRoot, sessionPath)) return sessionDirectory;
      } catch {
        // A missing or inaccessible allowlist root cannot contain a resumable session.
      }
    }
  } catch {
    // Session metadata is advisory; preserve the live-root fallback.
  }
  return undefined;
}

async function enrichGjcSdkRunOptions(options: GjcWorkerOptions): Promise<GjcWorkerOptions> {
  let modelId = options.modelId ?? options.model;
  let modelProfile = typeof options.modelProfile === 'string' ? options.modelProfile.trim() : '';
  if (typeof modelId === 'string' && modelId.startsWith('profile:')) {
    modelProfile = modelId.slice('profile:'.length).trim();
    modelId = 'default';
  }
  if (modelId === null || modelId === undefined) {
    try {
      const { providerModelsService } = await import('./modules/providers/index.js');
      modelId = (await providerModelsService.getCurrentActiveModel('gjc')).model;
    } catch {
      throw new GjcConfigurationError('Unable to resolve the active GJC model.');
    }
  }
  if (typeof modelId !== 'string' || !modelId.trim()) {
    throw new GjcConfigurationError('GJC requires a configured model ID.');
  }

  const liveSessionRoot = typeof options.sessionRoot === 'string' && options.sessionRoot
    ? options.sessionRoot
    : getGjcLiveSessionRoot();
  const sessionRoot = typeof options.sessionId === 'string' && options.sessionId
    ? await resolveGjcResumeSessionRoot(options.sessionId, liveSessionRoot) ?? liveSessionRoot
    : liveSessionRoot;
  return {
    ...options,
    cwd: options.cwd ?? options.projectPath,
    sessionRoot,
    credential: options.credential ?? { kind: 'stored' },
    modelId,
    ...(modelProfile ? { modelProfile } : {}),
    effort: typeof options.effort === 'string' && options.effort ? options.effort : 'default',
    toolNames: options.toolNames ?? [...GJC_AGENT_TOOL_NAMES],
    spawns: options.spawns ?? '*',
    bashPolicy: options.bashPolicy ?? { allowedPrefixes: [] },
  };
}

export function killWorkerTree(
  child: Child,
  platform: NodeJS.Platform = process.platform,
  kill: (pid: number, signal: NodeJS.Signals | 0) => void = process.kill,
): Promise<void> {
  if (platform === 'win32') {
    // Windows runtime is frozen in v2; no verified tree-reap implementation exists.
    return Promise.reject(new Error('GJC worker tree reaping is unconfirmed on Windows.'));
  }
  return new Promise((resolve, reject) => {
    let closed = false;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const reapProcessGroup = (): void => {
      try {
        kill(-child.pid!, 'SIGKILL');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ESRCH' && code !== 'EPERM') throw error;
      }
      try {
        child.kill('SIGKILL');
      } catch {
        // A concurrently exited child cannot prevent process-group verification.
      }
    };
    const verifyProcessGroup = (): void => {
      if (settled) return;
      if (!child.pid) {
        if (closed) finish();
        return;
      }
      try {
        reapProcessGroup();
        kill(-child.pid, 0);
        setTimeout(verifyProcessGroup, 25);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') {
          if (closed) finish();
          else setTimeout(verifyProcessGroup, 25);
        } else if (code === 'EPERM') {
          setTimeout(verifyProcessGroup, 25);
        } else {
          finish(new Error('GJC worker process group termination could not be verified.', { cause: error }));
        }
      }
    };
    child.on('close', () => {
      closed = true;
      verifyProcessGroup();
    });
    const timer = setTimeout(() => finish(new Error('GJC worker tree termination timed out.')), 5_000);
    timer.unref?.();
    try {
      if (child.pid) {
        try {
          kill(-child.pid, 'SIGKILL');
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ESRCH' && code !== 'EPERM') throw error;
          try {
            child.kill('SIGKILL');
          } catch {
            // A concurrently exited child cannot prevent process-group verification.
          }
        }
      } else if (!child.kill('SIGKILL')) {
        throw new Error('GJC worker process could not be terminated.');
      }
      verifyProcessGroup();
    } catch (error) {
      finish(error instanceof Error ? error : new Error('GJC worker tree termination failed.'));
    }
  });
}

/** Supervises the private Protocol v1 worker while preserving app-owned lifecycle state. */
export class GjcWorkerSupervisor {
  private readonly runtime: Required<Pick<GjcWorkerSupervisorRuntime, 'spawn' | 'initializeTimeoutMs' | 'shutdownTimeoutMs' | 'requestTimeoutMs' | 'createScope' | 'diagnostic' | 'notifyRunStopped' | 'notifyRunFailed' | 'killTree' | 'killProcessTree' | 'platform' | 'environment' | 'enrichOptions'>> & Pick<GjcWorkerSupervisorRuntime, 'corePath' | 'workerPath' | 'compiled' | 'bunPath' | 'allowDevelopmentBun'>;
  private child?: Child;
  private ready = false;
  private starting?: Promise<void>;
  private shuttingDown = false;
  private shutdownPromise?: Promise<void>;
  private terminating?: Promise<void>;
  private terminatingGeneration?: { child: Child; runIds: ReadonlySet<string>; outcome: Promise<GjcWorkerReapOutcome> };
  private terminationFailure?: Error;
  private decoder?: GjcWorkerNdjsonDecoder;
  private tracker = new GjcWorkerRequestTracker();
  private readonly runs = new Map<string, Run>();
  private readonly aliases = new Map<string, string>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly expiredRequests = new Map<string, ExpiredRequest>();
  private readonly oauthListeners = new Set<GjcWorkerOAuthListener>();
  private readonly activityEpoch = randomUUID();
  private activityRevision = 0n;
  private readonly activityTasks = { starting: 0, settling: 0 };
  private readonly unreapedWorkers = new Set<Child>();
  private requestTimeoutUncertainty = false;
  private readonly reapingWorkers = new Set<Child>();
  private runProcessProofMissing = false;
  private readonly hasRunProcessReaper: boolean;

  constructor(runtime: GjcWorkerSupervisorRuntime = {}) {
    this.hasRunProcessReaper = runtime.killProcessTree !== undefined;
    this.runtime = {
      spawn: runtime.spawn ?? spawnChild as unknown as Spawn,
      corePath: runtime.corePath,
      workerPath: runtime.workerPath,
      compiled: runtime.compiled,
      bunPath: runtime.bunPath,
      allowDevelopmentBun: runtime.allowDevelopmentBun ?? process.env.GAJAE_ALLOW_DEVELOPMENT_BUN === '1',
      enrichOptions: runtime.enrichOptions ?? (async (options) => options),
      initializeTimeoutMs: runtime.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS,
      shutdownTimeoutMs: runtime.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
      requestTimeoutMs: runtime.requestTimeoutMs ?? 30_000,
      createScope: runtime.createScope ?? (() => `gjc-${randomUUID()}`),
      diagnostic: runtime.diagnostic ?? (() => {}),
      notifyRunStopped: runtime.notifyRunStopped ?? notifyRunStopped as unknown as RunStoppedNotifier,
      notifyRunFailed: runtime.notifyRunFailed ?? notifyRunFailed as unknown as RunFailedNotifier,
      killTree: runtime.killTree ?? ((child) => killWorkerTree(child, runtime.platform ?? process.platform)),
      killProcessTree: runtime.killProcessTree ?? (() => {}),
      platform: runtime.platform ?? process.platform,
      environment: runtime.environment ?? process.env,
    };
  }

  /** Pure revision; unique across supervisors and never reused after an idle/busy/idle cycle. */
  getGeneration(): string {
    return `${this.activityEpoch}:${this.activityRevision}`;
  }

  /**
   * Read-only restart evidence, NOT an idle-worker probe. Protocol v1 does not
   * account for SDK continuations, title tasks, background bash or OAuth unwind.
   * Keep that uncertainty until the existing process-tree reap barrier succeeds.
   * Counts overlap and include app continuations after a request/run is removed.
   */
  snapshotActivity(): DesktopOwnerActivity {
    let registered = 0;
    let running = 0;
    let aborting = 0;
    let approvalsInFlight = 0;
    for (const run of this.runs.values()) {
      if (run.phase === 'registered') registered += 1;
      if (run.phase === 'request_issued') running += 1;
      if (run.abortPromise) aborting += 1;
    }
    for (const approval of this.approvals.values()) {
      if (approval.inFlight) approvalsInFlight += 1;
    }
    const unknown: string[] = [];
    if (this.unreapedWorkers.size || this.runProcessProofMissing) unknown.push('worker_runtime_unaccounted');
    if (this.requestTimeoutUncertainty) unknown.push('worker_request_timeout_unconfirmed');
    if (this.reapingWorkers.size) unknown.push('worker_reap_pending');
    if (this.terminationFailure) unknown.push('worker_reap_unconfirmed');
    if (this.runProcessProofMissing) unknown.push('worker_process_tree_unaccounted');
    return {
      owner: 'gjc-worker', generation: this.getGeneration(), complete: unknown.length === 0,
      starting: this.activityTasks.starting + registered,
      queued: this.tracker.size,
      running,
      settling: this.activityTasks.settling + aborting + approvalsInFlight,
      approvals: this.approvals.size,
      retained: this.unreapedWorkers.size + Number(this.runProcessProofMissing),
      unknown,
    };
  }

  private activityChanged(): void {
    this.activityRevision += 1n;
  }

  /** Covers awaits and synchronous user callbacks that can outlive map entries. */
  private beginActivity(kind: keyof GjcWorkerSupervisor['activityTasks']): () => void {
    this.activityTasks[kind] += 1;
    this.activityChanged();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activityTasks[kind] -= 1;
      this.activityChanged();
    };
  }
  /**
   * Sends a global OAuth request through the one supervised worker. OAuth
   * protocol requests deliberately carry no app session id.
   */
  private async oauthRequest(
    method: GjcWorkerOAuthRequestMethod,
    payload: JsonObject,
  ): Promise<GjcWorkerResponsePayload> {
    const release = this.beginActivity('settling');
    try {
      await this.ensureWorker();
      return await this.request(method, undefined, payload);
    } finally {
      release();
    }
  }

  async modelCatalog(): Promise<GjcWorkerResponsePayload> {
    const release = this.beginActivity('settling');
    try {
      await this.ensureWorker();
      return await this.request('models.catalog', undefined, {});
    } finally {
      release();
    }
  }

  async inspectGoal(scope: GjcGoalScope, providerSessionId: string): Promise<GjcGoalSnapshot> {
    const release = this.beginActivity('settling');
    try {
      const liveRoot = getGjcLiveSessionRoot();
      const sessionRoot = await resolveGjcResumeSessionRoot(providerSessionId, liveRoot) ?? liveRoot;
      await this.ensureWorker();
      const response = await this.request('goal.inspect', scope.appSessionId, { owner: scope.owner, cwd: scope.cwd, ...(scope.projectPath ? { projectPath: scope.projectPath } : {}), providerSessionId, sessionRoot });
      if (!response.ok) throw new Error(response.error.message);
      return response.result as GjcGoalSnapshot;
    } finally {
      release();
    }
  }

  async controlGoal(runId: string, scope: GjcGoalScope, command?: GjcGoalCommand, stopAfterMutation = true): Promise<GjcGoalSnapshot> {
    const run = this.runs.get(runId);
    if (!run || run.appScope !== scope.appSessionId || run.phase !== 'request_issued' || run.aborted || run.abortPromise) throw new Error('The active run changed. Refresh before controlling its goal.');
    const release = this.beginActivity('settling');
    try {
      const response = await this.request('goal.control', scope.appSessionId, {
        runId, owner: scope.owner, cwd: scope.cwd, ...(scope.projectPath ? { projectPath: scope.projectPath } : {}), ...(command ? { command } : {}),
        ...(stopAfterMutation ? {} : { stopAfterMutation: false }),
      });
      if (!response.ok) throw new Error(response.error.message);
      return response.result as GjcGoalSnapshot;
    } finally {
      release();
    }
  }

  oauthProviders(): Promise<GjcWorkerResponsePayload> {
    return this.oauthRequest('oauth.providers', {});
  }

  oauthStatus(): Promise<GjcWorkerResponsePayload> {
    return this.oauthRequest('oauth.status', {});
  }

  oauthStart(providerId: string): Promise<GjcWorkerResponsePayload> {
    if (!oauthIdentifier(providerId)) return Promise.resolve(oauthFailure('invalid_payload'));
    return this.oauthRequest('oauth.start', { providerId });
  }

  async oauthSubmit(attemptId: string, value: string): Promise<GjcWorkerResponsePayload> {
    if (!oauthIdentifier(attemptId) || typeof value !== 'string') {
      return oauthFailure('invalid_payload');
    }
    if (value.length > GJC_OAUTH_SUBMIT_MAX_LENGTH) {
      return oauthFailure('oauth_submit_too_large');
    }

    const payload: JsonObject = { attemptId, value };
    try {
      return await this.oauthRequest('oauth.submit', payload);
    } finally {
      // The serialized frame has already been written; do not retain input in
      // request tracking after the worker receives it.
      payload.value = '';
      value = '';
    }
  }

  oauthCancel(attemptId: string): Promise<GjcWorkerResponsePayload> {
    if (!oauthIdentifier(attemptId)) return Promise.resolve(oauthFailure('invalid_payload'));
    return this.oauthRequest('oauth.cancel', { attemptId });
  }

  subscribeOAuth(listener: GjcWorkerOAuthListener): () => void {
    this.oauthListeners.add(listener);
    return () => this.oauthListeners.delete(listener);
  }

  private emitOAuthEvent(event: GjcWorkerOAuthEvent): void {
    this.activityChanged();
    for (const listener of this.oauthListeners) {
      try {
        listener(event);
      } catch {
        this.diagnose('OAuth event listener failed.');
      }
    }
  }


  private diagnose(message: string): void {
    try {
      this.runtime.diagnostic(message);
    } catch {
      // Diagnostics must never interfere with worker lifecycle handling.
    }
  }

  private invokeAppCallback(label: string, callback: () => unknown): void {
    const release = this.beginActivity('settling');
    try {
      void Promise.resolve(callback()).catch(() => this.diagnose(label)).finally(release);
    } catch {
      this.diagnose(label);
      release();
    }
  }

  spawnRun(input: GjcWorkerSpawnRun): GjcWorkerRun {
    const { runId, appSessionId, message, options = {}, writer } = input;
    if (!safeId(runId) || !safeId(appSessionId) || this.runs.has(runId) || this.shuttingDown) {
      const error = new Error(SAFE_FAILURE);
      const started = Promise.reject(error);
      const completion = Promise.reject(error);
      void started.catch(() => {});
      void completion.catch(() => {});
      return { started, completion, outcome: Promise.resolve('not_started'), abortHandle: runId };
    }
    let resolve!: () => void; let reject!: (error: Error) => void;
    let resolveOutcome!: (outcome: GjcWorkerOutcome) => void;
    let resolveStarted!: () => void; let rejectStarted!: (error: Error) => void;
    const completion = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    const outcome = new Promise<GjcWorkerOutcome>((res) => { resolveOutcome = res; });
    void completion.catch(() => {});
    const started = new Promise<void>((res, rej) => { resolveStarted = res; rejectStarted = rej; });
    void started.catch(() => {});
    const run: Run = {
      runId, appScope: appSessionId, writer, options, aborted: false, phase: 'registered',
      terminalForwarded: false, terminalFailed: false, resolve, reject,
      resolveOutcome, resolveStarted, rejectStarted, started: false,
    };
    this.runs.set(runId, run);
    this.activityChanged();
    void this.startRun(run, message);
    return { started, completion, outcome, phase: () => run.phase, abortHandle: runId };
  }

  private canStartRun(run: Run, startingChild: Child | undefined): boolean {
    // A cancelled/reaped run may have been removed and its ID reused while
    // startup or model/session-root enrichment was awaiting external work.
    if (this.runs.get(run.runId) !== run || run.phase !== 'registered') return false;
    if (run.aborted || this.shuttingDown) {
      // Exact identity + registered phase select abort's existing synchronous
      // not_started path. Its notification promises retain their own lifetime.
      void this.abort(run.runId);
      return false;
    }
    // Bind to the Child, not the activity revision (ordinary events change it).
    // If its generation is being reaped, workerFailed still owns settlement.
    return Boolean(startingChild && this.child === startingChild && this.ready
      && !this.terminating && !this.terminationFailure && !run.cleanupUnconfirmed && !run.abortPromise);
  }

  private async startRun(run: Run, message: string): Promise<void> {
    const release = this.beginActivity('settling');
    try {
      await this.ensureWorker();
      const startingChild = this.child;
      if (!this.canStartRun(run, startingChild)) return;

      const providerSessionId = safeId(run.options.sessionId);
      if (providerSessionId) {
        run.providerSessionId = providerSessionId;
        this.aliases.set(providerSessionId, run.runId);
        this.activityChanged();
      }

      const options = safeOptions(await this.runtime.enrichOptions(run.options));
      // No await between the final ownership check and writing the request.
      if (!this.canStartRun(run, startingChild)) return;
      if (!options) {
        this.finish(run, true, SAFE_FAILURE, 'not_started');
        return;
      }

      const payload: JsonObject = {
        message,
        options,
        ...(providerSessionId ? { providerSessionId } : {}),
      };
      const method = providerSessionId ? 'session.resume' : 'session.start';
      const response = await this.request(
        method,
        run.appScope,
        payload,
        null,
        run.runId,
        () => {
          run.phase = 'request_issued';
          run.started = true;
          this.activityChanged();
          run.resolveStarted();
        },
      );
      if (response.ok && object(response.result)?.aborted === true) {
        // Goal limits can stop inside the worker without an app turn.abort.
        // Preserve that outcome through native jobs and the chat terminal.
        run.runtimeAborted = !run.aborted && !run.abortPromise;
        run.aborted = true;
        this.activityChanged();
      }
      this.finish(run, run.terminalFailed || !response.ok, runFailureMessage(response));
    } catch (error) {
      // workerFailed owns terminal settlement and must first prove the reap barrier.
      if (this.terminating || (this.terminationFailure && run.phase === 'request_issued')) return;
      this.finish(
        run,
        true,
        error instanceof GjcConfigurationError ? error.message : SAFE_FAILURE,
      );
    } finally {
      release();
    }
  }

  private ensureWorker(): Promise<void> {
    if (this.terminationFailure) return Promise.reject(this.terminationFailure);
    if (this.terminating) {
      return this.terminating.then(() => this.ensureWorker());
    }
    if (this.ready && this.child) return Promise.resolve();
    if (this.starting) return this.starting;
    const release = this.beginActivity('starting');
    try {
      return this.startWorker(release);
    } catch (error) {
      release();
      throw error;
    }
  }

  private startWorker(releaseStartup: () => void): Promise<void> {
    const compiled = this.runtime.compiled ?? !import.meta.url.endsWith('.ts');
    const workerPath = this.runtime.workerPath ?? fileURLToPath(new URL(compiled ? './gjc-bun-worker.js' : './gjc-bun-worker.ts', import.meta.url));
    const bundledBunPath = fileURLToPath(new URL(
      compiled ? '../../dist-native/bun' : '../dist-native/bun',
      import.meta.url,
    ));
    const bunPath = this.runtime.bunPath
      ?? (existsSync(bundledBunPath) ? bundledBunPath : undefined)
      ?? (!compiled && this.runtime.allowDevelopmentBun ? 'bun' : undefined);
    if (!bunPath) throw new Error(SAFE_FAILURE);
    const coreExecutable = this.runtime.platform === 'win32'
      ? 'gajae-core.exe'
      : 'gajae-core';
    const corePath = this.runtime.corePath ?? fileURLToPath(new URL(
      compiled
        ? `../../dist-native/${coreExecutable}`
        : `../dist-native/${coreExecutable}`,
      import.meta.url,
    ));
    const coreArgs = ['--', bunPath, workerPath];
    const workerEnv = {
      ...this.runtime.environment,
      GJC_WORKER_AGENT_DIR: this.runtime.environment.GJC_WORKER_AGENT_DIR ?? join(homedir(), '.gjc', 'agent'),
    };
    const launch = this.runtime.platform === 'win32'
      ? createWindowsJobLaunch(
          corePath,
          coreArgs,
          workerEnv,
          process.cwd(),
        )
      : {
          command: corePath,
          args: coreArgs,
          env: workerEnv,
        };
    const child = this.runtime.spawn(launch.command, launch.args, {
      detached: this.runtime.platform !== 'win32',
      env: launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child; this.ready = false; this.decoder = new GjcWorkerNdjsonDecoder();
    this.unreapedWorkers.add(child);
    this.activityChanged();
    const usesWindowsJobGuard = this.runtime.platform === 'win32';
    let guardSettled = !usesWindowsJobGuard;
    let guardBuffer = Buffer.alloc(0);
    let resolveGuard!: () => void;
    let rejectGuard!: (error: Error) => void;
    const guardReady = usesWindowsJobGuard
      ? new Promise<void>((resolve, reject) => {
          resolveGuard = resolve;
          rejectGuard = reject;
        })
      : Promise.resolve();
    let guardTimer: NodeJS.Timeout | undefined;
    const settleGuard = (error?: Error): void => {
      if (guardSettled) return;
      guardSettled = true;
      this.activityChanged();
      if (guardTimer) clearTimeout(guardTimer);
      if (error) rejectGuard(error);
      else resolveGuard();
    };
    if (usesWindowsJobGuard) {
      guardTimer = setTimeout(() => {
        settleGuard(new Error(SAFE_FAILURE));
        void this.workerFailed(child);
      }, this.runtime.initializeTimeoutMs);
      guardTimer.unref?.();
    }
    child.stdout.on('data', (chunk: Buffer) => {
      if (guardSettled) {
        this.onStdout(child, chunk);
        return;
      }
      guardBuffer = Buffer.concat([guardBuffer, chunk]);
      if (guardBuffer.length > 128) {
        settleGuard(new Error(SAFE_FAILURE));
        void this.workerFailed(child);
        return;
      }
      const newline = guardBuffer.indexOf(0x0a);
      if (newline < 0) return;
      const prelude = guardBuffer.subarray(0, newline).toString('utf8').replace(/\r$/u, '');
      const remaining = guardBuffer.subarray(newline + 1);
      guardBuffer = Buffer.alloc(0);
      if (prelude !== GJC_WINDOWS_JOB_GUARD_READY) {
        settleGuard(new Error(SAFE_FAILURE));
        void this.workerFailed(child);
        return;
      }
      try {
        child.stdin.write(`${GJC_WINDOWS_JOB_GUARD_ACK}\n`);
      } catch {
        settleGuard(new Error(SAFE_FAILURE));
        void this.workerFailed(child);
        return;
      }
      settleGuard();
      if (remaining.length > 0) this.onStdout(child, remaining);
    });
    const failWorker = (guardedProcessExited = false): void => {
      settleGuard(new Error(SAFE_FAILURE));
      void this.workerFailed(child, guardedProcessExited);
    };
    child.stdin.on('error', () => failWorker());
    child.stderr?.on('data', (chunk: Buffer) => this.diagnose(chunk.toString('utf8')));
    child.on('error', () => failWorker());
    child.on('exit', () => failWorker(true));
    child.on('close', () => failWorker(true));
    const starting = guardReady
      .then(() => this.request(
        'worker.initialize',
        undefined,
        {},
        this.runtime.initializeTimeoutMs,
      ))
      .then((response) => {
        if (child !== this.child) throw new Error('worker generation was replaced during initialization');
        if (!response.ok) throw new Error(`worker.initialize was rejected (${response.error.code})`);
        this.ready = true;
        this.activityChanged();
      })
      .catch((error: unknown) => {
        // Callers only ever see the sanitized failure; this line is the one
        // record of why a worker never came up (typically the bootstrap
        // outlasting initializeTimeoutMs).
        const reason = error instanceof Error ? error.message : String(error);
        this.diagnose(`GJC worker initialization failed after ${this.runtime.initializeTimeoutMs}ms bound: ${reason}`);
        this.workerFailed(child);
        throw new Error(SAFE_FAILURE);
      })
      .finally(() => {
        if (this.starting === starting) {
          this.starting = undefined;
          this.activityChanged();
        }
        releaseStartup();
      });
    this.starting = starting;
    this.activityChanged();
    return starting;
  }

  private request(
    method: GjcWorkerRequestMethod,
    sessionId: string | undefined,
    payload: JsonObject,
    timeout: number | null = this.runtime.requestTimeoutMs,
    id = `req-${randomUUID()}`,
    onWritten?: () => void,
  ): Promise<GjcWorkerResponsePayload> {
    const child = this.child;
    if (!child) return Promise.reject(new Error(SAFE_FAILURE));
    const request: GjcWorkerRequestFrame = {
      protocolVersion: GJC_WORKER_PROTOCOL_VERSION,
      kind: 'request',
      id,
      method,
      ...(sessionId ? { sessionId } : {}),
      payload,
    } as GjcWorkerRequestFrame;
    let frame: string;
    try {
      frame = serializeGjcWorkerFrame(request);
    } catch (error) {
      return Promise.reject(error);
    }
    const tracked = this.tracker.track(request);
    this.activityChanged();
    try {
      child.stdin.write(frame);
      onWritten?.();
    } catch {
      void this.workerFailed(child);
    }
    if (timeout === null) return tracked;
    return new Promise<GjcWorkerResponsePayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.tracker.reject(
          request.id,
          new Error(REQUEST_TIMEOUT),
        )) {
          // The bounded late-response correlation cache is not a lifetime proof.
          // Even a late OAuth/goal reply cannot account for its SDK continuations.
          this.requestTimeoutUncertainty = true;
          this.expiredRequests.set(request.id, {
            method: request.method,
            ...('sessionId' in request ? { sessionId: request.sessionId } : {}),
          });
          if (this.expiredRequests.size > 256) {
            const oldest = this.expiredRequests.keys().next().value;
            if (oldest) this.expiredRequests.delete(oldest);
          }
          this.activityChanged();
        }
      }, timeout);
      timer.unref?.();
      tracked.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private onStdout(child: Child, chunk: Buffer): void {
    if (child !== this.child) return;
    try {
      for (const frame of this.decoder?.push(chunk) ?? []) {
        // A fatal response can retire this generation midway through a batch.
        // Its remaining frames must not publish terminals or satisfy requests.
        if (child !== this.child) break;
        if (frame.kind === 'response') this.handleResponse(frame);
        else if (frame.kind === 'event') this.handleEvent(frame);
        else throw new GjcWorkerProtocolError('unexpected_request', 'Worker emitted a request frame.');
      }
    } catch { this.workerFailed(child); }
  }

  private handleResponse(response: GjcWorkerResponseFrame): void {
    if (!response.payload.ok && response.payload.error.code === GJC_CLEANUP_UNCONFIRMED_CODE) {
      const child = this.child;
      if (child) {
        for (const run of this.runs.values()) run.cleanupUnconfirmed = true;
        this.activityChanged();
        // Fence synchronously, before settling the request and its startRun
        // continuation. workerFailed owns every terminal after verified reap.
        void this.workerFailed(child);
      }
      return;
    }
    const expired = this.expiredRequests.get(response.id);
    if (!expired) {
      this.tracker.settle(response);
      this.activityChanged();
      return;
    }

    const responseSession = 'sessionId' in response ? response.sessionId : undefined;
    if (expired.method !== response.method || expired.sessionId !== responseSession) {
      throw new GjcWorkerProtocolError(
        'mismatched_response',
        'Late response does not match its expired request.',
      );
    }
    this.expiredRequests.delete(response.id);
    this.activityChanged();
  }

  private handleEvent(event: GjcWorkerEventFrame): void {
    if (
      event.method === 'oauth.phase'
      || event.method === 'oauth.providers.updated'
      || event.method === 'provider.auth.updated'
    ) {
      this.emitOAuthEvent({ method: event.method, payload: event.payload });
      return;
    }
    const payload = object(event.payload);
    const runId = safeId(payload?.runId);
    const run = runId ? this.runs.get(runId) : undefined;
    const scope = 'sessionId' in event ? event.sessionId : undefined;
    if (!run || scope !== run.appScope) return;
    this.activityChanged();

    if (event.method === 'worker.status') {
      const processId = payload?.processId;
      if (processId === null) {
        // A status message dropping a PID is not OS termination proof. Do not
        // forget a process the existing reap path can no longer verify.
        if (run.processId) this.runProcessProofMissing = true;
        run.processId = undefined;
        return;
      }
      if (
        typeof processId === 'number'
        && Number.isSafeInteger(processId)
        && processId > 0
        && processId <= 0x7fffffff
      ) {
        if (!this.hasRunProcessReaper || (run.processId && run.processId !== processId)) {
          this.runProcessProofMissing = true;
        }
        run.processId = processId;
      }
      return;
    }

    const message = payload?.message;
    const messageRecord = object(message);
    if (event.method === 'session.created') {
      const providerSessionId = safeId(payload?.providerSessionId);
      if (providerSessionId) {
        if (
          run.providerSessionId
          && this.aliases.get(run.providerSessionId) === run.runId
        ) {
          this.aliases.delete(run.providerSessionId);
        }
        run.providerSessionId = providerSessionId;
        this.aliases.set(providerSessionId, run.runId);
        try {
          run.writer.setSessionId?.(providerSessionId);
        } catch {
          // A disconnected writer must not break worker lifecycle handling.
        }
      }
    }

    const requestId = safeId(messageRecord?.requestId);
    if (requestId && messageRecord?.kind === 'permission_request') {
      this.approvals.set(requestId, {
        runId: run.runId,
        appScope: run.appScope,
        message,
        inFlight: false,
      });
    }
    if (requestId && messageRecord?.kind === 'permission_cancelled') {
      this.approvals.delete(requestId);
    }

    if (Object.hasOwn(event.payload, 'message')) {
      try {
        run.writer.send(message);
      } catch {
        // The run still needs deterministic terminal cleanup after disconnect.
      }
    }

    if (event.method === 'turn.failed' || event.method === 'turn.completed') {
      run.terminalForwarded = true;
      run.terminalFailed = event.method === 'turn.failed';
      this.activityChanged();
    }
  }

  /**
   * Delivers a message into a run that is still streaming.
   *
   * Resolves false when there is nothing live to steer — an unknown alias, a
   * run that never started, or a runtime without steering — which is the
   * caller's signal to queue the message rather than drop it.
   */
  async steer(alias: string, message: string): Promise<boolean> {
    const runId = this.runs.has(alias) ? alias : this.aliases.get(alias);
    const run = runId ? this.runs.get(runId) : undefined;
    // 'request_issued' is the only phase with a turn actually in flight:
    // 'registered' has not reached the worker yet and 'run_terminal' is over.
    if (!run || run.phase !== 'request_issued' || run.aborted || run.abortPromise) return false;

    const release = this.beginActivity('settling');
    try {
      const response = await this.request('turn.steer', run.appScope, {
        runId: run.runId,
        message,
      });
      if (!response.ok) return false;
      return object(response.result)?.steered === true;
    } catch {
      return false;
    } finally {
      release();
    }
  }

  abort(alias: string): Promise<GjcWorkerAbortOutcome> {
    const runId = this.runs.has(alias) ? alias : this.aliases.get(alias);
    const run = runId ? this.runs.get(runId) : undefined;
    if (!run || run.phase === 'run_terminal') return Promise.resolve('unconfirmed');
    if (run.abortPromise) return run.abortPromise.then((aborted) => aborted ? 'aborted' : 'unconfirmed');
    if (run.phase === 'registered') {
      run.aborted = true;
      this.activityChanged();
      this.finish(run, false, SAFE_FAILURE, 'not_started');
      return Promise.resolve('not_started');
    }
    const release = this.beginActivity('settling');
    const abortPromise = this.request('turn.abort', run.appScope, {
      runId: run.runId,
    }).then((response) => {
      const result = response.ok ? object(response.result) : undefined;
      if (!response.ok || result?.aborted !== true || run.phase === 'run_terminal') return false;
      run.aborted = true;
      this.activityChanged();
      return true;
    }).catch(() => false).finally(() => {
      if (run.abortPromise === abortPromise) {
        run.abortPromise = undefined;
        this.activityChanged();
      }
      release();
    });
    run.abortPromise = abortPromise;
    this.activityChanged();
    return abortPromise.then((aborted) => aborted ? 'aborted' : 'unconfirmed');
  }
  async terminate(alias: string): Promise<GjcWorkerReapOutcome> {
    const runId = this.runs.has(alias) ? alias : this.aliases.get(alias);
    const child = this.child;
    if (runId && child && this.runs.has(runId)) return this.workerFailed(child);
    const generation = this.terminatingGeneration;
    if (runId && generation?.runIds.has(runId)) return generation.outcome;
    return 'unconfirmed';
  }

  isActive(alias: string): boolean {
    const runId = this.runs.has(alias) ? alias : this.aliases.get(alias);
    return Boolean(runId && this.runs.has(runId));
  }

  active(): string[] {
    return [...this.runs.keys()];
  }

  resolveApproval(requestId: string, decision: GjcApprovalDecision): boolean {
    if (!this.child || this.terminating || this.terminationFailure) return false;
    const pending = this.approvals.get(requestId);
    const serializedDecision = safeJsonObject(decision);
    if (!pending || !serializedDecision) return false;
    if (pending.inFlight) return true;
    pending.inFlight = true;
    const release = this.beginActivity('settling');
    void this.request('ask.reply', pending.appScope, {
      runId: pending.runId,
      requestId,
      decision: serializedDecision,
    }).then((response) => {
      const result = response.ok ? object(response.result) : undefined;
      if (!response.ok || result?.accepted !== true) {
        this.restoreApproval(requestId, pending);
      }
    }).catch(() => this.restoreApproval(requestId, pending)).finally(release);
    return true;
  }

  private restoreApproval(requestId: string, pending: PendingApproval): void {
    if (this.approvals.get(requestId) !== pending) return;
    const run = this.runs.get(pending.runId);
    if (run?.cleanupUnconfirmed) return;
    if (!run || run.phase === 'run_terminal') {
      this.approvals.delete(requestId);
      this.activityChanged();
      return;
    }

    pending.inFlight = false;
    this.activityChanged();
    try {
      run.writer.send(pending.message);
    } catch {
      // Reconnect replay still exposes the restored app-owned mirror.
    }
  }

  pendingApprovals(appSessionId: string): unknown[] {
    if (!this.child || this.terminating || this.terminationFailure) return [];
    return [...this.approvals.values()]
      .filter((item) => item.appScope === appSessionId && !item.inFlight)
      .map((item) => item.message);
  }

  private finish(run: Run, failed: boolean, failureMessage = SAFE_FAILURE, outcome: GjcWorkerOutcome = run.aborted ? 'aborted' : run.phase === 'registered' ? 'not_started' : 'completed'): void {
    const release = this.beginActivity('settling');
    try {
      this.finishRun(run, failed, failureMessage, outcome);
    } finally {
      release();
    }
  }

  private finishRun(run: Run, failed: boolean, failureMessage: string, outcome: GjcWorkerOutcome): void {
    if (run.phase === 'run_terminal') return;
    if (run.cleanupUnconfirmed) {
      if (outcome !== 'reaped') return;
      // An abort response that raced the fatal fault is not proof that this
      // generation drained. Preserve only terminals verified before the fault.
      if (!run.terminalForwarded) {
        failed = true;
        run.aborted = false;
        run.runtimeAborted = false;
      }
    }
    if (run.processId && outcome !== 'reaped') this.runProcessProofMissing = true;
    run.phase = 'run_terminal';
    this.activityChanged();
    if (!run.started) run.rejectStarted(new Error(failureMessage));
    run.resolveOutcome(outcome);

    this.runs.delete(run.runId);
    if (
      run.providerSessionId
      && this.aliases.get(run.providerSessionId) === run.runId
    ) {
      this.aliases.delete(run.providerSessionId);
    }
    for (const [id, pending] of this.approvals) {
      if (pending.runId === run.runId) this.approvals.delete(id);
    }
    this.activityChanged();

    const sessionId = run.providerSessionId ?? run.appScope;
    if (failed && !run.aborted) {
      if (!run.terminalForwarded) {
        try {
          run.writer.send(createNormalizedMessage({
            kind: 'error',
            content: failureMessage,
            provider: 'gjc',
            sessionId,
          }));
          run.writer.send(createCompleteMessage({
            provider: 'gjc',
            sessionId,
            actualSessionId: sessionId,
            exitCode: 1,
          }));
        } catch {
          // Notification and promise settlement remain authoritative.
        }
      }
      if (run.options.notificationOwner !== 'terminal-adapter') {
        this.invokeAppCallback('GJC failure notification failed.', () => this.runtime.notifyRunFailed({
          userId: run.writer.userId ?? null,
          provider: 'gjc',
          sessionId,
          sessionName: run.options.sessionSummary ?? null,
          error: failureMessage,
        }));
      }
      run.reject(new Error(failureMessage));
      return;
    }

    if ((!run.aborted || run.runtimeAborted) && !run.terminalForwarded) {
      try {
        run.writer.send({ ...createCompleteMessage({
          provider: 'gjc',
          sessionId,
          actualSessionId: sessionId,
          exitCode: 0,
        }), ...(run.runtimeAborted ? { aborted: true } : {}) });
      } catch {
        // Notification and promise settlement remain authoritative.
      }
    }
    if (run.options.notificationOwner !== 'terminal-adapter') {
      this.invokeAppCallback('GJC stop notification failed.', () => this.runtime.notifyRunStopped({
        userId: run.writer.userId ?? null,
        provider: 'gjc',
        sessionId,
        sessionName: run.options.sessionSummary ?? null,
        stopReason: run.aborted ? 'aborted' : 'completed',
      }));
    }
    run.resolve();
  }

  private workerFailed(child: Child, guardedProcessExited = false): Promise<GjcWorkerReapOutcome> {
    const existingGeneration = this.terminatingGeneration;
    if (existingGeneration?.child === child) return existingGeneration.outcome;
    if (child !== this.child) return Promise.resolve('unconfirmed');
    // Retain ownership BEFORE clearing child or calling an injected terminator;
    // callbacks may read the owner synchronously inside killTree().
    const release = this.beginActivity('settling');
    this.reapingWorkers.add(child);
    this.child = undefined;
    this.ready = false;
    this.starting = undefined;
    this.decoder = undefined;
    this.activityChanged();

    const usesWindowsJobGuard = this.runtime.platform === 'win32';
    const affectedRuns = [...this.runs.values()];
    const terminations: Promise<void>[] = [];
    const terminate = (label: string, action: () => void | Promise<void>): void => {
      try {
        terminations.push(Promise.resolve(action()).catch((error) => {
          this.diagnose(label);
          throw error;
        }));
      } catch (error) {
        this.diagnose(label);
        terminations.push(Promise.reject(error));
      }
    };
    // On frozen v2 Windows, tree reaping is deliberately unverified and fails closed.
    // `guardedProcessExited` cannot establish descendant termination without a tested runtime.
    void guardedProcessExited;
    terminate('GJC worker tree termination failed.', () => this.runtime.killTree(child));
    if (!usesWindowsJobGuard) {
      for (const run of affectedRuns) {
        if (run.processId) terminate('GJC run tree termination failed.', () => this.runtime.killProcessTree(run.processId!));
      }
    }
    const termination = Promise.all(terminations).then(() => {}).catch((error) => {
      this.terminationFailure = new Error(SAFE_FAILURE, { cause: error });
      this.activityChanged();
      throw this.terminationFailure;
    });
    this.terminating = termination;
    const outcome = termination.then(
      () => {
        // Only this existing successful OS tree-reap barrier can clear the
        // generation's runtime/timeout uncertainty, never failAll/exit/eviction.
        // Lost/unverified separately reported PIDs remain a distinct blocker.
        this.reapingWorkers.delete(child);
        // Windows has no qualified tree-reap contract, including injected hooks.
        if (!usesWindowsJobGuard) this.unreapedWorkers.delete(child);
        // The default no-op run reaper or a discarded PID cannot prove the whole
        // tree gone. Its bounded poison latch survives without retaining every
        // otherwise-reaped Child (and its streams) across later generations.
        if (this.unreapedWorkers.size === 0 && !this.runProcessProofMissing) {
          this.requestTimeoutUncertainty = false;
        }
        this.activityChanged();
        for (const run of affectedRuns) {
          this.finish(run, run.terminalForwarded ? run.terminalFailed : true, SAFE_FAILURE, 'reaped');
        }
        return 'reaped' as const;
      },
      () => {
        this.reapingWorkers.delete(child);
        this.activityChanged();
        for (const run of affectedRuns) run.resolveOutcome('unconfirmed');
        return 'unconfirmed' as const;
      },
    ).finally(release);
    this.terminatingGeneration = {
      child,
      runIds: new Set(affectedRuns.map((run) => run.runId)),
      outcome,
    };
    this.activityChanged();
    void termination.finally(() => {
      if (this.terminating === termination) {
        this.terminating = undefined;
        this.activityChanged();
      }
    }).catch(() => {});

    this.tracker.failAll(new Error(SAFE_FAILURE));
    this.expiredRequests.clear();
    this.activityChanged();
    return outcome;
  }

  private async awaitTermination(): Promise<void> {
    const termination = this.terminating;
    if (termination) await termination;
    if (this.terminationFailure) throw this.terminationFailure;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.activityChanged();
    this.shutdownPromise = this.stopWorker();
    return this.shutdownPromise;
  }

  private async stopWorker(): Promise<void> {
    const release = this.beginActivity('settling');
    try {
      await this.stopWorkerAndReap();
    } finally {
      release();
    }
  }

  private async stopWorkerAndReap(): Promise<void> {
    const child = this.child;
    if (!child) {
      await this.awaitTermination();
      return;
    }
    for (const run of this.runs.values()) run.aborted = true;
    this.activityChanged();
    try {
      await this.request(
        'worker.shutdown',
        undefined,
        {},
        this.runtime.shutdownTimeoutMs,
      );
    } catch {
      // Tree termination below remains the shutdown fallback.
    }
    if (child === this.child) await this.workerFailed(child);
    await this.awaitTermination();
  }
}

const WORKER_LOG_MAX_BYTES = 4 * 1024 * 1024;
const workerLogPath = join(homedir(), '.gajae-app', 'logs', 'gjc-worker.log');

/**
 * Persists worker diagnostics (stderr and swallowed run failures) to disk.
 * Protocol responses stay sanitized, so this file is the only place an operator
 * can see why a run reported the generic "GJC worker failed." message.
 */
function appendWorkerDiagnostic(message: string): void {
  const text = message.endsWith('\n') ? message : `${message}\n`;
  try {
    mkdirSync(dirname(workerLogPath), { recursive: true });
    if ((statSync(workerLogPath, { throwIfNoEntry: false })?.size ?? 0) > WORKER_LOG_MAX_BYTES) {
      writeFileSync(workerLogPath, '');
    }
    appendFileSync(workerLogPath, `${new Date().toISOString()} ${text}`);
  } catch {
    // Diagnostics are best-effort and must never affect worker lifecycle handling.
  }
}

const INITIALIZATION_DIAGNOSTIC = /^GJC worker initialization failed/u;

/**
 * Worker stderr is file-only (it is noisy: terminal bells, SDK chatter), but a
 * worker that never initialized is an app-level event operators must be able
 * to see in the server output, not just in the log file.
 */
function reportWorkerDiagnostic(message: string): void {
  appendWorkerDiagnostic(message);
  if (INITIALIZATION_DIAGNOSTIC.test(message)) console.error(`[GJC] ${message.trimEnd()}`);
}

const supervisor = new GjcWorkerSupervisor({ enrichOptions: enrichGjcSdkRunOptions, diagnostic: reportWorkerDiagnostic });
registerGjcRuntimeModelCatalogLoader(() => supervisor.modelCatalog());

/** No lazy spawn, shutdown, admission mutation or SDK idle claim. */
export function createGjcWorkerDesktopRestartReader(worker: GjcWorkerSupervisor = supervisor): {
  getGeneration(): string;
  read(): DesktopOwnerActivity;
} {
  return Object.freeze({
    getGeneration: () => worker.getGeneration(),
    read: () => worker.snapshotActivity(),
  });
}

export function getGjcWorkerSupervisor(): GjcWorkerSupervisor { return supervisor; }
export function isGjcSessionActive(alias: string) { return supervisor.isActive(alias); }
export function resolveGjcToolApproval(requestId: string, decision: GjcApprovalDecision) { return supervisor.resolveApproval(requestId, decision); }
export function getPendingGjcApprovalsForSession(appSessionId: string) { return supervisor.pendingApprovals(appSessionId); }
export function shutdownGjcWorker() { return supervisor.shutdown(); }
export function spawnGjcRun(message: string, options: GjcWorkerOptions = {}, writer: GjcWorkerWriter): Promise<void> & { abortHandle: string } {
  const runId = `run-${randomUUID()}`;
  const appSessionId = writer.getAppSessionId?.() ?? options.sessionId ?? `gjc-${randomUUID()}`;
  const run = supervisor.spawnRun({ runId, appSessionId, message, options, writer });
  const completion = run.completion as Promise<void> & { abortHandle: string };
  completion.abortHandle = run.abortHandle;
  return completion;
}
export function abortGjcRun(runId: string) { return supervisor.abort(runId); }
/** Delivers a message into a run that is still streaming; false when there is nothing live to steer. */
export function steerGjcRun(runId: string, message: string) { return supervisor.steer(runId, message); }
