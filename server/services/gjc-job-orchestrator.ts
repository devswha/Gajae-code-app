import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { createJobTerminalPayload, isJobProjectionEvent, jobTerminalEventId, type JobProjectionEvent } from '../../shared/gjc-job-projection-protocol.js';
import type { DesktopOwnerActivity } from '../../shared/desktopUpdateProtocol.js';
import { getGjcWorkerSupervisor, type GjcWorkerAbortOutcome, type GjcWorkerOptions, type GjcWorkerOutcome, type GjcWorkerReapOutcome, type GjcWorkerRun, type GjcWorkerSpawnRun, type GjcWorkerWriter } from '../gjc-worker-client.js';
import { getDatabasePath } from '../modules/database/connection.js';
import type { DesktopWorkAdmission } from '../shared/interfaces.js';

import { GjcGitClient } from './gjc-git-client.js';
import { createNativeJobsDesktopRestartReader, GjcJobsClient, GjcJobsClientError } from './gjc-jobs-client.js';

type Lease = { owner: string; generation: number };
type RunSnapshot = { runId: string; appSessionId?: string | null; providerSessionId?: string | null };
type JobSnapshot = { jobId: string; provider?: string; state: string; lease?: Lease | null; worktreeId?: string | null; branch?: string | null; repositoryRoot?: string | null; baseCommit?: string | null; currentRun?: RunSnapshot | null; dispatchCheckpoint?: unknown; lastSequence?: number };
type Binding = { jobId: string; state: string; providerSessionId?: string | null };
export type JobAuthority = {
  reserveStart(params: Record<string, unknown>): Promise<unknown>; turnAdmit(params: Record<string, unknown>): Promise<unknown>; prepare(params: Record<string, unknown>): Promise<unknown>; admit(params: Record<string, unknown>): Promise<unknown>; readmit(params: Record<string, unknown>): Promise<unknown>;
  transition(params: Record<string, unknown>): Promise<unknown>; markDispatching(params: Record<string, unknown>): Promise<unknown>; runFinalize(params: Record<string, unknown>): Promise<unknown>; cancelAdmission(params: Record<string, unknown>): Promise<unknown>; appendEvent(params: Record<string, unknown>): Promise<unknown>; appendAdminEvent(params: Record<string, unknown>): Promise<unknown>; get(params: Record<string, unknown>): Promise<unknown>;
  list?(params?: Record<string, unknown>): Promise<unknown>; replayEvents(params: Record<string, unknown>): Promise<unknown>;
  bindingResolve(params: Record<string, unknown>): Promise<unknown>; bindingRelease(params: Record<string, unknown>): Promise<unknown>; interruptForShutdown(): Promise<unknown>; reconcile(params?: Record<string, unknown>): Promise<unknown>; bindProviderSession(params: Record<string, unknown>): Promise<unknown>;
};
export type GitWorktrees = { create(params: Record<string, unknown>): Promise<unknown>; list(params?: Record<string, unknown>): Promise<unknown>; status(params?: Record<string, unknown>): Promise<unknown> };
export type JobSupervisor = { spawnRun(input: GjcWorkerSpawnRun): GjcWorkerRun; abort(alias: string): Promise<GjcWorkerAbortOutcome>; terminate?(alias: string): Promise<GjcWorkerReapOutcome> };
export type JobOrchestratorOptions = GjcWorkerOptions & {
  writer: GjcWorkerWriter; jobId?: string; cap?: number; dispatched?: boolean;
  signal?: AbortSignal;
  onPrepared?: (cwd: string) => Promise<void>;
  onRun?: (run: GjcWorkerRun) => void;
  retainWorkspaceOnFailure?: boolean;
};
export type JobRunHandle = { jobId: string; runId?: string; state: string; started: Promise<void>; completion: Promise<void>; abortHandle: string };
export type JobOrchestratorDependencies = { jobs: JobAuthority; git?: GitWorktrees; gitForProject?: (projectRoot: string) => GitWorktrees; supervisor: JobSupervisor; owner?: string; createId?: () => string; broadcast?: (jobId: string, event: JobProjectionEvent) => void; stopCompletionTimeoutMs?: number; desktopAdmission?: DesktopWorkAdmission; initialize?: () => Promise<unknown> };
export class GjcCapacityExhaustedError extends Error { constructor(public readonly jobId: string) { super(`GJC job ${jobId} is waiting for capacity.`); this.name = 'GjcCapacityExhaustedError'; } }

const desktopContinuation = new AsyncLocalStorage<() => boolean>();
/** Server-only continuation capability: the caller must prove a still-live owner.
 * Never expose this through request options. Consumed at one entry, not inherited
 * by arbitrary callbacks or new roots dispatched by that operation. */
export function withOwnedJobDesktopContinuation<T>(ownsWork: () => boolean, action: () => T): T {
  if (!ownsWork()) throw new Error('Job continuation no longer has a live owner.');
  return desktopContinuation.run(ownsWork, action);
}

const safe = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function samePayload(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => samePayload(value, right[index]));
  if (!safe(left) || !safe(right)) return false;
  const leftKeys = Object.keys(left).sort(); const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && samePayload(left[key], right[key]));
}
const lower = (value: string) => value.toLowerCase();
const eventId = () => `event-${randomUUID()}`;
function snapshot(value: unknown): JobSnapshot { if (!safe(value) || typeof value.jobId !== 'string' || typeof value.state !== 'string') throw new Error('Invalid jobs authority response.'); return value as JobSnapshot; }
function binding(value: unknown): Binding { if (!safe(value) || typeof value.jobId !== 'string' || typeof value.state !== 'string') throw new Error('Invalid job binding response.'); return value as Binding; }
function lease(value: JobSnapshot): Lease { if (!value.lease || typeof value.lease.owner !== 'string' || !Number.isSafeInteger(value.lease.generation)) throw new Error('Job has no active lease.'); return value.lease; }
function worktree(value: unknown): { worktreeId: string; path: string; head?: string } { const item = safe(value) && safe(value.worktree) ? value.worktree : undefined; if (!item || typeof item.worktreeId !== 'string' || typeof item.path !== 'string') throw new Error('Invalid git worktree.create response.'); return item as { worktreeId: string; path: string; head?: string }; }
function worktreePath(value: unknown, id: string): string | undefined { const items = Array.isArray(value) ? value : safe(value) && Array.isArray(value.items) ? value.items : []; const item = items.find((candidate) => safe(candidate) && candidate.worktreeId === id && typeof candidate.path === 'string'); return safe(item) && typeof item.path === 'string' ? item.path : undefined; }
function sameFence(current: JobSnapshot, runId: string, expected: Lease): boolean { return current.currentRun?.runId === runId && current.lease?.owner === expected.owner && current.lease?.generation === expected.generation; }
type PersistenceScope = { pending: Set<Promise<void>>; ownsWork: () => boolean; failure?: unknown };
function failureError(error: unknown): Error { return error instanceof Error ? new Error(error.message) : new Error('Worker failed.'); }
function confirmedReap(outcome: GjcWorkerReapOutcome | undefined): boolean {
  return outcome === 'not_started' || outcome === 'reaped';
}
async function settledOutcome(run: GjcWorkerRun | undefined): Promise<GjcWorkerOutcome | undefined> {
  if (!run?.outcome) return undefined;
  let outcome: GjcWorkerOutcome | undefined;
  void run.outcome.then(
    (value) => { outcome = value; },
    () => { outcome = 'unconfirmed'; },
  );
  await Promise.resolve();
  return outcome;
}
const STOP_COMPLETION_TIMEOUT_MS = 1_000;
async function terminalCompletion(run: GjcWorkerRun, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run.completion.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          timer = undefined;
          resolve(false);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Durable v5 facade: Job is a bound workspace; every dispatch creates one fenced Run. */
export class JobOrchestrator {
  private readonly owner: string; private readonly createId: () => string; private readonly stopCompletionTimeoutMs: number;
  private readonly queues = new Map<string, Promise<unknown>>(); private readonly activeRuns = new Map<string, { runId: string; lease: Lease; abortHandle: string; run: GjcWorkerRun; uncertain?: boolean }>();
  private readonly activityEpoch = randomUUID();
  private activityRevision = 0n;
  private readonly activityTasks = { starting: 0, settling: 0 };
  private desktopAdmission?: DesktopWorkAdmission;
  private closed = false;
  private initializationFailed = false;
  private admissionBlocked = false;
  private healthChain: Promise<void> = Promise.resolve();
  constructor(private readonly deps: JobOrchestratorDependencies) {
    this.owner = deps.owner ?? `orchestrator-${randomUUID()}`;
    this.createId = deps.createId ?? randomUUID;
    this.stopCompletionTimeoutMs = deps.stopCompletionTimeoutMs ?? STOP_COMPLETION_TIMEOUT_MS;
    this.desktopAdmission = deps.desktopAdmission;
    if (deps.initialize) void this.admitted('orchestrator:initialize', 'starting', deps.initialize).catch(() => {
      this.initializationFailed = true;
      this.activityChanged();
    });
  }
  getGeneration(): string { return `${this.activityEpoch}:${this.activityRevision}`; }
  snapshotActivity(): DesktopOwnerActivity {
    const unknown: string[] = [];
    if (this.admissionBlocked) unknown.push('orchestrator_authority_unavailable');
    if (this.initializationFailed) unknown.push('orchestrator_initialization_failed');
    if (this.closed) unknown.push('orchestrator_closed');
    const uncertain = [...this.activeRuns.values()].filter((run) => run.uncertain).length;
    if (uncertain) unknown.push('orchestrator_settlement_unconfirmed');
    return {
      owner: 'orchestrator', generation: this.getGeneration(), complete: unknown.length === 0,
      starting: this.activityTasks.starting, queued: this.queues.size, running: this.activeRuns.size,
      settling: this.activityTasks.settling, approvals: 0, retained: uncertain, unknown,
    };
  }
  configureDesktopAdmission(admission?: DesktopWorkAdmission): void {
    this.desktopAdmission = admission;
    this.activityChanged();
  }
  /** Retirement is not a proof of idle; readers of an old instance fail closed. */
  markClosed(): void { this.closed = true; this.activityChanged(); }
  private activityChanged(): void { this.activityRevision += 1n; }
  private async activity<T>(kind: keyof JobOrchestrator['activityTasks'], action: () => Promise<T>): Promise<T> {
    this.activityTasks[kind] += 1;
    this.activityChanged();
    try { return await action(); }
    finally { this.activityTasks[kind] -= 1; this.activityChanged(); }
  }
  private async admitted<T>(source: string, kind: keyof JobOrchestrator['activityTasks'], action: () => Promise<T>, completion = false): Promise<T> {
    const owned = completion || desktopContinuation.getStore()?.() === true;
    const release = owned ? this.desktopAdmission?.enterCompletion(source) : this.desktopAdmission?.enter(source);
    try { return await this.activity(kind, () => desktopContinuation.exit(action)); }
    finally { release?.(); }
  }
  private forgetRun(jobId: string): void {
    if (this.activeRuns.delete(jobId)) this.activityChanged();
  }
  private uncertainRun(jobId: string, runId: string): void {
    const active = this.activeRuns.get(jobId);
    if (active?.runId === runId && !active.uncertain) { active.uncertain = true; this.activityChanged(); }
  }
  private clearRuns(): void { if (this.activeRuns.size) { this.activeRuns.clear(); this.activityChanged(); } }
  private git(root: string): GitWorktrees { const client = this.deps.gitForProject?.(root) ?? this.deps.git; if (!client) throw new Error('GJC Git worktree client is unavailable.'); return client; }
  private serial<T>(jobId: string, action: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(jobId) ?? Promise.resolve();
    const result = prior.catch(() => undefined).then(() => {
      this.activityChanged();
      return action();
    });
    const tail = result.catch(() => undefined).finally(() => {
      if (this.queues.get(jobId) === tail) this.queues.delete(jobId);
      this.activityChanged();
    });
    this.queues.set(jobId, tail);
    this.activityChanged();
    return result;
  }
  private params(jobId: string, current: JobSnapshot): Record<string, unknown> { return { jobId, lease: lease(current) }; }
  private async mutate(jobId: string, action: () => Promise<unknown>, confirmed: (value: JobSnapshot) => boolean): Promise<JobSnapshot> { try { return snapshot(await action()); } catch (error) { const fresh = snapshot(await this.deps.jobs.get({ jobId })); if (confirmed(fresh)) return fresh; throw error; } }
  private publish(jobId: string, event: JobProjectionEvent, writer?: GjcWorkerWriter): void {
    try { this.deps.broadcast?.(jobId, event); } catch { /* Replay recovers an isolated live callback failure. */ }
    try { writer?.send(event.payload); } catch { /* Worker output delivery is not durable authority state. */ }
  }
  private async finalize(jobId: string, current: JobSnapshot, runId: string, state: 'succeeded' | 'failed' | 'aborted' | 'interrupted', reason: unknown): Promise<JobSnapshot> {
    const id = jobTerminalEventId(runId);
    const after = Number.isSafeInteger(current.lastSequence) && current.lastSequence! >= 0 ? current.lastSequence! : 0;
    const payload = createJobTerminalPayload({ runId, appSessionId: current.currentRun?.appSessionId, outcome: state, reason });
    const result = await this.mutate(jobId, () => this.deps.jobs.runFinalize({ ...this.params(jobId, current), runId, terminalRunState: state, eventId: id, payload }), (fresh) => lower(fresh.state) === state || (!sameFence(fresh, runId, lease(current)) && (lower(fresh.state) === 'ready' || lower(fresh.state) === 'interrupted')));
    try {
      const replay = await this.deps.jobs.replayEvents({ jobId, after });
      const event = safe(replay) && Array.isArray(replay.events) ? replay.events.find((candidate) => safe(candidate) && candidate.eventId === id) : undefined;
      if (isJobProjectionEvent(event)) this.publish(jobId, event);
    } catch { /* The committed terminal event remains recoverable through replay. */ }
    return result;
  }
  private trackPersistence(scope: PersistenceScope, action: () => Promise<void>): void {
    const pending = this.admitted('orchestrator:persistence', 'settling', action, scope.ownsWork()).catch((error) => { scope.failure ??= error; this.activityChanged(); }).finally(() => { scope.pending.delete(pending); this.activityChanged(); });
    scope.pending.add(pending);
    this.activityChanged();
  }
  private async drainPersistence(scope: PersistenceScope): Promise<void> {
    while (scope.pending.size) await Promise.all([...scope.pending]);
  }
  private enqueueEvent(jobId: string, current: JobSnapshot, runId: string, payload: unknown, writer: GjcWorkerWriter, scope: PersistenceScope): void {
    const id = eventId(); const expected = lease(current);
    this.trackPersistence(scope, () => this.serial(jobId, async () => {
      const fresh = snapshot(await this.deps.jobs.get({ jobId }));
      if (!sameFence(fresh, runId, expected)) return;
      const event = await this.deps.jobs.appendEvent({ ...this.params(jobId, fresh), runId, eventId: id, payload });
      if (!isJobProjectionEvent(event)) throw new Error('Invalid committed job event response.');
      this.publish(jobId, event, writer);
    }));
  }
  private writer(jobId: string, current: JobSnapshot, runId: string, writer: GjcWorkerWriter, scope: PersistenceScope): GjcWorkerWriter {
    return {
      ...writer,
      send: (payload) => {
        if (safe(payload) && payload.kind === 'complete' && typeof payload.exitCode === 'number' && payload.exitCode !== 0) {
          scope.failure ??= new Error('Worker reported an unsuccessful turn.');
        }
        this.enqueueEvent(jobId, current, runId, payload, writer, scope);
      },
      setSessionId: (providerSessionId) => {
        const expected = lease(current);
        this.trackPersistence(scope, () => this.serial(jobId, async () => {
          const fresh = snapshot(await this.deps.jobs.get({ jobId }));
          if (!sameFence(fresh, runId, expected)) return;
          await this.deps.jobs.bindProviderSession({ ...this.params(jobId, fresh), runId, providerSessionId });
          try { writer.setSessionId?.(providerSessionId); } catch { /* Live delivery is not durable authority state. */ }
        }));
      },
    };
  }
  private completion(jobId: string, runId: string, expected: Lease, run: GjcWorkerRun, scope: PersistenceScope, signal?: AbortSignal): Promise<void> {
    return this.activity('settling', () => run.completion.then(
      async () => {
        await this.drainPersistence(scope);
        const outcome = await run.outcome;
        if (outcome === 'unconfirmed') throw new GjcJobsClientError('Worker termination is unconfirmed.', 'worker_stop_unconfirmed');
        return this.serial(jobId, async () => {
          const fresh = snapshot(await this.deps.jobs.get({ jobId }));
          if (!sameFence(fresh, runId, expected)) return;
          const aborted = outcome === 'aborted' || signal?.aborted;
          if (!aborted && (outcome === 'not_started' || outcome === 'reaped')) scope.failure ??= new Error('Worker stopped without completing the turn.');
          await this.finalize(jobId, fresh, runId, scope.failure ? 'failed' : aborted ? 'aborted' : 'succeeded', scope.failure ? failureError(scope.failure).message : aborted ? 'aborted' : 'completed');
          this.forgetRun(jobId);
          if (scope.failure) throw failureError(scope.failure);
        });
      },
      async (error) => {
        await this.drainPersistence(scope);
        if (await run.outcome === 'unconfirmed') throw failureError(error);
        await this.serial(jobId, async () => {
          const fresh = snapshot(await this.deps.jobs.get({ jobId }));
          if (!sameFence(fresh, runId, expected)) return;
          await this.finalize(jobId, fresh, runId, signal?.aborted ? 'aborted' : 'failed', failureError(scope.failure ?? error).message);
          this.forgetRun(jobId);
        });
        throw failureError(error);
      },
    )).catch((error) => { this.uncertainRun(jobId, runId); throw error; });
  }
  private async failRun(jobId: string, runId: string, expected: Lease, run: GjcWorkerRun | undefined, error: unknown, retainWorkspace = false): Promise<void> {
    const outcome = await settledOutcome(run);
    if (outcome === 'not_started' || run?.phase?.() === 'registered') {
      const fresh = snapshot(await this.deps.jobs.get({ jobId }));
      if (sameFence(fresh, runId, expected)) {
        if (retainWorkspace && fresh.worktreeId && fresh.repositoryRoot) await this.finalize(jobId, fresh, runId, 'failed', failureError(error).message);
        else await this.cancelAdmission(jobId, fresh, error, runId);
      }
      this.forgetRun(jobId);
      return;
    }
    if (outcome === 'reaped' || outcome === 'completed') {
      const fresh = snapshot(await this.deps.jobs.get({ jobId }));
      if (sameFence(fresh, runId, expected)) await this.finalize(jobId, fresh, runId, 'failed', failureError(error).message);
      this.forgetRun(jobId);
      return;
    }
    if (!run || !await this.stopRun(run)) { this.uncertainRun(jobId, runId); return; }
    const fresh = snapshot(await this.deps.jobs.get({ jobId }));
    if (sameFence(fresh, runId, expected)) await this.finalize(jobId, fresh, runId, 'failed', failureError(error).message);
    this.forgetRun(jobId);
  }
  private async stopRun(run: GjcWorkerRun): Promise<boolean> {
    const aborted = await this.deps.supervisor.abort(run.abortHandle).catch((): GjcWorkerAbortOutcome => 'unconfirmed');
    if (aborted === 'not_started') return true;
    if (await terminalCompletion(run, this.stopCompletionTimeoutMs)) {
      const outcome = await settledOutcome(run);
      if (!run.outcome || (outcome !== undefined && outcome !== 'unconfirmed')) return true;
    }
    return confirmedReap(await this.deps.supervisor.terminate?.(run.abortHandle).catch((): GjcWorkerReapOutcome => 'unconfirmed'));
  }
  private async cancelAdmission(jobId: string, current: JobSnapshot, error: unknown, runId?: string): Promise<void> {
    const terminalEvent = runId
      ? {
          eventId: jobTerminalEventId(runId),
          payload: createJobTerminalPayload({ runId, appSessionId: current.currentRun?.appSessionId, outcome: 'failed', reason: failureError(error).message }),
        }
      : undefined;
    const after = Number.isSafeInteger(current.lastSequence) && current.lastSequence! >= 0 ? current.lastSequence! : 0;
    let response: unknown;
    await this.mutate(
      jobId,
      async () => {
        response = await this.deps.jobs.cancelAdmission({
          ...this.params(jobId, current),
          eventId: eventId(),
          payload: { kind: 'admission_failed', error: failureError(error).message },
          ...(terminalEvent ? { terminalEvent } : {}),
        });
        return response;
      },
      (fresh) => fresh.lease?.owner !== lease(current).owner || fresh.lease?.generation !== lease(current).generation,
    );
    if (!terminalEvent) return;
    let event = safe(response) ? response.terminalEvent : undefined;
    if (!isJobProjectionEvent(event)) {
      const replay = await this.deps.jobs.replayEvents({ jobId, after });
      event = safe(replay) && Array.isArray(replay.events)
        ? replay.events.find((candidate) => safe(candidate) && candidate.eventId === terminalEvent.eventId)
        : undefined;
    }
    if (!isJobProjectionEvent(event) || event.eventId !== terminalEvent.eventId || !samePayload(event.payload, terminalEvent.payload)) {
      throw new Error('Invalid committed terminal event response.');
    }
    this.publish(jobId, event);
  }
  private async dispatch(jobId: string, current: JobSnapshot, runId: string, appSessionId: string, message: string, options: JobOrchestratorOptions, cwd: string, sessionId?: string | null): Promise<JobRunHandle> {
    let run: GjcWorkerRun | undefined;
    let expected: Lease | undefined;
    const { signal, onPrepared: _prepared, onRun, writer: _writer, retainWorkspaceOnFailure, ...workerOptions } = options;
    let unsubscribe = () => {};
    let dispatching = true;
    const admissionLease = lease(current);
    const cancelled = async (): Promise<JobRunHandle> => {
      const fresh = snapshot(await this.deps.jobs.get({ jobId }));
      if (sameFence(fresh, runId, admissionLease)) await this.finalize(jobId, fresh, runId, 'aborted', 'aborted before dispatch');
      this.forgetRun(jobId);
      return { jobId, runId, state: 'ready', started: Promise.resolve(), completion: Promise.resolve(), abortHandle: runId };
    };
    try {
      if (signal?.aborted) return await cancelled();
      current = await this.mutate(jobId, () => this.deps.jobs.markDispatching({ ...this.params(jobId, current), runId }), (fresh) => Boolean(fresh.dispatchCheckpoint));
      expected = lease(current);
      if (signal?.aborted) return await cancelled();
      const scope: PersistenceScope = { pending: new Set(), ownsWork: () => dispatching || this.activeRuns.get(jobId)?.runId === runId };
      run = this.deps.supervisor.spawnRun({ runId, appSessionId, message, options: { ...workerOptions, cwd, sessionId, notificationOwner: 'terminal-adapter' }, writer: this.writer(jobId, current, runId, options.writer, scope) });
      this.activeRuns.set(jobId, { runId, lease: expected, abortHandle: run.abortHandle, run });
      this.activityChanged();
      const ownedRun = run;
      // The worker promise can outlive startup failure or registry clearing.
      // Keep its actual lifetime independently of the durable active-run map.
      void this.activity('settling', async () => {
        await Promise.all([ownedRun.completion.catch(() => undefined), ownedRun.outcome?.catch(() => 'unconfirmed')]);
      });
      const abort = () => { void this.activity('settling', () => this.stopRun(ownedRun)).catch(() => this.uncertainRun(jobId, runId)); };
      signal?.addEventListener('abort', abort, { once: true });
      unsubscribe = () => signal?.removeEventListener('abort', abort);
      onRun?.(run);
      if (signal?.aborted) abort();
      void run.completion.catch(() => {});
      await run.started;
      current = await this.mutate(jobId, () => this.deps.jobs.transition({ ...this.params(jobId, current), state: 'running' }), (fresh) => lower(fresh.state) === 'running');
      const completion = this.completion(jobId, runId, expected, run, scope, signal).finally(unsubscribe);
      // REST job routes respond 202 and drop the handle without awaiting
      // completion (unlike the chat WebSocket path). The terminal failure is
      // already durably recorded by finalize(), so mark the wrapper handled to
      // keep an unobserved worker failure from crashing the whole sidecar via
      // unhandledRejection. Awaiting consumers still observe the rejection.
      void completion.catch(() => {});
      return { jobId, runId, state: current.state, started: run.started, completion, abortHandle: run.abortHandle };
    } catch (error) {
      unsubscribe();
      if (signal?.aborted && expected && (!run || await this.stopRun(run))) return cancelled();
      if (expected) await this.failRun(jobId, runId, expected, run, error, retainWorkspaceOnFailure);
      throw error;
    } finally {
      dispatching = false;
    }
  }
  private ensureAdmission(): void { if (this.admissionBlocked || this.closed) throw new GjcJobsClientError('GJC job authority is unavailable.', 'authority_unavailable'); }
  async start(provider: 'gjc', appSessionId: string, projectRoot: string, message: string, options: JobOrchestratorOptions): Promise<JobRunHandle> {
    return this.admitted('orchestrator:start', 'starting', () => this.startOwned(provider, appSessionId, projectRoot, message, options));
  }
  private async startOwned(provider: 'gjc', appSessionId: string, projectRoot: string, message: string, options: JobOrchestratorOptions): Promise<JobRunHandle> {
    if (provider !== 'gjc' || !appSessionId) throw new Error('GJC provider and app session are required.');
    options.signal?.throwIfAborted();
    this.ensureAdmission();
    const suffix = this.createId().replace(/[^a-z0-9]/giu, '').toLowerCase().slice(-12); const jobId = options.jobId ?? `job-${suffix}`;
    // Cap by UTF-16 units but never split a surrogate pair: a trailing lone
    // high surrogate becomes an unpaired \uDXXX escape that the native
    // authority's JSON parser rejects, failing job creation.
    let prompt = message.trim().slice(0, 2_000);
    if (/[\uD800-\uDBFF]$/u.test(prompt)) prompt = prompt.slice(0, -1);
    return this.serial(jobId, async () => {
      let current: JobSnapshot;
      try {
        current = snapshot(await this.deps.jobs.reserveStart({ jobId, provider, appSessionId, owner: this.owner, cap: options.cap ?? 4, ...(prompt ? { prompt } : {}) }));
      } catch (error) {
        if (error instanceof GjcJobsClientError && error.code === 'capacity_exhausted') throw new GjcCapacityExhaustedError(jobId);
        throw error;
      }
      if (lower(current.state) === 'waiting') throw new GjcCapacityExhaustedError(jobId);
      let dispatched = false;
      try {
        const branch = `job/${jobId}`; const path = join(projectRoot, '.gjc-worktrees', jobId);
        const created = worktree(await this.git(projectRoot).create({ jobId, path, branch }));
        if (!created.head) throw new Error('worktree.create did not return a base commit.');
        current = await this.mutate(jobId, () => this.deps.jobs.prepare({ ...this.params(jobId, current), worktreeId: created.worktreeId, branch, baseCommit: created.head, repositoryRoot: projectRoot }), (fresh) => fresh.worktreeId === created.worktreeId);
        await options.onPrepared?.(created.path);
        const runId = `run-${this.createId()}`;
        current = await this.mutate(jobId, () => this.deps.jobs.admit({ ...this.params(jobId, current), runId, appSessionId }), (fresh) => fresh.currentRun?.runId === runId);
        dispatched = true;
        return await this.dispatch(jobId, current, runId, appSessionId, message, options, created.path);
      } catch (error) {
        if (!dispatched) await this.cancelAdmission(jobId, current, error);
        throw error;
      }
    });
  }
  async turnStart(provider: 'gjc', appSessionId: string, message: string, options: JobOrchestratorOptions): Promise<JobRunHandle> {
    return this.admitted('orchestrator:turn-start', 'starting', () => this.turnStartOwned(provider, appSessionId, message, options));
  }
  private async turnStartOwned(provider: 'gjc', appSessionId: string, message: string, options: JobOrchestratorOptions): Promise<JobRunHandle> {
    if (provider !== 'gjc' || !appSessionId) throw new Error('GJC provider and app session are required.');
    options.signal?.throwIfAborted();
    this.ensureAdmission();
    const bound = binding(await this.deps.jobs.bindingResolve({ provider, appSessionId }));
    if (lower(bound.state) !== 'ready') throw new Error('Only ready jobs can start a new turn.');
    return this.serial(bound.jobId, async () => {
      const runId = `run-${this.createId()}`; let current: JobSnapshot;
      try {
        current = snapshot(await this.deps.jobs.turnAdmit({ jobId: bound.jobId, appSessionId, owner: this.owner, runId, cap: options.cap ?? 4 }));
      } catch (error) {
        if (error instanceof GjcJobsClientError && error.code === 'capacity_exhausted') throw new GjcCapacityExhaustedError(bound.jobId);
        throw error;
      }
      let dispatched = false;
      try {
        if (!current.worktreeId || !current.repositoryRoot || !current.branch) throw new Error('Ready job has no stored repository root, branch and worktree.');
        const git = this.git(current.repositoryRoot);
        const cwd = worktreePath(await git.list({}), current.worktreeId);
        if (!cwd) throw new Error('Stored worktree is no longer available.');
        // Listing is discovery, not authorization: its path can have been
        // replaced since the previous turn. Revalidate the registered Git
        // pointer and repository ownership just as interrupted resume does.
        await git.status({ jobId: bound.jobId, branch: current.branch, path: cwd });
        dispatched = true;
        return await this.dispatch(bound.jobId, current, runId, appSessionId, message, options, cwd, bound.providerSessionId);
      } catch (error) {
        if (!dispatched) await this.cancelAdmission(bound.jobId, current, error);
        throw error;
      }
    });
  }
  async resume(jobId: string, appSessionId: string, message: string, options: JobOrchestratorOptions): Promise<JobRunHandle> {
    return this.admitted('orchestrator:resume', 'starting', () => this.resumeOwned(jobId, appSessionId, message, options));
  }
  private async resumeOwned(jobId: string, appSessionId: string, message: string, options: JobOrchestratorOptions): Promise<JobRunHandle> {
    if (!appSessionId) throw new Error('GJC app session is required.');
    options.signal?.throwIfAborted();
    this.ensureAdmission();
    return this.serial(jobId, async () => {
      const current = snapshot(await this.deps.jobs.get({ jobId }));
      if (lower(current.state) !== 'interrupted' || !current.worktreeId || !current.branch || !current.repositoryRoot) throw new Error('Only interrupted jobs with a stored repository root and worktree can be resumed.');
      const bound = binding(await this.deps.jobs.bindingResolve({ provider: 'gjc', appSessionId }));
      if (bound.jobId !== jobId) throw new Error('Session binding does not belong to this job.');
      const git = this.git(current.repositoryRoot); const cwd = worktreePath(await git.list({}), current.worktreeId);
      if (!cwd) throw new Error('Stored worktree is no longer available.');
      await git.status({ jobId, branch: current.branch, path: cwd });
      const runId = `run-${this.createId()}`; let admitted: JobSnapshot;
      try {
        admitted = snapshot(await this.deps.jobs.readmit({ jobId, appSessionId, owner: this.owner, cap: options.cap ?? 4, runId }));
      } catch (error) {
        if (error instanceof GjcJobsClientError && error.code === 'capacity_exhausted') throw new GjcCapacityExhaustedError(jobId);
        throw error;
      }
      let dispatched = false;
      try {
        dispatched = true;
        return await this.dispatch(jobId, admitted, runId, appSessionId, message, options, cwd, bound.providerSessionId);
      } catch (error) {
        if (!dispatched) await this.cancelAdmission(jobId, admitted, error);
        throw error;
      }
    });
  }
  async appendAdminEvent(jobId: string, eventId: string, payload: unknown): Promise<void> {
    await this.admitted('orchestrator:admin-event', 'settling', () => this.serial(jobId, async () => {
      const event = await this.deps.jobs.appendAdminEvent({ jobId, eventId, payload });
      if (!isJobProjectionEvent(event)) throw new Error('Invalid committed job event response.');
      this.publish(jobId, event);
    }));
  }
  async abort(target: { jobId?: string; appSessionId?: string; provider?: string } | string): Promise<boolean> {
    return this.admitted('orchestrator:abort', 'settling', () => this.abortOwned(target), true);
  }
  private async abortOwned(target: { jobId?: string; appSessionId?: string; provider?: string } | string): Promise<boolean> {
    const jobId = typeof target === 'string' ? target : target.jobId ?? binding(await this.deps.jobs.bindingResolve({ provider: target.provider, appSessionId: target.appSessionId })).jobId;
    return this.serial(jobId, async () => {
      let current = snapshot(await this.deps.jobs.get({ jobId }));
      if (lower(current.state) !== 'running' && lower(current.state) !== 'aborting') return false;
      if (lower(current.state) === 'running') current = snapshot(await this.deps.jobs.transition({ ...this.params(jobId, current), state: 'aborting' }));
      const active = this.activeRuns.get(jobId);
      if (!active) return false;
      const stopped = await this.stopRun(active.run);
      if (!stopped) return false;
      const fresh = snapshot(await this.deps.jobs.get({ jobId }));
      if (sameFence(fresh, active.runId, active.lease)) await this.finalize(jobId, fresh, active.runId, 'aborted', 'aborted');
      this.forgetRun(jobId);
      return true;
    });
  }
  async interruptForShutdown(): Promise<unknown> {
    // Irreversible shutdown may clear registry entries without worker proof.
    // Never turn that administrative clearing into a reusable idle reader.
    this.markClosed();
    return this.activity('settling', async () => { const result = await this.deps.jobs.interruptForShutdown(); this.clearRuns(); return result; });
  }
  async resolveBinding(provider: string, appSessionId: string): Promise<Binding | null> {
    return this.admitted('orchestrator:binding', 'starting', () => this.resolveBindingOwned(provider, appSessionId));
  }
  private async resolveBindingOwned(provider: string, appSessionId: string): Promise<Binding | null> {
    try {
      return binding(await this.deps.jobs.bindingResolve({ provider, appSessionId }));
    } catch (error) {
      if (error instanceof GjcJobsClientError && error.code === 'not_found') return null;
      throw error;
    }
  }
  reconcile(): Promise<unknown> { return this.admitted('orchestrator:reconcile', 'settling', () => this.deps.jobs.reconcile({})); }
  authorityHealth(healthy: boolean): Promise<void> {
    if (!healthy) { this.admissionBlocked = true; this.activityChanged(); }
    return this.admitted('orchestrator:authority-health', 'settling', () => this.authorityHealthOwned(healthy), true);
  }
  private authorityHealthOwned(healthy: boolean): Promise<void> {
    const transition = async (): Promise<void> => {
      if (!healthy) {
        this.admissionBlocked = true;
        this.activityChanged();
        const runs = [...this.activeRuns.values()];
        const stopped = await Promise.all(runs.map((run) => this.stopRun(run.run)));
        if (stopped.every(Boolean)) this.clearRuns();
        return;
      }
      if (this.activeRuns.size) throw new GjcJobsClientError('GJC worker reaping is unconfirmed.', 'authority_unavailable');
      await this.deps.jobs.reconcile({});
      this.admissionBlocked = false;
      this.activityChanged();
    };
    const result = this.healthChain.catch(() => undefined).then(transition);
    this.healthChain = result.catch(() => undefined);
    return result;
  }
}
type ProductionOrchestrator = JobOrchestrator & { close(): void }; let production: ProductionOrchestrator | undefined; let productionAuthority: GjcJobsClient | undefined;
let productionDesktopAdmission: DesktopWorkAdmission | undefined;
export function configureGjcJobOrchestratorDesktopAdmission(admission?: DesktopWorkAdmission): void {
  productionDesktopAdmission = admission;
  production?.configureDesktopAdmission(admission);
}
/** Captures the owner once; reads never instantiate clients or query native jobs.
 * Native durable jobs (including archived jobs) require their own parent reader. */
export function createGjcJobOrchestratorDesktopRestartReader(orchestrator: JobOrchestrator = getProductionJobOrchestrator()): {
  getGeneration(): string; read(): DesktopOwnerActivity;
} {
  return Object.freeze({ getGeneration: () => orchestrator.getGeneration(), read: () => orchestrator.snapshotActivity() });
}
export function getProductionJobAuthority(): JobAuthority { getProductionJobOrchestrator(); if (!productionAuthority) throw new Error('GJC job authority is unavailable.'); return productionAuthority; }
export function getProductionNativeJobsDesktopRestartReader(): ReturnType<typeof createNativeJobsDesktopRestartReader> {
  getProductionJobOrchestrator();
  if (!productionAuthority) throw new Error('GJC job authority is unavailable.');
  return createNativeJobsDesktopRestartReader(productionAuthority);
}
export function getProductionJobOrchestrator(): ProductionOrchestrator {
  if (production) return production;
  const database = join(dirname(getDatabasePath()), 'jobs.sqlite3');
  const jobs = new GjcJobsClient({ database, onHealthChange: (healthy) => { void orchestrator?.authorityHealth(healthy).catch(() => undefined); } });
  productionAuthority = jobs;
  const clients = new Map<string, GjcGitClient>();
  const gitForProject = (projectRoot: string): GjcGitClient => {
    if (!projectRoot) throw new Error('GJC requires a project root.');
    if (!existsSync(join(projectRoot, '.git'))) throw new Error(`GJC project root is not a Git repository: ${projectRoot}`);
    let client = clients.get(projectRoot);
    if (!client) { client = new GjcGitClient({ workdir: projectRoot }); clients.set(projectRoot, client); }
    return client;
  };
  const orchestrator = new JobOrchestrator({ jobs, gitForProject, supervisor: getGjcWorkerSupervisor(), desktopAdmission: productionDesktopAdmission, initialize: () => mkdir(dirname(database), { recursive: true }) }) as ProductionOrchestrator;
  orchestrator.close = () => { orchestrator.markClosed(); jobs.close(); productionAuthority = undefined; for (const client of clients.values()) client.close(); clients.clear(); production = undefined; };
  production = orchestrator;
  return orchestrator;
}
