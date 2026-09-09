import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, useCallback, useState } from 'react';

import { useBrowserAutoReveal } from './useBrowserAutoReveal';

const originalSocket = globalThis.WebSocket;
const sockets: TestSocket[] = [];
class TestSocket {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) { sockets.push(this); }
  close() { this.closed = true; this.onclose?.(); }
  send(sessionId: string, ids: string[], extras: Record<string, unknown> = {}) {
    this.onmessage?.({ data: JSON.stringify({
      type: 'state', sessionId,
      payload: { sessionId, activeTabId: ids.at(-1) ?? null, tabs: ids.map((id) => ({ id, title: id, url: 'about:blank', loading: false, canGoBack: false, canGoForward: false })) },
      ...extras,
    }) });
  }
}
function Harness({ sessionId }: { sessionId?: string }) {
  const [open, setOpen] = useState(false);
  const [reveals, setReveals] = useState(0);
  const reveal = useCallback(() => { setOpen(true); setReveals((n) => n + 1); }, []);
  useBrowserAutoReveal(sessionId, reveal);
  return createElement('div', null,
    createElement('output', null, `${open ? 'open' : 'closed'}:${reveals}`),
    createElement('button', { onClick: () => setOpen(false) }, 'Close'),
  );
}
function setup(sessionId?: string) {
  globalThis.WebSocket = TestSocket as unknown as typeof WebSocket;
  return render(createElement(Harness, { sessionId }));
}
afterEach(() => { cleanup(); globalThis.WebSocket = originalSocket; sockets.length = 0; });

test('watching an idle session uses metadata only and reveals its first active tab', () => {
  setup('a');
  assert.equal(sockets[0].url, 'ws://localhost/ws/browser?sessionId=a&mode=state');
  act(() => sockets[0].send('a', []));
  assert.equal(screen.getByRole('status').textContent, 'closed:0');
  act(() => sockets[0].send('a', ['one']));
  assert.equal(screen.getByRole('status').textContent, 'open:1');
});

test('closing stays closed through loading/title updates, but a new tab reveals once', () => {
  setup('a');
  act(() => sockets[0].send('a', ['one']));
  fireEvent.click(screen.getByText('Close'));
  act(() => { sockets[0].send('a', ['one']); sockets[0].send('a', ['one']); });
  assert.equal(screen.getByRole('status').textContent, 'closed:1');
  act(() => sockets[0].send('a', ['one', 'two']));
  assert.equal(screen.getByRole('status').textContent, 'open:2');
  fireEvent.click(screen.getByText('Close'));
  act(() => sockets[0].send('a', ['two', 'one']));
  assert.equal(screen.getByRole('status').textContent, 'closed:2');
});

test('stopping and reopening reveals again, including a reused tab id', () => {
  setup('a');
  act(() => sockets[0].send('a', ['one']));
  fireEvent.click(screen.getByText('Close'));
  act(() => { sockets[0].send('a', []); sockets[0].send('a', ['one']); });
  assert.equal(screen.getByRole('status').textContent, 'open:2');
});

test('foreign sessions, malformed state and frames cannot reveal the panel', () => {
  setup('a');
  act(() => {
    sockets[0].send('b', ['one']);
    sockets[0].send('a', ['one'], { payload: { sessionId: 'b', tabs: [] } });
    sockets[0].send('a', ['one'], { type: 'frame' });
    sockets[0].onmessage?.({ data: 'not json' });
    sockets[0].onmessage?.({ data: new ArrayBuffer(4) });
  });
  assert.equal(screen.getByRole('status').textContent, 'closed:0');
});

test('session changes retire old callbacks and no project means no watcher', () => {
  const view = setup();
  assert.equal(sockets.length, 0);
  view.rerender(createElement(Harness, { sessionId: 'a' }));
  view.rerender(createElement(Harness, { sessionId: 'b' }));
  assert.equal(sockets[0].closed, true);
  act(() => sockets[0].send('a', ['one']));
  assert.equal(screen.getByRole('status').textContent, 'closed:0');
  act(() => sockets[1].send('b', ['one']));
  assert.equal(screen.getByRole('status').textContent, 'open:1');
  view.unmount();
  assert.equal(sockets[1].closed, true);
});

test('reconnecting does not reopen a dismissed tab and unmount cancels retry', async () => {
  const view = setup('a');
  act(() => sockets[0].send('a', ['one']));
  fireEvent.click(screen.getByText('Close'));
  act(() => sockets[0].close());
  await waitFor(() => assert.equal(sockets.length, 2), { timeout: 2_000 });
  act(() => sockets[1].send('a', ['one']));
  assert.equal(screen.getByRole('status').textContent, 'closed:1');
  act(() => sockets[1].close());
  view.unmount();
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(sockets.length, 2);
});
