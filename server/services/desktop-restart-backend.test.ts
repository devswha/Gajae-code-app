import assert from 'node:assert/strict';
import test from 'node:test';

import { isRestartControlResult } from '../../shared/desktopRestartProtocol.js';

import { DesktopRestartAuthority } from './desktop-restart-authority.js';
import { DesktopRestartBackend } from './desktop-restart-backend.js';

const native = 'a'.repeat(64);
const id = 'b'.repeat(64);
const prepare = { action: 'prepare', attemptId: id, draftEpoch: 1, remainingMs: 5000 } as const;
const idle = () => ({ owner: 'worker', generation: 'worker:1', complete: true,
  starting: 0, queued: 0, running: 0, settling: 0, approvals: 0, retained: 0, unknown: [] });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

function fixture() {
  let time = 1000;
  const backend = new DesktopRestartBackend(() => time);
  let reads = 0;
  const reader = { read: (): unknown | Promise<unknown> => idle() };
  const authority = new DesktopRestartAuthority({ now: () => time,
    requiredOwners: ['worker', 'ui-drafts'], ownerReaders: {
      worker: { getGeneration: () => 'worker:1', read: () => { reads++; return reader.read(); } },
      'ui-drafts': backend.draftReader,
    } });
  backend.attachAuthority(authority);
  return { backend, authority, reader, readCount: () => reads, advance: (amount: number) => { time += amount; } };
}

test('unbound/malformed control cannot provide sealed UI evidence; status performs no owner reads', async () => {
  const f = fixture();
  assert.equal(f.backend.draftReader.read().complete, false);
  assert.equal((await f.backend.handle(prepare, native)).error, 'unauthorized');
  f.backend.bind(native);
  assert.equal((await f.backend.handle({ action: 'status' }, native)).state, 'open');
  assert.equal(f.readCount(), 0);
  assert.equal((await f.backend.handle({ ...prepare, install: '/tmp/foreign.app' } as never, native)).error, 'invalid_command');
  assert.equal(f.backend.draftReader.read().complete, false);
  assert.equal(f.readCount(), 0);
});

test('native sealed prepare and exact token commit fence work without invoking any shutdown', async () => {
  const f = fixture(); f.backend.bind(native);
  const before = f.backend.draftReader.getGeneration();
  const result = await f.backend.handle(prepare, native);
  assert.equal(result.ok, true); assert.equal(result.state, 'prepared'); assert.ok(result.token);
  assert.equal(isRestartControlResult(result), true);
  assert.notEqual(f.backend.draftReader.getGeneration(), before);
  assert.equal(f.backend.draftReader.read().complete, true);
  assert.throws(() => f.authority.enter('new:work'), { code: 'DESKTOP_RESTART_FENCED' });
  assert.equal((await f.backend.handle({ action: 'commit', attemptId: id, token: 'forged' }, native)).ok, false);
  assert.equal(f.authority.state, 'prepared');
  const committed = await f.backend.handle({ action: 'commit', attemptId: id, token: result.token! }, native);
  assert.equal(committed.state, 'committed'); assert.equal(committed.ok, true);
  assert.equal(committed.token, null);
  assert.equal((await f.backend.handle({ action: 'cancel', attemptId: id }, native)).error, 'committed');
  assert.throws(() => f.authority.enterCompletion('late:completion'), { code: 'DESKTOP_RESTART_FENCED' });
});

test('busy runtime reopens without discarding work and a consumed draft epoch cannot be replayed', async () => {
  const f = fixture(); f.backend.bind(native);
  const release = f.authority.enter('accepted:work');
  assert.equal((await f.backend.handle(prepare, native)).error, 'busy');
  assert.equal(f.backend.draftReader.read().complete, false);
  assert.equal((await f.authority.snapshot()).ingress, 1);
  release();
  assert.equal((await f.backend.handle(prepare, native)).error, 'stale_epoch');
  const fresh = await f.backend.handle({ ...prepare, draftEpoch: 2, attemptId: 'c'.repeat(64) }, native);
  assert.equal(fresh.ok, true);
  await f.backend.handle({ action: 'cancel', attemptId: 'c'.repeat(64) }, native);
});

test('cancel during asynchronous prepare rejects late completion without reviving UI evidence', async () => {
  const f = fixture(); f.backend.bind(native);
  const held = deferred<unknown>(); f.reader.read = () => held.promise;
  const pending = f.backend.handle(prepare, native);
  await tick();
  assert.equal(f.authority.state, 'preparing');
  const cancelled = await f.backend.handle({ action: 'cancel', attemptId: id }, native);
  assert.equal(cancelled.ok, true); assert.equal(cancelled.state, 'open');
  assert.equal((await pending).ok, false);
  const release = f.authority.enter('new:work');
  held.resolve(idle()); await tick();
  assert.equal(f.authority.state, 'open');
  assert.equal(f.backend.draftReader.read().complete, false);
  release();
});

test('controller loss during commit reopens precommit but never reopens a completed commit', async () => {
  for (const finish of [false, true]) {
    const f = fixture(); f.backend.bind(native);
    const prepared = await f.backend.handle(prepare, native); assert.ok(prepared.token);
    if (finish) {
      assert.equal((await f.backend.handle({ action: 'commit', attemptId: id, token: prepared.token! }, native)).ok, true);
      f.backend.disconnected(native);
      assert.equal(f.authority.state, 'committed');
      assert.throws(() => f.authority.enter('work'), { code: 'DESKTOP_RESTART_FENCED' });
    } else {
      const held = deferred<unknown>(); f.reader.read = () => held.promise;
      const pending = f.backend.handle({ action: 'commit', attemptId: id, token: prepared.token! }, native);
      await tick(); f.backend.disconnected(native);
      assert.equal((await pending).ok, false);
      held.resolve(idle()); await tick();
      assert.equal(f.authority.state, 'open');
    }
    assert.throws(() => f.backend.bind('c'.repeat(64)), /retired/u);
  }
});

test('expiry and intervening owned completion invalidate a prepared token', async () => {
  for (const expire of [false, true]) {
    const f = fixture(); f.backend.bind(native);
    const prepared = await f.backend.handle(prepare, native); assert.ok(prepared.token);
    if (expire) f.advance(10_000);
    else { const release = f.authority.enterCompletion('notification:accepted'); release(); }
    const result = await f.backend.handle({ action: 'commit', attemptId: id, token: prepared.token! }, native);
    assert.equal(result.ok, false); assert.equal(result.state, 'open');
    assert.equal(f.backend.draftReader.read().complete, false);
  }
});

test('stale epoch disconnect cannot cancel a current native owner', async () => {
  const f = fixture(); f.backend.bind(native);
  const result = await f.backend.handle(prepare, native);
  f.backend.disconnected('c'.repeat(64));
  assert.equal(f.authority.state, 'prepared');
  assert.equal((await f.backend.handle({ action: 'commit', attemptId: id, token: result.token! }, 'c'.repeat(64))).ok, false);
  assert.equal(f.authority.state, 'prepared');
  await f.backend.handle({ action: 'cancel', attemptId: id }, native);
});
