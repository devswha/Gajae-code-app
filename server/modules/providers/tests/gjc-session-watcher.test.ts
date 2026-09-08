import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { GjcSessionWatcher, type GjcSessionWatcherOptions } from '../services/gjc-session-watcher.service.js';

// The watcher service intentionally unrefs its internal timers so a shutting-down
// owner is never kept alive. Tests that await only those timers would let the
// event loop drain before they fire (observed on macOS), so hold one referenced
// handle for the lifetime of this file.
const keepAlive = setInterval(() => {}, 60_000);
after(() => clearInterval(keepAlive));

class FakeChild extends EventEmitter {
  readonly stdin = new EventEmitter() as EventEmitter & { end(): void };
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kills: (NodeJS.Signals | undefined)[] = [];

  constructor() {
    super();
    this.stdin.end = () => {};
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.kills.push(signal);
    return true;
  }

  output(value: string | Buffer): void {
    this.stdout.emit('data', value);
  }
}

type SpawnCall = { command: string; args: string[]; options: unknown };

function setup(overrides: Partial<GjcSessionWatcherOptions> = {}): { watcher: GjcSessionWatcher; child: FakeChild; calls: SpawnCall[]; events: { kind: 'add' | 'change'; path: string }[]; failures: Error[] } {
  const child = new FakeChild();
  const calls: SpawnCall[] = [];
  const events: { kind: 'add' | 'change'; path: string }[] = [];
  const failures: Error[] = [];
  const watcher = new GjcSessionWatcher({
    roots: ['/one', '/two'],
    onEvent: (event) => events.push(event),
    onFailure: (error) => failures.push(error),
    spawn: ((command: string, args: string[], options: unknown) => {
      calls.push({ command, args, options });
      return child;
    }) as never,
    readyTimeoutMs: 100,
    closeDrainTimeoutMs: 10,
    closeExitTimeoutMs: 10,
    ...overrides,
  });
  return { watcher, child, calls, events, failures };
}

async function ready(watcher: GjcSessionWatcher, child: FakeChild): Promise<void> {
  const started = watcher.start();
  child.output('{"protocolVersion":1,"kind":"ready"}\n');
  await started;
}

test('spawns the native watcher directly with all roots and no detached process', async () => {
  const { watcher, child, calls } = setup({ corePath: '/native/gajae-core', environment: { SAFE: '1' } });
  await ready(watcher, child);
  assert.deepEqual(calls, [{
    command: '/native/gajae-core',
    args: ['watch', '--root', '/one', '--root', '/two'],
    options: { detached: false, env: { SAFE: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  }]);
});

test('resolves source and compiled native core layouts', async () => {
  const source = setup({ compiled: false, platform: 'linux' });
  await ready(source.watcher, source.child);
  assert.equal(source.calls[0].command, fileURLToPath(new URL('../../../../dist-native/gajae-core', import.meta.url)));
  const compiled = setup({ compiled: true, platform: 'win32' });
  await ready(compiled.watcher, compiled.child);
  assert.equal(compiled.calls[0].command, fileURLToPath(new URL('../../../../../dist-native/gajae-core.exe', import.meta.url)));
});

test('decodes fragmented UTF-8 CRLF frames and coalesces paths in insertion order', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const { watcher, child, events } = setup({ onEvent: async (event) => {
    events.push(event);
    if (event.path === 'a') await blocked;
  } });
  await ready(watcher, child);
  child.output(Buffer.from('{"protocolVersion":1,"kind":"event","event":"add","path":"a"}\r\n'));
  child.output(Buffer.from('{"protocolVersion":1,"kind":"event","event":"change","path":"b"}\r\n{"protocolVersion":1,"kind":"event","event":"add","path":"b"}\r\n{"protocolVersion":1,"kind":"event","event":"change","path":"a"}\r\n'));
  await Promise.resolve();
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [{ kind: 'add', path: 'a' }, { kind: 'add', path: 'b' }, { kind: 'change', path: 'a' }]);
  const utf8 = Buffer.from('{"protocolVersion":1,"kind":"event","event":"add","path":"é"}\r\n');
  const split = utf8.indexOf(0xc3) + 1;
  child.output(utf8.subarray(0, split));
  child.output(utf8.subarray(split));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.at(-1), { kind: 'add', path: 'é' });
});

test('rejects malformed, oversized, pre-ready, and duplicate-ready frames without path-bearing failures', async () => {
  for (const frame of [
    '{"protocolVersion":1,"kind":"event","event":"add","path":"secret"}\n',
    '{"protocolVersion":1,"kind":"unknown"}\n',
    '{"protocolVersion":1,"kind":"ready","extra":true}\n',
    `${'x'.repeat(64 * 1024 + 1)}\n`,
  ]) {
    const { watcher, child, failures } = setup();
    const started = watcher.start();
    child.output(frame);
    await assert.rejects(started, /GJC session watcher failed\./u);
    assert.equal(failures.length, 1);
    assert.doesNotMatch(failures[0].message, /secret/u);
  }
  const { watcher, child, failures } = setup();
  await ready(watcher, child);
  child.output('{"protocolVersion":1,"kind":"ready"}\n');
  assert.equal(failures.length, 1);
});

test('reports unexpected exit only once and enforces ready timeout', async () => {
  const exited = setup();
  await ready(exited.watcher, exited.child);
  exited.child.emit('exit', 1, null);
  exited.child.emit('close', 1, null);
  assert.equal(exited.failures.length, 1);
  const timedOut = setup({ readyTimeoutMs: 1 });
  await assert.rejects(timedOut.watcher.start(), /GJC session watcher failed\./u);
  assert.equal(timedOut.failures.length, 1);
});

test('contains callback diagnostics and continues without exposing event paths', async () => {
  const diagnostics: string[] = [];
  const { watcher, child, failures } = setup({
    diagnostic: (message) => diagnostics.push(message),
    onEvent: () => {
      throw new Error('sensitive callback detail');
    },
  });
  await ready(watcher, child);
  child.output('{"protocolVersion":1,"kind":"event","event":"add","path":"secret-path"}\n');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(diagnostics, ['GJC session watcher callback failed.']);
  assert.equal(failures.length, 0);
  assert.doesNotMatch(diagnostics.join(' '), /secret-path|sensitive/u);
});

test('fails closed when distinct queued paths exceed the fixed bound', async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const { watcher, child, failures } = setup({ onEvent: () => hold });
  await ready(watcher, child);
  child.output('{"protocolVersion":1,"kind":"event","event":"add","path":"blocking"}\n');
  await Promise.resolve();

  child.output(Array.from({ length: 4097 }, (_, index) => (
    `{"protocolVersion":1,"kind":"event","event":"change","path":"queued-${index}"}\n`
  )).join(''));

  assert.equal(failures.length, 1);
  assert.doesNotMatch(failures[0].message, /queued-/u);
  release();
});

test('close cancellation and kill requests do not claim unsettled callbacks or process exit', async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const callbacks: string[] = [];
  let callbackSignal: AbortSignal | undefined;
  const { watcher, child } = setup({
    closeDrainTimeoutMs: 1,
    closeExitTimeoutMs: 1,
    onEvent: (event, signal) => {
      callbacks.push(event.path);
      callbackSignal = signal;
      return hold;
    },
  });
  await ready(watcher, child);
  child.output('{"protocolVersion":1,"kind":"event","event":"add","path":"warmup"}\n');
  await new Promise((resolve) => setImmediate(resolve));
  child.output('{"protocolVersion":1,"kind":"event","event":"add","path":"accepted"}\n');
  await assert.rejects(watcher.close(), /shutdown is unconfirmed/);

  assert.deepEqual(child.kills, ['SIGKILL']);
  assert.deepEqual(callbacks, ['warmup']);
  assert.equal(callbackSignal?.aborted, true);
  assert.equal(watcher.snapshotActivity().running, 1);
  assert.equal(watcher.snapshotActivity().settling, 1);
  release();
  child.emit('close');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(callbacks, ['warmup']);
  assert.equal(watcher.snapshotActivity().running, 0);
  assert.equal(watcher.snapshotActivity().settling, 0);
});

test('close before readiness rejects the pending start without reporting a runtime failure', async () => {
  const { watcher, child, failures } = setup();
  const started = watcher.start();
  const rejected = assert.rejects(started, /GJC session watcher failed\./u);
  child.stdin.end = () => child.emit('close');
  await watcher.close();

  await rejected;
  assert.equal(failures.length, 0);
});

test('fenced watcher dispatch retains the path and resumes without duplicating it', async () => {
  let fenced = true; let calls = 0; let active = 0; let revision = 0;
  const { watcher, child } = setup({
    desktopAdmission: {
      enter() { if (fenced) throw Object.assign(new Error('fenced'), { code: 'DESKTOP_RESTART_FENCED' }); active++; return () => { active--; }; },
      enterCompletion() { throw new Error('not a completion'); },
    },
    onActivityChange() { revision++; },
    onEvent() { assert.equal(active, 1); calls++; },
  });
  await ready(watcher, child);
  child.output('{"protocolVersion":1,"kind":"event","event":"change","path":"fixture.jsonl"}\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0); assert.equal(watcher.snapshotActivity().queued, 1);
  const before = revision; fenced = false;
  for (let attempt = 0; attempt < 100 && !calls; attempt++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(calls, 1); assert.equal(active, 0); assert.ok(revision > before);
  assert.equal(watcher.snapshotActivity().queued, 0);
  child.stdin.end = () => child.emit('close'); await watcher.close();
});
