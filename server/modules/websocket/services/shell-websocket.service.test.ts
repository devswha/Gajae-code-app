import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import test from 'node:test';

import pty, { type IPty } from 'node-pty';
import { WebSocket } from 'ws';

import type { DesktopWorkAdmission } from '@/shared/interfaces.js';

import { getShellActivityGeneration, handleShellConnection, snapshotShellActivity } from './shell-websocket.service.js';

const GRACE_PERIOD = 30 * 60 * 1000;

class FakePty {
  readonly writes: string[] = [];
  readonly sizes: Array<[number, number]> = [];
  kills = 0;
  private data?: (chunk: string) => void;
  private exited?: (status: { exitCode: number }) => void;
  onData(callback: (chunk: string) => void) { this.data = callback; return { dispose() {} }; }
  onExit(callback: (status: { exitCode: number }) => void) { this.exited = callback; return { dispose() {} }; }
  write(data: string) { this.writes.push(data); }
  resize(cols: number, rows: number) { this.sizes.push([cols, rows]); }
  kill() { this.kills++; }
  output(data: string) { this.data?.(data); }
  exit() { this.exited?.({ exitCode: 0 }); }
}

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly frames: Array<{ type: string; data?: string; message?: string; code?: string }> = [];
  send(data: string) { this.frames.push(JSON.parse(data)); }
  receive(frame: Record<string, unknown>) { this.emit('message', Buffer.from(JSON.stringify(frame))); }
  close() { this.readyState = WebSocket.CLOSED; this.emit('close'); }
  output() { return this.frames.map(frame => frame.data ?? '').join(''); }
}

class FakeAdmission implements DesktopWorkAdmission {
  fenced = false;
  active = 0;
  releases = 0;
  readonly sources: string[] = [];
  onRelease?: () => void;
  enter(source: string) {
    this.sources.push(source);
    if (this.fenced) throw Object.assign(new Error('fixture denial must not leak'), { code: 'DESKTOP_RESTART_FENCED' });
    this.active += 1;
    return () => {
      assert.equal(this.active, 1, 'the synchronous handler owns exactly one live lease');
      this.onRelease?.();
      this.active -= 1;
      this.releases += 1;
    };
  }
  enterCompletion(_source: string): () => void {
    throw new Error('Shell producer messages must use regular admission.');
  }
}

function fixture(t: test.TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timeout = t.mock.method(globalThis, 'setTimeout');
  const terminals: FakePty[] = [];
  const spawn = t.mock.method(pty, 'spawn', () => {
    const terminal = new FakePty();
    terminals.push(terminal);
    return terminal as unknown as IPty;
  });
  t.after(() => { for (const terminal of terminals) terminal.exit(); });
  const init = { type: 'init', projectPath: os.tmpdir(), sessionId: randomUUID(), isPlainShell: true, initialCommand: 'fixture-shell' };
  const connect = (desktopRestartAdmission?: DesktopWorkAdmission) => {
    const socket = new FakeSocket();
    handleShellConnection(socket as unknown as WebSocket, {
      desktopRestartAdmission,
      resolveProviderSessionId: () => undefined,
      stripAnsiSequences: value => value,
      normalizeDetectedUrl: () => null,
      extractUrlsFromText: () => [],
      shouldAutoOpenUrlFromOutput: () => false,
    });
    return socket;
  };
  return { init, connect, terminals, timeout, spawn };
}

test('shell activity is initially complete and empty; connection and snapshot reads have no side effects', t => {
  const f = fixture(t);
  const before = snapshotShellActivity();
  assert.deepEqual(before, {
    owner: 'shell', generation: getShellActivityGeneration(), complete: true,
    starting: 0, queued: 0, running: 0, settling: 0, approvals: 0, retained: 0, unknown: [],
  });
  const admission = new FakeAdmission();
  const socket = f.connect(admission);
  socket.receive({ type: 'input', data: 'no-owned-session' });
  socket.receive({ type: 'resize', cols: 100, rows: 40 });
  socket.receive({ type: 'status' });
  socket.receive({ type: 'constructor' });
  socket.close();
  assert.deepEqual(snapshotShellActivity(), before);
  assert.equal(getShellActivityGeneration(), before.generation);
  assert.equal(f.spawn.mock.callCount(), 0);
  assert.equal(f.timeout.mock.callCount(), 0);
  assert.deepEqual(admission.sources, []);
});

test('closing replaced A preserves B output and schedules no cleanup timer', t => {
  const f = fixture(t);
  const a = f.connect(); a.receive(f.init);
  const terminal = f.terminals[0]!;
  terminal.output('before-reconnect');
  const b = f.connect(); b.receive(f.init);
  assert.match(b.output(), /Reconnected to existing session.*before-reconnect/s);
  assert.equal(f.terminals.length, 1);
  a.close();
  assert.equal(f.timeout.mock.callCount(), 0);
  terminal.output('after-old-close');
  assert.match(b.output(), /after-old-close/);
  assert.doesNotMatch(a.output(), /after-old-close/);
  t.mock.timers.tick(GRACE_PERIOD + 1);
  assert.equal(terminal.kills, 0);
  terminal.output('still-owned');
  assert.match(b.output(), /still-owned/);
});

test('superseded sockets cannot input, resize, exit or force-restart the active terminal', t => {
  const f = fixture(t);
  const a = f.connect(); a.receive(f.init);
  const b = f.connect(); b.receive(f.init);
  const terminal = f.terminals[0]!;
  a.receive({ type: 'input', data: 'exit\n\u0004' });
  a.receive({ type: 'resize', cols: 1, rows: 1 });
  a.receive({ ...f.init, forceRestart: true });
  a.receive({ ...f.init, initialCommand: 'gjc auth login' });
  a.receive({ type: 'close' }); // Not a supported command; must remain harmless.
  assert.deepEqual(terminal.writes, []);
  assert.deepEqual(terminal.sizes, []);
  assert.equal(terminal.kills, 0);
  assert.equal(f.terminals.length, 1);
  b.receive({ type: 'input', data: 'current-owner\n' });
  b.receive({ type: 'resize', cols: 97, rows: 31 });
  assert.deepEqual(terminal.writes, ['current-owner\n']);
  assert.deepEqual(terminal.sizes, [[97, 31]]);
  assert.equal(f.timeout.mock.callCount(), 0);
});

test('owner disconnect buffers output, reconnect cancels expiry, and only the next owner close expires it', t => {
  const f = fixture(t);
  const a = f.connect(); a.receive(f.init);
  const terminal = f.terminals[0]!;
  a.close();
  assert.equal(f.timeout.mock.callCount(), 1);
  const oldExpiry = f.timeout.mock.calls[0]!.arguments[0];
  terminal.output('while-disconnected');
  t.mock.timers.tick(GRACE_PERIOD - 1);
  assert.equal(terminal.kills, 0);
  const b = f.connect(); b.receive(f.init);
  assert.match(b.output(), /while-disconnected/);
  // Even an already queued callback must not kill a reattached session.
  oldExpiry();
  t.mock.timers.tick(2);
  assert.equal(terminal.kills, 0);
  terminal.output('after-cancelled-expiry');
  assert.match(b.output(), /after-cancelled-expiry/);
  b.close();
  assert.equal(f.timeout.mock.callCount(), 2);
  t.mock.timers.tick(GRACE_PERIOD);
  assert.equal(terminal.kills, 1);
  const c = f.connect(); c.receive(f.init);
  assert.equal(f.terminals.length, 2);
  assert.doesNotMatch(c.output(), /Reconnected/);
});

test('current owner can restart and late output or exit from the old PTY cannot affect its replacement', t => {
  const f = fixture(t);
  const a = f.connect(); a.receive(f.init);
  const original = f.terminals[0]!;
  const b = f.connect(); b.receive(f.init);
  b.receive({ ...f.init, forceRestart: true });
  assert.equal(original.kills, 1);
  assert.equal(f.terminals.length, 2);
  const replacement = f.terminals[1]!;
  original.output('retired-output');
  original.exit();
  assert.doesNotMatch(b.output(), /retired-output|Process exited/);
  a.receive({ type: 'input', data: 'stale-exit\n' });
  a.close();
  b.receive({ type: 'input', data: 'replacement-owner\n' });
  replacement.output('replacement-output');
  assert.deepEqual(original.writes, []);
  assert.deepEqual(replacement.writes, ['replacement-owner\n']);
  assert.match(b.output(), /replacement-output/);
  assert.equal(f.timeout.mock.callCount(), 0);
});

test('the reconnected owner can start a fresh terminal after the previous PTY exits', t => {
  const f = fixture(t);
  const a = f.connect(); a.receive(f.init);
  const b = f.connect(); b.receive(f.init);
  f.terminals[0]!.exit();
  assert.match(b.output(), /Process exited with code 0/);
  b.receive({ type: 'input', data: 'after-exit\n' });
  assert.deepEqual(f.terminals[0]!.writes, []);
  b.receive(f.init);
  assert.equal(f.terminals.length, 2);
  b.receive({ type: 'input', data: 'fresh\n' });
  assert.deepEqual(f.terminals[1]!.writes, ['fresh\n']);
});

for (const forceRestart of [false, true]) {
  test(`a superseded socket stays revoked after PTY exit (replacement restart: ${forceRestart})`, t => {
    const f = fixture(t);
    const a = f.connect(); a.receive(f.init);
    const b = f.connect(); b.receive({ ...f.init, forceRestart });
    const terminal = f.terminals.at(-1)!;
    terminal.exit();
    const count = f.terminals.length;

    // No session entry remains to identify the superseded socket. Delayed
    // init frames must still not seize the session before its owner restarts.
    a.receive({ ...f.init, forceRestart: true });
    a.receive({ ...f.init, sessionId: randomUUID() });
    assert.equal(f.terminals.length, count);
    b.receive(f.init);
    assert.equal(f.terminals.length, count + 1);
    a.receive({ type: 'input', data: 'stale\n' });
    b.receive({ type: 'input', data: 'owner\n' });
    assert.deepEqual(f.terminals.at(-1)!.writes, ['owner\n']);
  });
}

test('switching sessions detaches the old PTY without redirecting its output or exit', t => {
  const f = fixture(t);
  const a = f.connect(); a.receive(f.init);
  const original = f.terminals[0]!;
  a.receive({ ...f.init, sessionId: randomUUID() });
  const replacement = f.terminals[1]!;
  assert.equal(f.timeout.mock.callCount(), 1);
  original.output('old-session-buffer');
  assert.doesNotMatch(a.output(), /old-session-buffer/);
  const b = f.connect(); b.receive(f.init);
  assert.match(b.output(), /old-session-buffer/);
  original.exit();
  assert.match(b.output(), /Process exited with code 0/);
  assert.doesNotMatch(a.output(), /Process exited/);
  a.receive({ type: 'input', data: 'new-session\n' });
  replacement.output('new-session-output');
  assert.deepEqual(replacement.writes, ['new-session\n']);
  assert.match(a.output(), /new-session-output/);
});

test('an invalid re-init leaves the current binding and output intact', t => {
  const f = fixture(t);
  const a = f.connect(); a.receive(f.init);
  a.receive({ ...f.init, sessionId: 'invalid/session' });
  assert.ok(a.frames.some(frame => frame.message === 'Invalid session ID'));
  a.receive({ type: 'input', data: 'valid-owner\n' });
  f.terminals[0]!.output('still-valid');
  assert.deepEqual(f.terminals[0]!.writes, ['valid-owner\n']);
  assert.match(a.output(), /still-valid/);
  assert.equal(f.timeout.mock.callCount(), 0);
});

test('fenced init cannot spawn, reclaim, detach or force-restart a retained terminal', t => {
  const f = fixture(t);
  const admission = new FakeAdmission();
  const owner = f.connect(admission);
  admission.fenced = true;
  const beforeSpawn = snapshotShellActivity();
  owner.receive(f.init);
  assert.equal(f.spawn.mock.callCount(), 0);
  assert.deepEqual(snapshotShellActivity(), beforeSpawn);
  const denial = { type: 'error', code: 'DESKTOP_RESTART_FENCED', message: 'Desktop restart is being prepared. Retry this request.' };
  assert.deepEqual(owner.frames, [denial]);
  assert.equal(admission.releases, 0);

  admission.fenced = false;
  owner.receive(f.init);
  const terminal = f.terminals[0]!;
  admission.fenced = true;
  const before = snapshotShellActivity();
  owner.receive({ ...f.init, forceRestart: true });
  owner.receive({ ...f.init, sessionId: randomUUID() });
  owner.receive({ ...f.init, initialCommand: 'gjc auth login' });
  const replacement = f.connect(admission);
  replacement.receive(f.init);
  assert.equal(f.terminals.length, 1);
  assert.equal(terminal.kills, 0);
  assert.equal(f.timeout.mock.callCount(), 0);
  assert.deepEqual(snapshotShellActivity(), before);
  assert.deepEqual(owner.frames.slice(-3), [denial, denial, denial]);
  assert.deepEqual(replacement.frames, [denial]);
  assert.equal(admission.releases, 1);
  terminal.output('the original owner is still attached');
  assert.match(owner.output(), /original owner/);
  assert.doesNotMatch(replacement.output(), /original owner/);

  admission.fenced = false;
  owner.receive({ type: 'input', data: 'still-owner\n' });
  assert.deepEqual(terminal.writes, ['still-owner\n']);
});

test('each input and resize is fenced on an already accepted connection, without stopping its PTY', t => {
  const f = fixture(t);
  const admission = new FakeAdmission();
  const owner = f.connect(admission);
  owner.receive(f.init);
  const terminal = f.terminals[0]!;
  admission.fenced = true;
  const before = snapshotShellActivity();
  owner.receive({ type: 'input', data: 'must-not-run\n' });
  owner.receive({ type: 'resize', cols: 2, rows: 2 });
  assert.deepEqual(terminal.writes, []);
  assert.deepEqual(terminal.sizes, []);
  assert.equal(terminal.kills, 0);
  assert.deepEqual(snapshotShellActivity(), before);
  assert.deepEqual(owner.frames.slice(-2).map(frame => frame.code), ['DESKTOP_RESTART_FENCED', 'DESKTOP_RESTART_FENCED']);
  assert.doesNotMatch(owner.output(), /fixture denial/);
  assert.equal(admission.active, 0);
  assert.equal(admission.releases, 1);

  admission.fenced = false;
  owner.receive({ type: 'input', data: 'accepted\n' });
  const afterInput = getShellActivityGeneration();
  assert.notEqual(afterInput, before.generation);
  owner.receive({ type: 'resize', cols: 97, rows: 31 });
  assert.notEqual(getShellActivityGeneration(), afterInput);
  assert.deepEqual(terminal.writes, ['accepted\n']);
  assert.deepEqual(terminal.sizes, [[97, 31]]);
  assert.deepEqual(admission.sources, ['shell.init', 'shell.input', 'shell.resize', 'shell.input', 'shell.resize']);
  assert.equal(admission.releases, 3);
});

test('admission spans synchronous spawn, setup, input and resize; release observes the registered owner', t => {
  const f = fixture(t);
  const admission = new FakeAdmission();
  const owner = f.connect(admission);
  const terminal = new FakePty();
  f.terminals.push(terminal);
  f.spawn.mock.mockImplementation(() => {
    assert.equal(admission.active, 1);
    assert.equal(snapshotShellActivity().starting, 1);
    assert.equal(snapshotShellActivity().running, 0);
    return terminal as unknown as IPty;
  });
  admission.onRelease = () => {
    assert.equal(snapshotShellActivity().starting, 0);
    assert.equal(snapshotShellActivity().running, 1);
  };
  const send = owner.send.bind(owner);
  const sendMock = t.mock.method(owner, 'send', (payload: string) => {
    assert.equal(admission.active, 1, 'welcome/setup has not released admission early');
    send(payload);
  });
  owner.receive(f.init);
  assert.equal(admission.active, 0);
  const write = terminal.write.bind(terminal);
  t.mock.method(terminal, 'write', (data: string) => {
    assert.equal(admission.active, 1);
    write(data);
  });
  t.mock.method(terminal, 'resize', () => { assert.equal(admission.active, 1); });
  owner.receive({ type: 'input', data: 'leased\n' });
  owner.receive({ type: 'resize', cols: 120, rows: 40 });
  assert.equal(admission.active, 0);
  assert.equal(admission.releases, 3);
  // Exit output is an owned completion, not a new ingress operation.
  sendMock.mock.restore();
});

test('throwing producers release admission synchronously and cannot erase PTY uncertainty', t => {
  const f = fixture(t);
  const admission = new FakeAdmission();
  const owner = f.connect(admission);
  owner.receive(f.init);
  const terminal = f.terminals[0]!;
  t.mock.method(terminal, 'write', () => { throw new Error('fixture write failure'); });
  t.mock.method(terminal, 'resize', () => { throw new Error('fixture resize failure'); });
  owner.receive({ type: 'input', data: 'attempted\n' });
  owner.receive({ type: 'resize', cols: 120, rows: 40 });
  assert.equal(admission.active, 0);
  assert.equal(admission.releases, 3);
  assert.match(owner.output(), /fixture write failure/);
  assert.match(owner.output(), /fixture resize failure/);
  assert.equal(snapshotShellActivity().running, 1);

  terminal.exit();
  f.spawn.mock.mockImplementation(() => { throw new Error('fixture spawn failure'); });
  owner.receive(f.init);
  assert.equal(admission.active, 0);
  assert.equal(admission.releases, 4);
  assert.match(owner.output(), /fixture spawn failure/);
  assert.equal(snapshotShellActivity().starting, 0);
  assert.equal(snapshotShellActivity().running, 0);
  assert.equal(snapshotShellActivity().complete, false);
  assert.deepEqual(snapshotShellActivity().unknown, ['pty_descendants_unverified']);
});

test('superseded sockets cannot acquire a lease, even after the current generation exits', t => {
  const f = fixture(t);
  const admission = new FakeAdmission();
  const a = f.connect(admission); a.receive(f.init);
  const b = f.connect(admission); b.receive(f.init);
  assert.equal(admission.releases, 2);
  admission.fenced = true;
  a.receive({ type: 'input', data: 'revoked\n' });
  a.receive({ type: 'resize' });
  a.receive({ ...f.init, forceRestart: true });
  a.close();
  f.terminals[0]!.exit();
  a.receive(f.init);
  assert.deepEqual(admission.sources, ['shell.init', 'shell.init']);
  assert.equal(f.timeout.mock.callCount(), 0);
  assert.equal(f.terminals[0]!.kills, 0);
});

test('detached sessions remain busy and grace expiry retains a retiring generation until its own exit', t => {
  const f = fixture(t);
  const admission = new FakeAdmission();
  const a = f.connect(admission); a.receive(f.init);
  const original = f.terminals[0]!;
  const connected = snapshotShellActivity();
  assert.equal(connected.running, 1);
  assert.equal(connected.retained, 0);
  admission.fenced = true;
  a.close(); // Normal detach remains available under the fence.
  const detached = snapshotShellActivity();
  assert.notEqual(detached.generation, connected.generation);
  assert.equal(detached.running, 1);
  assert.equal(detached.retained, 1);
  assert.equal(original.kills, 0);
  assert.equal(admission.releases, 1);
  original.output('buffered-output');
  assert.notEqual(getShellActivityGeneration(), detached.generation);
  const beforeExpiry = snapshotShellActivity();
  t.mock.timers.tick(GRACE_PERIOD);
  const retiring = snapshotShellActivity();
  assert.equal(original.kills, 1);
  assert.notEqual(retiring.generation, beforeExpiry.generation);
  assert.equal(retiring.running, 0);
  assert.equal(retiring.retained, 0);
  assert.equal(retiring.settling, 1);
  assert.deepEqual(snapshotShellActivity(), retiring, 'snapshot does not force-drain or change the timer');
  assert.equal(original.kills, 1);

  admission.fenced = false;
  const b = f.connect(admission); b.receive(f.init);
  assert.equal(snapshotShellActivity().running, 1);
  assert.equal(snapshotShellActivity().settling, 1);
  const beforeExit = getShellActivityGeneration();
  original.exit();
  assert.notEqual(getShellActivityGeneration(), beforeExit);
  assert.equal(snapshotShellActivity().running, 1);
  assert.equal(snapshotShellActivity().settling, 0);
  assert.doesNotMatch(b.output(), /Process exited/);
  b.receive({ type: 'input', data: 'replacement\n' });
  assert.deepEqual(f.terminals[1]!.writes, ['replacement\n']);
});

test('replacement and out-of-order late exits retain every retiring generation, not only the keyed PTY', t => {
  const f = fixture(t);
  const owner = f.connect(); owner.receive(f.init);
  const original = f.terminals[0]!;
  owner.receive({ ...f.init, forceRestart: true });
  const middle = f.terminals[1]!;
  owner.receive({ ...f.init, forceRestart: true });
  const latest = f.terminals[2]!;
  assert.equal(original.kills, 1);
  assert.equal(middle.kills, 1);
  assert.equal(snapshotShellActivity().running, 1);
  assert.equal(snapshotShellActivity().settling, 2);
  middle.exit();
  assert.equal(snapshotShellActivity().settling, 1);
  assert.equal(snapshotShellActivity().running, 1);
  const afterMiddleExit = getShellActivityGeneration();
  middle.exit();
  middle.output('stale');
  assert.equal(getShellActivityGeneration(), afterMiddleExit, 'duplicate retired callbacks are inert');
  latest.exit();
  assert.equal(snapshotShellActivity().running, 0);
  assert.equal(snapshotShellActivity().settling, 1);
  original.exit();
  const exited = snapshotShellActivity();
  assert.equal(exited.running, 0);
  assert.equal(exited.settling, 0);
  assert.equal(exited.complete, false, 'leader exit is not detached-descendant reap proof');
  assert.deepEqual(exited.unknown, ['pty_descendants_unverified']);
  // A returned snapshot must never expose mutable owner state.
  (exited.unknown as string[]).push('forged');
  exited.running = 999;
  assert.deepEqual(snapshotShellActivity().unknown, ['pty_descendants_unverified']);
  assert.equal(snapshotShellActivity().running, 0);
});

test('reconnect changes activity generation and a cancelled old expiry is read-only', t => {
  const f = fixture(t);
  const a = f.connect(); a.receive(f.init);
  a.close();
  const expiry = f.timeout.mock.calls[0]!.arguments[0];
  const before = snapshotShellActivity();
  const b = f.connect(); b.receive(f.init);
  const reconnected = snapshotShellActivity();
  assert.notEqual(reconnected.generation, before.generation);
  assert.equal(reconnected.running, 1);
  assert.equal(reconnected.retained, 0);
  expiry();
  assert.deepEqual(snapshotShellActivity(), reconnected);
  assert.equal(f.terminals[0]!.kills, 0);
});

test('synchronous exit during a requested restart does not leak or delete the replacement', t => {
  const f = fixture(t);
  const owner = f.connect(); owner.receive(f.init);
  const original = f.terminals[0]!;
  t.mock.method(original, 'kill', () => {
    assert.equal(snapshotShellActivity().settling, 1);
    original.kills += 1;
    original.exit();
  });
  owner.receive({ ...f.init, forceRestart: true });
  assert.equal(original.kills, 1);
  assert.equal(f.terminals.length, 2);
  assert.equal(snapshotShellActivity().running, 1);
  assert.equal(snapshotShellActivity().settling, 0);
  owner.receive({ type: 'input', data: 'replacement\n' });
  assert.deepEqual(f.terminals[1]!.writes, ['replacement\n']);
});

test('a failed user-requested kill retains original ownership and retiring uncertainty until exit', t => {
  const f = fixture(t);
  const admission = new FakeAdmission();
  const owner = f.connect(admission); owner.receive(f.init);
  const original = f.terminals[0]!;
  t.mock.method(original, 'kill', () => { throw new Error('fixture kill failure'); });
  owner.receive({ ...f.init, forceRestart: true });
  assert.equal(f.terminals.length, 1);
  assert.equal(admission.active, 0);
  assert.equal(admission.releases, 2);
  assert.equal(snapshotShellActivity().running, 1);
  assert.equal(snapshotShellActivity().settling, 1);
  owner.receive({ type: 'input', data: 'still-owned\n' });
  assert.deepEqual(original.writes, ['still-owned\n']);
  original.exit();
  assert.equal(snapshotShellActivity().running, 0);
  assert.equal(snapshotShellActivity().settling, 0);
  assert.deepEqual(snapshotShellActivity().unknown, ['pty_descendants_unverified']);
});
