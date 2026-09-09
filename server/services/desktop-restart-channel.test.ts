import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type connect as Connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import type { RestartControlCommand, RestartControlResult } from '../../shared/desktopRestartProtocol.js';

import { DesktopRestartChannel, type DesktopRestartHandler } from './desktop-restart-channel.js';

// Every credential and endpoint is synthetic. Never import server startup or
// obtain a native binding, key, socket or data directory from the running app.
const binding = { protocolVersion: 1 as const, socket: '/unused-test-only/rpc', secret: 'a'.repeat(64), epoch: 'b'.repeat(64) };
const attemptId = 'c'.repeat(64);
const openResult: RestartControlResult = { ok: true, state: 'open', attemptId: null, token: null, expiresInMs: null, error: null };
const line = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const ack = (fields: Record<string, unknown> = {}) => ({ protocolVersion: 1, kind: 'backendAttached', epoch: binding.epoch, ...fields });
const control = (id = 1, command: RestartControlCommand = { action: 'status' }, fields: Record<string, unknown> = {}) => ({
  protocolVersion: 1, kind: 'restartControl', id, epoch: binding.epoch, command, ...fields,
});

// Independent wire implementation: do not use the production proof helper.
function proof(challenge: Record<string, unknown>, fields: Record<string, unknown> = {}, key: string | Buffer = binding.secret) {
  const digest = createHmac('sha256', key)
    .update(`gajae-native-update-v1\0${challenge.epoch}\0${challenge.nonce}`, 'utf8').digest('hex');
  return { protocolVersion: 1, kind: 'challenge', epoch: challenge.epoch, nonce: challenge.nonce, proof: digest, ...fields };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function handlerFixture(overrides: Partial<DesktopRestartHandler> = {}) {
  const bound: string[] = [];
  const handled: Array<{ command: RestartControlCommand; epoch: string }> = [];
  const disconnected: string[] = [];
  const handler: DesktopRestartHandler = {
    bind(epoch) { bound.push(epoch); overrides.bind?.(epoch); },
    handle(command, epoch) { handled.push({ command, epoch }); return overrides.handle?.(command, epoch) ?? Promise.resolve(openResult); },
    disconnected(epoch) { disconnected.push(epoch); overrides.disconnected?.(epoch); },
  };
  return { handler, bound, handled, disconnected };
}

class TestSocket extends EventEmitter {
  written = '';
  destroyed = false;
  write(value: string) { this.written += value; return true; }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } return this; }
  frames(): Record<string, unknown>[] { return this.written.split('\n').filter(Boolean).map((value) => JSON.parse(value)); }
  receive(value: unknown) { this.emit('data', line(value)); }
}

function fixture(t: TestContext, overrides: Partial<DesktopRestartHandler> = {}) {
  const socket = new TestSocket();
  const observed = handlerFixture(overrides);
  const connections: unknown[][] = [];
  const channel = new DesktopRestartChannel({
    binding, pid: 42, handler: observed.handler,
    connect: ((...args: unknown[]) => { connections.push(args); return socket; }) as unknown as typeof Connect,
  });
  t.after(() => channel.close());
  function connect() { socket.emit('connect'); return socket.frames()[0]; }
  function authenticate() { const challenge = connect(); socket.receive(proof(challenge)); }
  function ready() { authenticate(); socket.receive(ack()); assert.equal(channel.isReady(), true); }
  return { channel, socket, connections, connect, authenticate, ready, ...observed };
}

function onlyChallenge(frames: Record<string, unknown>[], wire: string, pid = 42) {
  assert.equal(frames.length, 1, 'unproven endpoint receives no credential-bearing second frame');
  const challenge = frames[0];
  assert.deepEqual(challenge, { protocolVersion: 1, kind: 'challenge', epoch: binding.epoch, pid, nonce: challenge.nonce });
  assert.match(String(challenge.nonce), /^[a-f0-9]{64}$/u);
  assert.equal(wire.includes(binding.secret), false);
  assert.doesNotMatch(wire, /"(?:secret|token|command|attemptId)"/u);
}

test('same-socket HMAC proof precedes secret disclosure and exact attach ack precedes binding', async (t) => {
  const h = fixture(t);
  assert.deepEqual(h.connections, [[binding.socket]]);
  assert.equal(h.socket.written, '');
  assert.equal(h.channel.isReady(), false);
  const challenge = h.connect();
  onlyChallenge(h.socket.frames(), h.socket.written);
  const response = line(proof(challenge));
  h.socket.emit('data', response.subarray(0, response.length - 1));
  onlyChallenge(h.socket.frames(), h.socket.written);
  assert.deepEqual(h.bound, []);
  h.socket.emit('data', response.subarray(-1));
  assert.deepEqual(h.socket.frames()[1], { protocolVersion: 1, kind: 'backendAttach', epoch: binding.epoch, secret: binding.secret, pid: 42 });
  assert.equal(h.connections.length, 1, 'authentication must not switch transports');
  assert.deepEqual(h.bound, []);
  assert.equal(h.channel.isReady(), false);
  const attached = line(ack());
  h.socket.emit('data', attached.subarray(0, -1));
  assert.deepEqual(h.bound, []);
  h.socket.emit('data', attached.subarray(-1));
  assert.deepEqual(h.bound, [binding.epoch]);
  assert.equal(h.channel.isReady(), true);
  h.socket.receive(control());
  await tick();
  assert.deepEqual(h.handled, [{ command: { action: 'status' }, epoch: binding.epoch }]);
  assert.deepEqual(h.socket.frames()[2], { protocolVersion: 1, kind: 'restartControlResult', epoch: binding.epoch, id: 1, result: openResult });
  assert.deepEqual(h.disconnected, []);
});

test('forged, copied and non-exact proof frames disclose no secret and never bind', async (t) => {
  const changes: Record<string, unknown>[] = [
    { protocolVersion: 2 }, { protocolVersion: '1' }, { kind: 'backendAttached' },
    { epoch: 'd'.repeat(64) }, { nonce: 'e'.repeat(64) }, { nonce: null },
    { proof: '0'.repeat(64) }, { proof: 'a'.repeat(63) }, { proof: 'A'.repeat(64) },
    { proof: 'g'.repeat(64) }, { proof: 1 }, { proof: undefined }, { secret: binding.secret },
  ];
  const variants: Array<[string, (challenge: Record<string, unknown>) => unknown]> = [
    ...changes.map((fields): [string, (challenge: Record<string, unknown>) => unknown] => [JSON.stringify(fields), (challenge) => proof(challenge, fields)]),
    ['wrong key', (challenge) => proof(challenge, {}, 'attacker-test-key')],
    ['hex-decoded key instead of UTF-8', (challenge) => proof(challenge, {}, Buffer.from(binding.secret, 'hex'))],
    ['ack instead of proof', () => ack()],
    ['control instead of proof', () => control()],
  ];
  for (const [name, make] of variants) {
    await t.test(name, () => {
      const h = fixture(t); const challenge = h.connect();
      h.socket.receive(make(challenge));
      onlyChallenge(h.socket.frames(), h.socket.written);
      assert.equal(h.socket.destroyed, true);
      assert.equal(h.channel.isReady(), false);
      assert.deepEqual(h.bound, []);
      assert.deepEqual(h.handled, []);
      assert.deepEqual(h.disconnected, []);
    });
  }
});

test('a valid proof captured from another channel cannot authenticate a fresh nonce', (t) => {
  const first = fixture(t); const captured = proof(first.connect());
  first.socket.receive(captured); first.socket.receive(ack()); first.channel.close();
  const second = fixture(t); const challenge = second.connect();
  assert.notEqual(challenge.nonce, captured.nonce);
  second.socket.receive(captured);
  assert.equal(second.socket.destroyed, true);
  onlyChallenge(second.socket.frames(), second.socket.written);
  assert.deepEqual(second.bound, []);
});

test('attach acknowledgments reject wrong epochs, fields, kinds and premature controls before bind', async (t) => {
  for (const [name, value] of [
    ['copied epoch', ack({ epoch: 'd'.repeat(64) })], ['missing epoch', ack({ epoch: undefined })],
    ['version', ack({ protocolVersion: 2 })], ['string version', ack({ protocolVersion: '1' })],
    ['request echo', ack({ kind: 'backendAttach' })], ['extra pid', ack({ pid: 42 })],
    ['extra secret', ack({ secret: binding.secret })], ['control before ack', control()],
  ] as const) {
    await t.test(name, async () => {
      const h = fixture(t); h.authenticate(); h.socket.receive(value); await tick();
      assert.equal(h.socket.destroyed, true);
      assert.equal(h.channel.isReady(), false);
      assert.deepEqual(h.bound, []);
      assert.deepEqual(h.handled, []);
      assert.deepEqual(h.disconnected, []);
      assert.equal(h.socket.frames().length, 2);
    });
  }
});

test('coalesced attach ack and first control bind once and dispatch exactly once', async (t) => {
  const h = fixture(t); h.authenticate();
  h.socket.emit('data', Buffer.concat([line(ack()), line(control())]));
  assert.deepEqual(h.bound, [binding.epoch]);
  await tick();
  assert.deepEqual(h.handled, [{ command: { action: 'status' }, epoch: binding.epoch }]);
  assert.equal(h.socket.frames().length, 3);
  assert.equal(h.channel.isReady(), true);
});

test('fragmented controls preserve ordering and accept only increasing IDs after settlement', async (t) => {
  const h = fixture(t); h.ready();
  const commands: RestartControlCommand[] = [
    { action: 'status' }, { action: 'prepare', attemptId, draftEpoch: 1, remainingMs: 5_000 },
    { action: 'commit', attemptId, token: 'synthetic-token' }, { action: 'cancel', attemptId },
  ];
  const ids = [1, 3, 4, Number.MAX_SAFE_INTEGER];
  for (const [index, command] of commands.entries()) {
    const bytes = line(control(ids[index], command));
    for (const byte of bytes.subarray(0, -1)) h.socket.emit('data', Buffer.from([byte]));
    assert.equal(h.handled.length, index, 'incomplete frames must not dispatch');
    h.socket.emit('data', bytes.subarray(-1)); await tick();
    assert.deepEqual(h.handled[index], { command, epoch: binding.epoch });
    assert.equal(h.socket.frames()[index + 2].id, ids[index]);
    assert.equal(h.channel.isReady(), true);
  }
});

test('copied control epochs, duplicate IDs and replayed acknowledgments revoke a bound channel', async (t) => {
  for (const [name, frame] of [
    ['copied epoch', control(11, { action: 'status' }, { epoch: 'd'.repeat(64) })],
    ['duplicate ID', control(10)], ['older ID', control(9)], ['repeated ack', ack()],
    ['extra authority field', control(11, { action: 'status' }, { install: true })],
  ] as const) {
    await t.test(name, async () => {
      const h = fixture(t); h.ready(); h.socket.receive(control(10)); await tick();
      assert.equal(h.handled.length, 1);
      h.socket.receive(frame); await tick();
      assert.equal(h.socket.destroyed, true);
      assert.equal(h.channel.isReady(), false);
      assert.deepEqual(h.disconnected, [binding.epoch]);
      assert.equal(h.handled.length, 1);
      assert.equal(h.socket.frames().length, 3);
    });
  }
});

test('coalesced control pipelining revokes before a queued handler can start', async (t) => {
  for (const nextId of [1, 2]) {
    await t.test(`second ID ${nextId}`, async () => {
      const h = fixture(t); h.ready();
      h.socket.emit('data', Buffer.concat([line(control()), line(control(nextId))]));
      await tick();
      assert.deepEqual(h.handled, []);
      assert.deepEqual(h.disconnected, [binding.epoch]);
      assert.equal(h.socket.frames().length, 2);
      assert.equal(h.channel.isReady(), false);
    });
  }
});

test('in-flight replay or pipelining revokes transport but leaves the actual promise backend-owned', async (t) => {
  for (const nextId of [1, 2]) {
    await t.test(`second ID ${nextId}`, async () => {
      const pending = deferred<RestartControlResult>(); let settled = false;
      const h = fixture(t, { handle: async () => { const result = await pending.promise; settled = true; return result; } });
      h.ready(); h.socket.receive(control()); await tick();
      assert.equal(h.handled.length, 1);
      h.socket.receive(control(nextId)); await tick();
      assert.equal(settled, false, 'transport revocation must not manufacture backend settlement');
      assert.deepEqual(h.disconnected, [binding.epoch]);
      assert.equal(h.socket.destroyed, true);
      pending.resolve(openResult); await tick();
      assert.equal(settled, true);
      assert.equal(h.handled.length, 1);
      assert.equal(h.socket.frames().length, 2, 'late completion must not send a response');
    });
  }
});

test('close or socket failure between receipt and microtask dispatch prevents a late handler', async (t) => {
  for (const cause of ['close', 'error', 'peer close'] as const) {
    await t.test(cause, async () => {
      const h = fixture(t); h.ready(); h.socket.receive(control());
      if (cause === 'close') h.channel.close();
      else if (cause === 'error') h.socket.emit('error', new Error('synthetic transport failure'));
      else h.socket.destroy();
      h.socket.receive(control(2)); h.socket.emit('connect'); h.channel.close();
      await tick();
      assert.deepEqual(h.handled, []);
      assert.deepEqual(h.disconnected, [binding.epoch]);
      assert.deepEqual(h.bound, [binding.epoch]);
      assert.equal(h.channel.isReady(), false);
      assert.equal(h.socket.frames().length, 2);
    });
  }
});

test('late handler resolution and rejection after close cannot respond or disconnect twice', async (t) => {
  for (const outcome of ['resolve', 'reject'] as const) {
    await t.test(outcome, async () => {
      const pending = deferred<RestartControlResult>();
      const h = fixture(t, { handle: () => pending.promise });
      h.ready(); h.socket.receive(control()); await tick();
      assert.equal(h.handled.length, 1);
      h.channel.close(); h.channel.close();
      if (outcome === 'resolve') pending.resolve(openResult);
      else pending.reject(new Error('synthetic late backend rejection'));
      await tick();
      assert.deepEqual(h.disconnected, [binding.epoch]);
      assert.equal(h.socket.frames().length, 2);
      assert.equal(h.channel.isReady(), false);
    });
  }
});

test('unbound handshake timeouts never call disconnected and ignore all late input', async (t) => {
  for (const phase of ['connecting', 'challenge', 'attaching'] as const) {
    await t.test(phase, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const h = fixture(t);
      if (phase === 'challenge') h.connect();
      if (phase === 'attaching') h.authenticate();
      t.mock.timers.tick(1_999); assert.equal(h.socket.destroyed, false);
      t.mock.timers.tick(1); assert.equal(h.socket.destroyed, true);
      const written = h.socket.written;
      h.socket.emit('connect'); h.socket.receive(ack()); h.socket.receive(control()); await tick();
      assert.deepEqual(h.bound, []);
      assert.deepEqual(h.handled, []);
      assert.deepEqual(h.disconnected, []);
      assert.equal(h.socket.written, written);
    });
  }
});

test('attach acknowledgment cancels the handshake timer and idle readiness has no watchdog', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = fixture(t); h.ready(); t.mock.timers.tick(20_000);
  assert.equal(h.channel.isReady(), true);
  assert.deepEqual(h.disconnected, []);
});

test('handler watchdog revokes only bound transport and does not settle accepted work', async (t) => {
  for (const [name, command, budget] of [
    ['prepare', { action: 'prepare', attemptId, draftEpoch: 1, remainingMs: 7 }, 57],
    ['status', { action: 'status' }, 5_050],
  ] satisfies Array<[string, RestartControlCommand, number]>) {
    await t.test(name, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const pending = deferred<RestartControlResult>(); let settled = false;
      const h = fixture(t, { handle: async () => { const result = await pending.promise; settled = true; return result; } });
      h.ready(); h.socket.receive(control(1, command)); await tick();
      assert.equal(h.handled.length, 1);
      t.mock.timers.tick(budget - 1); assert.equal(h.channel.isReady(), true);
      t.mock.timers.tick(1); await tick();
      assert.equal(h.channel.isReady(), false);
      assert.deepEqual(h.disconnected, [binding.epoch]);
      assert.equal(settled, false);
      assert.equal(h.socket.frames().length, 2, 'timeout is not a backend response');
      h.socket.receive(control(2)); pending.resolve(openResult); await tick();
      assert.equal(settled, true);
      assert.equal(h.handled.length, 1);
      assert.equal(h.socket.frames().length, 2);
    });
  }
});

test('settled handlers clear their watchdog without revoking the bound channel', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = fixture(t); h.ready(); h.socket.receive(control()); await tick();
  t.mock.timers.tick(20_000);
  assert.equal(h.channel.isReady(), true);
  h.socket.receive(control(2)); await tick();
  assert.equal(h.handled.length, 2);
  assert.deepEqual(h.disconnected, []);
});

test('handler exceptions, rejected promises and invalid results fail closed without output', async (t) => {
  const handlers: Array<[string, DesktopRestartHandler['handle']]> = [
    ['throw', () => { throw new Error('synthetic failure'); }],
    ['reject', () => Promise.reject(new Error('synthetic failure'))],
    ['missing result', () => Promise.resolve(undefined as never)],
    ['extra field', () => Promise.resolve({ ...openResult, path: '/tmp/payload' })],
    ['malformed state', () => Promise.resolve({ ...openResult, state: 'installed' } as never)],
    ['coerced state', () => Promise.resolve({ ...openResult, state: ['open'] } as never)],
  ];
  for (const [name, handle] of handlers) {
    await t.test(name, async () => {
      const h = fixture(t, { handle }); h.ready(); h.socket.receive(control()); await tick();
      assert.deepEqual(h.socket.frames().slice(2), [], 'invalid results must never cross the native wire');
      assert.equal(h.channel.isReady(), false);
      assert.deepEqual(h.disconnected, [binding.epoch]);
      assert.equal(h.socket.frames().length, 2);
    });
  }
});

test('connect and disconnect callback failures cannot revive or leak a channel', (t) => {
  const observed = handlerFixture();
  const failed = new DesktopRestartChannel({ binding, pid: 42, handler: observed.handler,
    connect: (() => { throw new Error('synthetic connect failure'); }) as unknown as typeof Connect,
  });
  t.after(() => failed.close());
  assert.equal(failed.isReady(), false);
  assert.deepEqual(observed.bound, []);
  assert.deepEqual(observed.disconnected, []);
  const h = fixture(t, { disconnected() { throw new Error('synthetic disconnect failure'); } });
  h.ready(); assert.doesNotThrow(() => h.channel.close()); h.channel.close();
  assert.deepEqual(h.disconnected, [binding.epoch]);
  assert.equal(h.socket.destroyed, true);
});

// An invalid UTF-8 value in an overwritten JSON key would disappear under a
// replacement-character decoder. Fatal decoding must reject the wire itself.
function invalidUtf8Frame(valid: unknown, bytes = [0xff]) {
  return Buffer.concat([Buffer.from('{"kind":"'), Buffer.from(bytes), Buffer.from(`",${JSON.stringify(valid).slice(1)}\n`)]);
}

test('malformed, oversized and invalid UTF-8 frames fail closed in every phase', async (t) => {
  for (const phase of ['challenge', 'attaching', 'ready'] as const) {
    await t.test(phase, async (t) => {
      const variants: Array<[string, (valid: unknown) => Buffer]> = [
        ['empty line', () => Buffer.from('\n')], ['malformed JSON', () => Buffer.from('{broken}\n')],
        ['null', () => line(null)], ['array', () => line([])], ['unknown object', () => line({})],
        ['oversized complete frame', (valid) => Buffer.concat([Buffer.alloc(4097, 32), line(valid)])],
        ['oversized partial frame', () => Buffer.alloc(4097, 32)],
        ['oversized receive buffer', (valid) => Buffer.concat([line(valid), Buffer.alloc(16 * 1024, 32)])],
        ...[[0xff], [0x80], [0xc0, 0xaf], [0xe2, 0x82], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80]]
          .map((bytes): [string, (valid: unknown) => Buffer] => [`invalid UTF-8 ${Buffer.from(bytes).toString('hex')}`, (valid) => invalidUtf8Frame(valid, bytes)]),
      ];
      for (const [name, bytes] of variants) {
        await t.test(name, async (t) => {
          const h = fixture(t); const challenge = h.connect();
          if (phase !== 'challenge') h.socket.receive(proof(challenge));
          if (phase === 'ready') h.socket.receive(ack());
          const valid = phase === 'challenge' ? proof(challenge) : phase === 'attaching' ? ack() : control();
          const before = h.socket.written;
          h.socket.emit('data', bytes(valid)); await tick();
          assert.equal(h.socket.destroyed, true);
          assert.equal(h.channel.isReady(), false);
          assert.deepEqual(h.handled, []);
          assert.deepEqual(h.disconnected, phase === 'ready' ? [binding.epoch] : []);
          assert.equal(h.socket.written, before);
        });
      }
    });
  }
});

test('truncated frames never dispatch and peer closure discards buffered input', async (t) => {
  for (const phase of ['challenge', 'attaching', 'ready'] as const) {
    await t.test(phase, async (t) => {
      const h = fixture(t); const challenge = h.connect();
      if (phase !== 'challenge') h.socket.receive(proof(challenge));
      if (phase === 'ready') h.socket.receive(ack());
      const valid = phase === 'challenge' ? proof(challenge) : phase === 'attaching' ? ack() : control();
      const bytes = line(valid); const before = h.socket.written;
      h.socket.emit('data', bytes.subarray(0, -1)); await tick();
      assert.deepEqual(h.handled, []);
      assert.equal(h.socket.written, before);
      h.socket.emit('end'); h.socket.destroy();
      h.socket.emit('data', bytes.subarray(-1)); await tick();
      assert.deepEqual(h.bound, phase === 'ready' ? [binding.epoch] : []);
      assert.deepEqual(h.disconnected, phase === 'ready' ? [binding.epoch] : []);
      assert.deepEqual(h.handled, []);
      assert.equal(h.channel.isReady(), false);
      assert.equal(h.socket.written, before);
    });
  }
});

class NativePeer extends EventEmitter {
  readonly frames: Record<string, unknown>[] = [];
  readonly captured: Buffer[] = [];
  readonly closed: Promise<void>;
  private buffer = Buffer.alloc(0);
  private ended = false;
  private read = 0;
  private failure?: Error;

  constructor(readonly socket: Socket) {
    super();
    this.closed = new Promise((resolve) => socket.once('close', () => { this.ended = true; this.emit('frame'); resolve(); }));
    socket.on('error', () => {}); // Refused endpoints may observe ECONNRESET.
    socket.on('data', (chunk: Buffer) => {
      this.captured.push(Buffer.from(chunk)); this.buffer = Buffer.concat([this.buffer, chunk]);
      try {
        for (;;) {
          const newline = this.buffer.indexOf(10);
          if (newline < 0) break;
          this.frames.push(JSON.parse(this.buffer.subarray(0, newline).toString('utf8')));
          this.buffer = this.buffer.subarray(newline + 1);
        }
      } catch (error) { this.failure = error as Error; socket.destroy(); }
      this.emit('frame');
    });
  }

  async nextFrame(): Promise<Record<string, unknown>> {
    while (this.read >= this.frames.length) {
      if (this.failure) throw this.failure;
      assert.equal(this.ended, false, 'native peer closed before the expected frame');
      await once(this, 'frame');
    }
    return this.frames[this.read++];
  }
}

async function unixFixture(t: TestContext, overrides: Partial<DesktopRestartHandler> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'gjr-'));
  const socketPath = join(directory, 'rpc');
  const server = createServer(); const peers = new Set<Socket>();
  const cleanup: { channel?: DesktopRestartChannel } = {}; let connections = 0;
  const observed = handlerFixture(overrides);
  t.after(async () => {
    cleanup.channel?.close();
    for (const socket of peers) socket.destroy();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    // Cleanup is restricted to the private directory returned by this mkdtemp.
    await rm(directory, { recursive: true, force: true });
  });
  server.on('connection', (socket) => { connections++; peers.add(socket); socket.once('close', () => peers.delete(socket)); });
  await chmod(directory, 0o700);
  const listening = once(server, 'listening'); server.listen(socketPath); await listening;
  await chmod(socketPath, 0o600);
  const accepted = once(server, 'connection');
  const channel = new DesktopRestartChannel({ binding: { ...binding, socket: socketPath }, pid: process.pid, handler: observed.handler });
  cleanup.channel = channel;
  const [socket] = await accepted as [Socket];
  const peer = new NativePeer(socket);
  return { channel, peer, ...observed, connections: () => connections };
}

const unixOptions = { skip: process.platform === 'win32', timeout: 5_000 };

test('real Unix socket authenticates before disclosing secret and accepts coalesced ack plus first control', unixOptions, async (t) => {
  const h = await unixFixture(t); const challenge = await h.peer.nextFrame();
  onlyChallenge(h.peer.frames, Buffer.concat(h.peer.captured).toString('utf8'), process.pid);
  assert.deepEqual(h.bound, []);
  h.peer.socket.write(line(proof(challenge)));
  assert.deepEqual(await h.peer.nextFrame(), { protocolVersion: 1, kind: 'backendAttach', epoch: binding.epoch, secret: binding.secret, pid: process.pid });
  assert.deepEqual(h.bound, [], 'proof alone must not bind the backend');
  assert.equal(h.channel.isReady(), false);
  h.peer.socket.write(Buffer.concat([line(ack()), line(control())]));
  assert.deepEqual(await h.peer.nextFrame(), { protocolVersion: 1, kind: 'restartControlResult', epoch: binding.epoch, id: 1, result: openResult });
  assert.deepEqual(h.bound, [binding.epoch]);
  assert.deepEqual(h.handled, [{ command: { action: 'status' }, epoch: binding.epoch }]);
  assert.equal(h.connections(), 1);
  h.channel.close(); await h.peer.closed;
  assert.deepEqual(h.disconnected, [binding.epoch]);
});

test('real substituted Unix endpoint with a forged HMAC receives only a challenge', unixOptions, async (t) => {
  const h = await unixFixture(t); const challenge = await h.peer.nextFrame();
  h.peer.socket.write(line(proof(challenge, {}, 'synthetic-attacker-key'))); await h.peer.closed;
  onlyChallenge(h.peer.frames, Buffer.concat(h.peer.captured).toString('utf8'), process.pid);
  assert.equal(h.connections(), 1);
  assert.equal(h.channel.isReady(), false);
  assert.deepEqual(h.bound, []);
  assert.deepEqual(h.handled, []);
  assert.deepEqual(h.disconnected, []);
});

test('real Unix socket refuses a control before the exact attach acknowledgment', unixOptions, async (t) => {
  const h = await unixFixture(t); const challenge = await h.peer.nextFrame();
  h.peer.socket.write(line(proof(challenge))); await h.peer.nextFrame();
  h.peer.socket.write(line(control())); await h.peer.closed;
  assert.deepEqual(h.bound, []);
  assert.deepEqual(h.handled, []);
  assert.deepEqual(h.disconnected, []);
  assert.equal(h.peer.frames.length, 2);
});

test('real Unix framing rejects malformed, oversized, invalid UTF-8 and truncated attach acknowledgments', unixOptions, async (t) => {
  const variants: Array<[string, Buffer, boolean]> = [
    ['malformed JSON', Buffer.from('{broken}\n'), false],
    ['oversized', Buffer.concat([Buffer.alloc(4097, 32), line(ack())]), false],
    ['invalid UTF-8', invalidUtf8Frame(ack()), false],
    ['truncated before EOF', line(ack()).subarray(0, -1), true],
  ];
  for (const [name, bytes, eof] of variants) {
    await t.test(name, unixOptions, async (t) => {
      const h = await unixFixture(t); const challenge = await h.peer.nextFrame();
      h.peer.socket.write(line(proof(challenge))); await h.peer.nextFrame();
      if (eof) h.peer.socket.end(bytes); else h.peer.socket.write(bytes);
      await h.peer.closed;
      assert.equal(h.channel.isReady(), false);
      assert.deepEqual(h.bound, []);
      assert.deepEqual(h.handled, []);
      assert.deepEqual(h.disconnected, []);
      assert.equal(h.peer.frames.length, 2);
    });
  }
});
