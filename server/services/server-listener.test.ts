import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import ts from 'typescript';
import { WebSocketServer } from 'ws';

import { listenForStartup } from './server-listener.js';

async function close(server: net.Server) {
  await new Promise<void>(resolve => server.close(() => resolve()));
}

test('HTTP bind failure forwarded by ws rejects without an unhandled WebSocketServer error', async () => {
  const owner = http.createServer();
  owner.listen(0, '127.0.0.1'); await once(owner, 'listening');
  const server = http.createServer(); const sockets = new WebSocketServer({ server });
  try {
    await assert.rejects(listenForStartup(server, sockets, (owner.address() as net.AddressInfo).port, '127.0.0.1', async () => {
      throw new Error('readiness must not run after failed bind');
    }), { code: 'EADDRINUSE' });
    assert.equal(owner.listening, true);
    assert.equal(sockets.listenerCount('error'), 0);
  } finally { sockets.close(); await close(server); await close(owner); }
});

test('listening alone does not finish initialization; readiness failure remains observable', async () => {
  const server = http.createServer(); const sockets = new WebSocketServer({ server });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let done = false;
  const started = listenForStartup(server, sockets, 0, '127.0.0.1', async () => { await gate; }).then(() => { done = true; });
  try {
    await once(server, 'listening');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(done, false);
    release(); await started;
    assert.equal(done, true);
  } finally { release(); sockets.close(); await close(server); }
  const second = http.createServer(); const secondSockets = new WebSocketServer({ server: second });
  try { await assert.rejects(listenForStartup(second, secondSockets, 0, '127.0.0.1', async () => { throw new Error('ready failed'); }), /ready failed/); }
  finally { secondSockets.close(); await close(second); }
});

test('the actual index startup failure joins cleanup and removes only its owned Unix socket', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gjc-listen-'));
  const socketPath = path.join(directory, 'a.sock');
  const owner = http.createServer(); owner.listen(0, '127.0.0.1'); await once(owner, 'listening');
  const server = http.createServer(); const wss = new WebSocketServer({ server });
  const automation = net.createServer();
  let exited!: (code: number) => void;
  const completion = new Promise<number>(resolve => { exited = resolve; });
  let markerWrites = 0; let automationStopped = false;
  const source = ts.createSourceFile('index.js', readFileSync(new URL('../index.js', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const startup = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'startServer');
  assert.ok(startup);
  const identity = (value: unknown) => value;
  const context = {
    enterInternalActivity: () => () => {}, markInternalActivityUncertain() {},
    desktopRestartAdmission: { state: 'open' },
    initializeDatabase: async () => {},
    automationService: {
      startBridge: async () => { automation.listen(socketPath); await once(automation, 'listening'); },
      shutdown: async () => { await close(automation); automationStopped = true; },
    },
    gjcJobOrchestrator: { reconcile: async () => {}, interruptForShutdown: async () => {}, close() {} },
    evaluateExposure: () => ({ level: 'allow' }),
    fs: { existsSync: () => false }, path, APP_ROOT: directory,
    c: { info: identity, warn: identity, bright: identity, dim: identity, tip: identity }, console: { log() {}, warn() {}, error() {} },
    SERVER_PORT: (owner.address() as net.AddressInfo).port, HOST: '127.0.0.1', DISPLAY_HOST: '127.0.0.1', VITE_PORT: 5173,
    process: { env: {}, on() {}, exitCode: 0, exit: (code: number) => { assert.equal(automationStopped, true); exited(code); } },
    server, wss, listenForStartup,
    writeLocalServerMarker: async () => { markerWrites++; }, removeLocalServerMarker: async () => {},
    initializeSessionsWatcher: async () => {}, closeSessionsWatcher: async () => {},
    drainWebSocketClients: async () => {}, shutdownGjcWorker: async () => {},
    setInterval: () => { throw new Error('unexpected incomplete cleanup'); },
  };
  try {
    const run = runInNewContext(`(${startup.getText(source)})`, context) as () => Promise<void>;
    await run();
    assert.equal(await completion, 1);
    assert.equal(markerWrites, 0);
    await assert.rejects(lstat(socketPath), { code: 'ENOENT' });
    assert.equal(owner.listening, true);
  } finally {
    wss.close(); await close(server); await close(automation); await close(owner);
    await rm(directory, { recursive: true, force: true });
  }
});

test('an error during readiness does not release the callback owner before its real completion', async () => {
  const server = http.createServer(); const sockets = new WebSocketServer({ server });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let settled = false;
  const pending = listenForStartup(server, sockets, 0, '127.0.0.1', async () => { await gate; });
  const checked = assert.rejects(pending, /during ready/).then(() => { settled = true; });
  try {
    await once(server, 'listening');
    server.emit('error', new Error('during ready'));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    release(); await checked;
  } finally { release(); sockets.close(); await close(server); }
});
