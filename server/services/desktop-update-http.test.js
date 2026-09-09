import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import snapshot from '../../shared/fixtures/desktop-update-status.json' with { type: 'json' };
import { createGjcAppFactory } from '../app-factory.js';

test('production HTTP composition requires the desktop cookie, exact Origin and native view binding', async (t) => {
  const names = ['GJC_DESKTOP', 'GJC_DESKTOP_API_KEY', 'GJC_DESKTOP_BOOTSTRAP_NONCE'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.GJC_DESKTOP = '1'; process.env.GJC_DESKTOP_API_KEY = 'a'.repeat(64); process.env.GJC_DESKTOP_BOOTSTRAP_NONCE = 'b'.repeat(64);
  t.after(() => { for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; } });
  let requests = 0;
  const factory = createGjcAppFactory({
    authority: {}, orchestrator: { deps: {} }, gitService: {}, projection: { publish() {} },
    terminalNotificationAdapter: undefined, authenticateWebSocket: () => false,
    authenticateGjcRoute: (_request, _response, next) => next(), validateApiKey: (_request, _response, next) => next(),
    chat: {}, shell: {},
    desktopUpdateRelay: {
      isAvailable: () => true,
      async request(command, view) {
        requests += 1;
        if (view !== 'c'.repeat(64)) throw new Error('updater_unauthorized');
        if (command.action === 'restart') throw new Error('updater_installation_unavailable');
        return snapshot;
      },
    },
  });
  factory.server.listen(0, '127.0.0.1'); await once(factory.server, 'listening');
  t.after(async () => { factory.wss.close(); await new Promise((resolve) => factory.server.close(resolve)); });
  const origin = `http://127.0.0.1:${factory.server.address().port}`;
  const cookie = `gajae_desktop_api_key=${'a'.repeat(64)}`;
  const call = (headers = {}, body = { action: 'status' }) => fetch(`${origin}/api/desktop/update`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await call()).status, 401);
  assert.equal((await call({ Cookie: cookie })).status, 403);
  assert.equal((await call({ Cookie: cookie, Origin: origin })).status, 403);
  assert.equal(requests, 0);
  const bound = { Cookie: cookie, Origin: origin, 'X-Gajae-Update-View': 'c'.repeat(64) };
  assert.equal((await call({ ...bound, Origin: 'https://foreign.test' })).status, 403);
  assert.equal((await call({ ...bound, 'X-Gajae-Update-View': 'd'.repeat(64) })).status, 403);
  const valid = await call(bound);
  assert.equal(valid.status, 200); assert.equal(valid.headers.get('Cache-Control'), 'no-store');
  const response = await valid.json(); assert.deepEqual(response, snapshot);
  assert.equal(JSON.stringify(response).includes('c'.repeat(64)), false);
  assert.equal((await call(bound, { action: 'status', path: '/Applications' })).status, 400);
  assert.equal((await call(bound, { action: 'setAutomatic', automatic: 'yes' })).status, 400);
  assert.equal((await call(bound, { action: 'restart' })).status, 400);
  assert.equal((await call(bound, { action: 'download' })).status, 400);
  assert.equal((await call(bound, { action: 'restart', targetId: 'f'.repeat(64) })).status, 503);
  assert.equal((await call(bound, { action: 'download', targetId: 'f'.repeat(64) })).status, 200);
  assert.equal((await call(bound, { action: 'download', targetId: 'f'.repeat(64), url: 'https://foreign.test/update' })).status, 400);
});

test('a normal self-hosted app never exposes desktop update operations even if a relay is injected', async (t) => {
  const previous = process.env.GJC_DESKTOP; delete process.env.GJC_DESKTOP;
  t.after(() => { if (previous !== undefined) process.env.GJC_DESKTOP = previous; });
  const factory = createGjcAppFactory({
    authority: {}, orchestrator: { deps: {} }, gitService: {}, projection: { publish() {} }, terminalNotificationAdapter: undefined,
    authenticateWebSocket: () => false, authenticateGjcRoute: (_request, _response, next) => next(), validateApiKey: (_request, _response, next) => next(), chat: {}, shell: {},
    desktopUpdateRelay: { isAvailable: () => true, request: () => { throw new Error('must not be called'); } },
  });
  factory.server.listen(0, '127.0.0.1'); await once(factory.server, 'listening');
  t.after(async () => { factory.wss.close(); await new Promise((resolve) => factory.server.close(resolve)); });
  const origin = `http://127.0.0.1:${factory.server.address().port}`;
  const response = await fetch(`${origin}/api/desktop/update`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Gajae-Update-View': 'c'.repeat(64) }, body: '{"action":"check"}' });
  assert.equal(response.status, 404);
});
