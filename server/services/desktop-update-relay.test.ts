import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type connect as Connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import snapshot from '../../shared/fixtures/desktop-update-status.json' with { type: 'json' };
import { isDesktopUpdateCommand, isDesktopUpdateSnapshot } from '../../shared/desktopUpdateProtocol.js';

import { DesktopUpdateRelay } from './desktop-update-relay.js';

class TestSocket extends EventEmitter {
  written = '';
  destroyed = false;
  write(value: string) { this.written += value; }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } }
  frames(): Record<string, unknown>[] { return this.written.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
  challengeResponse(extras: Record<string, unknown> = {}, key: string | Buffer = 'a'.repeat(64)): string {
    const challenge = this.frames()[0];
    assert.equal(challenge.kind, 'challenge');
    const { epoch, nonce } = challenge;
    const proof = createHmac('sha256', key).update(`gajae-native-update-v1\0${epoch}\0${nonce}`, 'utf8').digest('hex');
    return `${JSON.stringify({ protocolVersion: 1, kind: 'challenge', epoch, nonce, proof, ...extras })}\n`;
  }
  /** Explicit native authentication on the SAME fake socket, before any reply. */
  authenticate(): string {
    assert.equal(this.frames().length, 1);
    const line = this.challengeResponse();
    this.emit('data', Buffer.from(line));
    assert.equal(this.frames().length, 2);
    return line;
  }
  response(extras: Record<string, unknown> = {}) {
    const frames = this.frames();
    assert.equal(frames.length, 2, 'authenticate the socket before replying');
    this.emit('data', Buffer.from(`${JSON.stringify({ protocolVersion: 1, sequence: frames[1].sequence, ok: true, snapshot, ...extras })}\n`));
  }
}
function noCapabilities(socket: TestSocket) {
  assert.equal(socket.frames().length, 1);
  const challenge = socket.frames()[0];
  assert.deepEqual(Object.keys(challenge).sort(), ['epoch', 'kind', 'nonce', 'pid', 'protocolVersion']);
  assert.doesNotMatch(socket.written, /"(?:secret|view|origin|command)"/);
  assert.equal(socket.written.includes('a'.repeat(64)), false);
  assert.equal(socket.written.includes('c'.repeat(64)), false);
}
const init = (extras: Record<string, unknown> = {}) => `GJC_DESKTOP_UPDATE_INIT ${JSON.stringify({ protocolVersion: 1, socket: '/private/tmp/owned-native/rpc', secret: 'a'.repeat(64), epoch: 'b'.repeat(64), ...extras })}\n`;
function harness(enabled = true) {
  const input = new PassThrough();
  const sockets: TestSocket[] = [];
  const relay = new DesktopUpdateRelay({ input, pid: 42, platform: 'darwin', env: enabled ? { GJC_DESKTOP: '1', GJC_DESKTOP_UPDATE_PIPE: '1' } : {}, connect: (() => { const socket = new TestSocket(); sockets.push(socket); return socket; }) as unknown as typeof Connect });
  const request = () => relay.request({ action: 'status' }, 'c'.repeat(64), 'http://127.0.0.1:43123');
  return { input, relay, sockets, request };
}

test('ordinary web/Linux/no-update launch never reads stdin or obtains a native binding', async () => {
  for (const platform of ['linux', 'darwin'] as const) {
    const input = new PassThrough();
    const relay = new DesktopUpdateRelay({ input, platform, env: platform === 'linux' ? { GJC_DESKTOP: '1', GJC_DESKTOP_UPDATE_PIPE: '1' } : {} });
    assert.equal(input.listenerCount('data'), 0);
    input.write(init());
    assert.equal(relay.isAvailable(), false);
    await assert.rejects(relay.request({ action: 'status' }, 'c'.repeat(64), 'http://127.0.0.1:43123'), /unavailable/);
  }
});

test('only one bounded fragmented owned initialization is accepted; duplicate/unknown input retires it', () => {
  const { relay, input } = harness();
  const frame = init();
  input.write(frame.slice(0, 20)); assert.equal(relay.isAvailable(), false);
  input.write(frame.slice(20)); assert.equal(relay.isAvailable(), true);
  input.write(frame); assert.equal(relay.isAvailable(), false);
  for (const frame of [init({ command: 'install' }), init({ secret: 'short' }), init({ socket: 'relative' }), 'x'.repeat(4097), '{}\n']) {
    const h = harness(); h.input.write(frame); assert.equal(h.relay.isAvailable(), false); h.relay.retire();
  }
});

test('valid round trip authenticates transport and forwards only the validated public snapshot', async () => {
  const h = harness(); h.input.write(init());
  const response = h.request(); h.sockets[0].emit('connect');
  const challenge = h.sockets[0].frames()[0];
  assert.deepEqual(challenge, { protocolVersion: 1, kind: 'challenge', epoch: 'b'.repeat(64), pid: 42, nonce: challenge.nonce });
  assert.match(String(challenge.nonce), /^[a-f0-9]{64}$/);
  noCapabilities(h.sockets[0]);
  h.sockets[0].authenticate();
  const sent = h.sockets[0].frames()[1];
  assert.deepEqual(sent, { protocolVersion: 1, secret: 'a'.repeat(64), epoch: 'b'.repeat(64), pid: 42, sequence: 1, view: 'c'.repeat(64), origin: 'http://127.0.0.1:43123', command: { action: 'status' } });
  assert.equal(h.sockets.length, 1, 'no reconnect between proof and command');
  h.sockets[0].response(); assert.deepEqual(await response, snapshot);
  assert.equal(h.sockets[0].destroyed, true); h.relay.retire();
});

test('unbound views and arbitrary updater commands are refused before opening a socket', async () => {
  const h = harness(); h.input.write(init());
  await assert.rejects(h.relay.request({ action: 'status' }, 'copied-cookie', 'http://127.0.0.1:43123'), /unauthorized/);
  await assert.rejects(h.relay.request({ action: 'status' }, 'c'.repeat(64), 'https://evil.test'), /unauthorized/);
  await assert.rejects(h.relay.request({ action: 'status', path: '/Applications' } as never, 'c'.repeat(64), 'http://127.0.0.1:43123'), /unavailable/);
  assert.equal(h.sockets.length, 0); h.relay.retire();
});

test('oversized, forged sequence, malformed state and extra responses fail closed', async () => {
  for (const value of ['x'.repeat(32769), '{}\n{}\n', JSON.stringify({ protocolVersion: 1, sequence: 2, ok: true, snapshot }) + '\n', JSON.stringify({ protocolVersion: 1, sequence: 1, ok: true, snapshot: {} }) + '\n']) {
    const h = harness(); h.input.write(init()); const response = h.request(); h.sockets[0].emit('connect');
    h.sockets[0].authenticate();
    h.sockets[0].emit('data', Buffer.from(value)); await assert.rejects(response, /protocol_error/); h.relay.retire();
  }
});

test('native rejection and disconnect never report saved preferences or installation success', async () => {
  const h = harness(); h.input.write(init()); const response = h.request(); h.sockets[0].emit('connect');
  h.sockets[0].authenticate();
  h.sockets[0].response({ ok: false, error: 'updater_unauthorized' }); await assert.rejects(response, /unauthorized/);
  const pending = h.request(); h.relay.retire(); await assert.rejects(pending, /unavailable/);
  assert.equal(h.relay.isAvailable(), false);
});

test('request queue and deadlines are bounded; timeout is not a cancellation acknowledgment', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(); h.input.write(init());
  const requests = Array.from({ length: 4 }, () => assert.rejects(h.request(), /timeout|unavailable/));
  h.sockets.forEach((socket) => { socket.emit('connect'); noCapabilities(socket); });
  await assert.rejects(h.request(), /busy/);
  t.mock.timers.tick(2_000);
  await Promise.all(requests); assert.ok(h.sockets.every((s) => s.destroyed)); h.relay.retire();
});

test('a substituted endpoint cannot obtain secret, view or command with a forged proof or public snapshot', async (t) => {
  const forged: Array<(socket: TestSocket) => string> = [
    (socket) => socket.challengeResponse({ proof: 'd'.repeat(64) }),
    (socket) => socket.challengeResponse({}, 'wrong-key'),
    // Wire key is UTF-8 text, not a hex-decoded secret.
    (socket) => socket.challengeResponse({}, Buffer.from('a'.repeat(64), 'hex')),
    () => `${JSON.stringify({ protocolVersion: 1, sequence: 1, ok: true, snapshot })}\n`,
    () => '{}\n',
    () => 'null\n',
    () => '[]\n',
    () => '{invalid}\n',
  ];
  for (const [index, response] of forged.entries()) {
    await t.test(`substitution ${index}`, async () => {
      const h = harness(); h.input.write(init());
      const pending = h.relay.request({ action: 'setAutomatic', automatic: false }, 'c'.repeat(64), 'http://127.0.0.1:43123');
      const rejected = assert.rejects(pending, /updater_unauthorized|updater_protocol_error/);
      const socket = h.sockets[0]; socket.emit('connect');
      socket.emit('data', Buffer.from(response(socket)));
      await rejected;
      noCapabilities(socket);
      assert.equal(socket.destroyed, true);
      h.relay.retire();
    });
  }
});

test('real isolated Unix attacker endpoint receives only a challenge and no second request after an invalid proof', {
  skip: process.platform === 'win32', timeout: 5_000,
}, async (t) => {
  // This path and every credential below are synthetic, test-owned fixtures.
  // No desktop process, production socket, app data or native key is accessed.
  const directory = await mkdtemp(join(tmpdir(), 'gju-'));
  const socketPath = join(directory, 'rpc');
  const input = new PassThrough();
  // No connect override: exercise a real net.Socket and kernel Unix transport.
  const relay = new DesktopUpdateRelay({ input, platform: 'darwin', env: { GJC_DESKTOP: '1', GJC_DESKTOP_UPDATE_PIPE: '1' } });
  const peers = new Set<Socket>();
  const captured: Buffer[] = [];
  let total = 0;
  let connections = 0;
  let replied = false;
  let fixtureError: unknown;
  let resolveClosed!: () => void;
  const peerClosed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const attacker = createServer((socket) => {
    connections += 1;
    peers.add(socket);
    socket.on('error', () => {}); // A rejected endpoint may receive ECONNRESET.
    socket.once('close', () => { peers.delete(socket); resolveClosed(); });
    socket.on('data', (chunk: Buffer) => {
      if (total + chunk.length > 4096) { fixtureError = new Error('Fixture request exceeded its bound.'); socket.destroy(); return; }
      total += chunk.length;
      captured.push(Buffer.from(chunk));
      if (replied) return; // Keep recording until the client actually closes.
      const bytes = Buffer.concat(captured);
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      try {
        const challenge = JSON.parse(bytes.subarray(0, newline).toString('utf8'));
        const proof = createHmac('sha256', 'attacker-does-not-have-native-key')
          .update(`gajae-native-update-v1\0${challenge.epoch}\0${challenge.nonce}`, 'utf8').digest('hex');
        replied = true;
        socket.write(`${JSON.stringify({ protocolVersion: 1, kind: 'challenge', epoch: challenge.epoch, nonce: challenge.nonce, proof })}\n`);
      } catch (error) { fixtureError = error; socket.destroy(); }
    });
  });
  t.after(async () => {
    relay.retire(); input.destroy();
    for (const socket of peers) socket.destroy();
    if (attacker.listening) await new Promise<void>((resolve, reject) => attacker.close((error) => error ? reject(error) : resolve()));
    // Remove only the private directory returned by this test's mkdtemp.
    await rm(directory, { recursive: true, force: true });
  });
  await chmod(directory, 0o700);
  attacker.listen(socketPath);
  await once(attacker, 'listening');
  await chmod(socketPath, 0o600);
  input.write(init({ socket: socketPath }));
  await assert.rejects(relay.request({ action: 'setAutomatic', automatic: false }, 'c'.repeat(64), 'http://127.0.0.1:43123'), /updater_unauthorized/);
  await peerClosed;
  assert.equal(fixtureError, undefined);
  assert.equal(connections, 1);
  assert.equal(replied, true);
  const wire = Buffer.concat(captured).toString('utf8');
  const frames = wire.trim().split('\n');
  assert.equal(frames.length, 1, 'no credential-bearing second request was received before close');
  const challenge = JSON.parse(frames[0]);
  assert.deepEqual(Object.keys(challenge).sort(), ['epoch', 'kind', 'nonce', 'pid', 'protocolVersion']);
  assert.equal(challenge.protocolVersion, 1);
  assert.equal(challenge.kind, 'challenge');
  assert.equal(challenge.epoch, 'b'.repeat(64));
  assert.equal(challenge.pid, process.pid);
  assert.match(challenge.nonce, /^[a-f0-9]{64}$/);
  assert.equal(wire.includes('a'.repeat(64)), false);
  assert.equal(wire.includes('c'.repeat(64)), false);
  assert.doesNotMatch(wire, /"(?:secret|view|origin|command)"/);
});

test('challenge verification requires exact fields, echo, type and lowercase 32-byte proof', async (t) => {
  const changes = [
    { protocolVersion: 2 }, { protocolVersion: '1' }, { kind: 'response' },
    { epoch: 'd'.repeat(64) }, { epoch: null }, { nonce: 'e'.repeat(64) }, { nonce: 1 },
    { proof: 'a'.repeat(62) }, { proof: 'A'.repeat(64) }, { proof: 'g'.repeat(64) },
    { proof: 42 }, { proof: null }, { proof: undefined }, { extra: true },
  ];
  for (const [index, fields] of changes.entries()) {
    await t.test(`invalid proof frame ${index}`, async () => {
      const h = harness(); h.input.write(init()); const response = h.request();
      const rejected = assert.rejects(response, /unauthorized/);
      const socket = h.sockets[0]; socket.emit('connect');
      socket.emit('data', Buffer.from(socket.challengeResponse(fields)));
      await rejected; noCapabilities(socket); h.relay.retire();
    });
  }
});

test('fresh per-connection nonces reject a proof captured from another request', async () => {
  const h = harness(); h.input.write(init());
  const first = h.request(); h.sockets[0].emit('connect');
  const captured = h.sockets[0].challengeResponse();
  h.sockets[0].authenticate(); h.sockets[0].response(); await first;
  const second = h.request(); const rejected = assert.rejects(second, /unauthorized/);
  h.sockets[1].emit('connect');
  assert.notEqual(h.sockets[0].frames()[0].nonce, h.sockets[1].frames()[0].nonce);
  h.sockets[1].emit('data', Buffer.from(captured));
  await rejected; noCapabilities(h.sockets[1]); h.relay.retire();
});

test('fragmented handshake withholds capabilities until the complete proof, then accepts fragmented reply', async () => {
  const h = harness(); h.input.write(init()); const response = h.request();
  const socket = h.sockets[0]; socket.emit('connect');
  const proof = socket.challengeResponse();
  for (const character of proof.slice(0, -1)) {
    socket.emit('data', Buffer.from(character));
    noCapabilities(socket);
  }
  socket.emit('data', Buffer.from('\n'));
  assert.equal(socket.frames().length, 2);
  const reply = `${JSON.stringify({ protocolVersion: 1, sequence: socket.frames()[1].sequence, ok: true, snapshot })}\n`;
  for (let offset = 0; offset < reply.length; offset += 17) socket.emit('data', Buffer.from(reply.slice(offset, offset + 17)));
  assert.deepEqual(await response, snapshot); h.relay.retire();
});

test('coalesced duplicate challenge or premature command reply is rejected before capabilities are sent', async () => {
  for (const suffix of ['duplicate', 'reply']) {
    const h = harness(); h.input.write(init()); const response = h.request();
    const rejected = assert.rejects(response, /protocol_error/);
    const socket = h.sockets[0]; socket.emit('connect');
    const proof = socket.challengeResponse();
    socket.emit('data', Buffer.from(proof + (suffix === 'duplicate' ? proof : `${JSON.stringify({ protocolVersion: 1, sequence: 1, ok: true, snapshot })}\n`)));
    await rejected; noCapabilities(socket); h.relay.retire();
  }
});

test('a repeated challenge after authentication does not trigger another credential-bearing request', async () => {
  const h = harness(); h.input.write(init()); const response = h.request();
  const rejected = assert.rejects(response, /protocol_error/);
  const socket = h.sockets[0]; socket.emit('connect');
  const proof = socket.authenticate();
  socket.emit('data', Buffer.from(proof));
  await rejected;
  assert.equal(socket.frames().length, 2); assert.equal(socket.destroyed, true); h.relay.retire();
});

test('duplicate command responses in one frame fail; late data after settlement cannot write again', async () => {
  const h = harness(); h.input.write(init()); const response = h.request();
  const rejected = assert.rejects(response, /protocol_error/);
  const socket = h.sockets[0]; socket.emit('connect'); socket.authenticate();
  const reply = `${JSON.stringify({ protocolVersion: 1, sequence: 1, ok: true, snapshot })}\n`;
  socket.emit('data', Buffer.from(reply + reply)); await rejected;
  socket.emit('data', Buffer.from(socket.challengeResponse())); socket.emit('connect');
  assert.equal(socket.frames().length, 2);
  const next = h.request(); h.sockets[1].emit('connect'); h.sockets[1].authenticate(); h.sockets[1].response();
  assert.deepEqual(await next, snapshot);
  h.sockets[1].response(); // Already settled/closed: ignored, not another operation.
  assert.equal(h.sockets[1].frames().length, 2); h.relay.retire();
});

test('oversized unauthenticated data is rejected before Buffer.concat allocates it', async (t) => {
  const h = harness(); h.input.write(init()); const response = h.request();
  const rejected = assert.rejects(response, /protocol_error/);
  const socket = h.sockets[0]; socket.emit('connect');
  const concat = t.mock.method(Buffer, 'concat');
  socket.emit('data', Buffer.alloc(32 * 1024 + 1, 'x'));
  assert.equal(concat.mock.callCount(), 0);
  await rejected; noCapabilities(socket); h.relay.retire();
});

test('the complete challenge plus reply exchange has a 32 KiB receive budget', async () => {
  for (const excess of [0, 1]) {
    const h = harness(); h.input.write(init()); const response = h.request();
    const socket = h.sockets[0]; socket.emit('connect');
    const proof = socket.authenticate();
    const reply = `${JSON.stringify({ protocolVersion: 1, sequence: 1, ok: true, snapshot })}\n`;
    const padding = ' '.repeat(32 * 1024 - Buffer.byteLength(proof) - Buffer.byteLength(reply) + excess);
    const expected = excess ? assert.rejects(response, /protocol_error/) : response;
    socket.emit('data', Buffer.from(padding + reply));
    const result = await expected;
    if (!excess) assert.deepEqual(result, snapshot);
    assert.equal(socket.destroyed, true); h.relay.retire();
  }
});

test('handshake progress and authentication do not renew the total two-second deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(); h.input.write(init()); const response = h.request();
  const rejected = assert.rejects(response, /timeout/);
  const socket = h.sockets[0]; socket.emit('connect');
  const proof = socket.challengeResponse();
  socket.emit('data', Buffer.from(proof.slice(0, 30)));
  t.mock.timers.tick(1_500);
  noCapabilities(socket);
  socket.emit('data', Buffer.from(proof.slice(30)));
  assert.equal(socket.frames().length, 2);
  t.mock.timers.tick(499); assert.equal(socket.destroyed, false);
  t.mock.timers.tick(1); await rejected;
  socket.response(); assert.equal(socket.frames().length, 2); h.relay.retire();
});

test('timeout, retirement or native close before authentication never sends capabilities', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const ending of ['timeout', 'retire', 'close']) {
    const h = harness(); h.input.write(init()); const response = h.request();
    const rejected = assert.rejects(response, /timeout|unavailable/);
    const socket = h.sockets[0]; socket.emit('connect');
    const lateProof = socket.challengeResponse();
    if (ending === 'timeout') t.mock.timers.tick(2_000);
    else if (ending === 'retire') h.relay.retire();
    else socket.destroy();
    await rejected;
    socket.emit('data', Buffer.from(lateProof)); socket.emit('connect');
    noCapabilities(socket); h.relay.retire();
  }
});

test('a connection arriving after its deadline cannot even write a challenge', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(); h.input.write(init()); const response = h.request();
  const rejected = assert.rejects(response, /timeout/);
  t.mock.timers.tick(2_000); await rejected;
  h.sockets[0].emit('connect'); assert.equal(h.sockets[0].written, ''); h.relay.retire();
});

test('the validated command is captured before the handshake awaits native authentication', async () => {
  const h = harness(); h.input.write(init());
  const command = { action: 'setAutomatic' as const, automatic: false };
  const response = h.relay.request(command, 'c'.repeat(64), 'http://127.0.0.1:43123');
  h.sockets[0].emit('connect'); noCapabilities(h.sockets[0]);
  command.automatic = true;
  h.sockets[0].authenticate();
  assert.deepEqual(h.sockets[0].frames()[1].command, { action: 'setAutomatic', automatic: false });
  h.sockets[0].response(); await response; h.relay.retire();
});

test('shared state and command fixtures reject malformed partial payloads', () => {
  assert.equal(isDesktopUpdateSnapshot(snapshot), true);
  for (const payload of [{}, null, { ...snapshot, downloadedBytes: -1 }, { ...snapshot, totalBytes: 2 }, { ...snapshot, phase: 'installed' }, { ...snapshot, extra: 'not-in-contract' }]) assert.equal(isDesktopUpdateSnapshot(payload), false);
  for (const command of [{ action: 'status' }, { action: 'check' }, { action: 'restart' }, { action: 'setAutomatic', automatic: false }]) assert.equal(isDesktopUpdateCommand(command), true);
  for (const command of [{ action: 'install' }, { action: 'status', url: 'https://evil.test' }, { action: 'setAutomatic' }]) assert.equal(isDesktopUpdateCommand(command), false);
});
