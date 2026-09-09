import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import test from 'node:test';

import WebSocket from 'ws';

import { verifyWebSocketClient } from '@/modules/websocket/services/websocket-auth.service.js';
import { createWebSocketServer } from '@/modules/websocket/services/websocket-server.service.js';

/*
 * The upgrade check is the only thing standing between a page the owner
 * happens to visit and a fully authorized socket onto a server that runs shell
 * commands. A WebSocket handshake is not subject to the same-origin policy, and
 * the owner here is implicit - `authenticateWebSocket` takes no argument and
 * always returns them - so "can reach the port" used to be the whole of
 * "authorized". Loopback binding is no defence: the hostile page runs inside
 * the owner's own browser, which can reach loopback.
 */

const owner = () => ({ userId: 'owner', username: 'owner' });

test('restart fence rejects a new upgrade before implicit-owner creation', () => {
  let authenticated = 0;
  const result = verifyWebSocketClient(upgrade({ host: '127.0.0.1:3001' }), {
    authenticateWebSocket: () => { authenticated++; return owner(); },
    desktopRestartAdmission: {
      enter() { throw Object.assign(new Error('fenced'), { code: 'DESKTOP_RESTART_FENCED' }); },
      enterCompletion() { throw new Error('not a completion'); },
    },
  });
  assert.equal(result, false);
  assert.equal(authenticated, 0);
});

test('upgrade authentication remains accounted through synchronous owner attachment', () => {
  let active = 0;
  let completed = 0;
  const result = verifyWebSocketClient(upgrade({ host: '127.0.0.1:3001' }), {
    authenticateWebSocket: () => { assert.equal(active, 1); return owner(); },
    desktopRestartAdmission: {
      enter() { active++; return () => { active--; completed++; }; },
      enterCompletion() { throw new Error('not a completion'); },
    },
  });
  assert.equal(result, true);
  assert.equal(active, 0);
  assert.equal(completed, 1);
});

const upgrade = (headers: Record<string, string | undefined>) => ({
  req: { url: '/ws', headers },
  origin: headers.origin ?? '',
  secure: false,
}) as never;

const verify = (
  headers: Record<string, string | undefined>,
  allowedHosts?: string,
) => verifyWebSocketClient(upgrade({ host: '127.0.0.1:3001', ...headers }), {
  authenticateWebSocket: owner,
  allowedHosts,
});

test('a hostile site cannot open a socket onto a loopback server', () => {
  assert.equal(verify({ origin: 'https://evil.example' }), false);
});

test('the opaque origin cannot open a socket', () => {
  // Sandboxed iframes and file:// documents send this.
  assert.equal(verify({ origin: 'null' }), false);
});

test('a hostname that merely looks like loopback is still foreign', () => {
  assert.equal(verify({ origin: 'https://127.0.0.1.evil.example' }), false);
  assert.equal(verify({ origin: 'https://localhost.evil.example' }), false);
});

test('the dev client on another port still connects', () => {
  // Vite serves the UI on 5173 and proxies the socket to 3001, forwarding the
  // original Origin, so a port comparison would break every dev session.
  assert.equal(verify({ origin: 'http://localhost:5173' }), true);
  assert.equal(verify({ origin: 'http://127.0.0.1:5173' }), true);
});

test('a native client that sends no Origin still connects', () => {
  // The Tauri shell and CLI callers omit it. A browser cannot omit it
  // cross-origin, so this costs nothing.
  assert.equal(verify({}), true);
});

test('a host the owner listed in ALLOWED_HOSTS connects', () => {
  assert.equal(verify({ origin: 'https://mac.tail1e211e.ts.net' }, '.tail1e211e.ts.net'), true);
  assert.equal(verify({ origin: 'https://evil.example' }, '.tail1e211e.ts.net'), false);
});

test('the origin check runs before the desktop credential check', () => {
  // Otherwise a rejected origin would still exercise the credential path, and
  // in non-desktop mode that path returns true unconditionally.
  let desktopConsulted = false;

  const allowed = verifyWebSocketClient(upgrade({ host: '127.0.0.1:3001', origin: 'https://evil.example' }), {
    authenticateWebSocket: owner,
    desktopAuth: {
      authenticateWebSocket: () => { desktopConsulted = true; return true; },
    },
  });

  assert.equal(allowed, false);
  assert.equal(desktopConsulted, false);
});

test('a rejected origin never reaches the implicit owner lookup', () => {
  let ownerLookedUp = false;

  const allowed = verifyWebSocketClient(upgrade({ host: '127.0.0.1:3001', origin: 'https://evil.example' }), {
    authenticateWebSocket: () => { ownerLookedUp = true; return owner(); },
  });

  assert.equal(allowed, false);
  assert.equal(ownerLookedUp, false);
});

test('malformed upgrade targets fail closed before authentication instead of throwing', () => {
  for (const url of ['//[', '//%', 'http://[', '//attacker.example/ws']) {
    let lookedUp = false;
    const request = { url, headers: { host: '127.0.0.1:3001' } };
    assert.equal(verifyWebSocketClient({ req: request } as never, {
      authenticateWebSocket: () => { lookedUp = true; return owner(); },
    }), false, url);
    assert.equal(lookedUp, false);
  }
});

test('the optional deployment API key protects WebSocket upgrades before owner lookup', (t) => {
  const previous = process.env.API_KEY;
  const desktop = process.env.GJC_DESKTOP;
  process.env.API_KEY = 'fixture-deployment-key';
  delete process.env.GJC_DESKTOP;
  t.after(() => {
    if (previous === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = previous;
    if (desktop === undefined) delete process.env.GJC_DESKTOP;
    else process.env.GJC_DESKTOP = desktop;
  });
  for (const key of [undefined, '', 'incorrect', 'fixture-deployment-key']) {
    let lookedUp = false;
    const valid = key === 'fixture-deployment-key';
    assert.equal(verifyWebSocketClient(upgrade({ host: '127.0.0.1:3001', 'x-api-key': key }), {
      authenticateWebSocket: () => { lookedUp = true; return owner(); },
    }), valid);
    assert.equal(lookedUp, valid);
  }
});

test('the live gateway rejects unauthorized and malformed upgrades and still accepts an authenticated client', async (t) => {
  const previous = process.env.API_KEY;
  const desktop = process.env.GJC_DESKTOP;
  process.env.API_KEY = 'fixture-gateway-key';
  delete process.env.GJC_DESKTOP;
  t.after(() => {
    if (previous === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = previous;
    if (desktop === undefined) delete process.env.GJC_DESKTOP;
    else process.env.GJC_DESKTOP = desktop;
  });
  const server = createServer();
  let attached = 0;
  const gateway = createWebSocketServer(server, {
    verifyClient: { authenticateWebSocket: () => { attached++; return owner(); } },
    chat: {} as never,
    shell: {} as never,
    browser: (socket) => socket.send('authenticated'),
  });
  t.after(async () => {
    for (const socket of gateway.clients) socket.terminate();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const rejectUpgrade = (target: string) => new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1', port: address.port, path: target,
      headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' },
    }, (response) => { response.resume(); resolve(response.statusCode); });
    request.once('error', reject);
    request.once('upgrade', (_response, socket) => { socket.destroy(); reject(new Error('Unauthenticated upgrade succeeded')); });
    request.end();
  });
  for (const target of ['/ws', '/shell', '/desktop-notifications', '/ws/browser?sessionId=one', '//[']) {
    assert.equal(await rejectUpgrade(target), 401, target);
  }
  assert.equal(attached, 0);
  const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/browser`, { headers: { 'x-api-key': 'fixture-gateway-key' } });
  const message = once(client, 'message');
  t.after(() => client.terminate());
  assert.equal(String((await message)[0]), 'authenticated');
  assert.equal(attached, 1);
});
