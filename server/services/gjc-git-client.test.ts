import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';

import { GjcGitClient, NativeActivityGroup, type GjcNativeSpawn } from './gjc-git-client.js';

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stdin = new EventEmitter() as EventEmitter & { writes: string[]; write(data: string): boolean; end(): void };
  kills = 0;
  constructor() { super(); this.stdin.writes = []; this.stdin.write = (data) => (this.stdin.writes.push(data), true); this.stdin.end = () => {}; }
  kill(): boolean { this.kills += 1; return true; }
  emitFrame(frame: unknown): void { this.stdout.emit('data', Buffer.from(`${JSON.stringify(frame)}\n`)); }
}
function spawn(children: FakeChild[]): GjcNativeSpawn { return ((_command, _args, _options) => { const child = new FakeChild(); children.push(child); return child; }) as GjcNativeSpawn; }
function requestId(child: FakeChild, index = -1): string { return JSON.parse(child.stdin.writes.at(index)!).id; }
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function waitForChild(children: FakeChild[], index: number): Promise<FakeChild> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const child = children[index];
    if (child) return child;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for fake child ${index}.`);
}

async function ready(client: GjcGitClient, children: FakeChild[]): Promise<FakeChild> {
  const pending = client.start(); const child = children.at(-1)!;
  child.emitFrame({ protocolVersion: 1, kind: 'ready' });
  await pending;
  return child;
}

test('native ownership spans startup, request settlement and confirmed close without forced idle', async () => {
  const group = new NativeActivityGroup(); const children: FakeChild[] = [];
  const client = new GjcGitClient({ workdir: '/fixture', spawn: spawn(children), activityGroup: group });
  const initial = group.getGeneration();
  const starting = client.start();
  assert.equal(group.read().starting, 1);
  assert.notEqual(group.getGeneration(), initial);
  const child = children[0]!; child.emitFrame({ protocolVersion: 1, kind: 'ready' }); await starting;
  assert.equal(group.read().running, 0);
  const operation = client.status(); await tick();
  assert.ok(group.read().running > 0);
  child.emitFrame({ protocolVersion: 1, kind: 'response', id: requestId(child), ok: true, result: {} });
  assert.ok(group.read().running > 0, 'response is not settlement of the awaiting continuation');
  await operation; assert.equal(group.read().running, 0);
  client.close(); assert.equal(group.read().settling, 1);
  child.emit('close'); assert.equal(group.read().settling, 0);
  assert.equal(group.read().complete, true);
});

test('failed Git work remains uncertain after losing and closing its leader', async () => {
  const group = new NativeActivityGroup(); const children: FakeChild[] = [];
  const client = new GjcGitClient({ workdir: '/fixture', spawn: spawn(children), activityGroup: group });
  const child = await ready(client, children);
  const operation = client.create({}); await tick(); child.emit('exit', 1);
  await assert.rejects(operation); client.close(); child.emit('close');
  assert.equal(group.read().complete, false);
  assert.deepEqual(group.read().unknown, ['native_work_termination_unconfirmed']);
});

test('git assembles staged list items and multi-chunk diff responses', async () => {
  const children: FakeChild[] = []; const client = new GjcGitClient({ workdir: '/repo', spawn: spawn(children) });
  const child = await ready(client, children);
  const listed = client.list(); await tick(); const listId = requestId(child);
  child.emitFrame({ protocolVersion: 1, kind: 'item', id: listId, sequence: 0, item: { path: 'a' } });
  child.emitFrame({ protocolVersion: 1, kind: 'item', id: listId, sequence: 1, item: { path: 'b' } });
  child.emitFrame({ protocolVersion: 1, kind: 'response', id: listId, ok: true, result: { count: 2 } });
  assert.deepEqual(await listed, { count: 2, items: [{ path: 'a' }, { path: 'b' }] });
  const diff = client.diff(); await tick(); const diffId = requestId(child);
  assert.equal(JSON.parse(child.stdin.writes.at(-1)!).method, 'diff');
  child.emitFrame({ protocolVersion: 1, kind: 'chunk', id: diffId, sequence: 0, encoding: 'base64', data: Buffer.from('one ').toString('base64') });
  child.emitFrame({ protocolVersion: 1, kind: 'chunk', id: diffId, sequence: 1, encoding: 'base64', data: Buffer.from('two').toString('base64') });
  child.emitFrame({ protocolVersion: 1, kind: 'response', id: diffId, ok: true, result: { bytes: 7, chunks: 2, truncated: false } });
  assert.deepEqual(await diff, { bytes: 7, chunks: 2, truncated: false, patch: Buffer.from('one two') });
  client.close();
});

test('git rejects malformed frames, oversized aggregate streams, and kills the bad child', async () => {
  const malformedChildren: FakeChild[] = []; const malformed = new GjcGitClient({ workdir: '/repo', spawn: spawn(malformedChildren), restartDelayMs: 1 });
  const malformedRequest = malformed.list(); const bad = malformedChildren[0]!;
  bad.stdout.emit('data', Buffer.from('bad\n'));
  await assert.rejects(malformedRequest); assert.equal(bad.kills, 1); malformed.close();

  const children: FakeChild[] = []; const client = new GjcGitClient({ workdir: '/repo', spawn: spawn(children), restartDelayMs: 1 });
  const child = await ready(client, children); const pending = client.diff(); await tick(); const id = requestId(child);
  const data = Buffer.alloc(36 * 1024, 65).toString('base64');
  for (let sequence = 0; sequence <= 455; sequence += 1) child.emitFrame({ protocolVersion: 1, kind: 'chunk', id, sequence, encoding: 'base64', data });
  await assert.rejects(pending); assert.equal(child.kills, 1); client.close();
});

test('git ignores stale child close events after replacing a failed child', async () => {
  const children: FakeChild[] = []; const client = new GjcGitClient({ workdir: '/repo', spawn: spawn(children), restartDelayMs: 1 });
  const first = await ready(client, children);
  first.emit('exit', 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = children[1]!; second.emitFrame({ protocolVersion: 1, kind: 'ready' }); await tick();
  const pending = client.list(); await tick(); const id = requestId(second);
  first.emit('close');
  second.emitFrame({ protocolVersion: 1, kind: 'response', id, ok: true, result: { count: 0 } });
  assert.deepEqual(await pending, { count: 0, items: [] }); client.close();
});

test('git recovers from replacement spawn failure without hanging later requests', async () => {
  const children: FakeChild[] = []; let attempts = 0;
  const launcher = ((_command, _args, _options) => {
    attempts += 1;
    if (attempts === 2) throw new Error('replacement unavailable');
    const child = new FakeChild(); children.push(child); return child;
  }) as GjcNativeSpawn;
  const client = new GjcGitClient({ workdir: '/repo', spawn: launcher, restartDelayMs: 1 });
  const first = await ready(client, children); const failed = client.create({ branch: 'x' });
  first.emit('exit', 1); await assert.rejects(failed);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const pending = client.list(); const replacement = await waitForChild(children, 1);
  replacement.emitFrame({ protocolVersion: 1, kind: 'ready' }); await tick();
  const id = requestId(replacement); replacement.emitFrame({ protocolVersion: 1, kind: 'response', id, ok: true, result: { count: 0 } });
  assert.deepEqual(await pending, { count: 0, items: [] }); assert.equal(attempts, 3); client.close();
});
test('git serializes a request arriving during restart backoff onto the replacement generation', async () => {
  const children: FakeChild[] = []; const client = new GjcGitClient({ workdir: '/repo', spawn: spawn(children), restartDelayMs: 5 });
  const first = await ready(client, children);
  first.emit('exit', 1);
  const pending = client.list();
  assert.equal(children.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const replacement = children[1]!;
  replacement.emitFrame({ protocolVersion: 1, kind: 'ready' }); await tick();
  const id = requestId(replacement);
  replacement.emitFrame({ protocolVersion: 1, kind: 'response', id, ok: true, result: { count: 0 } });
  assert.deepEqual(await pending, { count: 0, items: [] });
  client.close();
});
