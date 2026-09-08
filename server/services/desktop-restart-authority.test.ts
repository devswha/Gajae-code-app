import assert from 'node:assert/strict';
import test from 'node:test';

import type { DesktopOwnerActivity } from '../../shared/desktopUpdateProtocol.js';

import {
  DesktopRestartAuthority,
  type DesktopRestartAuthorityOptions,
  type DesktopRestartPrepareResult,
} from './desktop-restart-authority.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class Clock {
  time = 1_000;
  private sequence = 0;
  readonly timers = new Map<number, { at: number; callback: () => void }>();
  now = () => this.time;
  schedule = (callback: () => void, delayMs: number) => {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return () => { this.timers.delete(id); };
  };
  advance(ms: number) {
    const end = this.time + ms;
    for (;;) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.time = end;
  }
}

const idle = (owner = 'worker', generation = 'g1', patch: Partial<DesktopOwnerActivity> = {}): DesktopOwnerActivity => ({
  owner, generation, complete: true, starting: 0, queued: 0, running: 0,
  settling: 0, approvals: 0, retained: 0, unknown: [], ...patch,
});

function fixture(options: Partial<DesktopRestartAuthorityOptions> = {}) {
  const clock = new Clock();
  const owner: { generation: string; reads: number; read: () => unknown | Promise<unknown> } = {
    generation: 'g1', reads: 0, read: () => idle('worker', owner.generation),
  };
  const authority = new DesktopRestartAuthority({
    requiredOwners: ['worker'],
    ownerReaders: { worker: { getGeneration: () => owner.generation, read: () => { owner.reads++; return owner.read(); } } },
    now: clock.now, schedule: clock.schedule, randomToken: () => 'deterministic-entropy',
    ...options,
  });
  return { authority, clock, owner };
}

const attempt = { attemptId: 'attempt-1', epoch: 'native-1' };
function prepared(result: DesktopRestartPrepareResult): asserts result is Extract<DesktopRestartPrepareResult, { ok: true }> {
  assert.equal(result.ok, true, JSON.stringify(result));
}
function fenced(authority: DesktopRestartAuthority) {
  assert.throws(() => authority.enter('http:start'), { code: 'DESKTOP_RESTART_FENCED' });
}
// Only flush in-memory promise reactions; never launch a server or read app data.
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('idle prepare fences synchronously, returns a bound expiring token, and commits after a fresh read', async () => {
  const { authority, clock, owner } = fixture();
  assert.equal((await authority.snapshot()).idle, true);
  const pending = authority.prepare(attempt);
  assert.equal(authority.state, 'preparing');
  fenced(authority);
  const result = await pending;
  prepared(result);
  assert.equal(result.attemptId, attempt.attemptId);
  assert.equal(result.epoch, attempt.epoch);
  assert.equal(result.expiresAt, clock.time + 10_000);
  assert.equal(result.snapshot.state, 'prepared');
  assert.equal(result.snapshot.complete, true);
  assert.equal(clock.timers.size, 1);
  const previousReads = owner.reads;
  const committing = authority.commit(result.token, attempt.epoch);
  fenced(authority);
  assert.deepEqual(await committing, { ok: true, state: 'committed', ...attempt });
  assert.equal(owner.reads, previousReads + 1);
  assert.equal(clock.timers.size, 0);
});

test('known ingress returns busy immediately without waiting for any owner reader', async () => {
  const { authority, owner } = fixture();
  const release = authority.enter('ws:chat.send');
  owner.read = () => new Promise(() => {});
  const result = await authority.prepare(attempt);
  assert.deepEqual(result, { ok: false, code: 'busy', blockers: [{ kind: 'busy', code: 'ingress_busy' }] });
  assert.equal(owner.reads, 0);
  assert.equal(authority.state, 'open');
  release();
});

test('owned completion may finish under a reversible fence but invalidates its prepared proof', async () => {
  const { authority } = fixture();
  const result = await authority.prepare(attempt);
  prepared(result);
  const release = authority.enterCompletion('ws:approval');
  release();
  const committed = await authority.commit(result.token, attempt.epoch);
  assert.equal(committed.ok, false);
  assert.equal(authority.state, 'open');
});

test('completion arriving during preparation cannot disappear behind a zero ingress count', async () => {
  const { authority, owner } = fixture();
  const read = deferred<DesktopOwnerActivity>();
  owner.read = () => read.promise;
  const pending = authority.prepare(attempt);
  const release = authority.enterCompletion('ws:abort');
  release();
  read.resolve(idle());
  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.blockers.some((blocker) => blocker.code === 'activity_changed'));
});

test('committed shutdown rejects even a formerly owned completion', async () => {
  const { authority } = fixture();
  const result = await authority.prepare(attempt);
  prepared(result);
  assert.equal((await authority.commit(result.token, attempt.epoch)).ok, true);
  assert.throws(() => authority.enterCompletion('ws:approval'), { code: 'DESKTOP_RESTART_FENCED' });
});

for (const count of ['starting', 'queued', 'running', 'settling', 'approvals', 'retained'] as const) {
  test(`owner ${count} blocks prepare without cancelling work`, async () => {
    const { authority, owner } = fixture();
    const value = idle('worker', 'g1', { [count]: 1 });
    owner.read = () => value;
    const result = await authority.prepare(attempt);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'busy');
    assert.equal(value[count], 1);
    assert.equal(authority.state, 'open');
  });
}

test('fixed required owner list does not silently lose missing or subsequently remapped readers', async () => {
  const requiredOwners = ['worker', 'pty'];
  const ownerReaders = { worker: { getGeneration: () => 'g1', read: () => idle() } };
  const { authority } = fixture({ requiredOwners, ownerReaders });
  requiredOwners.pop();
  ownerReaders.worker.read = () => idle('worker', 'g1', { running: 5 });
  const result = await authority.snapshot();
  assert.equal(result.complete, false);
  assert.equal(result.idle, false);
  assert.deepEqual(result.owners, [idle()]);
  assert.ok(result.blockers.some((item) => item.owner === 'pty' && item.code === 'owner_missing'));
  assert.equal((await authority.prepare(attempt)).ok, false);
});

test('empty, duplicate, malformed owner lists and out-of-budget timeouts reject configuration', () => {
  for (const requiredOwners of [[], ['worker', 'worker'], [''], ['x'.repeat(129)]]) {
    assert.throws(() => fixture({ requiredOwners }), TypeError);
  }
  for (const readTimeoutMs of [0, -1, 0.5, 5_001, Number.NaN, Infinity]) {
    assert.throws(() => fixture({ readTimeoutMs }), TypeError);
  }
  for (const tokenTtlMs of [0, -1, 10_001, Infinity]) assert.throws(() => fixture({ tokenTtlMs }), TypeError);
});

test('owner snapshot validation rejects malformed values and does not evaluate activity getters', async (t) => {
  const missing = { ...idle() } as Partial<DesktopOwnerActivity>;
  delete missing.retained;
  let getterCalled = false;
  const getter = { ...idle() };
  Object.defineProperty(getter, 'running', { enumerable: true, get() { getterCalled = true; return 0; } });
  const cases: unknown[] = [null, [], {}, missing, { ...idle(), extra: true }, idle('other'),
    { ...idle(), complete: 1 }, { ...idle(), unknown: [''] }, { ...idle(), unknown: new Array(1) },
    { ...idle(), unknown: ['a'.repeat(129)] }, { ...idle(), unknown: new Array(33).fill('unknown') },
    { ...idle(), generation: '' }, { ...idle(), [Symbol('extra')]: true }, getter, Object.create(idle())];
  for (const field of ['starting', 'queued', 'running', 'settling', 'approvals', 'retained']) {
    for (const value of [-1, 0.1, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null]) {
      cases.push({ ...idle(), [field]: value });
    }
  }
  for (const [index, value] of cases.entries()) {
    await t.test(`invalid snapshot ${index}`, async () => {
      const { authority, owner } = fixture();
      owner.read = () => value;
      const result = await authority.snapshot();
      assert.equal(result.complete, false);
      assert.equal(result.idle, false);
      assert.ok(result.blockers.some((item) => item.code === 'owner_invalid'));
    });
  }
  assert.equal(getterCalled, false);
});

test('failed and incomplete readers remain unknown without exposing their exception payload', async () => {
  for (const read of [
    () => { throw new Error('SENTINEL-private-data'); },
    () => Promise.reject(new Error('SENTINEL-private-data')),
    () => idle('worker', 'g1', { complete: false }),
    () => idle('worker', 'g1', { unknown: ['cleanup_unconfirmed'] }),
  ]) {
    const { authority, owner } = fixture();
    owner.read = read;
    const result = await authority.prepare(attempt);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'unknown');
    assert.doesNotMatch(JSON.stringify(result), /SENTINEL/);
    assert.equal(authority.state, 'open');
  }
});

test('incorrect or failed generation observations are unknown', async () => {
  for (const getGeneration of [() => 'g2', () => '', () => { throw new Error('private'); }]) {
    const { authority } = fixture({ ownerReaders: { worker: { getGeneration, read: () => idle() } } });
    assert.equal((await authority.snapshot()).complete, false);
  }
});

test('snapshot copies validated values and unknown codes instead of retaining mutable owner references', async () => {
  const { authority, owner } = fixture();
  const value = idle('worker', 'g1', { unknown: ['pending_cleanup'] });
  owner.read = () => value;
  const snapshot = await authority.snapshot();
  value.running = 42;
  (value.unknown as string[]).push('late_change');
  assert.equal(snapshot.owners[0]?.running, 0);
  assert.deepEqual(snapshot.owners[0]?.unknown, ['pending_cleanup']);
});

test('all owner reads share a bounded deadline and late results cannot prepare a token', async () => {
  const pending = deferred<unknown>();
  const { authority, owner, clock } = fixture();
  owner.read = () => pending.promise;
  const preparing = authority.prepare(attempt);
  clock.advance(5_000);
  const result = await preparing;
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.blockers.some((item) => item.code === 'owner_timeout'));
  assert.equal(authority.state, 'open');
  pending.resolve(idle());
  await tick();
  assert.equal(authority.state, 'open');
  assert.equal(clock.timers.size, 0);
});

test('a reader completing after its deadline is rejected even before a delayed timer callback runs', async () => {
  const { authority, owner, clock } = fixture();
  owner.read = () => { clock.time += 5_001; return idle(); };
  const result = await authority.prepare(attempt);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.blockers.some((item) => item.code === 'owner_timeout'));
});

test('the prepare budget includes time after aggregate collection and token generation', async () => {
  const first = fixture();
  const snapshot = first.authority.snapshot.bind(first.authority);
  first.authority.snapshot = async () => { const value = await snapshot(); first.clock.time += 5_000; return value; };
  const late = await first.authority.prepare(attempt);
  assert.equal(late.ok, false);
  if (!late.ok) assert.ok(late.blockers.some((item) => item.code === 'snapshot_timeout'));
  const clock = new Clock();
  const second = fixture({ now: clock.now, schedule: clock.schedule, randomToken: () => { clock.time += 5_000; return 'nonce'; } });
  assert.equal((await second.authority.prepare(attempt)).ok, false);
  assert.equal(second.authority.state, 'open');
});

test('an earlier owner changing while another read awaits invalidates the entire aggregate', async () => {
  let generation = 'g1';
  const pending = deferred<unknown>();
  const { authority } = fixture({ requiredOwners: ['worker', 'pty'], ownerReaders: {
    worker: { getGeneration: () => generation, read: () => idle() },
    pty: { getGeneration: () => 'p1', read: () => pending.promise },
  } });
  const preparing = authority.prepare(attempt);
  await tick();
  generation = 'g2';
  pending.resolve(idle('pty', 'p1'));
  const result = await preparing;
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.blockers.some((item) => item.code === 'owner_stale' && item.owner === 'worker'));
});

test('admission racing an unfenced diagnostic snapshot is observable even after its lease releases', async () => {
  const pending = deferred<unknown>();
  const { authority, owner } = fixture();
  owner.read = () => pending.promise;
  const snapshot = authority.snapshot();
  const release = authority.enter('ws:chat.send');
  release();
  pending.resolve(idle());
  const result = await snapshot;
  assert.equal(result.ingress, 0);
  assert.equal(result.idle, false);
  assert.ok(result.blockers.some((item) => item.code === 'activity_changed'));
});

test('duplicate concurrent prepare shares a single attempt; other attempts cannot displace its fence', async () => {
  const pending = deferred<unknown>();
  const { authority, owner } = fixture();
  owner.read = () => pending.promise;
  const first = authority.prepare(attempt);
  assert.equal(authority.prepare({ ...attempt }), first);
  assert.deepEqual(await authority.prepare({ ...attempt, attemptId: 'other' }), { ok: false, code: 'in_progress', blockers: [] });
  assert.equal(owner.reads, 1);
  fenced(authority);
  pending.resolve(idle());
  const result = await first;
  prepared(result);
  assert.equal(authority.prepare(attempt), first);
  authority.cancel(result.token);
});

test('new admission is rejected from inside owner reads during prepare and commit', async () => {
  const { authority, owner } = fixture();
  owner.read = () => { fenced(authority); return idle(); };
  const result = await authority.prepare(attempt);
  prepared(result);
  assert.equal((await authority.commit(result.token, attempt.epoch)).ok, true);
  fenced(authority);
});

test('commit rejects busy owners and preserves an independent health failure across update cancellation', async () => {
  const { authority, owner } = fixture();
  let healthy = true;
  owner.read = () => idle('worker', 'g1', healthy ? {} : { complete: false, unknown: ['health_failure'] });
  const result = await authority.prepare(attempt);
  prepared(result);
  healthy = false;
  const committed = await authority.commit(result.token, attempt.epoch);
  assert.equal(committed.ok, false);
  authority.cancel(result.token);
  authority.controllerLost(attempt.epoch);
  assert.equal(healthy, false);
  assert.equal((await authority.prepare({ attemptId: 'next', epoch: 'native-2' })).ok, false);
  assert.equal((await authority.snapshot()).idle, false);
});

test('busy activity appearing at commit never reaches committed', async () => {
  const { authority, owner } = fixture();
  const result = await authority.prepare(attempt);
  prepared(result);
  owner.read = () => idle('worker', 'g1', { retained: 1 });
  const committed = await authority.commit(result.token, attempt.epoch);
  assert.equal(committed.ok, false);
  if (!committed.ok) assert.equal(committed.code, 'busy');
  assert.equal(authority.state, 'open');
});

test('owner generation changing between prepare and commit requires a fresh attempt even if idle again', async () => {
  const { authority, owner } = fixture();
  const result = await authority.prepare(attempt);
  prepared(result);
  owner.generation = 'g2';
  const committed = await authority.commit(result.token, attempt.epoch);
  assert.equal(committed.ok, false);
  if (!committed.ok) assert.ok(committed.blockers.some((item) => item.code === 'owner_stale'));
});

test('commit checks generation again after the aggregate promise resolves', async () => {
  const { authority, owner } = fixture();
  const result = await authority.prepare(attempt);
  prepared(result);
  const snapshot = authority.snapshot.bind(authority);
  // Model the microtask boundary after collecting real snapshots, not a fake idle result.
  authority.snapshot = async () => { const value = await snapshot(); owner.generation = 'g2'; return value; };
  assert.equal((await authority.commit(result.token, attempt.epoch)).ok, false);
  assert.equal(authority.state, 'open');
});

test('invalid token or controller epoch cannot cancel, replace, or commit the prepared attempt', async () => {
  const { authority } = fixture();
  for (const input of [{ attemptId: '', epoch: 'native-1' }, { attemptId: 'a', epoch: '' }]) {
    assert.equal((await authority.prepare(input)).ok, false);
  }
  const result = await authority.prepare(attempt);
  prepared(result);
  assert.equal((await authority.commit(result.token, 'native-other')).ok, false);
  assert.equal((await authority.commit('invalid', attempt.epoch)).ok, false);
  authority.cancel('invalid');
  authority.controllerLost('native-other');
  assert.equal(authority.state, 'prepared');
  assert.equal((await authority.commit(result.token, attempt.epoch)).ok, true);
});

test('expiry reopens only the reversible fence and invalidates the old token', async () => {
  const { authority, clock } = fixture();
  const result = await authority.prepare(attempt);
  prepared(result);
  clock.advance(9_999);
  fenced(authority);
  clock.advance(1);
  assert.equal(authority.state, 'open');
  assert.equal((await authority.commit(result.token, attempt.epoch)).ok, false);
  authority.enter('http:start')();
  const next = await authority.prepare(attempt);
  prepared(next);
  assert.notEqual(next.token, result.token); // same injected entropy is still attempt-specific
  authority.cancel(result.token);
  assert.equal(authority.state, 'prepared');
  authority.cancel(next.token);
});

test('commit awaiting a snapshot cannot outlive token expiry', async () => {
  const { authority, owner, clock } = fixture({ readTimeoutMs: 100, tokenTtlMs: 50 });
  const result = await authority.prepare(attempt);
  prepared(result);
  const pending = deferred<unknown>();
  owner.read = () => pending.promise;
  const committing = authority.commit(result.token, attempt.epoch);
  clock.advance(50);
  assert.equal((await committing).ok, false);
  pending.resolve(idle());
  await tick();
  assert.equal(authority.state, 'open');
});

test('commit also checks expiry after its asynchronous snapshot, without requiring timer delivery', async () => {
  const { authority, clock } = fixture();
  const result = await authority.prepare(attempt);
  prepared(result);
  const snapshot = authority.snapshot.bind(authority);
  authority.snapshot = async () => { const value = await snapshot(); clock.time += 10_000; return value; };
  assert.equal((await authority.commit(result.token, attempt.epoch)).ok, false);
  assert.equal(authority.state, 'open');
});

test('commit exceeding the snapshot budget fails even while its token has time remaining', async () => {
  const { authority, clock } = fixture();
  const result = await authority.prepare(attempt);
  prepared(result);
  const snapshot = authority.snapshot.bind(authority);
  authority.snapshot = async () => { const value = await snapshot(); clock.time += 5_001; return value; };
  const committed = await authority.commit(result.token, attempt.epoch);
  assert.equal(committed.ok, false);
  if (!committed.ok) assert.ok(committed.blockers.some((item) => item.code === 'snapshot_timeout'));
  assert.equal(authority.state, 'open');
});

test('a failed commit snapshot is unknown and never clears its owner health failure', async () => {
  const { authority, owner, clock } = fixture();
  const result = await authority.prepare(attempt);
  prepared(result);
  const pending = deferred<unknown>();
  owner.read = () => pending.promise;
  const committing = authority.commit(result.token, attempt.epoch);
  clock.advance(5_000);
  const failed = await committing;
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.ok(failed.blockers.some((item) => item.code === 'owner_timeout'));
  assert.equal(authority.state, 'open');
  pending.reject(new Error('late private failure'));
  await tick();
  owner.read = () => idle('worker', 'g1', { unknown: ['cleanup_unconfirmed'] });
  assert.equal((await authority.prepare({ ...attempt, attemptId: 'retry' })).ok, false);
});

test('controller loss while a commit is in flight is precommit cancellation, not restart', async () => {
  const { authority, owner } = fixture();
  const result = await authority.prepare(attempt);
  prepared(result);
  const pending = deferred<unknown>();
  owner.read = () => pending.promise;
  const committing = authority.commit(result.token, attempt.epoch);
  authority.controllerLost(attempt.epoch);
  assert.equal((await committing).ok, false);
  authority.enter('http:start')();
  pending.resolve(idle());
  await tick();
  assert.equal(authority.state, 'open');
});

test('controller loss while preparing rejects promptly and late snapshots cannot displace a new attempt', async () => {
  const { authority, owner } = fixture();
  const pending = deferred<unknown>();
  owner.read = () => pending.promise;
  const first = authority.prepare(attempt);
  authority.controllerLost(attempt.epoch);
  assert.equal((await first).ok, false);
  authority.enter('http:start')();
  assert.equal((await authority.prepare(attempt)).ok, false);
  owner.read = () => idle();
  const second = await authority.prepare({ attemptId: 'next', epoch: 'native-2' });
  prepared(second);
  pending.resolve(idle());
  await tick();
  assert.equal(authority.state, 'prepared');
  assert.equal((await authority.commit(second.token, second.epoch)).ok, true);
});

test('cancel while commit reads releases only that fence; late commit cannot interrupt newly admitted work', async () => {
  const { authority, owner } = fixture();
  const result = await authority.prepare(attempt);
  prepared(result);
  const pending = deferred<unknown>();
  owner.read = () => pending.promise;
  const committing = authority.commit(result.token, attempt.epoch);
  authority.cancel(result.token);
  const release = authority.enter('http:accepted-after-cancel');
  assert.equal((await committing).ok, false);
  pending.resolve(idle());
  await tick();
  assert.equal(authority.state, 'open');
  assert.equal((await authority.snapshot()).ingress, 1);
  release();
});

test('concurrent commit shares its read and committed never reopens for cancel, expiry or controller loss', async () => {
  const { authority, owner, clock } = fixture();
  const result = await authority.prepare(attempt);
  prepared(result);
  const pending = deferred<unknown>();
  owner.read = () => pending.promise;
  const first = authority.commit(result.token, attempt.epoch);
  assert.equal(authority.commit(result.token, attempt.epoch), first);
  pending.resolve(idle());
  assert.equal((await first).ok, true);
  authority.cancel(result.token);
  authority.cancel(result.token);
  authority.controllerLost(attempt.epoch);
  clock.advance(20_000);
  assert.equal(authority.state, 'committed');
  fenced(authority);
  assert.equal((await authority.prepare({ attemptId: 'next', epoch: 'native-2' })).ok, false);
  assert.equal((await authority.commit(result.token, attempt.epoch)).ok, true);
});

test('caller-mutated prepare snapshot cannot rewrite the internally retained generation proof', async () => {
  const { authority, owner } = fixture();
  const result = await authority.prepare(attempt);
  prepared(result);
  result.snapshot.owners[0]!.generation = 'g2';
  owner.generation = 'g2';
  assert.equal((await authority.commit(result.token, attempt.epoch)).ok, false);
});

test('lease release is idempotent and guard retains ownership through asynchronous work and failures', async () => {
  const { authority } = fixture();
  const release = authority.enter('http:start');
  release(); release();
  assert.equal((await authority.snapshot()).ingress, 0);
  const pending = deferred<number>();
  const guarded = authority.guard('internal:work', () => pending.promise);
  assert.equal((await authority.snapshot()).ingress, 1);
  assert.equal((await authority.prepare(attempt)).ok, false);
  pending.resolve(42);
  assert.equal(await guarded, 42);
  await assert.rejects(authority.guard('internal:work', () => { throw new Error('failed'); }), /failed/);
  await assert.rejects(authority.guard('internal:work', () => Promise.reject(new Error('failed'))), /failed/);
  assert.equal((await authority.snapshot()).ingress, 0);
});

test('token generation failure reopens the update fence without returning a token', async () => {
  for (const randomToken of [() => '', () => { throw new Error('entropy unavailable'); }]) {
    const { authority } = fixture({ randomToken });
    assert.deepEqual(await authority.prepare(attempt), { ok: false, code: 'token_unavailable', blockers: [] });
    assert.equal(authority.state, 'open');
  }
});
