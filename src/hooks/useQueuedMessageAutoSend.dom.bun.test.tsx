import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { act, cleanup, renderHook } from '@testing-library/react';

import { readQueuedMessages, writeQueuedMessages } from '../components/chat/utils/chatStorage';
import { useChatComposerState } from '../components/chat/hooks/useChatComposerState';
import { resetComposerFreezeForTests } from '../shared/composerFreeze';

import { useQueuedMessageAutoSend } from './useQueuedMessageAutoSend';
import type { SessionActivityMap } from './useSessionProtection';

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); resetComposerFreezeForTests(); localStorage.clear(); globalThis.fetch = originalFetch; });

const busy = (): SessionActivityMap => new Map([['a', { startedAt: Date.now(), statusText: null, canInterrupt: true, awaitingInput: false }]]);

test('a background queue held during disconnection resumes when the socket opens', () => {
  writeQueuedMessages('a', [{ content: 'follow up' }]);
  const sent: unknown[] = [];
  const ws = new EventTarget() as WebSocket;
  Object.defineProperty(ws, 'readyState', { value: WebSocket.CONNECTING, writable: true });
  const view = renderHook(({ processingSessions }: { processingSessions: SessionActivityMap }) => useQueuedMessageAutoSend({
    processingSessions, activeSessionId: 'b', ws, sendMessage: (message) => { sent.push(message); }, markSessionProcessing: () => undefined,
  }), { initialProps: { processingSessions: busy() } });
  view.rerender({ processingSessions: new Map() });
  assert.equal(readQueuedMessages('a').length, 1);
  Object.defineProperty(ws, 'readyState', { value: WebSocket.OPEN, writable: true });
  act(() => { ws.dispatchEvent(new Event('open')); });
  assert.equal(sent.length, 1, 'a completed session must not lose its dispatch eligibility while offline');
  assert.equal(readQueuedMessages('a').length, 0);
});

test('an unacknowledged steer cannot be auto-sent as a background follow-up', () => {
  writeQueuedMessages('a', [{ id: 'steer-a', content: 'already steered', pendingSteer: true } as never]);
  const sent: unknown[] = [];
  const ws = Object.assign(new EventTarget(), { readyState: WebSocket.OPEN }) as WebSocket;
  const view = renderHook(({ processingSessions }: { processingSessions: SessionActivityMap }) => useQueuedMessageAutoSend({
    processingSessions, activeSessionId: 'b', ws, sendMessage: (message) => { sent.push(message); }, markSessionProcessing: () => undefined,
  }), { initialProps: { processingSessions: busy() } });
  view.rerender({ processingSessions: new Map() });
  assert.deepEqual(sent, [], 'the server may have accepted steering before its delayed acknowledgement');
  assert.equal(readQueuedMessages('a').length, 1);
});

test('a socket failure during dispatch preserves the background queue for reconnect', () => {
  writeQueuedMessages('a', [{ content: 'keep queued' }]);
  let accepting = false;
  let marked = 0;
  const ws = Object.assign(new EventTarget(), { readyState: WebSocket.OPEN }) as WebSocket;
  const view = renderHook(({ processingSessions }: { processingSessions: SessionActivityMap }) => useQueuedMessageAutoSend({
    processingSessions, activeSessionId: 'b', ws, sendMessage: () => accepting, markSessionProcessing: () => { marked += 1; },
  }), { initialProps: { processingSessions: busy() } });
  view.rerender({ processingSessions: new Map() });
  assert.equal(readQueuedMessages('a').length, 1);
  assert.equal(marked, 0);
  accepting = true;
  act(() => ws.dispatchEvent(new Event('open')));
  assert.equal(readQueuedMessages('a').length, 0);
  assert.equal(marked, 1);
  act(() => ws.dispatchEvent(new Event('open')));
  assert.equal(marked, 1, 'reconnect must not dispatch a second turn');
});

test('a session running again before reconnect cannot flush an older completion', () => {
  writeQueuedMessages('a', [{ content: 'wait for next completion' }]);
  const sent: unknown[] = [];
  const ws = Object.assign(new EventTarget(), { readyState: WebSocket.CONNECTING }) as WebSocket;
  const view = renderHook(({ processingSessions }: { processingSessions: SessionActivityMap }) => useQueuedMessageAutoSend({
    processingSessions, activeSessionId: 'b', ws, sendMessage: (message) => { sent.push(message); }, markSessionProcessing: () => undefined,
  }), { initialProps: { processingSessions: busy() } });
  view.rerender({ processingSessions: new Map() });
  view.rerender({ processingSessions: busy() });
  Object.defineProperty(ws, 'readyState', { value: WebSocket.OPEN });
  act(() => ws.dispatchEvent(new Event('open')));
  assert.deepEqual(sent, []);
  assert.equal(readQueuedMessages('a').length, 1);
});

function mountSteeringSequence() {
  globalThis.fetch = async () => new Response('[]');
  const sent: Array<{ type: string; sessionId: string; content: string }> = [];
  const socket = Object.assign(new EventTarget(), { readyState: WebSocket.OPEN }) as WebSocket;
  type Props = { activeSessionId: string; processingSessions: SessionActivityMap; ws: WebSocket | null };
  const initialProps: Props = { activeSessionId: 'a', processingSessions: busy(), ws: socket };
  const view = renderHook(({ activeSessionId, processingSessions, ws }: Props) => {
    const sendMessage = (message: unknown) => {
      if (ws?.readyState !== WebSocket.OPEN) return false;
      sent.push(message as typeof sent[number]);
      return true;
    };
    const composer = useChatComposerState({
      selectedProject: { projectId: 'project', displayName: 'Project', fullPath: '/repo', origin: 'explicit' },
      selectedSession: { id: activeSessionId, __provider: 'gjc' }, currentSessionId: activeSessionId,
      gjcModel: 'test-model', isLoading: processingSessions.has(activeSessionId), canAbortSession: true,
      tokenBudget: null, sendMessage, scrollToBottom: () => undefined, addMessage: () => undefined,
      setIsUserScrolledUp: () => undefined, setPendingPermissionRequests: () => undefined,
    });
    useQueuedMessageAutoSend({ processingSessions, activeSessionId, ws, sendMessage, markSessionProcessing: () => undefined });
    return composer;
  }, { initialProps });
  act(() => view.result.current.handleInputChange({ target: { value: 'follow up A', selectionStart: 11 } } as never));
  act(() => view.result.current.handleSteer({ preventDefault() {} } as never));
  view.rerender({ activeSessionId: 'b', processingSessions: busy(), ws: socket });
  view.rerender({ activeSessionId: 'b', processingSessions: new Map(), ws: socket });
  assert.equal(readQueuedMessages('a')[0]?.pendingSteer, true);
  assert.deepEqual(sent.map((message) => message.type), ['chat.steer']);
  return { view, sent, socket };
}

test('a background completion waiting for steering rejection dispatches as soon as rejection arrives', () => {
  const { view, sent } = mountSteeringSequence();
  act(() => view.result.current.resolveSteerResult('follow up A', false, 'a'));
  assert.deepEqual(sent.map(({ type, sessionId, content }) => ({ type, sessionId, content })), [
    { type: 'chat.steer', sessionId: 'a', content: 'follow up A' },
    { type: 'chat.send', sessionId: 'a', content: 'follow up A' },
  ]);
  assert.deepEqual(readQueuedMessages('a'), []);
  assert.deepEqual(view.result.current.queuedDrafts, [], 'B has no queued message');
});

test('a completed background steer rejected while offline dispatches exactly once after reconnect', () => {
  const { view, sent } = mountSteeringSequence();
  view.rerender({ activeSessionId: 'b', processingSessions: new Map(), ws: null });
  act(() => view.result.current.resolveSteerResult('follow up A', false, 'a'));
  assert.equal(readQueuedMessages('a')[0]?.pendingSteer, undefined);
  assert.equal(sent.length, 1);
  const reconnected = Object.assign(new EventTarget(), { readyState: WebSocket.CONNECTING }) as WebSocket;
  view.rerender({ activeSessionId: 'b', processingSessions: new Map(), ws: reconnected });
  Object.defineProperty(reconnected, 'readyState', { value: WebSocket.OPEN });
  act(() => reconnected.dispatchEvent(new Event('open')));
  assert.equal(sent.length, 2);
  assert.equal(sent[1].sessionId, 'a');
  assert.equal(sent[1].type, 'chat.send');
  assert.deepEqual(readQueuedMessages('a'), []);
  act(() => reconnected.dispatchEvent(new Event('open')));
  assert.equal(sent.length, 2);
});

test('a completed background steer accepted late never becomes a second send', () => {
  const { view, sent, socket } = mountSteeringSequence();
  act(() => view.result.current.resolveSteerResult('follow up A', true, 'a'));
  act(() => socket.dispatchEvent(new Event('open')));
  assert.deepEqual(readQueuedMessages('a'), []);
  assert.deepEqual(sent.map((message) => message.type), ['chat.steer']);
});

test('a consumed cached queue cannot resurrect on activation or the next keystroke', async () => {
  const { view, sent, socket } = mountSteeringSequence();
  act(() => view.result.current.resolveSteerResult('follow up A', false, 'a'));
  assert.equal(sent.length, 2);
  assert.deepEqual(readQueuedMessages('a'), []);
  view.rerender({ activeSessionId: 'a', processingSessions: new Map(), ws: socket });
  act(() => view.result.current.handleInputChange({ target: { value: 'fresh draft', selectionStart: 11 } } as never));
  assert.deepEqual(view.result.current.queuedDrafts, []);
  assert.deepEqual(readQueuedMessages('a'), []);
  act(() => view.result.current.handleClearInput());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 800)); });
  assert.equal(sent.length, 2, 'no duplicate after clearing the new input either');
});
