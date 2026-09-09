import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Browser, Page, Target } from 'puppeteer-core';

import type { DesktopOwnerActivity } from '../../../shared/desktopUpdateProtocol.js';

import { BrowserRequestQueue } from './browser-runtime.js';
import { BrowserRuntime } from './browser-sidecar.js';
import { BrowserSidecarClient } from './browser-sidecar-client.js';
import { isBrowserChildActivity, type BrowserChildActivity, type BrowserRequestFrame } from './browser-protocol.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('Expected lifecycle transition did not happen');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function isIdle(activity: DesktopOwnerActivity) {
  return activity.complete && !activity.unknown.length
    && ['starting', 'queued', 'running', 'settling', 'retained', 'approvals']
      .every((field) => activity[field as keyof DesktopOwnerActivity] === 0);
}

test('child activity validation rejects malformed or extra fields', () => {
  const activity: BrowserChildActivity = {
    version: 1, epoch: 'child-epoch', revision: 1, requestSequence: 1,
    starting: 0, queued: 0, running: 0, callbacks: 0, settling: 0, retained: 0,
    browserAlive: false, unknown: [],
  };
  assert.equal(isBrowserChildActivity(activity), true);
  for (const value of [
    { ...activity, callbacks: -1 }, { ...activity, requestSequence: NaN },
    { ...activity, unknown: ['payload with spaces'] }, { ...activity, browserAlive: 0 },
    { ...activity, extra: true }, { ...activity, version: 2 },
  ]) assert.equal(isBrowserChildActivity(value), false);
});

test('queue owner covers global/session tails and realtime close before handler settlement', async () => {
  const started: string[] = [];
  const holds = new Map<string, ReturnType<typeof deferred<void>>>();
  let revisions = 0;
  const queue = new BrowserRequestQueue(async (frame) => {
    started.push(frame.id);
    await holds.get(frame.id)!.promise;
  }, () => { revisions++; }, (error) => { throw error; });
  const request = (id: string, method: BrowserRequestFrame['method'], sessionId?: string) => {
    holds.set(id, deferred<void>());
    queue.enqueue({ protocolVersion: 1, kind: 'request', id, method, payload: {}, ...(sessionId ? { sessionId } : {}) });
  };
  request('global-a', 'status');
  request('global-b', 'status');
  request('run', 'browser.command', 'session');
  request('next', 'browser.command', 'session');
  request('close', 'session.close', 'session');
  assert.deepEqual(started, ['close']);
  assert.deepEqual(queue.snapshot(), { queued: 4, running: 1, requestSequence: 5 });
  await Promise.resolve();
  assert.equal(queue.snapshot().running, 3);
  assert.equal(queue.snapshot().queued, 2);
  const before = revisions;
  queue.snapshot();
  assert.equal(revisions, before, 'snapshot is inert');
  for (const id of ['close', 'global-a', 'run']) holds.get(id)!.resolve();
  await until(() => started.length === 5);
  assert.equal(queue.snapshot().running, 2);
  holds.get('global-b')!.resolve();
  holds.get('next')!.resolve();
  await until(() => queue.snapshot().running === 0);
  assert.equal(queue.snapshot().queued, 0);
});

class FakePage extends EventEmitter {
  closed = false;
  closeFailure = false;
  readonly evaluation = deferred<Record<string, unknown>>();
  readonly cdp = Object.assign(new EventEmitter(), {
    send: async (method: string) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame' } } };
      if (method === 'Page.getNavigationHistory') return { currentIndex: 0, entries: [] };
      if (method === 'Runtime.evaluate') return this.evaluation.promise;
      return {};
    },
  });
  readonly targetValue = { createCDPSession: async () => this.cdp };
  target() { return this.targetValue; }
  isClosed() { return this.closed; }
  url() { return 'about:blank'; }
  async title() { return 'Fixture'; }
  async setViewport() {}
  async createCDPSession() { return this.cdp; }
  async close() {
    if (this.closeFailure) throw new Error('page close failed');
    this.closed = true;
    this.evaluation.reject(new Error('Target closed'));
    this.emit('close');
  }
}

async function runtimeFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'browser-runtime-owner-'));
  const process = Object.assign(new EventEmitter(), { pid: 123456 });
  const pages: FakePage[] = [];
  let closeRequests = 0;
  let killRequests = 0;
  let revisions = 0;
  let groupAlive = false;
  const browser = Object.assign(new EventEmitter(), {
    connected: true,
    process: () => process,
    target: () => ({ createCDPSession: async () => ({
      on() {},
      async send(method: string) { if (method === 'Browser.close') closeRequests++; return {}; },
    }) }),
    async newPage() {
      const page = new FakePage();
      void page.evaluation.promise.catch(() => {});
      pages.push(page);
      return page;
    },
    async close() { killRequests++; throw new Error('force-close fallback is forbidden'); },
  });
  const runtime = new BrowserRuntime({
    profilePath: directory, executablePath: globalThis.process.execPath,
    launch: async () => browser as unknown as Browser,
    changed: () => { revisions++; }, emit: () => {}, processGroupExists: () => groupAlive,
  });
  return {
    runtime, browser, pages, process, directory,
    setGroupAlive: (value: boolean) => { groupAlive = value; },
    revisions: () => revisions, closeRequests: () => closeRequests, killRequests: () => killRequests,
    async cleanup() { process.emit('close', 0); await rm(directory, { recursive: true, force: true }); },
  };
}

test('a user close retains child ownership through Chromium close acknowledgment until actual exit', async () => {
  const fixture = await runtimeFixture();
  try {
    await fixture.runtime.open('session', {});
    const close = fixture.runtime.close('session');
    await until(() => fixture.closeRequests() === 1);
    assert.equal(fixture.runtime.snapshotActivity().browserAlive, true);
    assert.equal(fixture.runtime.snapshotActivity().retained, 1);
    assert.ok(fixture.runtime.snapshotActivity().settling > 0);
    const revision = fixture.revisions();
    for (let i = 0; i < 3; i++) fixture.runtime.snapshotActivity();
    assert.equal(fixture.revisions(), revision);
    assert.equal(fixture.killRequests(), 0);
    fixture.process.emit('close', 0);
    await close;
    assert.deepEqual(fixture.runtime.snapshotActivity(), {
      starting: 0, callbacks: 0, settling: 0, retained: 0, browserAlive: false, unknown: [],
    });
  } finally { await fixture.cleanup(); }
});

test('close before an accepted open starts cannot leave a late Chromium launch behind', async () => {
  const fixture = await runtimeFixture();
  try {
    const open = assert.rejects(fixture.runtime.open('session', {}), /session_closing/);
    await fixture.runtime.close('session');
    await open;
    assert.equal(fixture.pages.length, 0);
    assert.equal(fixture.closeRequests(), 0);
    assert.deepEqual(fixture.runtime.snapshotActivity(), {
      starting: 0, callbacks: 0, settling: 0, retained: 0, browserAlive: false, unknown: [],
    });
  } finally { await fixture.cleanup(); }
});

test('popup page resolution concurrent with close is retained, closed, and drained before idle', async () => {
  const fixture = await runtimeFixture();
  try {
    await fixture.runtime.open('session', {});
    const popup = new FakePage();
    void popup.evaluation.promise.catch(() => {});
    const page = deferred<Page>();
    const target = {
      opener: () => fixture.pages[0]!.targetValue,
      type: () => 'page', page: () => page.promise,
    } as unknown as Target;
    fixture.browser.emit('targetcreated', target);
    await Promise.resolve();
    const close = fixture.runtime.close('session');
    await until(() => fixture.closeRequests() === 1);
    fixture.process.emit('close', 0);
    await Promise.resolve();
    assert.ok(fixture.runtime.snapshotActivity().callbacks > 0);
    assert.equal(fixture.runtime.snapshotActivity().retained, 1);
    page.resolve(popup as unknown as Page);
    await close;
    await until(() => fixture.runtime.snapshotActivity().callbacks === 0);
    assert.equal(popup.closed, true);
    assert.equal(fixture.runtime.snapshotActivity().retained, 0);
    assert.deepEqual(fixture.runtime.snapshotActivity().unknown, []);
  } finally { await fixture.cleanup(); }
});

test('Chromium leader exit cannot prove idle while its process group still exists', async () => {
  const fixture = await runtimeFixture();
  try {
    await fixture.runtime.open('session', {});
    const close = fixture.runtime.close('session');
    await until(() => fixture.closeRequests() === 1);
    fixture.setGroupAlive(true);
    fixture.process.emit('close', 0);
    await until(() => fixture.runtime.snapshotActivity().unknown.length > 0);
    assert.equal(fixture.runtime.snapshotActivity().browserAlive, true);
    assert.ok(fixture.runtime.snapshotActivity().callbacks > 0);
    assert.equal(fixture.killRequests(), 0);
    fixture.setGroupAlive(false);
    await close;
    await until(() => fixture.runtime.snapshotActivity().callbacks === 0);
    assert.equal(fixture.runtime.snapshotActivity().browserAlive, false);
    assert.deepEqual(fixture.runtime.snapshotActivity().unknown, []);
  } finally { fixture.setGroupAlive(false); await fixture.cleanup(); }
});

test('failed launcher with no process handle remains unknown after the empty session is closed', async () => {
  const fixture = await runtimeFixture();
  try {
    const runtime = new BrowserRuntime({
      executablePath: process.execPath, profilePath: fixture.directory, emit: () => {},
      launch: async () => { throw new Error('launcher failed before publishing its process'); },
    });
    await assert.rejects(runtime.open('session', {}), /launcher failed/);
    await runtime.close('session');
    assert.equal(runtime.snapshotActivity().retained, 0);
    assert.deepEqual(runtime.snapshotActivity().unknown, ['browser_launch_unconfirmed']);
  } finally { await fixture.cleanup(); }
});

test('run timeout retains the evaluation until late settlement or verified browser closure', async () => {
  const fixture = await runtimeFixture();
  try {
    await fixture.runtime.open('session', {});
    await assert.rejects(fixture.runtime.command('session', { action: 'run', code: 'pending', timeoutMs: 5 }), /run_timeout/);
    assert.ok(fixture.runtime.snapshotActivity().callbacks > 0);
    assert.deepEqual(fixture.runtime.snapshotActivity().unknown, ['browser_callback_unconfirmed']);
    fixture.pages[0]!.evaluation.resolve({ result: { type: 'string', value: 'late result' } });
    await until(() => fixture.runtime.snapshotActivity().callbacks === 0);
    assert.deepEqual(fixture.runtime.snapshotActivity().unknown, []);
    assert.equal(fixture.runtime.snapshotActivity().browserAlive, true);
    const close = fixture.runtime.close('session');
    await until(() => fixture.closeRequests() === 1);
    fixture.process.emit('close', 0);
    await close;
  } finally { await fixture.cleanup(); }
});

test('failed page close with another live session stays unknown and does not close the other owner', async () => {
  const fixture = await runtimeFixture();
  try {
    await fixture.runtime.open('first', {});
    await fixture.runtime.open('second', {});
    fixture.pages[0]!.closeFailure = true;
    await assert.rejects(fixture.runtime.close('first'), /page close failed/);
    assert.equal(fixture.runtime.snapshotActivity().retained, 2);
    assert.deepEqual(fixture.runtime.snapshotActivity().unknown, ['browser_operation_unconfirmed']);
    assert.equal(fixture.closeRequests(), 0);
    assert.equal(fixture.pages[1]!.closed, false);
    fixture.pages[0]!.closeFailure = false;
    await fixture.runtime.close('first');
    const close = fixture.runtime.close('second');
    await until(() => fixture.closeRequests() === 1);
    fixture.process.emit('close', 0);
    await close;
    assert.deepEqual(fixture.runtime.snapshotActivity().unknown, []);
  } finally { await fixture.cleanup(); }
});

test('isolated real sidecar: popup, worker, screencast, timed-out evaluation, close, reopen and idle', {
  skip: process.env.GAJAE_BROWSER_LIFECYCLE_E2E !== '1', timeout: 60_000,
}, async () => {
  const executable = process.env.GAJAE_BROWSER_E2E_EXECUTABLE;
  assert.ok(executable && existsSync(executable), 'Set GAJAE_BROWSER_E2E_EXECUTABLE to an installed Chromium executable');
  const runtimePath = fileURLToPath(new URL('../../../dist-native/bun', import.meta.url));
  assert.ok(existsSync(runtimePath));
  const directory = await mkdtemp(join(tmpdir(), 'browser-lifecycle-e2e-'));
  const previous = Object.fromEntries(['GAJAE_BROWSER_EXECUTABLE_PATH', 'GAJAE_BROWSER_PROFILE_DIR', 'GAJAE_BROWSER_CACHE_DIR']
    .map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    GAJAE_BROWSER_EXECUTABLE_PATH: executable,
    GAJAE_BROWSER_PROFILE_DIR: join(directory, 'profile'),
    GAJAE_BROWSER_CACHE_DIR: join(directory, 'cache'),
  });
  const server = http.createServer((request, response) => {
    if (request.url === '/worker.js') {
      response.setHeader('Content-Type', 'application/javascript');
      response.end('self.addEventListener("install", () => self.skipWaiting()); self.addEventListener("activate", event => event.waitUntil(self.clients.claim())); self.addEventListener("fetch", () => {});');
    } else {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>Isolated lifecycle fixture</title><p>Browser lifecycle</p>');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/`;
  const client = new BrowserSidecarClient({ runtimePath });
  const observations: DesktopOwnerActivity[] = [];
  let frames = 0;
  client.subscribe((event) => { if (event.method === 'frame') frames++; });
  try {
    await client.status();
    await until(() => isIdle(client.snapshotActivity()));
    await client.open('lifecycle', { url });
    const pid = client.browserPid;
    assert.ok(pid);
    await client.command('lifecycle', { action: 'run', code: 'document.cookie = "lifecycle=preserved;max-age=3600"; window.open("/popup"); await navigator.serviceWorker.register("/worker.js"); await navigator.serviceWorker.ready; "ready"' });
    await until(() => client.cachedState('lifecycle').tabs.length === 2);
    await client.subscribeFrames('lifecycle');
    await until(() => frames > 0);
    await assert.rejects(client.command('lifecycle', {
      action: 'run', code: 'await new Promise(resolve => setTimeout(() => resolve("late"), 200)); "late"', timeoutMs: 10,
    }), /run_timeout/);
    observations.push(client.snapshotActivity());
    assert.ok(observations.at(-1)!.unknown.includes('browser_callback_unconfirmed'));
    await until(() => !client.snapshotActivity().unknown.length);
    await assert.rejects(client.command('lifecycle', {
      action: 'run', code: 'await new Promise(() => {});', timeoutMs: 10,
    }), /run_timeout/);
    await client.close('lifecycle');
    await until(() => isIdle(client.snapshotActivity()), 10_000);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    if (process.platform !== 'win32') assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' });
    const generation = client.getGeneration();
    for (let i = 0; i < 10; i++) assert.equal(isIdle(client.snapshotActivity()), true);
    assert.equal(client.getGeneration(), generation);
    await client.open('lifecycle', { url });
    assert.notEqual(client.browserPid, pid);
    const cookie = await client.command('lifecycle', { action: 'run', code: 'document.cookie' });
    assert.match(JSON.stringify(cookie), /lifecycle=preserved/);
    await client.close('lifecycle');
    await until(() => isIdle(client.snapshotActivity()), 10_000);
    await client.shutdown();
    await until(() => isIdle(client.snapshotActivity()));
  } finally {
    await client.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
