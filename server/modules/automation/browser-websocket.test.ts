import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import test from 'node:test';

import type WebSocket from 'ws';

import { isBrowserSessionState, type BrowserSessionState } from '../../../shared/browserSessionState.js';

import type { BrowserEventFrame } from './browser-protocol.js';
import { handleBrowserConnection } from './browser-websocket.js';

class FakeWebSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = this.OPEN;
  bufferedAmount = 0;
  sent: Array<string | Buffer> = [];

  send(value: string | Buffer): void {
    this.sent.push(value);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }
}

test('an open browser websocket resubscribes after the sidecar session is recreated', async () => {
  const socket = new FakeWebSocket();
  let listener: ((event: BrowserEventFrame) => void) | undefined;
  let subscribeCalls = 0;
  let unsubscribeCalls = 0;
  const service = {
    subscribeBrowser(next: (event: BrowserEventFrame) => void) {
      listener = next;
      return () => { listener = undefined; };
    },
    browser: {
      cachedState(sessionId: string) { return { sessionId, activeTabId: null, tabs: [] }; },
      async subscribeFrames() {
        subscribeCalls += 1;
        return { sessionId: 'session-1', activeTabId: 'tab-1', tabs: [{ id: 'tab-1' }] };
      },
      async unsubscribeFrames() { unsubscribeCalls += 1; },
    },
  };

  handleBrowserConnection(
    socket as unknown as WebSocket,
    { url: '/ws/browser?sessionId=session-1' } as IncomingMessage,
    service,
  );
  assert.equal(subscribeCalls, 1);
  assert.ok(listener);
  await Promise.resolve();
  assert.deepEqual(JSON.parse(String(socket.sent[0])), {
    type: 'state',
    sessionId: 'session-1',
    payload: { sessionId: 'session-1', activeTabId: 'tab-1', tabs: [{ id: 'tab-1' }] },
  });

  listener({
    protocolVersion: 1,
    kind: 'event',
    method: 'state',
    sessionId: 'session-1',
    payload: { sessionId: 'session-1', activeTabId: null, tabs: [] },
  });
  listener({
    protocolVersion: 1,
    kind: 'event',
    method: 'state',
    sessionId: 'session-1',
    payload: { sessionId: 'session-1', activeTabId: 'tab-1', tabs: [{ id: 'tab-1' }] },
  });
  await Promise.resolve();
  assert.equal(subscribeCalls, 2);

  // Subsequent state updates for the same live sidecar session do not stack
  // redundant screencast subscriptions.
  listener({
    protocolVersion: 1,
    kind: 'event',
    method: 'state',
    sessionId: 'session-1',
    payload: { sessionId: 'session-1', activeTabId: 'tab-1', tabs: [{ id: 'tab-1' }] },
  });
  await Promise.resolve();
  assert.equal(subscribeCalls, 2);

  socket.close();
  await Promise.resolve();
  assert.equal(unsubscribeCalls, 1);
});

function browserState(sessionId = 'session-1'): BrowserSessionState {
  return {
    sessionId,
    activeTabId: 'tab-1',
    tabs: [{ id: 'tab-1', title: 'Example', url: 'https://example.test/', loading: false, canGoBack: false, canGoForward: false }],
  };
}

function streamingService(snapshot?: BrowserSessionState) {
  const listeners = new Set<(event: BrowserEventFrame) => void>();
  const calls = { cached: [] as string[], subscribe: [] as string[], unsubscribe: [] as string[], cleanup: 0 };
  const streamingSessions = new Set<string>();
  const service = {
    subscribeBrowser(listener: (event: BrowserEventFrame) => void) {
      listeners.add(listener);
      return () => { calls.cleanup += 1; listeners.delete(listener); };
    },
    browser: {
      cachedState(sessionId: string): BrowserSessionState {
        calls.cached.push(sessionId);
        return snapshot?.sessionId === sessionId ? structuredClone(snapshot) : { sessionId, activeTabId: null, tabs: [] };
      },
      async subscribeFrames(sessionId: string) {
        calls.subscribe.push(sessionId);
        streamingSessions.add(sessionId);
        return snapshot ?? { sessionId, activeTabId: null, tabs: [] };
      },
      async unsubscribeFrames(sessionId: string) {
        calls.unsubscribe.push(sessionId);
        streamingSessions.delete(sessionId);
      },
    },
  };
  return {
    service, listeners, calls, streamingSessions,
    emit(method: BrowserEventFrame['method'], payload: Record<string, unknown>, sessionId = 'session-1') {
      for (const listener of listeners) listener({ protocolVersion: 1, kind: 'event', method, sessionId, payload });
    },
  };
}

function connect(socket: FakeWebSocket, service: ReturnType<typeof streamingService>['service'], mode = 'state') {
  handleBrowserConnection(
    socket as unknown as WebSocket,
    { url: `/ws/browser?sessionId=session-1${mode ? `&mode=${mode}` : ''}` } as IncomingMessage,
    service,
  );
}

test('a metadata-only observer immediately gets an empty cache snapshot without frame subscriptions', () => {
  const socket = new FakeWebSocket();
  const fixture = streamingService();
  connect(socket, fixture.service);

  assert.deepEqual(socket.sent.map((value) => JSON.parse(String(value))), [{
    type: 'state', sessionId: 'session-1', payload: { sessionId: 'session-1', activeTabId: null, tabs: [] },
  }]);
  assert.deepEqual(fixture.calls.cached, ['session-1']);
  assert.deepEqual(fixture.calls.subscribe, []);
  socket.close();
  assert.deepEqual(fixture.calls.unsubscribe, []);
  assert.equal(fixture.listeners.size, 0);
});

test('a metadata-only observer receives cached and future matching state snapshots only', () => {
  const state = browserState();
  const socket = new FakeWebSocket();
  const fixture = streamingService(state);
  connect(socket, fixture.service);

  fixture.emit('state', browserState('session-2'), 'session-2');
  // A valid envelope cannot smuggle another session's state to the observer.
  fixture.emit('state', browserState('session-2'));
  fixture.emit('state', { sessionId: 'session-1', activeTabId: 'tab-1', tabs: [{ id: 'tab-1' }] });
  for (const method of ['ready', 'frame', 'async', 'error', 'download.progress'] as const) {
    fixture.emit(method, { data: Buffer.from('screenshot').toString('base64'), type: 'dialog', message: 'private', progress: 1 });
  }
  assert.equal(socket.sent.length, 1);

  const next = browserState();
  next.tabs[0]!.loading = true;
  fixture.emit('state', next);
  const empty = { sessionId: 'session-1', activeTabId: null, tabs: [] };
  fixture.emit('state', empty);
  fixture.emit('state', state);
  assert.deepEqual(socket.sent.map((value) => JSON.parse(String(value))), [state, next, empty, state].map((payload) => ({
    type: 'state', sessionId: 'session-1', payload,
  })));
  assert.ok(socket.sent.every((value) => typeof value === 'string'));
  assert.deepEqual(fixture.calls.subscribe, []);
  socket.close();
  assert.deepEqual(fixture.calls.unsubscribe, []);
});

test('metadata observer error and close clean up once and stale callbacks cannot send', () => {
  const socket = new FakeWebSocket();
  const fixture = streamingService();
  connect(socket, fixture.service);
  const listener = [...fixture.listeners][0]!;
  socket.emit('error', new Error('connection failed'));
  assert.equal(fixture.listeners.size, 0);
  listener({ protocolVersion: 1, kind: 'event', method: 'state', sessionId: 'session-1', payload: browserState() });
  assert.equal(socket.sent.length, 1);
  socket.close();
  assert.equal(fixture.calls.cleanup, 1);
  assert.deepEqual(fixture.calls.unsubscribe, []);
});

test('disconnecting a metadata observer never stops a real preview for the same session', async () => {
  const preview = new FakeWebSocket();
  const observer = new FakeWebSocket();
  const fixture = streamingService(browserState());
  connect(preview, fixture.service, '');
  await Promise.resolve();
  connect(observer, fixture.service);
  assert.deepEqual(fixture.calls.subscribe, ['session-1']);
  assert.equal(fixture.listeners.size, 2);
  observer.close();
  assert.deepEqual(fixture.calls.unsubscribe, []);
  assert.equal(fixture.streamingSessions.has('session-1'), true);
  assert.equal(fixture.listeners.size, 1);

  fixture.emit('frame', { data: Buffer.from('live preview').toString('base64'), mimeType: 'image/jpeg' });
  const packet = preview.sent.at(-1);
  assert.ok(Buffer.isBuffer(packet));
  const headerLength = packet.readUInt32BE(0);
  assert.deepEqual(JSON.parse(packet.subarray(4, 4 + headerLength).toString()), {
    type: 'frame', sessionId: 'session-1', mimeType: 'image/jpeg',
  });
  assert.equal(packet.subarray(4 + headerLength).toString(), 'live preview');
  assert.equal(observer.sent.length, 1);

  preview.emit('error', new Error('preview disconnected'));
  preview.close();
  await Promise.resolve();
  assert.deepEqual(fixture.calls.unsubscribe, ['session-1']);
  assert.equal(fixture.calls.cleanup, 2);
  assert.equal(fixture.listeners.size, 0);
});

test('invalid session observers close before reading cache or registering listeners', () => {
  for (const url of ['/ws/browser?mode=state', '/ws/browser?sessionId=..%2Fother&mode=state']) {
    const socket = new FakeWebSocket();
    const fixture = streamingService();
    handleBrowserConnection(socket as unknown as WebSocket, { url } as IncomingMessage, fixture.service);
    assert.equal(socket.readyState, 3);
    assert.deepEqual(socket.sent, []);
    assert.deepEqual(fixture.calls.cached, []);
    assert.deepEqual(fixture.calls.subscribe, []);
    assert.deepEqual(fixture.calls.unsubscribe, []);
    assert.equal(fixture.listeners.size, 0);
  }
});

test('shared browser state validation rejects malformed fields, arrays and mismatched sessions', () => {
  const state = browserState();
  assert.equal(isBrowserSessionState(state), true);
  assert.equal(isBrowserSessionState(state, 'session-1'), true);
  assert.equal(isBrowserSessionState(state, 'session-2'), false);
  assert.equal(isBrowserSessionState({ sessionId: 'session-1', activeTabId: null, tabs: [] }, 'session-1'), true);
  for (const malformed of [
    null, [], {}, Object.assign([], state),
    { ...state, sessionId: '' }, { ...state, sessionId: 1 },
    { ...state, activeTabId: undefined }, { ...state, activeTabId: false },
    { ...state, activeTabId: '' }, { ...state, activeTabId: 'absent' },
    { ...state, tabs: {} }, { ...state, tabs: [null] },
    { ...state, tabs: [Object.assign([], state.tabs[0])] },
    { ...state, tabs: [state.tabs[0], state.tabs[0]] },
    ...['id', 'title', 'url', 'loading', 'canGoBack', 'canGoForward'].map((field) => ({
      ...state, tabs: [{ ...state.tabs[0], [field]: undefined }],
    })),
    { ...state, tabs: [{ ...state.tabs[0], id: '' }] },
    { ...state, tabs: [{ ...state.tabs[0], loading: 'false' }] },
  ]) {
    assert.equal(isBrowserSessionState(malformed), false, JSON.stringify(malformed));
  }
});
