import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { WebSocket } from 'ws';

import { closeConnection, getConnection, gjcTerminalNotificationDispatchesDb, initializeDatabase, notificationChannelEndpointsDb, notificationPreferencesDb, userDb } from '@/modules/database/index.js';
import { configureNotificationDesktopAdmission, getNotificationActivityGeneration, snapshotNotificationActivity } from '@/modules/notifications/index.js';
import { enterNotificationActivity } from '@/modules/notifications/services/desktop-update-activity.service.js';
import { registerDesktopNotificationClient, sendDesktopNotification, unregisterDesktopNotificationClient } from '@/modules/notifications/services/desktop-notification-clients.service.js';
import { createGjcTerminalNotificationAdapter } from '@/modules/notifications/services/gjc-terminal-notification-adapter.service.js';
import { createNotificationEvent, notifyRunFailed, notifyRunStopped, notifyUserIfEnabled } from '@/modules/notifications/services/notification-orchestrator.service.js';
import { handleDesktopNotificationsConnection } from '@/modules/notifications/websocket/desktop-notifications-websocket.service.js';
import type { DesktopWorkAdmission } from '@/shared/interfaces.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

// The module consumes only the injected admission interface. The real restart
// authority's prepare/commit behavior is tested at its composition boundary.
class Admission implements DesktopWorkAdmission {
  fenced = false;
  committed = false;
  active = 0;
  enter(): () => void {
    if (this.fenced) throw Object.assign(new Error('Restart fenced.'), { code: 'DESKTOP_RESTART_FENCED' });
    return this.acquire();
  }
  enterCompletion(): () => void {
    if (this.committed) throw Object.assign(new Error('Restart fenced.'), { code: 'DESKTOP_RESTART_FENCED' });
    return this.acquire();
  }
  private acquire(): () => void {
    this.active++;
    let released = false;
    return () => { assert.equal(released, false, 'release exactly once'); released = true; this.active--; };
  }
  snapshot() {
    return { idle: this.active === 0 && snapshotNotificationActivity().running === 0, ingress: this.active };
  }
}

let authority: Admission | undefined;
const admission = {
  enter: () => authority?.enter() ?? (() => {}),
  enterCompletion: () => authority?.enterCompletion() ?? (() => {}),
};
configureNotificationDesktopAdmission(admission);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

class Socket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  delay = false;
  throwSend = false;
  frames: Array<Record<string, unknown>> = [];
  pending: Array<(error?: Error) => void> = [];
  send(message: string, callback?: (error?: Error) => void) {
    if (this.throwSend) throw new Error('socket send failed');
    const frame = JSON.parse(message) as Record<string, unknown>;
    this.frames.push(frame);
    if (callback && this.delay && frame.type === 'notification') this.pending.push(callback);
    else callback?.();
  }
  close() { this.readyState = 3; this.emit('close'); }
  complete(error?: Error) { for (const callback of this.pending.splice(0)) callback(error); }
  get ws() { return this as unknown as WebSocket; }
}

async function fixture(t: test.TestContext) {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(join(tmpdir(), 'notification-activity-'));
  closeConnection();
  process.env.DATABASE_PATH = join(directory, 'auth.db');
  await initializeDatabase();
  const userId = Number(userDb.createUser('notification-activity-user', 'hash').id);
  notificationPreferencesDb.updatePreferences(userId, {
    channels: { desktop: true }, events: { actionRequired: true, stop: true, error: true },
  });
  const current = new Admission();
  authority = current;
  const sockets: Socket[] = [];
  const socket = () => { const value = new Socket(); sockets.push(value); return value; };
  t.after(async () => {
    authority = undefined;
    for (const value of sockets) value.complete();
    await tick();
    for (const value of sockets) unregisterDesktopNotificationClient(value.ws);
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const connect = (value: Socket, deviceId = 'device-1') => {
    handleDesktopNotificationsConnection(value.ws, { user: { id: userId } } as AuthenticatedWebSocketRequest);
    value.emit('message', JSON.stringify({ type: 'register', deviceId }));
  };
  return { userId, authority: current, socket, connect };
}

const terminal = (id = 'terminal-1') => ({
  eventId: id, sequence: 1,
  payload: { schemaVersion: 1, kind: 'job_terminal', runId: 'run-1', appSessionId: 'app-1', outcome: 'succeeded', reason: 'completed' },
});
const dispatchRow = () => getConnection().prepare('SELECT status, failure FROM gjc_terminal_notification_dispatches').get() as { status: string; failure: string | null };

test('notification revision is pure, monotonic and release is idempotent', async (t) => {
  const f = await fixture(t);
  const before = snapshotNotificationActivity();
  configureNotificationDesktopAdmission(admission);
  assert.deepEqual(snapshotNotificationActivity(), before);
  assert.equal(getNotificationActivityGeneration(), before.generation);
  const release = enterNotificationActivity(false);
  const busy = snapshotNotificationActivity();
  assert.equal(busy.running, 1);
  assert.notEqual(busy.generation, before.generation);
  assert.equal(f.authority.snapshot().idle, false);
  release();
  const after = snapshotNotificationActivity();
  release();
  assert.deepEqual(snapshotNotificationActivity(), after);
  assert.deepEqual({ ...after, generation: before.generation }, before);
  assert.ok(BigInt(after.generation.split(':').at(-1)!) > BigInt(busy.generation.split(':').at(-1)!));
});

test('stop and failure notification facades return their delayed send lifetimes', async (t) => {
  const f = await fixture(t);
  const socket = f.socket(); socket.delay = true; f.connect(socket);
  const stopped = notifyRunStopped({ userId: f.userId, provider: 'gjc', stopReason: 'delayed stop' });
  const failed = notifyRunFailed({ userId: f.userId, provider: 'gjc', error: 'delayed failure' });
  assert.ok(stopped instanceof Promise);
  assert.ok(failed instanceof Promise);
  let settled = false;
  const both = Promise.all([stopped, failed]).then(() => { settled = true; });
  await tick();
  assert.equal(settled, false);
  assert.equal(socket.pending.length, 2);
  // Both facades and both underlying sends must still own their leases. A
  // premature outer finally would leave only the two transport leases here.
  assert.equal(snapshotNotificationActivity().running, 4);
  assert.equal(f.authority.snapshot().idle, false);
  socket.close();
  assert.equal(settled, false);
  assert.equal((await f.authority.snapshot()).idle, false);
  socket.complete();
  await both;
  assert.equal((await f.authority.snapshot()).idle, true);
});

test('the synchronous send tally remains owned after it is returned and a socket closes', async (t) => {
  const f = await fixture(t);
  const socket = f.socket(); socket.delay = true; f.connect(socket);
  const tally = sendDesktopNotification(f.userId, { data: { tag: 'queued-not-presented' } });
  assert.deepEqual(tally, { attempted: 1, sent: 1 });
  assert.equal('then' in tally, false);
  socket.close();
  await tick();
  assert.equal((await f.authority.snapshot()).idle, false);
  socket.complete(new Error('transport failed later'));
  await tick();
  assert.equal((await f.authority.snapshot()).idle, true);
  // It remains the original enqueue tally, never a claim of UI presentation.
  assert.deepEqual(tally, { attempted: 1, sent: 1 });
});

test('dedupe and disabled-event paths stay synchronous and do not release an earlier send', async (t) => {
  const f = await fixture(t);
  const socket = f.socket(); socket.delay = true; f.connect(socket);
  const event = { ...createNotificationEvent({ provider: 'gjc', kind: 'stop', code: 'run.stopped' }), dedupeKey: 'pending-dedupe' };
  const pending = notifyUserIfEnabled({ userId: f.userId, event });
  const active = snapshotNotificationActivity().running;
  assert.equal(active, 2);
  assert.equal(notifyUserIfEnabled({ userId: f.userId, event }), undefined);
  assert.equal(snapshotNotificationActivity().running, active);
  notificationPreferencesDb.updatePreferences(f.userId, { events: { stop: false } });
  assert.equal(notifyRunStopped({ userId: f.userId, provider: 'gjc', stopReason: 'disabled stop' }), undefined);
  assert.equal(snapshotNotificationActivity().running, active);
  assert.equal(socket.pending.length, 1);
  socket.complete();
  await pending;
  assert.equal((await f.authority.snapshot()).idle, true);
});

test('an existing socket fences each new registration but accepts owned close and inert acknowledgement', async (t) => {
  const f = await fixture(t);
  const socket = f.socket();
  handleDesktopNotificationsConnection(socket.ws, { user: { id: f.userId } } as AuthenticatedWebSocketRequest);
  assert.equal(f.authority.snapshot().idle, true);
  f.authority.fenced = true;
  assert.doesNotThrow(() => socket.emit('message', JSON.stringify({ type: 'register', deviceId: 'late-device' })));
  assert.equal(socket.frames.at(-1)?.code, 'DESKTOP_RESTART_FENCED');
  assert.deepEqual(notificationChannelEndpointsDb.getEndpoints(f.userId, 'desktop'), []);
  assert.throws(() => registerDesktopNotificationClient({ ws: socket.ws, userId: f.userId, deviceId: 'direct' }), { code: 'DESKTOP_RESTART_FENCED' });
  f.authority.fenced = false;
  socket.emit('message', JSON.stringify({ type: 'register', deviceId: 'late-device' }));
  assert.equal(socket.frames.at(-1)?.type, 'registered');
  assert.equal(f.authority.snapshot().idle, true);
  f.authority.fenced = true;
  const generation = getNotificationActivityGeneration();
  socket.emit('message', JSON.stringify({ type: 'notification_ack' }));
  assert.equal(getNotificationActivityGeneration(), generation);
  assert.doesNotThrow(() => socket.close());
  assert.notEqual(getNotificationActivityGeneration(), generation);
  assert.deepEqual(sendDesktopNotification(f.userId, {}), { attempted: 0, sent: 0 });
});

test('an owned notification may finish under a closed fence and changes the owner revision', async (t) => {
  const f = await fixture(t);
  const socket = f.socket(); socket.delay = true; f.connect(socket);
  assert.equal(f.authority.snapshot().idle, true);
  const generation = getNotificationActivityGeneration();
  f.authority.fenced = true;
  const pending = notifyRunStopped({ userId: f.userId, provider: 'gjc', stopReason: 'accepted before restart' });
  assert.ok(pending instanceof Promise);
  assert.equal(socket.pending.length, 1);
  socket.complete();
  await pending;
  assert.notEqual(getNotificationActivityGeneration(), generation);
});

test('late errors from a replaced socket do not remove the newly registered client', async (t) => {
  const f = await fixture(t);
  const first = f.socket(); first.delay = true; f.connect(first);
  sendDesktopNotification(f.userId, {});
  const replacement = f.socket(); f.connect(replacement);
  assert.equal(first.readyState, 3);
  first.complete(new Error('retired send failed'));
  await tick();
  assert.deepEqual(sendDesktopNotification(f.userId, {}), { attempted: 1, sent: 1 });
  assert.equal(replacement.frames.filter((frame) => frame.type === 'notification').length, 1);
  await tick();
  assert.equal((await f.authority.snapshot()).idle, true);
});

test('postcommit socket callbacks and synchronous send failures do not crash or leak activity', async (t) => {
  const f = await fixture(t);
  const socket = f.socket(); f.connect(socket); socket.throwSend = true;
  assert.deepEqual(sendDesktopNotification(f.userId, {}), { attempted: 1, sent: 0 });
  await tick();
  socket.throwSend = false;
  registerDesktopNotificationClient({ ws: socket.ws, userId: f.userId, deviceId: 'device-1' });
  assert.equal(f.authority.snapshot().idle, true);
  f.authority.fenced = true;
  f.authority.committed = true;
  assert.doesNotThrow(() => socket.close());
  assert.doesNotThrow(() => socket.emit('error', new Error('late socket error')));
  assert.throws(() => notifyRunFailed({ userId: f.userId, provider: 'gjc', error: 'not silently dropped after commit' }), { code: 'DESKTOP_RESTART_FENCED' });
});

test('terminal facade promises retain the claim until acceptance is durably decided', async (t) => {
  const f = await fixture(t);
  const delivery = deferred<void>();
  let sends = 0;
  const adapter = createGjcTerminalNotificationAdapter({
    authority: { replayEvents: async () => ({ events: [] }) }, resolveUserId: () => f.userId,
    notifications: { createNotificationEvent: (event) => event, notifyUserIfEnabled: () => { sends++; return delivery.promise; } },
  });
  const markAccepted = gjcTerminalNotificationDispatchesDb.markAccepted;
  t.mock.method(gjcTerminalNotificationDispatchesDb, 'markAccepted', (claim: string) => {
    assert.ok(snapshotNotificationActivity().running > 0);
    markAccepted(claim);
  });
  assert.equal(adapter.onCommittedEvent('job-1', terminal()), 'accepted');
  assert.equal(dispatchRow().status, 'claimed');
  assert.equal(adapter.onCommittedEvent('job-1', terminal()), 'deduped');
  assert.equal(sends, 1);
  assert.equal(f.authority.snapshot().idle, false);
  delivery.resolve();
  await tick();
  assert.equal(dispatchRow().status, 'accepted');
  assert.equal((await f.authority.snapshot()).idle, true);
});

test('a rejected terminal facade promise records failure before releasing and is not retried', async (t) => {
  const f = await fixture(t);
  const delivery = deferred<void>();
  const unhandled: unknown[] = [];
  const capture = (error: unknown) => { unhandled.push(error); };
  process.on('unhandledRejection', capture);
  t.after(() => process.off('unhandledRejection', capture));
  let sends = 0;
  const markFailed = gjcTerminalNotificationDispatchesDb.markFailed;
  t.mock.method(gjcTerminalNotificationDispatchesDb, 'markFailed', (claim: string, failure: string) => {
    assert.ok(snapshotNotificationActivity().running > 0);
    markFailed(claim, failure);
  });
  const adapter = createGjcTerminalNotificationAdapter({
    authority: { replayEvents: async () => ({ events: [] }) }, resolveUserId: () => f.userId,
    notifications: { createNotificationEvent: (event) => event, notifyUserIfEnabled: () => { sends++; return delivery.promise; } },
  });
  assert.equal(adapter.onCommittedEvent('job-1', terminal()), 'accepted');
  delivery.reject(new Error('asynchronous facade failed'));
  await tick();
  assert.equal(dispatchRow().status, 'failed');
  assert.match(dispatchRow().failure!, /asynchronous facade failed/);
  assert.equal(adapter.onCommittedEvent('job-1', terminal()), 'deduped');
  assert.equal(sends, 1);
  assert.deepEqual(unhandled, []);
  assert.equal((await f.authority.snapshot()).idle, true);
});

test('startup catch-up owns list, replay, facade and ledger settlement and rejects new scans while fenced', async (t) => {
  const f = await fixture(t);
  const listing = deferred<void>(); const delivery = deferred<void>(); const sending = deferred<void>();
  let listCalls = 0;
  const adapter = createGjcTerminalNotificationAdapter({
    authority: {
      list: async () => { listCalls++; await listing.promise; return [{ jobId: 'job-1', lastSequence: 0 }]; },
      replayEvents: async () => ({ events: [terminal()] }),
    }, resolveUserId: () => f.userId,
    notifications: { createNotificationEvent: (event) => event, notifyUserIfEnabled: () => { sending.resolve(); return delivery.promise; } },
  });
  const baseline = adapter.startupCatchUp();
  assert.equal(snapshotNotificationActivity().running, 1);
  assert.equal(f.authority.snapshot().idle, false);
  listing.resolve();
  await baseline;
  let caughtUp = false;
  const catchUp = adapter.startupCatchUp().then(() => { caughtUp = true; });
  await sending.promise;
  assert.equal(caughtUp, false);
  assert.equal(dispatchRow().status, 'claimed');
  assert.ok(snapshotNotificationActivity().running >= 2);
  delivery.resolve();
  await catchUp;
  assert.equal(dispatchRow().status, 'accepted');
  assert.equal((await f.authority.snapshot()).idle, true);
  f.authority.fenced = true;
  await assert.rejects(adapter.startupCatchUp(), { code: 'DESKTOP_RESTART_FENCED' });
  assert.equal(listCalls, 2);
});

test('failed startup list and synchronous facade failures release exactly once', async (t) => {
  const f = await fixture(t);
  const adapter = createGjcTerminalNotificationAdapter({
    authority: { list: async () => { throw new Error('list failed'); }, replayEvents: async () => ({ events: [] }) },
    resolveUserId: () => f.userId,
    notifications: { createNotificationEvent: (event) => event, notifyUserIfEnabled: () => { throw new Error('facade failed'); } },
  });
  await assert.rejects(adapter.startupCatchUp(), /list failed/);
  assert.equal(adapter.onCommittedEvent('job-1', terminal()), 'failed');
  assert.equal(dispatchRow().status, 'failed');
  assert.equal(snapshotNotificationActivity().running, 0);
  assert.equal((await f.authority.snapshot()).ingress, 0);
});
