import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';

import type WebSocket from 'ws';

import type { DesktopWorkAdmission } from '@/shared/interfaces.js';

import type { DesktopOwnerActivity } from '../../../shared/desktopUpdateProtocol.js';

import {
  AutomationService, configureDesktopRestartAdmission, createAutomationDesktopRestartReader,
  createBrowserDesktopRestartReader, createComputerDesktopRestartReader,
} from './automation.service.js';
import type { BrowserChildActivity, BrowserRequestFrame, BrowserRequestMethod } from './browser-protocol.js';
import { BrowserSidecarClient } from './browser-sidecar-client.js';
import { handleBrowserConnection } from './browser-websocket.js';
import { CuaDriverClient } from './cua-client.js';

class Admission implements DesktopWorkAdmission {
  fenced = false;
  active = 0;
  sources: string[] = [];
  enter(source: string): () => void {
    this.sources.push(source);
    if (this.fenced) throw new Error('restart fenced');
    this.active++;
    let released = false;
    return () => {
      assert.equal(released, false, 'admission must release exactly once');
      released = true;
      this.active--;
    };
  }
  enterCompletion(): () => void { throw new Error('new automation must not claim completion admission'); }
}

type WireRequest = Omit<BrowserRequestFrame, 'method'> & {
  method: string;
  params?: { name?: string; arguments?: { session?: string } };
};

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode = null;
  kills = 0;
  calls: WireRequest[] = [];
  constructor() {
    super();
    this.stdin.on('data', (bytes: Buffer) => {
      for (const line of bytes.toString().trim().split('\n')) this.calls.push(JSON.parse(line) as WireRequest);
    });
  }
  kill(): boolean { this.kills++; return true; }
  close(): void {
    this.exitCode = 0;
    this.stdout.end();
    this.stderr.end();
    this.emit('close', 0);
  }
  browserReply(request: WireRequest, result: unknown = {}): void {
    this.stdout.write(`${JSON.stringify({
      protocolVersion: 1, kind: 'response', id: request.id, method: request.method,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}), ok: true, result,
    })}\n`);
  }
  cuaReply(request: WireRequest, result: unknown = { ok: true }): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
  }
}

function children(t: TestContext) {
  const processes: FakeChild[] = [];
  const spawn = t.mock.method(childProcess, 'spawn', () => {
    const child = new FakeChild();
    processes.push(child);
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    for (const child of processes) if (child.exitCode === null) child.close();
    spawn.mock.restore();
    syncBuiltinESMExports();
  });
  return { processes, spawn };
}

function environment(t: TestContext, values: Record<string, string>) {
  for (const [name, value] of Object.entries(values)) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 1_000; i++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.fail('expected asynchronous transition did not happen');
}

function idle(activity: DesktopOwnerActivity): void {
  assert.equal(activity.complete, true);
  assert.deepEqual(activity.unknown, []);
  for (const field of ['starting', 'queued', 'running', 'settling', 'retained', 'approvals'] as const) {
    assert.equal(activity[field], 0, `${activity.owner}.${field}`);
  }
}

async function startBrowser(client: BrowserSidecarClient, fixture: ReturnType<typeof children>) {
  const status = client.status();
  await until(() => Boolean(fixture.processes[0]?.calls.length));
  const child = fixture.processes[0]!;
  assert.equal(child.calls[0]!.method, 'initialize');
  child.browserReply(child.calls[0]!);
  await until(() => child.calls.some((call) => call.method === 'status'));
  child.browserReply(child.calls.find((call) => call.method === 'status')!);
  await status;
  return child;
}

async function initializeCua(fixture: ReturnType<typeof children>) {
  await until(() => Boolean(fixture.processes.at(-1)?.calls.length));
  const child = fixture.processes.at(-1)!;
  assert.equal(child.calls[0]!.method, 'initialize');
  child.cuaReply(child.calls[0]!);
  await until(() => child.calls.some((call) => call.method === 'tools/call'));
  return child;
}

test('all three readers are pure, complete for healthy unused owners, and independent snapshots', (t) => {
  const fixture = children(t);
  const admission = new Admission();
  const service = new AutomationService();
  configureDesktopRestartAdmission(admission, service);
  const readers = [createAutomationDesktopRestartReader(service), createBrowserDesktopRestartReader(service.browser), createComputerDesktopRestartReader(service)];
  for (const reader of readers) {
    const generation = reader.getGeneration();
    const snapshot = reader.read();
    idle(snapshot);
    assert.equal(snapshot.generation, generation);
    (snapshot.unknown as string[]).push('caller_mutation');
    idle(reader.read());
    assert.equal(reader.getGeneration(), generation);
  }
  const generation = service.browser.getGeneration();
  const unsubscribe = service.subscribeBrowser(() => {});
  service.browser.cachedState('read-only');
  unsubscribe();
  assert.equal(service.browser.getGeneration(), generation);
  assert.equal(fixture.spawn.mock.callCount(), 0);
  assert.deepEqual(admission.sources, []);
});

test('fenced direct service and client producers reject before startup, label creation or dispatch', async (t) => {
  environment(t, { GAJAE_AUTOMATION: '1', CUA_DRIVER_PATH: process.execPath });
  const fixture = children(t);
  const admission = new Admission();
  const service = new AutomationService(admission);
  admission.fenced = true;
  const generation = service.getGeneration();
  const operations = [
    () => service.openBrowser('session', {}),
    () => service.commandBrowser('session', { action: 'reload' }),
    () => service.inputBrowser('session', { kind: 'text', text: 'input' }),
    () => service.authorizeBrowser('session', {}),
    () => service.authorizeComputer('session', { tool: 'list_apps' }),
    () => service.callComputer('session', 'start_session', {}),
    () => service.stopSession('session'),
    () => service.startBridge(),
    () => service.status(),
    () => service.browser.open('session', {}),
    () => service.browser.command('session', { action: 'reload' }),
    () => service.browser.input('session', { kind: 'text', text: 'input' }),
    () => service.browser.state('session'),
    () => service.browser.status(),
    () => service.browser.subscribeFrames('session'),
    () => service.browser.unsubscribeFrames('session'),
    () => service.cua.call('start_session', {}),
    () => service.cua.status(),
  ];
  for (const operation of operations) await assert.rejects(operation(), /fenced/);
  assert.equal(fixture.spawn.mock.callCount(), 0);
  assert.equal(service.getGeneration(), generation);
  idle(service.snapshotActivity());
  idle(service.browser.snapshotActivity());
  idle(service.cua.snapshotActivity());
  assert.equal(admission.active, 0);
});

test('browser startup is owned before first await and concurrent requests wait for initialize', async (t) => {
  const fixture = children(t);
  const admission = new Admission();
  const client = new BrowserSidecarClient({ runtimePath: process.execPath, desktopRestartAdmission: admission });
  const before = client.getGeneration();
  const first = client.status();
  const second = client.status();
  assert.equal(admission.active, 2);
  assert.notEqual(client.getGeneration(), before);
  assert.equal(client.snapshotActivity().starting, 1);
  await Promise.resolve();
  const child = fixture.processes[0]!;
  assert.deepEqual(child.calls.map((call) => call.method), ['initialize']);
  child.browserReply(child.calls[0]!);
  await until(() => child.calls.length === 3);
  for (const request of child.calls.slice(1)) child.browserReply(request);
  await Promise.all([first, second]);
  idle(client.snapshotActivity());
  assert.equal(admission.active, 0);
});

test('browser timeout and cancellation retain uncertainty until matching late completion', async (t) => {
  const fixture = children(t);
  const admission = new Admission();
  const client = new BrowserSidecarClient({ runtimePath: process.execPath, desktopRestartAdmission: admission });
  const child = await startBrowser(client, fixture);
  // Exercise the production request path with a short deadline, not a second
  // timeout implementation or a fake pending-map mutation.
  const request = client as unknown as {
    request(method: BrowserRequestMethod, session: undefined, payload: Record<string, unknown>, timeout: number, signal?: AbortSignal): Promise<unknown>;
  };
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    const generation = client.getGeneration();
    const pending = request.request('status', undefined, {}, cancel ? 1_000 : 5, controller.signal);
    const rejected = assert.rejects(pending, cancel ? /cancelled/ : /timed out/);
    await until(() => child.calls.at(-1)?.method === 'status' && client.snapshotActivity().running === 1);
    const wire = child.calls.at(-1)!;
    if (cancel) controller.abort();
    await rejected;
    assert.equal(admission.active, 0, 'waiter released only after transfer to the pending owner');
    assert.equal(client.snapshotActivity().complete, false);
    assert.equal(client.snapshotActivity().running, 1);
    assert.deepEqual(client.snapshotActivity().unknown, ['browser_request_unconfirmed']);
    assert.notEqual(client.getGeneration(), generation);
    const uncertain = client.getGeneration();
    child.browserReply(wire);
    idle(client.snapshotActivity());
    assert.notEqual(client.getGeneration(), uncertain);
  }
});

test('mismatched browser response never deletes uncertainty and reads never kill or recover', async (t) => {
  const fixture = children(t);
  const client = new BrowserSidecarClient({ runtimePath: process.execPath });
  const child = await startBrowser(client, fixture);
  const pending = client.status();
  const rejected = assert.rejects(pending, /mismatched/);
  await until(() => client.snapshotActivity().running === 1);
  const request = child.calls.at(-1)!;
  child.browserReply({ ...request, method: 'session.close' });
  await rejected;
  const generation = client.getGeneration();
  for (let i = 0; i < 3; i++) {
    assert.equal(client.snapshotActivity().complete, false);
    client.cachedState('never-opened');
    assert.equal(client.getGeneration(), generation);
  }
  assert.equal(child.kills, 0);
  assert.equal(fixture.spawn.mock.callCount(), 1);
  child.browserReply(request);
  idle(client.snapshotActivity());
});

test('legacy browser sessions remain busy and best-effort close/cache deletion is not closure proof', async (t) => {
  const fixture = children(t);
  const client = new BrowserSidecarClient({ runtimePath: process.execPath });
  const child = await startBrowser(client, fixture);
  const open = client.open('session', {});
  await until(() => child.calls.at(-1)?.method === 'session.open');
  child.browserReply(child.calls.at(-1)!, {
    sessionId: 'session', activeTabId: 'tab',
    tabs: [{ id: 'tab', title: '', url: 'about:blank', loading: false, canGoBack: false, canGoForward: false }],
  });
  await open;
  assert.equal(client.snapshotActivity().retained, 1);
  assert.equal(client.snapshotActivity().running, 0);
  const close = client.close('session');
  assert.equal(client.snapshotActivity().retained, 1);
  await until(() => child.calls.at(-1)?.method === 'session.close');
  child.browserReply(child.calls.at(-1)!, { closed: true });
  await close;
  assert.deepEqual(client.cachedState('session').tabs, []);
  assert.equal(client.snapshotActivity().retained, 0);
  assert.equal(client.snapshotActivity().complete, false);
  assert.ok(client.snapshotActivity().unknown.includes('browser_closure_unconfirmed'));
  assert.equal(child.kills, 0, 'snapshots never force-close to obtain idle');
});

test('browser shutdown remains settling after acknowledgment until the child close event', async (t) => {
  const fixture = children(t);
  const client = new BrowserSidecarClient({ runtimePath: process.execPath });
  const child = await startBrowser(client, fixture);
  const shutdown = client.shutdown();
  child.browserReply(child.calls.at(-1)!, { shutdown: true });
  await shutdown;
  assert.ok(client.snapshotActivity().settling > 0);
  child.close();
  idle(client.snapshotActivity());
});

test('upgraded child proof must match epoch, request tail and settled callbacks before used browser idle', async (t) => {
  const fixture = children(t);
  const client = new BrowserSidecarClient({ runtimePath: process.execPath });
  const status = client.status();
  const child = fixture.processes[0]!;
  child.browserReply(child.calls[0]!, { activityProtocol: 1, activityEpoch: 'child-proof' });
  await until(() => child.calls.at(-1)?.method === 'status');
  child.browserReply(child.calls.at(-1)!);
  await status;
  assert.equal(client.snapshotActivity().complete, false, 'handshake is not an idle report');
  let revision = 0;
  const report = (patch: Partial<BrowserChildActivity> = {}) => {
    const activity: BrowserChildActivity = {
      version: 1, epoch: 'child-proof', revision: ++revision,
      requestSequence: child.calls.at(-1)!.sequence!, starting: 0, queued: 0, running: 0,
      callbacks: 0, settling: 0, retained: 0, browserAlive: false, unknown: [], ...patch,
    };
    child.stdout.write(`${JSON.stringify({ protocolVersion: 1, kind: 'event', method: 'async', payload: {
      type: 'browser.runtime.activity', activity,
    } })}\n`);
  };
  report({ callbacks: 1 });
  assert.equal(client.snapshotActivity().running, 1);
  report({ requestSequence: 1 });
  assert.equal(client.snapshotActivity().complete, false, 'old request tail cannot prove current idle');
  report();
  idle(client.snapshotActivity());
  const open = client.open('session', {});
  await until(() => child.calls.at(-1)?.method === 'session.open');
  child.browserReply(child.calls.at(-1)!, { sessionId: 'session', activeTabId: null, tabs: [] });
  await open;
  assert.equal(client.snapshotActivity().retained, 1);
  const close = client.close('session');
  await until(() => child.calls.at(-1)?.method === 'session.close');
  child.browserReply(child.calls.at(-1)!, { closed: true });
  await close;
  assert.equal(client.snapshotActivity().complete, false, 'close reply without matching child proof stays unknown');
  report({ callbacks: 1, browserAlive: true });
  assert.ok(client.snapshotActivity().running > 0);
  assert.ok(client.snapshotActivity().retained > 0);
  report({ unknown: ['browser_operation_unconfirmed'] });
  assert.equal(client.snapshotActivity().complete, false);
  report({ epoch: 'another-child' });
  assert.equal(client.snapshotActivity().complete, false);
  report();
  idle(client.snapshotActivity());
  const snapshot = client.snapshotActivity();
  report({ revision: revision - 1 });
  assert.equal(client.snapshotActivity().complete, false, 'replayed revision is not fresh evidence');
  report();
  idle(client.snapshotActivity());
  assert.equal(snapshot.complete, true, 'published snapshots do not mutate');
});

test('recovery callback admission is fenced while retained recovery ownership is preserved', async (t) => {
  const fixture = children(t);
  const admission = new Admission();
  const client = new BrowserSidecarClient({ runtimePath: process.execPath, desktopRestartAdmission: admission });
  const child = await startBrowser(client, fixture);
  const open = client.open('session', {});
  await until(() => child.calls.at(-1)?.method === 'session.open');
  const state = { sessionId: 'session', activeTabId: 'tab', tabs: [
    { id: 'tab', title: 'Keep me', url: 'https://recovery.test/', loading: false, canGoBack: false, canGoForward: false },
  ] };
  child.browserReply(child.calls.at(-1)!, state);
  await open;
  admission.fenced = true;
  const generation = client.getGeneration();
  child.close();
  await Promise.resolve();
  assert.equal(fixture.spawn.mock.callCount(), 1);
  assert.ok(admission.sources.includes('automation.browser.recovery'));
  assert.equal(client.snapshotActivity().retained, 1);
  assert.equal(client.snapshotActivity().queued, 1);
  assert.deepEqual(client.cachedState('session'), state, 'a rejected fence cannot discard recovery URLs');
  assert.notEqual(client.getGeneration(), generation);

  admission.fenced = false;
  const status = client.status();
  await until(() => fixture.processes.length === 2);
  const replacement = fixture.processes[1]!;
  replacement.browserReply(replacement.calls[0]!);
  await until(() => replacement.calls.some((call) => call.method === 'session.open'));
  const restored = replacement.calls.find((call) => call.method === 'session.open')!;
  assert.equal(restored.payload.url, 'https://recovery.test/');
  replacement.browserReply(restored, state);
  await until(() => replacement.calls.some((call) => call.method === 'status'));
  replacement.browserReply(replacement.calls.find((call) => call.method === 'status')!);
  await status;
  await until(() => client.snapshotActivity().settling === 0);
  assert.equal(client.snapshotActivity().queued, 0);
});

test('CUA named session ownership survives cancellation and is released by late end acknowledgment', async (t) => {
  environment(t, { GAJAE_AUTOMATION: '1', CUA_DRIVER_PATH: process.execPath });
  const fixture = children(t);
  const admission = new Admission();
  const service = new AutomationService(admission);
  const start = service.callComputer('session', 'start_session', {});
  assert.equal(service.snapshotActivity().retained, 1, 'session label is owned before executable lookup');
  assert.ok(service.cua.snapshotActivity().starting > 0);
  const child = await initializeCua(fixture);
  child.cuaReply(child.calls.at(-1)!);
  await start;
  const reader = createComputerDesktopRestartReader(service);
  assert.equal(reader.read().retained, 2, 'service label and original start request both retain the session');
  assert.equal(reader.read().running, 0);
  const controller = new AbortController();
  const end = service.callComputer('session', 'end_session', {}, controller.signal);
  const rejected = assert.rejects(end, /cancelled/);
  await until(() => child.calls.at(-1)?.params?.name === 'end_session');
  const request = child.calls.at(-1)!;
  assert.ok(service.snapshotActivity().settling > 0);
  controller.abort();
  await rejected;
  assert.equal(admission.active, 0);
  assert.equal(reader.read().complete, false);
  assert.equal(reader.read().retained, 2);
  assert.ok(child.calls.some((call) => call.method === 'notifications/cancelled'));
  const generation = reader.getGeneration();
  child.cuaReply(request);
  idle(reader.read());
  idle(service.snapshotActivity());
  assert.notEqual(reader.getGeneration(), generation);
});

test('CUA timed-out requests survive transport exit and replacement at the same session name', async (t) => {
  environment(t, { CUA_DRIVER_PATH: process.execPath });
  const fixture = children(t);
  const client = new CuaDriverClient();
  const first = client.call('start_session', { session: 'same-label' });
  const oldChild = await initializeCua(fixture);
  oldChild.cuaReply(oldChild.calls.at(-1)!);
  await first;
  const request = client as unknown as {
    request(method: string, params: Record<string, unknown>, timeout: number): Promise<unknown>;
  };
  await assert.rejects(request.request('tools/call', { name: 'list_apps', arguments: {} }, 5), /timed out/);
  assert.equal(client.snapshotActivity().complete, false);
  oldChild.close();
  const next = client.call('start_session', { session: 'same-label' });
  await until(() => fixture.processes.length === 2);
  const child = await initializeCua(fixture);
  child.cuaReply(child.calls.at(-1)!);
  await next;
  assert.equal(client.snapshotActivity().retained, 2, 'replacement must not erase an older transport owner');
  const end = client.call('end_session', { session: 'same-label' });
  await until(() => child.calls.at(-1)?.params?.name === 'end_session');
  oldChild.emit('close', 0);
  child.cuaReply(child.calls.at(-1)!);
  await end;
  assert.equal(client.snapshotActivity().retained, 1);
  assert.equal(client.snapshotActivity().running, 1);
  assert.deepEqual(client.snapshotActivity().unknown, ['cua_request_unconfirmed']);
});

test('failed computer cleanup retains its label and a retry can prove healthy idle', async (t) => {
  environment(t, { GAJAE_AUTOMATION: '1' });
  const service = new AutomationService();
  let failEnd = true;
  service.cua.call = async (tool) => tool === 'end_session' && failEnd
    ? { isError: true, content: [{ text: 'cleanup failed' }] } : { ok: true };
  await service.callComputer('session', 'start_session', {});
  await assert.rejects(service.callComputer('session', 'end_session', {}), /cleanup failed/);
  assert.equal(service.snapshotActivity().retained, 1);
  assert.deepEqual(service.snapshotActivity().unknown, ['computer_session_unconfirmed']);
  failEnd = false;
  await service.callComputer('session', 'end_session', {});
  idle(service.snapshotActivity());
});

test('computer close waits for an already-owned session start instead of forgetting its label', async (t) => {
  environment(t, { GAJAE_AUTOMATION: '1', CUA_DRIVER_PATH: process.execPath });
  const fixture = children(t);
  const service = new AutomationService();
  const start = service.callComputer('session', 'start_session', {});
  const end = service.callComputer('session', 'end_session', {});
  const child = await initializeCua(fixture);
  assert.equal(child.calls.filter((call) => call.params?.name === 'start_session').length, 1);
  assert.equal(child.calls.filter((call) => call.params?.name === 'end_session').length, 0);
  assert.equal(service.snapshotActivity().retained, 1);
  assert.ok(service.snapshotActivity().settling > 0);
  const startRequest = child.calls.at(-1)!;
  child.cuaReply(startRequest);
  await start;
  await until(() => child.calls.at(-1)?.params?.name === 'end_session');
  assert.equal(child.calls.at(-1)!.params?.arguments?.session, startRequest.params?.arguments?.session);
  child.cuaReply(child.calls.at(-1)!);
  await end;
  idle(createComputerDesktopRestartReader(service).read());
});

test('CUA inspection deadline keeps admission and unknown ownership until all processes close', async (t) => {
  environment(t, { CUA_DRIVER_PATH: process.execPath });
  const fixture = children(t);
  const admission = new Admission();
  const client = new CuaDriverClient({ desktopRestartAdmission: admission });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const status = client.status();
  const expected = process.platform === 'darwin' ? 3 : 2;
  for (let i = 0; i < 1_000 && fixture.processes.length < expected; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(fixture.processes.length, expected);
  const generation = client.getGeneration();
  t.mock.timers.tick(3_000);
  assert.equal(admission.active, 1);
  assert.deepEqual(client.snapshotActivity().unknown, ['cua_inspection_unconfirmed']);
  assert.notEqual(client.getGeneration(), generation);
  for (const child of fixture.processes.slice(0, -1)) child.close();
  assert.equal(client.snapshotActivity().complete, false);
  fixture.processes.at(-1)!.close();
  await status;
  assert.equal(admission.active, 0);
  idle(client.snapshotActivity());
});

class FakeWebSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  send(value: string): void { this.sent.push(value); }
  close(): void { this.readyState = 3; this.emit('close'); }
}

test('preview subscription is gated but cached-state websocket observers are inert under the fence', async (t) => {
  const fixture = children(t);
  const admission = new Admission();
  const service = new AutomationService(admission);
  admission.fenced = true;
  for (const mode of ['state', 'preview']) {
    const socket = new FakeWebSocket();
    const before = service.browser.getGeneration();
    handleBrowserConnection(socket as unknown as WebSocket, {
      url: `/ws/browser?sessionId=session&mode=${mode}`,
    } as IncomingMessage, service);
    await until(() => socket.sent.length > 0);
    const frame = JSON.parse(socket.sent[0]!) as { type: string };
    assert.equal(frame.type, mode === 'state' ? 'state' : 'error');
    assert.equal(service.browser.getGeneration(), before);
    if (mode === 'state') assert.deepEqual(admission.sources, []);
    socket.close();
  }
  assert.equal(fixture.spawn.mock.callCount(), 0);
  idle(service.browser.snapshotActivity());
});

async function bridge(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'automation-admission-'));
  environment(t, { GAJAE_AUTOMATION: '1', GAJAE_AUTOMATION_SOCKET: join(directory, 'bridge.sock') });
  const admission = new Admission();
  const service = new AutomationService(admission);
  await service.startBridge();
  const socket = net.createConnection(process.env.GJC_AUTOMATION_SOCKET!);
  await once(socket, 'connect');
  t.after(async () => {
    socket.destroy();
    await service.shutdown();
    await rm(directory, { recursive: true, force: true });
  });
  const send = (token = process.env.GJC_AUTOMATION_TOKEN) => socket.write(`${JSON.stringify({
    id: 'request', token, sessionId: 'session', surface: 'browser', operation: 'open', payload: {},
  })}\n`);
  return { admission, service, socket, send };
}

test('direct Unix bridge authenticates before admission and rejects fenced dispatch', { skip: process.platform === 'win32' }, async (t) => {
  const { admission, service, socket, send } = await bridge(t);
  service.openBrowser = async () => { assert.fail('fenced bridge must not dispatch'); };
  admission.fenced = true;
  const count = admission.sources.length;
  send('invalid-token');
  let [data] = await once(socket, 'data');
  assert.match(data.toString(), /Unauthorized/);
  assert.equal(admission.sources.length, count);
  send();
  [data] = await once(socket, 'data');
  assert.match(data.toString(), /fenced/);
  assert.equal(admission.sources.at(-1), 'automation.bridge.request');
  idle(service.snapshotActivity());
});

test('bridge socket close cannot release an executing handler before its actual promise settles', { skip: process.platform === 'win32' }, async (t) => {
  const { admission, service, socket, send } = await bridge(t);
  let finish!: (value: unknown) => void;
  service.openBrowser = () => new Promise((resolve) => { finish = resolve; });
  send();
  await until(() => Boolean(finish));
  socket.destroy();
  await once(socket, 'close');
  assert.equal(admission.active, 1);
  assert.equal(service.snapshotActivity().running, 1);
  const generation = service.getGeneration();
  finish({ opened: false });
  await until(() => admission.active === 0);
  idle(service.snapshotActivity());
  assert.notEqual(service.getGeneration(), generation);
});
