import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';

import { GjcJobsClient, GjcJobsClientError, GjcJobsEventTooLargeError, createNativeJobsDesktopRestartReader } from './gjc-jobs-client.js';
import { NativeActivityGroup, type GjcNativeSpawn } from './gjc-git-client.js';

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stdin = new EventEmitter() as EventEmitter & { writes: string[]; write(data: string): boolean; end(): void };
  constructor() { super(); this.stdin.writes = []; this.stdin.write = (data) => (this.stdin.writes.push(data), true); this.stdin.end = () => {}; }
  kill(): boolean { return true; }
  frame(value: unknown): void { this.stdout.emit('data', Buffer.from(`${JSON.stringify(value)}\n`)); }
}
function fake(children: FakeChild[]): GjcNativeSpawn { return ((_command, _args, _options) => { const child = new FakeChild(); children.push(child); return child; }) as GjcNativeSpawn; }
const idAt = (child: FakeChild, position: number) => JSON.parse(child.stdin.writes[position]!).id as string;

test('native jobs activity never starts a process and does not invalidate its own generation', async () => {
  const children: FakeChild[] = []; const group = new NativeActivityGroup();
  const client = new GjcJobsClient({ database: '/fixture.sqlite', spawn: fake(children), activityGroup: group });
  const reader = createNativeJobsDesktopRestartReader(client);
  await assert.rejects(reader.read()); assert.equal(children.length, 0);
  const started = client.start(); const child = children[0]!;
  child.frame({ protocolVersion: 1, id: idAt(child, 0), ok: true, result: [] }); await started;
  const generation = reader.getGeneration(); const observed = reader.read();
  assert.equal(JSON.parse(child.stdin.writes.at(-1)!).method, 'job.activity');
  assert.equal(group.read().running, 0, 'readonly status is not new work');
  child.frame({ protocolVersion: 1, id: idAt(child, 1), ok: true, result: { schemaVersion: 1, reserved: 0, queued: 2, running: 1, aborting: 0, unknown: 0 } });
  const result = await observed;
  assert.equal(result.generation, generation); assert.equal(reader.getGeneration(), generation);
  assert.equal(result.queued, 2); assert.equal(result.running, 1); assert.equal(result.complete, true);
  client.close(); child.emit('close'); assert.equal(group.read().settling, 0);
});

test('native observation rejects malformed and unknown state without certifying idle', async () => {
  const children: FakeChild[] = []; const client = new GjcJobsClient({ database: '/fixture.sqlite', spawn: fake(children), activityGroup: new NativeActivityGroup() });
  const starting = client.start(); const child = children[0]!;
  child.frame({ protocolVersion: 1, id: idAt(child, 0), ok: true, result: [] }); await starting;
  const bad = client.snapshotDesktopActivity();
  child.frame({ protocolVersion: 1, id: idAt(child, 1), ok: true, result: { schemaVersion: 1, reserved: -1, queued: 0, running: 0, aborting: 0, unknown: 0 } });
  await assert.rejects(bad);
  const uncertain = client.snapshotDesktopActivity();
  child.frame({ protocolVersion: 1, id: idAt(child, 2), ok: true, result: { schemaVersion: 1, reserved: 0, queued: 0, running: 0, aborting: 0, unknown: 1 } });
  assert.equal((await uncertain).complete, false);
  client.close(); child.emit('close');
});

test('jobs proves readiness through job.list probe and dispatches wrappers', async () => {
  const children: FakeChild[] = []; const client = new GjcJobsClient({ database: '/jobs.sqlite', spawn: fake(children) });
  const pending = client.admit({ id: 'run' }); const child = children[0]!;
  assert.equal(JSON.parse(child.stdin.writes[0]!).method, 'job.list');
  child.frame({ protocolVersion: 1, id: idAt(child, 0), ok: true, result: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.parse(child.stdin.writes[1]!).method, 'job.admit');
  child.frame({ protocolVersion: 1, id: idAt(child, 1), ok: true, result: { admitted: true } });
  assert.deepEqual(await pending, { admitted: true });
  const dispatching = client.markDispatching({ id: 'run', run_id: 'r1' }); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.parse(child.stdin.writes[2]!).method, 'job.markDispatching');
  child.frame({ protocolVersion: 1, id: idAt(child, 2), ok: true, result: { currentRun: { runId: 'r1' }, dispatchCheckpoint: { dispatchedAt: 'now' } } });
  assert.deepEqual(await dispatching, { currentRun: { runId: 'r1' }, dispatchCheckpoint: { dispatchedAt: 'now' } });
  const reconciled = client.reconcile(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.parse(child.stdin.writes[3]!).method, 'job.reconcile');
  child.frame({ protocolVersion: 1, id: idAt(child, 3), ok: true, result: { changedCount: 1, jobIds: ['run'] } });
  assert.deepEqual(await reconciled, { changedCount: 1, jobIds: ['run'] });
  const admin = client.appendAdminEvent({ jobId: 'run', eventId: 'publish.started', payload: {} }); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.parse(child.stdin.writes[4]!).method, 'job.appendAdminEvent');
  child.frame({ protocolVersion: 1, id: idAt(child, 4), ok: true, result: { sequence: 1 } });
  assert.deepEqual(await admin, { sequence: 1 }); client.close();
});
test('jobs preserves native error codes in typed errors', async () => {
  const children: FakeChild[] = [];
  const client = new GjcJobsClient({ database: '/jobs.sqlite', spawn: fake(children) });
  const pending = client.readmit({ jobId: 'job-1' });
  const child = children[0]!;
  child.frame({ protocolVersion: 1, id: idAt(child, 0), ok: true, result: [] });
  await new Promise((resolve) => setImmediate(resolve));
  child.frame({ protocolVersion: 1, id: idAt(child, 1), ok: false, error: { code: 'capacity_exhausted' } });
  await assert.rejects(pending, (error: unknown) => error instanceof GjcJobsClientError && error.code === 'capacity_exhausted');
  client.close();
});

test('jobs rejects requests on EOF, restarts, and does not replay admission', async () => {
  const children: FakeChild[] = []; const client = new GjcJobsClient({ database: '/jobs.sqlite', spawn: fake(children), restartDelayMs: 1 });
  const pending = client.transition({ id: 'run' }); const first = children[0]!;
  first.frame({ protocolVersion: 1, id: idAt(first, 0), ok: true, result: [] });
  await new Promise((resolve) => setImmediate(resolve)); first.emit('close');
  await assert.rejects(pending); await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(children.length, 2); assert.equal(children[1]!.stdin.writes.length, 1); assert.equal(JSON.parse(children[1]!.stdin.writes[0]!).method, 'job.list'); client.close();
});

test('jobs rejects malformed frames and aggregate overflow', async () => {
  const malformedChildren: FakeChild[] = []; const malformed = new GjcJobsClient({ database: '/jobs.sqlite', spawn: fake(malformedChildren), restartDelayMs: 1 });
  const malformedRequest = malformed.list(); malformedChildren[0]!.stdout.emit('data', Buffer.from('{bad}\n'));
  await assert.rejects(malformedRequest); malformed.close();

  const children: FakeChild[] = []; const client = new GjcJobsClient({ database: '/jobs.sqlite', spawn: fake(children), restartDelayMs: 1, aggregateLimitBytes: 1 });
  const pending = client.list(); const child = children[0]!;
  child.frame({ protocolVersion: 1, id: idAt(child, 0), ok: true, result: [] });
  await new Promise((resolve) => setImmediate(resolve));
  child.frame({ protocolVersion: 1, kind: 'item', id: idAt(child, 1), sequence: 0, item: { too: 'large' } });
  await assert.rejects(pending); client.close();
});
test('jobs rejects oversized event frames before starting the shared authority', async () => {
  const children: FakeChild[] = []; const client = new GjcJobsClient({ database: '/jobs.sqlite', spawn: fake(children) });
  await assert.rejects(
    client.appendEvent({ jobId: 'job-1', payload: { content: 'x'.repeat(64 * 1024) } }),
    (error: unknown) => error instanceof GjcJobsEventTooLargeError && error.code === 'event_too_large',
  );
  assert.equal(children.length, 0);
  client.close();
});
test('jobs reports authority generation health across restart and successful probe', async () => {
  const children: FakeChild[] = []; const health: Array<[boolean, number]> = [];
  const client = new GjcJobsClient({ database: '/jobs.sqlite', spawn: fake(children), restartDelayMs: 1, onHealthChange: (healthy, generation) => health.push([healthy, generation]) });
  const pending = client.list(); const first = children[0]!;
  first.frame({ protocolVersion: 1, id: idAt(first, 0), ok: true, result: [] });
  await new Promise((resolve) => setImmediate(resolve));
  first.frame({ protocolVersion: 1, id: idAt(first, 1), ok: true, result: [] });
  await pending;
  first.emit('close');
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = children[1]!;
  second.frame({ protocolVersion: 1, id: idAt(second, 0), ok: true, result: [] });
  assert.deepEqual(health, [[true, 1], [false, 1], [true, 2]]);
  client.close();
});
