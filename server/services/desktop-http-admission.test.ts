import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import { createGjcAppFactory } from '../app-factory.js';
import { asyncHandler, getHttpActivityGeneration, snapshotHttpActivity } from '../shared/utils.js';

import { DesktopRestartAuthority } from './desktop-restart-authority.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function authority() {
  return new DesktopRestartAuthority({ requiredOwners: ['test'], ownerReaders: { test: {
    getGeneration: () => 'g1',
    read: () => ({ owner: 'test', generation: 'g1', complete: true, starting: 0, queued: 0, running: 0, settling: 0, approvals: 0, retained: 0, unknown: [] }),
  } } });
}
const attempt = { attemptId: 'test', epoch: 'test-native' };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('response finish and client disconnect do not release unfinished handler ownership', async (t) => {
  const admission = authority();
  const app = express();
  app.locals.desktopRestartAdmission = admission;
  const started = deferred();
  const finish = deferred();
  app.post('/write', asyncHandler(async (_req, res) => {
    started.resolve();
    res.json({ accepted: true });
    await finish.promise;
  }));
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { finish.resolve(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${address.port}/write`, { method: 'POST' });
  await response.json(); await started.promise;
  assert.equal((await admission.snapshot()).ingress, 1);
  assert.equal((await admission.prepare(attempt)).ok, false);
  finish.resolve(); await tick();
  assert.equal((await admission.snapshot()).ingress, 0);
  assert.equal((await admission.prepare(attempt)).ok, true);
});

test('GET producers and later mounted routes share the production composition fence', async (t) => {
  const previous = process.env.GJC_DESKTOP;
  delete process.env.GJC_DESKTOP;
  t.after(() => { if (previous === undefined) delete process.env.GJC_DESKTOP; else process.env.GJC_DESKTOP = previous; });
  const admission = authority();
  let starts = 0;
  let ownerAttachments = 0;
  const factory = createGjcAppFactory({
    authority: {}, orchestrator: { deps: {} }, gitService: {}, projection: { publish() {} }, terminalNotificationAdapter: undefined,
    authenticateWebSocket: () => false, authenticateGjcRoute: (_req: unknown, _res: unknown, next: () => void) => next(),
    validateApiKey: (_req: unknown, _res: unknown, next: () => void) => next(), chat: {}, shell: {},
    desktopRestartAdmission: admission,
  });
  factory.app.get('/api/probe', asyncHandler(async (_req, res) => { starts++; res.json({ started: true }); }));
  factory.app.use('/api/owner-probe', (_req, _res, next) => { ownerAttachments++; next(); });
  factory.app.get('/api/owner-probe', asyncHandler(async (_req, res) => res.json({ ok: true })));
  factory.app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  factory.server.listen(0, '127.0.0.1'); await once(factory.server, 'listening');
  t.after(async () => { factory.wss.close(); await new Promise<void>((resolve) => factory.server.close(() => resolve())); });
  const address = factory.server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const prepared = await admission.prepare(attempt);
  assert.equal(prepared.ok, true);
  const denied = await fetch(`${origin}/api/probe`);
  assert.equal(denied.status, 503);
  assert.equal(denied.headers.get('retry-after'), '1');
  assert.equal((await denied.json()).code, 'DESKTOP_RESTART_FENCED');
  assert.equal(starts, 0);
  assert.equal((await fetch(`${origin}/api/owner-probe`)).status, 503);
  assert.equal(ownerAttachments, 0, 'new requests must not create an owner before handler admission');
  assert.equal((await fetch(`${origin}/health`)).status, 200);
  if (prepared.ok) admission.cancel(prepared.token);
  assert.equal((await fetch(`${origin}/api/probe`)).status, 200);
  assert.equal(starts, 1);
});

test('sync throws and async rejection release once and reach Express error handling', async (t) => {
  const admission = authority();
  const initialActivity = snapshotHttpActivity();
  const app = express(); app.locals.desktopRestartAdmission = admission;
  app.get('/sync', asyncHandler(() => { throw new Error('sync'); }));
  app.get('/async', asyncHandler(async () => { throw new Error('async'); }));
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(500).json({ error: error.message }); });
  const server = http.createServer(app).listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  for (const route of ['sync', 'async']) {
    const generation = getHttpActivityGeneration();
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/${route}`)).status, 500);
    assert.equal((await admission.snapshot()).ingress, 0);
    assert.equal(snapshotHttpActivity().running, initialActivity.running);
    assert.notEqual(getHttpActivityGeneration(), generation);
  }
});

test('aborted transport does not authorize restart before the accepted write settles', async (t) => {
  const admission = authority();
  const app = express(); app.locals.desktopRestartAdmission = admission;
  const started = deferred(); const finish = deferred();
  app.post('/write', asyncHandler(async (_req, res) => { started.resolve(); await finish.promise; res.end(); }));
  const server = http.createServer(app).listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { finish.resolve(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const controller = new AbortController();
  const request = fetch(`http://127.0.0.1:${address.port}/write`, { method: 'POST', signal: controller.signal }).catch(() => null);
  await started.promise; controller.abort(); await request; await tick();
  assert.equal((await admission.snapshot()).ingress, 1);
  assert.equal((await admission.prepare(attempt)).ok, false);
  finish.resolve(); await tick();
  assert.equal((await admission.snapshot()).ingress, 0);
});
