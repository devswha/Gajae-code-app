import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import type { DesktopOwnerActivity } from '../../shared/desktopUpdateProtocol.js';

const COUNTS = ['starting', 'queued', 'running', 'settling', 'approvals', 'retained'] as const;
const ACTIVITY_KEYS = ['owner', 'generation', 'complete', ...COUNTS, 'unknown'];
const identifier = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);

export type DesktopRestartState = 'open' | 'preparing' | 'prepared' | 'committed';
export type DesktopRestartBlocker = {
  kind: 'busy' | 'unknown';
  code: 'ingress_busy' | 'owner_busy' | 'owner_missing' | 'owner_failed' | 'owner_timeout'
    | 'owner_invalid' | 'owner_stale' | 'owner_incomplete' | 'owner_unknown' | 'activity_changed' | 'snapshot_timeout';
  owner?: string;
};
export type DesktopRestartSnapshot = {
  state: DesktopRestartState;
  revision: number;
  ingress: number;
  complete: boolean;
  idle: boolean;
  owners: readonly DesktopOwnerActivity[];
  blockers: readonly DesktopRestartBlocker[];
};
export type DesktopRestartFailure = {
  ok: false;
  code: 'busy' | 'unknown' | 'invalid_attempt' | 'in_progress' | 'committed'
    | 'invalid_token' | 'stale_epoch' | 'cancelled' | 'expired' | 'token_unavailable';
  blockers: readonly DesktopRestartBlocker[];
};
export type DesktopRestartPrepareResult = DesktopRestartFailure | {
  ok: true;
  attemptId: string;
  epoch: string;
  token: string;
  /** Deadline in the injected monotonic clock's milliseconds, not a wall-clock date. */
  expiresAt: number;
  snapshot: DesktopRestartSnapshot;
};
export type DesktopRestartCommitResult = DesktopRestartFailure | {
  ok: true;
  state: 'committed';
  attemptId: string;
  epoch: string;
};

export type DesktopRestartOwnerReader = {
  /**
   * Pure synchronous revision of ALL activity, including queued work. Change it
   * on every activity mutation and process replacement, not only on PID changes.
   */
  getGeneration(): string;
  /** Must be nonblocking/read-only; no lazy spawn, cancellation, or health reset. */
  read(): unknown | Promise<unknown>;
};
export type DesktopRestartAuthorityOptions = {
  requiredOwners: readonly string[];
  ownerReaders?: Readonly<Record<string, DesktopRestartOwnerReader | undefined>>;
  now?: () => number;
  randomToken?: () => string;
  /** Schedule a timer and return its cancellation function. Must not call inline. */
  schedule?: (callback: () => void, delayMs: number) => () => void;
  readTimeoutMs?: number;
  tokenTtlMs?: number;
  /** Trusted runtime admission, not an owner read or browser-selected callback. */
  preparationFence?: {
    owner: string;
    close(fenceId: string): void | Promise<void>;
    release(fenceId: string): void | Promise<void>;
  };
};

type Owner = { owner: string; reader?: DesktopRestartOwnerReader };
type ReadResult = { activity?: DesktopOwnerActivity; blockers: DesktopRestartBlocker[] };
type Attempt = {
  attemptId: string;
  epoch: string;
  sequence: number;
  prepareDeadline: number;
  phase: Exclude<DesktopRestartState, 'open'>;
  prepared: Promise<DesktopRestartPrepareResult>;
  resolvePrepare: (result: DesktopRestartPrepareResult) => void;
  token?: string;
  expiresAt?: number;
  cancelExpiry?: () => void;
  generations?: ReadonlyMap<string, string>;
  preparedRevision?: number;
  committing?: Promise<DesktopRestartCommitResult>;
  resolveCommit?: (result: DesktopRestartCommitResult) => void;
  fenceId?: string;
  fenceClosing?: Promise<void>;
};

const failure = (code: DesktopRestartFailure['code'], blockers: readonly DesktopRestartBlocker[] = []): DesktopRestartFailure => ({ ok: false, code, blockers });
const unknown = (code: DesktopRestartBlocker['code'], owner?: string): DesktopRestartBlocker => ({ kind: 'unknown', code, ...(owner ? { owner } : {}) });

function duration(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError('Invalid desktop restart timeout.');
  return value;
}

function activity(value: unknown, owner: string): DesktopOwnerActivity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== ACTIVITY_KEYS.length
    || ACTIVITY_KEYS.some((key) => !descriptors[key] || !Object.hasOwn(descriptors[key], 'value'))) return;
  const record = Object.fromEntries(ACTIVITY_KEYS.map((key) => [key, descriptors[key]!.value]));
  if (record.owner !== owner || !identifier(record.generation) || typeof record.complete !== 'boolean'
    || COUNTS.some((key) => !Number.isSafeInteger(record[key]) || record[key] < 0)
    || !Array.isArray(record.unknown) || record.unknown.length > 32
    || !Array.from(record.unknown).every(identifier)) return;
  // Copy the entire observation: a reader must not mutate a previously returned proof.
  return {
    owner, generation: record.generation, complete: record.complete,
    starting: record.starting, queued: record.queued, running: record.running,
    settling: record.settling, approvals: record.approvals, retained: record.retained,
    unknown: [...record.unknown],
  };
}

/**
 * Standalone safety primitive, NOT G3 acceptance or installation authority.
 * Integration still must fence every producer and prove zero-gap transfer to
 * these existing owners. It never cancels work, mutates health, or shuts down.
 * Owner revisions must cover internal producers across the entire async read.
 */
export class DesktopRestartAuthority {
  private readonly owners: readonly Owner[];
  private readonly now: () => number;
  private readonly randomToken: () => string;
  private readonly schedule: NonNullable<DesktopRestartAuthorityOptions['schedule']>;
  private readonly readTimeoutMs: number;
  private readonly tokenTtlMs: number;
  private readonly preparationFence: DesktopRestartAuthorityOptions['preparationFence'];
  private readonly fenceEpoch = randomUUID();
  private fenceReleaseFailed = false;
  private readonly lostEpochs = new Set<string>();
  private ingress = 0;
  private revision = 0;
  private sequence = 0;
  private attempt?: Attempt;

  constructor(options: DesktopRestartAuthorityOptions) {
    if (!Array.isArray(options.requiredOwners) || options.requiredOwners.length === 0
      || options.requiredOwners.length > 128 || !options.requiredOwners.every(identifier)
      || new Set(options.requiredOwners).size !== options.requiredOwners.length) {
      throw new TypeError('A nonempty unique required-owner list is required.');
    }
    this.owners = options.requiredOwners.map((owner) => {
      const reader = Object.hasOwn(options.ownerReaders ?? {}, owner) ? options.ownerReaders?.[owner] : undefined;
      return { owner, ...(reader && typeof reader.read === 'function' && typeof reader.getGeneration === 'function'
        ? { reader: { read: reader.read.bind(reader), getGeneration: reader.getGeneration.bind(reader) } } : {}) };
    });
    this.now = options.now ?? (() => performance.now());
    this.randomToken = options.randomToken ?? randomUUID;
    this.schedule = options.schedule ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref();
      return () => clearTimeout(timer);
    });
    this.readTimeoutMs = duration(options.readTimeoutMs, 5_000);
    this.tokenTtlMs = duration(options.tokenTtlMs, 10_000);
    if (options.preparationFence && (!options.requiredOwners.includes(options.preparationFence.owner)
      || typeof options.preparationFence.close !== 'function' || typeof options.preparationFence.release !== 'function')) {
      throw new TypeError('Preparation fence must belong to a required runtime owner.');
    }
    this.preparationFence = options.preparationFence ? Object.freeze({
      owner: options.preparationFence.owner,
      close: options.preparationFence.close.bind(options.preparationFence),
      release: options.preparationFence.release.bind(options.preparationFence),
    }) : undefined;
  }

  get state(): DesktopRestartState {
    this.expire();
    return this.attempt?.phase ?? 'open';
  }

  enter(source: string): () => void {
    if (typeof source !== 'string' || !source.trim() || source.length > 256) throw new TypeError('An admission source is required.');
    this.expire();
    if (this.attempt) throw Object.assign(new Error('Desktop restart admission is fenced.'), { code: 'DESKTOP_RESTART_FENCED' });
    return this.acquire();
  }

  /** Only callers which have validated existing ownership may use this path. */
  enterCompletion(source: string): () => void {
    if (typeof source !== 'string' || !source.trim() || source.length > 256) throw new TypeError('An admission source is required.');
    this.expire();
    if (this.attempt?.phase === 'committed') throw Object.assign(new Error('Desktop restart admission is fenced.'), { code: 'DESKTOP_RESTART_FENCED' });
    return this.acquire();
  }

  private acquire(): () => void {
    this.ingress += 1;
    this.revision += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.ingress -= 1;
      this.revision += 1;
    };
  }

  async guard<T>(source: string, work: () => T | Promise<T>): Promise<T> {
    const release = this.enter(source);
    try { return await work(); }
    finally { release(); }
  }

  async snapshot(): Promise<DesktopRestartSnapshot> {
    this.expire();
    const revision = this.revision;
    // Worker fencing and all owner reads share the original prepare budget.
    const deadline = Math.min(this.now() + this.readTimeoutMs,
      this.attempt?.phase === 'preparing' ? this.attempt.prepareDeadline : Infinity);
    const results = await Promise.all(this.owners.map((owner) => this.readOwner(owner, deadline)));
    const owners = results.flatMap((result) => result.activity ? [result.activity] : []);
    const blockers = results.flatMap((result) => result.blockers);
    if (this.fenceReleaseFailed) blockers.push(unknown('owner_failed', this.preparationFence?.owner));
    blockers.push(...this.checkGenerations(owners));
    if (this.now() >= deadline) blockers.push(unknown('snapshot_timeout'));
    this.expire();
    if (revision !== this.revision) blockers.push(unknown('activity_changed'));
    if (this.ingress > 0) blockers.push({ kind: 'busy', code: 'ingress_busy' });
    const complete = !blockers.some((blocker) => blocker.kind === 'unknown');
    return { state: this.attempt?.phase ?? 'open', revision: this.revision, ingress: this.ingress, complete, idle: complete && blockers.length === 0, owners, blockers };
  }

  prepare(input: { attemptId: string; epoch: string }): Promise<DesktopRestartPrepareResult> {
    this.expire();
    if (!input || !identifier(input.attemptId) || !identifier(input.epoch)) return Promise.resolve(failure('invalid_attempt'));
    if (this.lostEpochs.has(input.epoch)) return Promise.resolve(failure('stale_epoch'));
    const current = this.attempt;
    if (current?.phase === 'committed') return Promise.resolve(failure('committed'));
    if (current) return current.attemptId === input.attemptId && current.epoch === input.epoch
      ? current.prepared : Promise.resolve(failure('in_progress'));
    // Known ingress cannot become idle by waiting or by forced cancellation.
    if (this.ingress > 0) return Promise.resolve(failure('busy', [{ kind: 'busy', code: 'ingress_busy' }]));
    let resolvePrepare!: Attempt['resolvePrepare'];
    const prepared = new Promise<DesktopRestartPrepareResult>((resolve) => { resolvePrepare = resolve; });
    const attempt: Attempt = { ...input, sequence: ++this.sequence, prepareDeadline: this.now() + this.readTimeoutMs, phase: 'preparing', prepared, resolvePrepare };
    this.attempt = attempt; // synchronous fence BEFORE any reader or await
    this.revision += 1;
    void this.prepareInner(attempt).then(resolvePrepare, () => {
      this.reopen(attempt, failure('unknown', [unknown('owner_failed')]));
    });
    return prepared;
  }

  commit(token: string, epoch: string): Promise<DesktopRestartCommitResult> {
    this.expire();
    const attempt = this.attempt;
    if (!attempt || attempt.phase === 'preparing' || token !== attempt.token || epoch !== attempt.epoch) {
      return Promise.resolve(failure('invalid_token'));
    }
    if (attempt.phase === 'committed') return Promise.resolve(this.committed(attempt));
    if (attempt.committing) return attempt.committing;
    let resolveCommit!: NonNullable<Attempt['resolveCommit']>;
    const committing = new Promise<DesktopRestartCommitResult>((resolve) => { resolveCommit = resolve; });
    attempt.committing = committing;
    attempt.resolveCommit = resolveCommit;
    void this.commitInner(attempt).then(resolveCommit, () => {
      this.reopen(attempt, failure('unknown', [unknown('owner_failed')]));
    });
    return committing;
  }

  cancel(token: string): void {
    this.expire();
    if (typeof token === 'string' && this.attempt?.token === token) this.reopen(this.attempt, failure('cancelled'));
  }

  controllerLost(epoch: string): void {
    if (!identifier(epoch) || this.attempt?.phase === 'committed') return;
    this.lostEpochs.add(epoch);
    if (this.attempt?.epoch === epoch) this.reopen(this.attempt, failure('stale_epoch'));
  }

  private async prepareInner(attempt: Attempt): Promise<DesktopRestartPrepareResult> {
    const initialRevision = this.revision;
    if (this.preparationFence) {
      // The top-level ingress fence is already closed. Only now fence the
      // existing worker, before obtaining its non-spawning activity proof.
      const fence = this.preparationFence;
      const fenceId = `restart:${this.fenceEpoch}:${attempt.sequence}`;
      attempt.fenceId = fenceId;
      attempt.fenceClosing = Promise.resolve().then(() => fence.close(fenceId));
      const closed = await this.readBeforeDeadline(() => attempt.fenceClosing, attempt.prepareDeadline);
      if (this.attempt !== attempt) return failure('cancelled');
      if (closed.kind !== 'value') {
        const result = failure('unknown', [unknown(closed.kind === 'timeout' ? 'owner_timeout' : 'owner_failed', fence.owner)]);
        this.reopen(attempt, result);
        return result;
      }
      if (initialRevision !== this.revision || this.ingress !== 0) {
        const result = failure('unknown', [unknown('activity_changed')]);
        this.reopen(attempt, result);
        return result;
      }
    }
    const snapshot = await this.snapshot();
    if (this.attempt !== attempt) return failure('cancelled');
    const blockers = [...snapshot.blockers, ...this.checkGenerations(snapshot.owners)];
    if (this.now() >= attempt.prepareDeadline) blockers.push(unknown('snapshot_timeout'));
    if (this.revision !== snapshot.revision || this.ingress !== 0) blockers.push(unknown('activity_changed'));
    if (blockers.length) {
      const result = failure(blockers.some((blocker) => blocker.kind === 'unknown') ? 'unknown' : 'busy', blockers);
      this.reopen(attempt, result);
      return result;
    }
    let entropy: string;
    try { entropy = this.randomToken(); }
    catch { this.reopen(attempt, failure('token_unavailable')); return failure('token_unavailable'); }
    if (!identifier(entropy)) { this.reopen(attempt, failure('token_unavailable')); return failure('token_unavailable'); }
    const changed = this.checkGenerations(snapshot.owners);
    if (this.now() >= attempt.prepareDeadline) changed.push(unknown('snapshot_timeout'));
    if (this.attempt !== attempt || this.revision !== snapshot.revision || this.ingress !== 0) changed.push(unknown('activity_changed'));
    if (changed.length) { const result = failure('unknown', changed); this.reopen(attempt, result); return result; }
    attempt.token = `restart:${attempt.sequence}:${entropy}`;
    attempt.generations = new Map(snapshot.owners.map((owner) => [owner.owner, owner.generation]));
    attempt.expiresAt = this.now() + this.tokenTtlMs;
    attempt.phase = 'prepared';
    this.revision += 1;
    attempt.preparedRevision = this.revision;
    attempt.cancelExpiry = this.schedule(() => this.expire(), this.tokenTtlMs);
    return { ok: true, token: attempt.token, attemptId: attempt.attemptId, epoch: attempt.epoch, expiresAt: attempt.expiresAt, snapshot: { ...snapshot, state: 'prepared', revision: this.revision } };
  }

  private async commitInner(attempt: Attempt): Promise<DesktopRestartCommitResult> {
    const deadline = this.now() + this.readTimeoutMs;
    const snapshot = await this.snapshot();
    this.expire();
    if (this.attempt !== attempt) return failure('cancelled');
    const blockers = [...snapshot.blockers, ...this.checkGenerations(snapshot.owners)];
    if (attempt.preparedRevision !== snapshot.revision) blockers.push(unknown('activity_changed'));
    for (const owner of snapshot.owners) {
      if (attempt.generations?.get(owner.owner) !== owner.generation) blockers.push(unknown('owner_stale', owner.owner));
    }
    this.expire();
    if (this.now() >= deadline) blockers.push(unknown('snapshot_timeout'));
    // Last synchronous check, AFTER every asynchronous read and generation getter.
    if (this.attempt !== attempt || this.revision !== snapshot.revision || this.ingress !== 0) blockers.push(unknown('activity_changed'));
    if (blockers.length) {
      const result = failure(blockers.some((blocker) => blocker.kind === 'unknown') ? 'unknown' : 'busy', blockers);
      this.reopen(attempt, result);
      return result;
    }
    attempt.phase = 'committed';
    this.revision += 1;
    attempt.cancelExpiry?.();
    attempt.cancelExpiry = undefined;
    return this.committed(attempt);
  }

  private committed(attempt: Attempt): DesktopRestartCommitResult {
    return { ok: true, state: 'committed', attemptId: attempt.attemptId, epoch: attempt.epoch };
  }

  private expire(): void {
    const attempt = this.attempt;
    if (attempt?.phase === 'prepared' && attempt.expiresAt !== undefined && this.now() >= attempt.expiresAt) {
      this.reopen(attempt, failure('expired'));
    }
  }

  private reopen(attempt: Attempt, result: DesktopRestartFailure): void {
    if (this.attempt !== attempt || attempt.phase === 'committed') return;
    attempt.cancelExpiry?.();
    this.attempt = undefined;
    this.revision += 1;
    attempt.resolvePrepare(result);
    attempt.resolveCommit?.(result);
    if (attempt.fenceId && attempt.fenceClosing && this.preparationFence) {
      // A timeout/cancel is not completion of an in-flight fence request. Join
      // its actual settlement, then send the exact-ID release in order. Keep
      // this cleanup counted so another prepare cannot overtake it.
      const release = this.acquire();
      const fenceId = attempt.fenceId;
      const fence = this.preparationFence;
      void attempt.fenceClosing.catch(() => {}).then(() => fence.release(fenceId)).catch(() => {
        this.fenceReleaseFailed = true;
      }).finally(release);
    }
  }

  private checkGenerations(activities: readonly DesktopOwnerActivity[]): DesktopRestartBlocker[] {
    const blockers: DesktopRestartBlocker[] = [];
    for (const value of activities) {
      try {
        if (this.owners.find((owner) => owner.owner === value.owner)?.reader?.getGeneration() !== value.generation) {
          blockers.push(unknown('owner_stale', value.owner));
        }
      } catch { blockers.push(unknown('owner_failed', value.owner)); }
    }
    return blockers;
  }

  private async readOwner({ owner, reader }: Owner, deadline: number): Promise<ReadResult> {
    if (!reader) return { blockers: [unknown('owner_missing', owner)] };
    try {
      const generation = reader.getGeneration();
      if (!identifier(generation)) return { blockers: [unknown('owner_stale', owner)] };
      const result = await this.readBeforeDeadline(reader.read, deadline);
      if (result.kind !== 'value') return { blockers: [unknown(result.kind === 'timeout' ? 'owner_timeout' : 'owner_failed', owner)] };
      const value = activity(result.value, owner);
      if (!value) return { blockers: [unknown('owner_invalid', owner)] };
      if (value.generation !== generation) return { blockers: [unknown('owner_stale', owner)] };
      const blockers: DesktopRestartBlocker[] = [];
      if (!value.complete) blockers.push(unknown('owner_incomplete', owner));
      if (value.unknown.length) blockers.push(unknown('owner_unknown', owner));
      if (COUNTS.some((key) => value[key] > 0)) blockers.push({ kind: 'busy', code: 'owner_busy', owner });
      return { activity: value, blockers };
    } catch { return { blockers: [unknown('owner_failed', owner)] }; }
  }

  private readBeforeDeadline(read: () => unknown | Promise<unknown>, deadline: number): Promise<{ kind: 'value'; value: unknown } | { kind: 'timeout' | 'failed' }> {
    return new Promise((resolve) => {
      let settled = false;
      let cancelTimer = () => {};
      const finish = (result: { kind: 'value'; value: unknown } | { kind: 'timeout' | 'failed' }) => {
        if (settled) return;
        settled = true;
        cancelTimer();
        resolve(result);
      };
      if (this.now() >= deadline) { finish({ kind: 'timeout' }); return; }
      cancelTimer = this.schedule(() => finish({ kind: 'timeout' }), deadline - this.now());
      try {
        void Promise.resolve(read()).then(
          (value) => finish(this.now() >= deadline ? { kind: 'timeout' } : { kind: 'value', value }),
          () => finish({ kind: 'failed' }),
        );
      } catch { finish({ kind: 'failed' }); }
    });
  }
}
