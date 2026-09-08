import { createHash, randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { parseGjcGoalCommand, type GjcGoalCommand, type GjcGoalSnapshot } from '../shared/gjc-goal.js';

import type { GjcGoalScope } from './gjc-goal-session.js';
import { GJC_INVALID_PERMISSIONS_CODE, GJC_INVALID_PERMISSIONS_MESSAGE, isGjcRunPermissionsError } from './gjc-permission-policy.js';
import {
  GJC_WORKER_PROTOCOL_VERSION,
  GjcWorkerNdjsonDecoder,
  GjcWorkerProtocolError,
  serializeGjcWorkerFrame,
  isGjcWorkerActivity,
  type GjcWorkerActivity,
  type GjcWorkerEventFrame,
  type GjcWorkerGlobalEventMethod,
  type GjcWorkerRequestFrame,
  type GjcWorkerResponseFrame,
  type JsonObject,
  type JsonValue,
} from './gjc-worker-protocol.js';
import { GJC_MODEL_UNRESOLVED_CODE, GJC_MODEL_UNRESOLVED_MESSAGE, isGjcModelResolutionError } from './gjc-model-resolution.js';
import { GJC_CLEANUP_UNCONFIRMED_CODE, GJC_CLEANUP_UNCONFIRMED_MESSAGE, isGjcCleanupUnconfirmedError } from './gjc-cleanup-error.js';

export type GjcWorkerWriter = {
  send(value: unknown): void;
  setSessionId?(sessionId: string): void;
  setCredential?(credential: { kind: 'stored'; providerId: string; credentialId: number }): void;
  setModel?(model: string): void;
  /** A runtime-owned stop (for example a goal limit) confirmed its abort. */
  setAborted?(): void;
};
type SpawnedRun = Promise<unknown> & { abortHandle?: string; processId?: number };
export type GjcWorkerOAuthEvent = {
  method: GjcWorkerGlobalEventMethod;
  payload: JsonObject;
};
export type GjcWorkerOAuthRuntime = {
  providers(): JsonObject;
  status(): JsonObject;
  start(providerId: string): JsonObject;
  submit(attemptId: string, value: string): JsonObject;
  cancel(attemptId: string): JsonObject;
  subscribe(listener: (event: GjcWorkerOAuthEvent) => void): () => void;
  close(): void;
};
export type GjcWorkerRuntime = {
  /** Pure, synchronous and complete only for accounted ownership. */
  observeActivity?(): GjcWorkerActivity;
  /** Reject new roots without aborting or suppressing accepted continuations. */
  setAdmissionFence?(closed: boolean): void;
  inspectGjcGoal?(scope: GjcGoalScope, providerSessionId: string, sessionRoot: string): Promise<GjcGoalSnapshot>;
  controlGjcGoal?(runId: string, scope: GjcGoalScope, command?: GjcGoalCommand, stopAfterMutation?: boolean): Promise<GjcGoalSnapshot>;
  spawnGjc(message: string, options: JsonObject, writer: GjcWorkerWriter): SpawnedRun;
  abortGjcSession(sessionId: string): Promise<boolean>;
  /**
   * Delivers a message into a turn that is already running. Optional: a runtime
   * that drives a CLI process has no way to reach a live turn, and the caller
   * queues the message instead of pretending it landed.
   */
  steerGjcSession?(runHandle: string, message: string): Promise<boolean>;
  resolveGjcToolApproval(requestId: string, decision: unknown): boolean;
  modelCatalog?(): Promise<JsonObject>;
  oauth?: GjcWorkerOAuthRuntime;
};
export type GjcWorkerHostOptions = {
  runtime?: () => Promise<GjcWorkerRuntime>;
  emit: (frame: GjcWorkerResponseFrame | GjcWorkerEventFrame) => void;
  closeDrainMs?: number;
  /** Private stderr-side sink for failures that protocol responses must not expose. */
  diagnostic?: (message: string) => void;
};

type Run = {
  runId: string;
  scope: string;
  active: boolean;
  abortHandle?: string;
  providerSessionId?: string;
  credential?: { kind: 'stored'; providerId: string; credentialId: number };
  model?: string;
  abortPromise?: Promise<boolean>;
  abortDeadlineExceeded: boolean;
  aborted: boolean;
  completion: Promise<void>;
  resolveCompletion: () => void;
};
const CLOSE_DRAIN_MS = 6_000;
const failure = (code: string, message: string) => ({ ok: false as const, error: { code, message } });
const success = (result?: JsonValue) => result === undefined ? { ok: true as const } : { ok: true as const, result };
const oauthErrors = new Set([
  'oauth_provider_not_found',
  'oauth_provider_unavailable',
  'oauth_attempt_active',
  'oauth_attempt_not_found',
  'oauth_attempt_not_active',
  'oauth_input_not_requested',
  'oauth_submit_too_large',
]);
function oauthFailure(error: unknown): ReturnType<typeof failure> {
  const code = error !== null
    && typeof error === 'object'
    && 'code' in error
    && typeof error.code === 'string'
    && oauthErrors.has(error.code)
    ? error.code
    : 'oauth_failed';
  return failure(code, 'OAuth request failed.');
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function json(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const items = value.map(json);
    return items.every((item) => item !== undefined) ? items as JsonValue[] : undefined;
  }
  if (object(value)) {
    const copy: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      const safe = json(child);
      if (safe !== undefined) copy[key] = safe;
    }
    return copy;
  }
  return undefined;
}
function payload(request: GjcWorkerRequestFrame, fields: readonly string[]): Record<string, unknown> | null {
  const source = request.payload as Record<string, unknown>;
  return Object.keys(source).every((key) => fields.includes(key)) ? source : null;
}
function options(value: unknown): JsonObject | null {
  return object(value) && json(value) !== undefined ? value as JsonObject : null;
}
function awaitDrain(completions: Promise<void>[], timeoutMs: number): Promise<void> {
  if (completions.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    void Promise.all(completions).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
function awaitAbort(promise: Promise<boolean>, timeoutMs: number): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    void promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(false); },
    );
  });
}

/** Isolated Protocol v1 host; its only output is supplied through emit. */
export class GjcWorkerHost {
  #cleanupUnconfirmed = false;

  #poisonOnCleanupFailure(error: unknown): void {
    if (!isGjcCleanupUnconfirmedError(error) || this.#cleanupUnconfirmed) return;
    this.#cleanupUnconfirmed = true;
    this.#closed = true;
    // Signal the fatal response without waiting for graceful shutdown. Only
    // the supervising process can establish that this generation was reaped.
    void Promise.resolve().then(() => this.close()).catch(() => {});
  }
  readonly #emit: GjcWorkerHostOptions['emit'];
  readonly #diagnostic: (message: string) => void;
  readonly #loadRuntime: NonNullable<GjcWorkerHostOptions['runtime']>;
  #runtime: GjcWorkerRuntime | undefined;
  #initializing = false;
  #initializationAttempted = false;
  #initialized = false;
  #closed = false;
  #fenceId: string | null = null;
  #operations = 0;
  #revision = 0;
  readonly #generation = randomUUID();
  #runs = new Map<string, Run>();
  #closePromise: Promise<void> | undefined;
  #oauthUnsubscribe: (() => void) | undefined;
  readonly #closeDrainMs: number;

  constructor(options: GjcWorkerHostOptions) {
    this.#emit = options.emit;
    this.#diagnostic = options.diagnostic ?? (() => {});
    this.#loadRuntime = options.runtime ?? loadProductionRuntime;
    this.#closeDrainMs = options.closeDrainMs ?? CLOSE_DRAIN_MS;
  }

  /**
   * Reports a swallowed runtime failure on the private diagnostics channel.
   * Protocol responses stay sanitized; without this the app can only ever see
   * "GJC run failed." and no operator can tell why a run died.
   */
  #diagnose(label: string, error: unknown): void {
    try {
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      this.#diagnostic(`${label}: ${detail}`);
    } catch {
      // Diagnostics must never interfere with run lifecycle handling.
    }
  }

  async handle(request: GjcWorkerRequestFrame): Promise<void> {
    if (this.#cleanupUnconfirmed) return this.#response(request, failure(GJC_CLEANUP_UNCONFIRMED_CODE, GJC_CLEANUP_UNCONFIRMED_MESSAGE));
    if (this.#closed) return this.#response(request, failure('worker_closed', 'Worker is no longer accepting requests.'));
    // Observation and admission controls are not work and must not invalidate
    // their own snapshot or enter the host's operation counter.
    if (request.method === 'worker.activity') return this.#observe(request);
    if (request.method === 'worker.admission') return this.#admission(request);
    if (this.#fenceId && ['worker.initialize', 'session.start', 'session.resume', 'turn.start', 'models.catalog', 'goal.inspect', 'oauth.start', 'oauth.providers', 'oauth.status'].includes(request.method)) {
      return this.#response(request, failure('worker_admission_fenced', 'Worker admission is fenced.'));
    }
    this.#operations += 1;
    this.#revision += 1;
    try { await this.#dispatch(request); }
    finally { this.#operations -= 1; this.#revision += 1; }
  }

  async #dispatch(request: GjcWorkerRequestFrame): Promise<void> {
    if (request.method === 'worker.initialize') return this.#initialize(request);
    if (!this.#initialized) return this.#response(request, failure('not_initialized', 'Worker must be initialized before use.'));
    switch (request.method) {
      case 'session.start': case 'session.resume': case 'turn.start': return this.#start(request);
      case 'turn.abort': return this.#abort(request);
      case 'turn.steer': return this.#steer(request);
      case 'goal.inspect': case 'goal.control': return this.#goal(request);
      case 'ask.reply': return this.#reply(request);
      case 'models.catalog': return this.#modelCatalog(request);
      case 'oauth.providers': return this.#oauthProviders(request);
      case 'oauth.status': return this.#oauthStatus(request);
      case 'oauth.start': return this.#oauthStart(request);
      case 'oauth.submit': return this.#oauthSubmit(request);
      case 'oauth.cancel': return this.#oauthCancel(request);
      case 'worker.shutdown': return this.#shutdown(request);
    }
  }

  #admission(request: Extract<GjcWorkerRequestFrame, { method: 'worker.admission' }>): void {
    const input = payload(request, ['fenceId', 'closed']);
    if (!input || typeof input.fenceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.fenceId)
      || typeof input.closed !== 'boolean') return this.#response(request, failure('invalid_payload', 'Admission request is invalid.'));
    if (!this.#initialized || !this.#runtime?.setAdmissionFence) {
      return this.#response(request, failure('worker_admission_unavailable', 'Worker admission is unavailable.'));
    }
    if (this.#fenceId !== null && this.#fenceId !== input.fenceId) {
      return this.#response(request, failure('worker_admission_conflict', 'Worker admission belongs to another fence.'));
    }
    const next = input.closed ? input.fenceId : null;
    if (next !== this.#fenceId) {
      try { this.#runtime.setAdmissionFence(input.closed); }
      catch { return this.#response(request, failure('worker_admission_unavailable', 'Worker admission is unavailable.')); }
      this.#fenceId = next;
      this.#revision += 1;
    }
    this.#response(request, success({ fenceId: this.#fenceId }));
  }

  #observe(request: Extract<GjcWorkerRequestFrame, { method: 'worker.activity' }>): void {
    if (!payload(request, [])) return this.#response(request, failure('invalid_payload', 'Activity request is invalid.'));
    let runtime: GjcWorkerActivity | undefined;
    try {
      const observed = this.#runtime?.observeActivity?.();
      if (isGjcWorkerActivity(observed)) runtime = observed;
    } catch { /* Missing or invalid runtime evidence remains unknown. */ }
    const unknown = [...new Set([
      ...(!this.#initialized ? ['worker_not_initialized'] : []),
      ...(!runtime ? ['worker_runtime_unaccounted'] : runtime.unknown),
      ...(!this.#fenceId ? ['worker_admission_open'] : []),
    ])].slice(0, 32);
    this.#response(request, success({
      // Bind BOTH ownership layers, including SDK-internal idle/busy/idle
      // cycles that emit no worker events. Hashing the tuple is pure and
      // bounded; taking an observation never increments either revision.
      generation: createHash('sha256').update(JSON.stringify([
        this.#generation, this.#revision, runtime?.generation ?? null,
      ])).digest('hex'),
      fenceId: this.#fenceId,
      complete: Boolean(runtime?.complete) && unknown.length === 0,
      starting: Number(this.#initializing) + (runtime?.starting ?? 0),
      queued: runtime?.queued ?? 0,
      running: this.#runs.size + (runtime?.running ?? 0),
      settling: this.#operations + (runtime?.settling ?? 0),
      approvals: runtime?.approvals ?? 0,
      retained: runtime?.retained ?? 0,
      unknown,
    }));
  }

  /** Idempotently rejects new work, aborts every run, and allows their children to settle. */
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#oauthUnsubscribe?.();
    this.#oauthUnsubscribe = undefined;
    this.#runtime?.oauth?.close();
    const runs = [...this.#runs.values()];
    const aborts = runs.map(async (run) => {
      try {
        await this.#runtime?.abortGjcSession(
          run.abortHandle ?? run.providerSessionId ?? run.runId,
        );
      } catch {
        // The bounded drain still waits for runtime completion or escalation.
      }
    });
    this.#closePromise = awaitDrain(
      [...aborts, ...runs.map((run) => run.completion)],
      this.#closeDrainMs,
    );
    return this.#closePromise;
  }

  #response(request: GjcWorkerRequestFrame, response: ReturnType<typeof success> | ReturnType<typeof failure>): void {
    if (this.#cleanupUnconfirmed) response = failure(GJC_CLEANUP_UNCONFIRMED_CODE, GJC_CLEANUP_UNCONFIRMED_MESSAGE);
    this.#emit({ protocolVersion: GJC_WORKER_PROTOCOL_VERSION, kind: 'response', id: request.id, method: request.method, payload: response, ...('sessionId' in request ? { sessionId: request.sessionId } : {}) } as GjcWorkerResponseFrame);
  }
  #event(run: Run, method: Exclude<GjcWorkerEventFrame['method'], GjcWorkerGlobalEventMethod>, eventPayload: JsonObject): void {
    if (this.#cleanupUnconfirmed || !run.active || this.#runs.get(run.runId) !== run) return;
    this.#emit({ protocolVersion: GJC_WORKER_PROTOCOL_VERSION, kind: 'event', id: `event-${randomUUID()}`, method, sessionId: run.scope, payload: { runId: run.runId, ...eventPayload } });
  }
  #oauthEvent(event: GjcWorkerOAuthEvent): void {
    if (this.#closed) return;
    this.#emit({
      protocolVersion: GJC_WORKER_PROTOCOL_VERSION,
      kind: 'event',
      id: `event-${randomUUID()}`,
      method: event.method,
      payload: event.payload,
    });
  }
  async #initialize(request: GjcWorkerRequestFrame): Promise<void> {
    if (this.#initializationAttempted || this.#initializing) return this.#response(request, failure('already_initialized', 'Worker has already been initialized.'));
    if (!payload(request, [])) return this.#response(request, failure('invalid_payload', 'Request payload is invalid.'));
    this.#initializationAttempted = true;
    this.#initializing = true;
    try {
      this.#runtime = await this.#loadRuntime();
      this.#oauthUnsubscribe = this.#runtime.oauth?.subscribe((event) => this.#oauthEvent(event));
      this.#initialized = true;
      this.#response(request, success());
    } catch (error) {
      this.#diagnose('worker initialization failed', error);
      this.#response(request, failure('initialization_failed', 'Worker initialization failed.'));
    } finally {
      this.#initializing = false;
    }
  }
  #oauthRuntime(): GjcWorkerOAuthRuntime | undefined {
    return this.#runtime?.oauth;
  }
  async #modelCatalog(request: GjcWorkerRequestFrame): Promise<void> {
    if (!payload(request, [])) return this.#response(request, failure('invalid_payload', 'Request payload is invalid.'));
    const runtime = this.#runtime;
    if (!runtime?.modelCatalog) return this.#response(request, failure('model_catalog_unavailable', 'Model catalog is not available in this worker.'));
    try {
      this.#response(request, success(await runtime.modelCatalog()));
    } catch (error) {
      this.#poisonOnCleanupFailure(error);
      this.#diagnose('model catalog failed', error);
      this.#response(request, failure('model_catalog_failed', 'Model catalog is unavailable.'));
    }
  }
  async #oauthProviders(request: GjcWorkerRequestFrame): Promise<void> {
    if (!payload(request, [])) return this.#response(request, failure('invalid_payload', 'Request payload is invalid.'));
    const oauth = this.#oauthRuntime();
    if (!oauth) return this.#response(request, failure('oauth_unavailable', 'OAuth is not available in this worker.'));
    try {
      this.#response(request, success(await oauth.providers()));
    } catch (error) {
      this.#response(request, oauthFailure(error));
    }
  }
  async #oauthStatus(request: GjcWorkerRequestFrame): Promise<void> {
    if (!payload(request, [])) return this.#response(request, failure('invalid_payload', 'Request payload is invalid.'));
    const oauth = this.#oauthRuntime();
    if (!oauth) return this.#response(request, failure('oauth_unavailable', 'OAuth is not available in this worker.'));
    try {
      this.#response(request, success(await oauth.status()));
    } catch (error) {
      this.#response(request, oauthFailure(error));
    }
  }
  async #oauthStart(request: GjcWorkerRequestFrame): Promise<void> {
    const input = payload(request, ['providerId']);
    if (!input || typeof input.providerId !== 'string' || !input.providerId || input.providerId.length > 256) {
      return this.#response(request, failure('invalid_payload', 'Request payload is invalid.'));
    }
    const oauth = this.#oauthRuntime();
    if (!oauth) return this.#response(request, failure('oauth_unavailable', 'OAuth is not available in this worker.'));
    try {
      this.#response(request, success(await oauth.start(input.providerId)));
    } catch (error) {
      this.#response(request, oauthFailure(error));
    }
  }
  async #oauthSubmit(request: GjcWorkerRequestFrame): Promise<void> {
    const input = payload(request, ['attemptId', 'value']);
    if (
      !input
      || typeof input.attemptId !== 'string'
      || !input.attemptId
      || input.attemptId.length > 256
      || typeof input.value !== 'string'
    ) {
      return this.#response(request, failure('invalid_payload', 'Request payload is invalid.'));
    }
    try {
      const oauth = this.#oauthRuntime();
      if (!oauth) {
        this.#response(request, failure('oauth_unavailable', 'OAuth is not available in this worker.'));
      } else {
        this.#response(request, success(await oauth.submit(input.attemptId, input.value)));
      }
    } catch (error) {
      this.#response(request, oauthFailure(error));
    } finally {
      input.value = '';
    }
  }
  async #oauthCancel(request: GjcWorkerRequestFrame): Promise<void> {
    const input = payload(request, ['attemptId']);
    if (!input || typeof input.attemptId !== 'string' || !input.attemptId || input.attemptId.length > 256) {
      return this.#response(request, failure('invalid_payload', 'Request payload is invalid.'));
    }
    const oauth = this.#oauthRuntime();
    if (!oauth) return this.#response(request, failure('oauth_unavailable', 'OAuth is not available in this worker.'));
    try {
      this.#response(request, success(await oauth.cancel(input.attemptId)));
    } catch (error) {
      this.#response(request, oauthFailure(error));
    }
  }
  async #start(request: Extract<GjcWorkerRequestFrame, { sessionId: string }>): Promise<void> {
    const fields = request.method === 'session.resume' ? ['message', 'options', 'providerSessionId'] : ['message', 'options'];
    const input = payload(request, fields);
    if (!input || typeof input.message !== 'string' || options(input.options) === null || (request.method === 'session.resume' && (typeof input.providerSessionId !== 'string' || !input.providerSessionId))) return this.#response(request, failure('invalid_payload', 'Request payload is invalid.'));
    if (this.#runs.has(request.id)) return this.#response(request, failure('duplicate_run_id', 'A run with this id is already active.'));
    let resolveCompletion!: () => void;
    const run: Run = { runId: request.id, scope: request.sessionId, active: true, aborted: false, abortDeadlineExceeded: false, completion: new Promise((resolve) => { resolveCompletion = resolve; }), resolveCompletion, ...(typeof input.providerSessionId === 'string' ? { providerSessionId: input.providerSessionId } : {}) };
    this.#runs.set(run.runId, run);
    const writer: GjcWorkerWriter = {
      send: (message) => this.#normalized(run, message),
      setSessionId: (providerSessionId) => this.#captureSession(run, providerSessionId),
      setCredential: (credential) => { if (!this.#cleanupUnconfirmed && run.active) run.credential = credential; },
      setModel: (model) => { if (!this.#cleanupUnconfirmed && run.active) run.model = model; },
      setAborted: () => { if (!this.#cleanupUnconfirmed && run.active) run.aborted = true; },
    };
    let completed = false;
    let invalidPermissions = false;
    let modelUnresolved = false;
    try {
      const spawned = this.#runtime!.spawnGjc(input.message, {
        ...options(input.options)!,
        runHandle: run.runId,
        appSessionId: run.scope,
        ...(run.providerSessionId ? { sessionId: run.providerSessionId } : {}),
      }, writer);
      run.abortHandle = spawned.abortHandle;
      const processId = spawned.processId;
      if (typeof processId === 'number' && Number.isSafeInteger(processId) && processId > 0) {
        this.#event(run, 'worker.status', { processId });
      }
      await spawned;
      completed = true;
    } catch (error) {
      // Keep the safe default failure response; report the cause on stderr only.
      // Two exceptions carry a fixed code: a malformed permissions block (the
      // app sent it) and a model the run cannot pair with a credential (the
      // app's model selection or the runtime's default role did it).
      invalidPermissions = isGjcRunPermissionsError(error);
      modelUnresolved = isGjcModelResolutionError(error);
      this.#poisonOnCleanupFailure(error);
      this.#diagnose(`run ${run.runId} failed`, error);
    } finally {
      await this.#settleStart(request, run, { completed, invalidPermissions, modelUnresolved });
    }
  }

  async #settleStart(
    request: Extract<GjcWorkerRequestFrame, { sessionId: string }>,
    run: Run,
    status: { completed: boolean; invalidPermissions: boolean; modelUnresolved: boolean },
  ): Promise<void> {
    let { completed } = status;
    const { invalidPermissions, modelUnresolved } = status;
    if (this.#cleanupUnconfirmed) {
      this.#response(request, failure(GJC_CLEANUP_UNCONFIRMED_CODE, GJC_CLEANUP_UNCONFIRMED_MESSAGE));
      return;
    }
    if (run.abortPromise) {
      const aborted = await awaitAbort(run.abortPromise, this.#closeDrainMs);
      if (aborted === undefined || run.abortDeadlineExceeded) {
        run.abortDeadlineExceeded = true;
        completed = false;
      } else {
        // A rejected abort (false) leaves the run active per the live spec;
        // the spawned run outcome alone governs `completed`.
        run.aborted = run.aborted || aborted;
      }
    }
    const result: JsonObject = {
      runId: run.runId,
      ...(run.providerSessionId ? { providerSessionId: run.providerSessionId } : {}),
      ...(run.credential ? { credential: run.credential } : {}),
      ...(run.model ? { model: run.model } : {}),
      ...(run.aborted ? { aborted: true } : {}),
    };
    // A sibling may poison the worker while this run awaits an abort.
    if (this.#cleanupUnconfirmed) {
      this.#response(request, failure(GJC_CLEANUP_UNCONFIRMED_CODE, GJC_CLEANUP_UNCONFIRMED_MESSAGE));
      return;
    }
    this.#event(run, 'worker.status', { processId: null });
    const failed = invalidPermissions
      ? failure(GJC_INVALID_PERMISSIONS_CODE, GJC_INVALID_PERMISSIONS_MESSAGE)
      : modelUnresolved
        ? failure(GJC_MODEL_UNRESOLVED_CODE, GJC_MODEL_UNRESOLVED_MESSAGE)
        : failure('run_failed', 'GJC run failed.');
    this.#response(request, completed ? success(result) : failed);
    run.active = false;
    if (this.#runs.get(run.runId) === run) this.#runs.delete(run.runId);
    run.resolveCompletion();
  }
  #captureSession(run: Run, providerSessionId: string): void {
    if (this.#cleanupUnconfirmed || !run.active || !providerSessionId || run.providerSessionId === providerSessionId) return;
    run.providerSessionId = providerSessionId;
    this.#event(run, 'session.created', { providerSessionId });
  }
  #normalized(run: Run, value: unknown): void {
    const message = json(value);
    if (!message || !object(message)) return;
    if (message.kind === 'session_created') {
      const providerSessionId = typeof message.newSessionId === 'string' ? message.newSessionId : typeof message.sessionId === 'string' ? message.sessionId : '';
      if (providerSessionId) this.#captureSession(run, providerSessionId);
      return;
    }
    let method: Exclude<GjcWorkerEventFrame['method'], 'worker.status' | GjcWorkerGlobalEventMethod> = 'message.completed';
    if (message.kind === 'stream_delta') method = 'message.delta';
    else if (message.kind === 'tool_use') method = 'tool.started';
    else if (message.kind === 'tool_result') method = 'tool.completed';
    else if (message.kind === 'permission_request' || message.kind === 'permission_cancelled') method = 'ask.presented';
    else if (message.kind === 'status' && message.text === 'token_budget') method = 'usage.updated';
    // Session facts (model, reasoning level, cwd, context window) ride the same
    // usage channel: they update at the same moment and the client handler
    // already subscribes to it.
    else if (message.kind === 'status' && message.text === 'session_state') method = 'usage.updated';
    else if (message.kind === 'complete') method = message.exitCode === 0 ? 'turn.completed' : 'turn.failed';
    this.#event(run, method, { message });
  }
  /**
   * Hands a message to a turn that is still running.
   *
   * Scoped exactly like an abort: only the session that owns the run may reach
   * it. A runtime without steering, or a run whose turn has already settled,
   * answers `steered: false` so the caller can queue the message instead of
   * losing it.
   */
  async #goal(request: Extract<GjcWorkerRequestFrame, { sessionId: string }>): Promise<void> {
    const input = payload(request, ['owner', 'cwd', 'projectPath', 'providerSessionId', 'sessionRoot', 'runId', 'command', 'stopAfterMutation']);
    if (!input || typeof input.owner !== 'string' || !input.owner || typeof input.cwd !== 'string' || !input.cwd) return this.#response(request, failure('invalid_payload', 'Invalid goal scope.'));
    if (input.projectPath !== undefined && (typeof input.projectPath !== 'string' || !input.projectPath)) return this.#response(request, failure('invalid_payload', 'Invalid goal project.'));
    if (input.stopAfterMutation !== undefined && typeof input.stopAfterMutation !== 'boolean') return this.#response(request, failure('invalid_payload', 'Invalid goal stop policy.'));
    const scope = { appSessionId: request.sessionId, owner: input.owner, cwd: input.cwd, ...(typeof input.projectPath === 'string' ? { projectPath: input.projectPath } : {}) };
    try {
      let result: GjcGoalSnapshot;
      if (request.method === 'goal.inspect') {
        if (typeof input.providerSessionId !== 'string' || !input.providerSessionId || typeof input.sessionRoot !== 'string' || !input.sessionRoot
          || input.runId !== undefined || input.command !== undefined || input.stopAfterMutation !== undefined || !this.#runtime?.inspectGjcGoal) throw new Error('Goal inspection is unavailable.');
        if ([...this.#runs.values()].some((run) => run.scope === request.sessionId)) throw new Error('The session has an active run.');
        result = await this.#runtime.inspectGjcGoal(scope, input.providerSessionId, input.sessionRoot);
      } else {
        const run = typeof input.runId === 'string' ? this.#runs.get(input.runId) : undefined;
        if (!run || run.scope !== request.sessionId || !this.#runtime?.controlGjcGoal
          || input.providerSessionId !== undefined || input.sessionRoot !== undefined) throw new Error('No active run exists for this goal control.');
        const command = input.command === undefined ? undefined : parseGjcGoalCommand(input.command);
        result = await this.#runtime.controlGjcGoal(run.abortHandle ?? run.runId, scope, command, input.stopAfterMutation !== false);
      }
      return this.#response(request, success(json(result)));
    } catch (error) {
      this.#poisonOnCleanupFailure(error);
      return this.#response(request, failure('goal_control_failed', error instanceof Error ? error.message : 'Goal operation failed.'));
    }
  }

  async #steer(request: Extract<GjcWorkerRequestFrame, { sessionId: string }>): Promise<void> {
    const input = payload(request, ['runId', 'message']);
    if (
      !input
      || typeof input.runId !== 'string' || !input.runId
      || typeof input.message !== 'string' || !input.message.trim()
    ) {
      return this.#response(request, failure('invalid_payload', 'Request payload is invalid.'));
    }

    const run = this.#runs.get(input.runId);
    if (!run || run.scope !== request.sessionId) {
      return this.#response(request, failure('run_not_found', 'No active run exists for this id.'));
    }

    const steer = this.#runtime?.steerGjcSession;
    if (!steer) {
      return this.#response(request, success({ runId: run.runId, steered: false }));
    }

    try {
      const steered = await steer.call(this.#runtime, run.abortHandle ?? run.providerSessionId ?? run.runId, input.message);
      this.#response(request, success({ runId: run.runId, steered }));
    } catch (error) {
      this.#poisonOnCleanupFailure(error);
      this.#diagnose(`run ${run.runId} steer failed`, error);
      this.#response(request, failure('steer_failed', 'Unable to steer the run.'));
    }
  }

  async #abort(request: Extract<GjcWorkerRequestFrame, { sessionId: string }>): Promise<void> {
    const input = payload(request, ['runId']);
    if (!input || typeof input.runId !== 'string' || !input.runId) return this.#response(request, failure('invalid_payload', 'Request payload is invalid.'));
    const run = this.#runs.get(input.runId);
    if (!run || run.scope !== request.sessionId) {
      return this.#response(request, failure('run_not_found', 'No active run exists for this id.'));
    }
    try {
      run.abortPromise ??= this.#runtime!.abortGjcSession(
        run.abortHandle ?? run.providerSessionId ?? run.runId,
      ).catch((error) => { this.#poisonOnCleanupFailure(error); throw error; });
      const aborted = await awaitAbort(run.abortPromise, this.#closeDrainMs);
      if (aborted === undefined || run.abortDeadlineExceeded) {
        run.abortDeadlineExceeded = true;
        this.#response(request, failure('abort_failed', 'Unable to abort the run.'));
      } else {
        // A refused abort (the runtime had nothing to stop, or its abort threw)
        // is not the run's final word: the next Stop must ask again rather than
        // replay this answer for the rest of the run.
        if (!aborted) run.abortPromise = undefined;
        run.aborted = aborted;
        this.#response(request, success({ runId: run.runId, aborted }));
      }
    } catch (error) {
      this.#poisonOnCleanupFailure(error);
      run.abortPromise = undefined;
      this.#response(request, failure('abort_failed', 'Unable to abort the run.'));
    }
  }
  async #reply(request: Extract<GjcWorkerRequestFrame, { sessionId: string }>): Promise<void> {
    const input = payload(request, ['runId', 'requestId', 'decision']);
    const run = typeof input?.runId === 'string' ? this.#runs.get(input.runId) : undefined;
    if (
      !input
      || !run
      || run.scope !== request.sessionId
      || typeof input.requestId !== 'string'
      || !input.requestId
      || json(input.decision) === undefined
    ) {
      return this.#response(request, failure('invalid_payload', 'Request payload is invalid.'));
    }
    try {
      this.#response(request, success({
        runId: run.runId,
        accepted: this.#runtime!.resolveGjcToolApproval(input.requestId, input.decision),
      }));
    } catch (error) {
      this.#poisonOnCleanupFailure(error);
      this.#response(request, failure('reply_failed', 'Unable to submit the reply.'));
    }
  }
  async #shutdown(request: GjcWorkerRequestFrame): Promise<void> {
    if (!payload(request, [])) return this.#response(request, failure('invalid_payload', 'Request payload is invalid.'));
    await this.close();
    this.#response(request, success());
  }
}

export function createGjcWorkerHost(options: GjcWorkerHostOptions): GjcWorkerHost { return new GjcWorkerHost(options); }

async function loadProductionRuntime(): Promise<GjcWorkerRuntime> {
  // A non-literal dynamic import keeps the Node CLI/loopback implementation out of
  // the Bun worker bundle while preserving the existing Node worker behavior.
  const nodeRuntimeModule = './gjc-worker-node-runtime.js';
  const nodeRuntime = await import(nodeRuntimeModule);
  return nodeRuntime.loadNodeProductionRuntime();
}

/**
 * Claims stdout for Protocol v1 frames and returns the writer for them.
 *
 * The SDK renders for a terminal: an ask sends a notification bell, and other
 * in-process code can `console.log`. Those bytes land in the same stdout that
 * carries NDJSON frames, so the supervisor decodes a malformed frame and kills
 * the worker ("GJC worker failed"). Non-protocol writes are redirected to
 * stderr instead of being allowed to corrupt the stream.
 */
export function claimProtocolStdout(output: Writable, diagnostics: Writable, stdout: Writable = process.stdout): (frame: string) => void {
  if (output !== stdout) return (frame) => { output.write(frame); };
  const protocolWrite = stdout.write.bind(stdout);
  stdout.write = ((chunk: string | Uint8Array, encoding?: unknown, callback?: unknown): boolean => {
    const done = typeof encoding === 'function' ? encoding : callback;
    try { diagnostics.write(chunk as string | Uint8Array); } catch { /* diagnostics are best-effort */ }
    if (typeof done === 'function') (done as (error?: Error | null) => void)(null);
    return true;
  }) as typeof stdout.write;
  return (frame) => { protocolWrite(frame); };
}

/** Runs the private NDJSON executable using only stdin/stdout/stderr. */
export function runGjcWorkerEntrypoint(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
  diagnostics: Writable = process.stderr,
  options: { runtime?: () => Promise<GjcWorkerRuntime> } = {},
): void {
  const emitFrame = claimProtocolStdout(output, diagnostics);
  const decoder = new GjcWorkerNdjsonDecoder();
  let failed = false;
  const host = new GjcWorkerHost({
    emit: (frame) => { emitFrame(serializeGjcWorkerFrame(frame)); },
    diagnostic: (message) => { diagnostics.write(`${message}\n`); },
    runtime: options.runtime,
  });
  const failClosed = (): void => {
    if (failed) return;
    failed = true;
    process.exitCode = 1;
    diagnostics.write('GJC worker protocol failure.\n');
    input.pause();
    void host.close()
      .catch(() => {})
      .finally(() => input.destroy());
  };
  const dispatch = (frame: GjcWorkerRequestFrame): void => { void host.handle(frame).catch(failClosed); };
  input.on('data', (chunk: Buffer) => {
    if (failed) return;
    try { for (const frame of decoder.push(chunk)) { if (frame.kind !== 'request') throw new GjcWorkerProtocolError('invalid_direction', 'Worker accepts requests only.'); dispatch(frame); } }
    catch { failClosed(); }
  });
  input.on('end', () => {
    if (failed) return;
    try {
      decoder.finish();
      void host.close().catch(failClosed);
    } catch {
      failClosed();
    }
  });
  input.on('error', failClosed);
  if (input === process.stdin) {
    output.on('error', failClosed);
    process.once('uncaughtException', failClosed);
    process.once('unhandledRejection', failClosed);
    process.once('SIGINT', failClosed);
    process.once('SIGTERM', failClosed);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runGjcWorkerEntrypoint();
