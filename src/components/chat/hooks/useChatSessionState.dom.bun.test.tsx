import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { act, cleanup, render, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';

import { useSessionStore, type FetchMoreResult, type NormalizedMessage, type SessionSlot, type SessionStore } from '../../../stores/useSessionStore';
import type { Project, ProjectSession } from '../../../types/app';

import { useChatSessionState } from './useChatSessionState';

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });
const project = { projectId: 'project', fullPath: '/repo', displayName: 'Repo' } as Project;
const empty: NormalizedMessage[] = [];
const noop = () => {};
const page = (total: number, hasMore = false): SessionSlot => ({
  total, hasMore, tokenUsage: { used: total }, serverMessages: [{ id: `m-${total}` }],
}) as SessionSlot;

function mount() {
  const pending: Array<{ id: string; resolve: (slot: SessionSlot) => void }> = [];
  const usage: Array<{ url: string; resolve: (response: Response) => void }> = [];
  globalThis.fetch = ((url: string) => new Promise<Response>((resolve) => { usage.push({ url, resolve }); })) as typeof fetch;
  const fetchPage = (id: string) => new Promise<SessionSlot>((resolve) => { pending.push({ id, resolve }); });
  const store = {
    getMessages: () => empty,
    has: () => true,
    isStale: () => false,
    setActiveSession: noop,
    fetchFromServer: fetchPage,
    fetchMore: fetchPage,
  } as unknown as SessionStore;
  const statusCheckSentAtRef = { current: new Map<string, number>() };
  const view = renderHook(({ id }: { id: string | null }) => useChatSessionState({
    selectedProject: project,
    selectedSession: id ? { id } as ProjectSession : null,
    ws: null, sendMessage: noop, resetStreamingState: noop,
    sessionStore: store, statusCheckSentAtRef,
  }), { initialProps: { id: 'a' as string | null } });
  const resolvePage = async (index: number, slot: SessionSlot) => {
    await act(async () => { pending.splice(index, 1)[0].resolve(slot); });
  };
  return { ...view, pending, usage, resolvePage };
}

test('a late initial history response cannot replace the next session pagination or budget', async () => {
  const view = mount();
  view.rerender({ id: 'b' });
  await view.resolvePage(1, page(2));
  await view.resolvePage(0, page(100, true));
  assert.equal(view.result.current.totalMessages, 2);
  assert.equal(view.result.current.hasMoreMessages, false);
  assert.deepEqual(view.result.current.tokenBudget, { used: 2 });
});

test('the loading indicator belongs to the pending session, not an old response', async () => {
  const view = mount();
  view.rerender({ id: 'b' });
  await view.resolvePage(0, page(100, true));
  assert.equal(view.result.current.isLoadingSessionMessages, true);
  await view.resolvePage(0, page(2));
  assert.equal(view.result.current.isLoadingSessionMessages, false);
});

test('late token usage success and failure cannot update another session', async () => {
  const view = mount();
  view.rerender({ id: 'b' });
  await act(async () => { view.usage[1].resolve(new Response(JSON.stringify({ used: 2 }))); });
  await act(async () => { view.usage[0].resolve(new Response(JSON.stringify({ used: 100 }))); });
  assert.deepEqual(view.result.current.tokenBudget, { used: 2 });

  view.rerender({ id: 'c' });
  view.rerender({ id: 'd' });
  await act(async () => { view.usage[3].resolve(new Response(JSON.stringify({ used: 4 }))); });
  await act(async () => { view.usage[2].resolve(new Response('{}', { status: 404 })); });
  assert.deepEqual(view.result.current.tokenBudget, { used: 4 });
});

test('an old load-all response cannot finish a new load-all request after switching away and back', async () => {
  const view = mount();
  await view.resolvePage(0, page(20, true));
  let first: Promise<void>;
  act(() => { first = view.result.current.loadAllMessages(); });
  view.rerender({ id: 'b' });
  await view.resolvePage(1, page(2));
  view.rerender({ id: 'a' });
  await view.resolvePage(1, page(20, true));
  let second: Promise<void>;
  act(() => { second = view.result.current.loadAllMessages(); });
  await view.resolvePage(0, page(100));
  await first!;
  assert.equal(view.result.current.isLoadingAllMessages, true);
  assert.equal(view.result.current.allMessagesLoaded, false);
  assert.equal(view.result.current.totalMessages, 20);
  await view.resolvePage(0, page(101));
  await second!;
  assert.equal(view.result.current.totalMessages, 101);
});

test('an old pagination request cannot change a new session or block its own pagination', async () => {
  const view = mount();
  await view.resolvePage(0, page(100, true));
  view.result.current.scrollContainerRef.current = document.createElement('div');
  let first: Promise<void>;
  act(() => { first = view.result.current.handleScroll(); });
  view.rerender({ id: 'b' });
  await view.resolvePage(1, page(50, true));
  let second: Promise<void>;
  act(() => { second = view.result.current.handleScroll(); });
  assert.deepEqual(view.pending.map(({ id }) => id), ['a', 'b']);
  await view.resolvePage(0, page(100));
  await first!;
  assert.equal(view.result.current.isLoadingMoreMessages, true);
  assert.equal(view.result.current.totalMessages, 50);
  await view.resolvePage(0, page(50));
  await second!;
  assert.equal(view.result.current.hasMoreMessages, false);
});

test('subscription cursors survive A → B → A, reconnect, and remount with the shared store', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ messages: [], total: 0, hasMore: false }))) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const shared = renderHook(useSessionStore, {
    wrapper: ({ children }) => createElement(QueryClientProvider, { client }, children),
  });
  const store = shared.result.current;
  store.trackReplayFrame('a', { seq: 80, replayGeneration: 'a-first' });
  store.trackReplayFrame('b', { seq: 3, replayGeneration: 'b-first' });
  const sent: unknown[] = [];
  const sendMessage = (message: unknown) => { sent.push(message); };
  const statusCheckSentAtRef = { current: new Map<string, number>() };
  const mountSubscriber = () => renderHook(({ id, socket }) => useChatSessionState({
    selectedProject: project, selectedSession: { id } as ProjectSession, ws: socket,
    sendMessage, resetStreamingState: noop, sessionStore: store, statusCheckSentAtRef,
  }), { initialProps: { id: 'a', socket: {} as WebSocket } });
  const expectCursor = (sessionId: string, replayGeneration: string, lastSeq: number) => {
    assert.deepEqual(sent.at(-1), { type: 'chat.subscribe', sessions: [{ sessionId, replayGeneration, lastSeq }] });
  };
  const view = mountSubscriber();
  await act(async () => {});
  expectCursor('a', 'a-first', 80);
  view.rerender({ id: 'b', socket: {} as WebSocket });
  await act(async () => {});
  expectCursor('b', 'b-first', 3);
  store.trackReplayFrame('a', { kind: 'chat_subscribed', replayGeneration: 'a-next' });
  store.trackReplayFrame('a', { seq: 1, replayGeneration: 'a-next' });
  view.rerender({ id: 'a', socket: {} as WebSocket });
  await act(async () => {});
  expectCursor('a', 'a-next', 1);
  sent.length = 0;
  view.rerender({ id: 'a', socket: {} as WebSocket });
  expectCursor('a', 'a-next', 1);
  view.unmount();
  mountSubscriber();
  await act(async () => {});
  expectCursor('a', 'a-next', 1);
  assert.deepEqual(store.getReplayCursor('b'), { replayGeneration: 'b-first', lastSeq: 3 });
});

const message = (id: string, seconds: number, content = id): NormalizedMessage => ({
  id, sessionId: 'session', timestamp: new Date(Date.UTC(2026, 8, 6, 0, 0, seconds)).toISOString(),
  provider: 'gjc', kind: 'text', role: 'assistant', content,
});

async function setup() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
  let rows = [message('first', 20), message('latest', 30)];
  let pageRequests = 0;
  let pageResolve: ((value: FetchMoreResult) => void) | undefined;
  let allResolve: ((value: unknown) => void) | undefined;
  let state: ReturnType<typeof useChatSessionState> | undefined;
  const store = {
    setActiveSession() {},
    getMessages: () => rows,
    has: () => true,
    isStale: () => false,
    fetchFromServer: (_id: string, options: { limit: number | null }) => options.limit === null
      ? new Promise(resolve => { allResolve = resolve; })
      : Promise.resolve({ serverMessages: rows, hasMore: true, total: 40 }),
    fetchMore: () => { pageRequests += 1; return new Promise(resolve => { pageResolve = resolve; }); },
  } as unknown as SessionStore;
  const props = {
    selectedProject: { projectId: 'project', displayName: 'Project', fullPath: '/project' },
    selectedSession: { id: 'session' }, ws: null, sendMessage() {}, resetStreamingState() {},
    statusCheckSentAtRef: { current: new Map<string, number>() },
    sessionStore: store,
  };
  function Harness() {
    state = useChatSessionState(props);
    return <div ref={state.scrollContainerRef}><div /></div>;
  }
  const view = render(<Harness />);
  await act(async () => {});
  act(() => state!.setIsUserScrolledUp(true));
  const update = (next: NormalizedMessage[]) => {
    rows = next;
    view.rerender(<Harness />);
  };
  return {
    state: () => state!,
    rows: () => rows,
    update,
    pageRequests: () => pageRequests,
    async page(next: NormalizedMessage[], beforeResolve?: () => void, hasMore = false) {
      let request: Promise<void>;
      act(() => { request = state!.handleScroll(); });
      assert.ok(pageResolve);
      beforeResolve?.();
      await act(async () => {
        const addedCount = next.length - rows.length;
        rows = next;
        pageResolve!({ failed: false, addedCount, hasMore, total: next.length });
        await request!;
      });
    },
    async pageOutcome(outcome: { failed: true } | null) {
      let request: Promise<void>;
      act(() => { request = state!.handleScroll(); });
      assert.ok(pageResolve);
      await act(async () => { pageResolve!(outcome); await request!; });
    },
    async retry(next: NormalizedMessage[]) {
      act(() => state!.retryOlderMessages());
      const addedCount = next.length - rows.length;
      rows = next;
      await act(async () => { pageResolve!({ failed: false, addedCount, hasMore: false, total: next.length }); });
    },
    async all(next: NormalizedMessage[] | null) {
      let request: Promise<void>;
      act(() => { request = state!.loadAllMessages(); });
      assert.ok(allResolve);
      await act(async () => {
        if (next) rows = next;
        allResolve!(next ? { serverMessages: rows, hasMore: false, total: rows.length } : null);
        await request!;
      });
    },
    async switchSession() {
      props.selectedSession = { id: 'another-session' };
      await act(async () => view.rerender(<Harness />));
    },
    close() { view.unmount(); globalThis.fetch = originalFetch; },
  };
}

test('an empty page claiming more history stops automatic retries without hiding history', async () => {
  const harness = await setup();
  try {
    await harness.page(harness.rows(), undefined, true);
    assert.equal(harness.state().historyLoadError, true);
    assert.equal(harness.state().hasMoreMessages, true);
    assert.equal(harness.state().allMessagesLoaded, false);
    for (let index = 0; index < 8; index++) {
      await act(async () => { await harness.state().handleScroll(); });
    }
    assert.equal(harness.pageRequests(), 1);
    assert.equal(harness.state().isLoadingMoreMessages, false);
    await harness.retry([message('recovered', 0), ...harness.rows()]);
    assert.equal(harness.pageRequests(), 2);
    assert.equal(harness.state().historyLoadError, false);
    assert.equal(harness.state().allMessagesLoaded, true);
  } finally { harness.close(); }
});

test('a superseded page stays quiet while a failed request raises the retry banner', async () => {
  const harness = await setup();
  try {
    // A reconcile after a live turn discards the in-flight page: not an error.
    await harness.pageOutcome(null);
    assert.equal(harness.state().historyLoadError, false);
    assert.equal(harness.state().hasMoreMessages, true);
    await harness.pageOutcome({ failed: true });
    assert.equal(harness.state().historyLoadError, true);
    assert.equal(harness.pageRequests(), 2);
    await act(async () => { await harness.state().handleScroll(); });
    assert.equal(harness.pageRequests(), 2, 'a failed page is not retried automatically');
    await harness.retry([message('recovered', 0), ...harness.rows()]);
    assert.equal(harness.state().historyLoadError, false);
  } finally { harness.close(); }
});

test('a refused load-all surfaces the retry banner and the paged path still works', async () => {
  const harness = await setup();
  try {
    await harness.all(null);
    assert.equal(harness.state().historyLoadError, true);
    assert.equal(harness.state().allMessagesLoaded, false);
    assert.equal(harness.state().isLoadingAllMessages, false);
    await act(async () => { await harness.state().handleScroll(); });
    assert.equal(harness.pageRequests(), 0, 'no automatic paging behind an unresolved error');
    await harness.retry([message('recovered', 0), ...harness.rows()]);
    assert.equal(harness.state().historyLoadError, false);
    assert.equal(harness.pageRequests(), 1);
  } finally { harness.close(); }
});

test('load earlier pages further back once the loaded window is fully visible', async () => {
  const harness = await setup();
  try {
    assert.equal(harness.state().hasMoreMessages, true);
    act(() => harness.state().loadEarlierMessages());
    assert.equal(harness.pageRequests(), 1, 'nothing hidden locally, so the control fetches a page');
  } finally { harness.close(); }
});

test('reaching the top loads immediately without another leave-and-return gesture', async () => {
  const harness = await setup();
  try {
    await harness.page([message('older', 10), ...harness.rows()], () => {
      assert.equal(harness.state().isLoadingMoreMessages, true);
      assert.equal(harness.state().showLoadAllOverlay, false);
      act(() => { void harness.state().handleScroll(); });
      assert.equal(harness.pageRequests(), 1, 'repeated input cannot duplicate an in-flight request');
    }, true);
    assert.equal(harness.state().isLoadingMoreMessages, false);
    // Stay at scrollTop=0, as when a folded page adds no height or the user
    // keeps pulling upward. No detour below the old 100px lock boundary.
    await harness.page([message('oldest', 0), ...harness.rows()]);
    assert.equal(harness.pageRequests(), 2);
    await act(async () => { await harness.state().handleScroll(); });
    assert.equal(harness.pageRequests(), 2, 'end of history never sends another request');
    assert.equal(harness.state().hasNewMessagesBelow, false);
  } finally { harness.close(); }
});

test('reaching the top reveals already cached older rows without clicking a count notice', async () => {
  const harness = await setup();
  try {
    act(() => harness.update(Array.from({ length: 130 }, (_, index) => message(`row-${index}`, index))));
    assert.equal(harness.state().visibleMessages.length, 100);
    await act(async () => { await harness.state().handleScroll(); });
    assert.equal(harness.state().visibleMessages.length, 130);
    assert.equal(harness.pageRequests(), 0);
  } finally { harness.close(); }
});

test('loading an older page does not announce existing messages below as new', async () => {
  const harness = await setup();
  try {
    await harness.page([message('older', 10), ...harness.rows()]);
    assert.equal(harness.state().isUserScrolledUp, true);
    assert.equal(harness.state().hasNewMessagesBelow, false);
  } finally { harness.close(); }
});

test('load-all does not announce historical messages as new', async () => {
  const harness = await setup();
  try {
    await harness.all([message('oldest', 0), message('older', 10), ...harness.rows()]);
    assert.equal(harness.state().hasNewMessagesBelow, false);
  } finally { harness.close(); }
});

test('new tail arrival still announces while an older page is in flight', async () => {
  const harness = await setup();
  try {
    const arrived = message('arrived', 40);
    await harness.page([message('older', 10), ...harness.rows(), arrived], () => {
      act(() => harness.update([...harness.rows(), arrived]));
      assert.equal(harness.state().isLoadingMoreMessages, true);
      assert.equal(harness.state().hasNewMessagesBelow, true);
    });
    assert.equal(harness.state().hasNewMessagesBelow, true);
  } finally { harness.close(); }
});

test('a genuine append in the same commit as prepend is announced', async () => {
  const harness = await setup();
  try {
    await harness.page([message('older', 10), ...harness.rows(), message('arrived', 40)]);
    assert.equal(harness.state().hasNewMessagesBelow, true);
    act(() => harness.state().scrollToBottomAndReset());
    assert.equal(harness.state().hasNewMessagesBelow, false);
  } finally { harness.close(); }
});

test('tail growth is announced without increasing the message count', async () => {
  const harness = await setup();
  try {
    act(() => harness.update([harness.rows()[0], message('latest', 30, 'latest streaming addition')]));
    assert.equal(harness.state().hasNewMessagesBelow, true);
  } finally { harness.close(); }
});

test('refreshing identical rows during history loading does not raise a badge', async () => {
  const harness = await setup();
  try {
    await harness.page([message('older', 10), ...harness.rows().map(row => ({ ...row }))]);
    assert.equal(harness.state().hasNewMessagesBelow, false);
  } finally { harness.close(); }
});

test('returning to previously viewed content after rewind is not a new arrival', async () => {
  const harness = await setup();
  try {
    act(() => harness.state().rewindMessages(1));
    assert.equal(harness.state().hasNewMessagesBelow, false);
  } finally { harness.close(); }
});

test('a finalized stream with only a persisted ID change is not a new message', async () => {
  const harness = await setup();
  try {
    act(() => harness.state().setIsUserScrolledUp(false));
    act(() => harness.update([harness.rows()[0], { ...message('stream', 30, 'answer'), kind: 'stream_delta' }]));
    act(() => harness.state().setIsUserScrolledUp(true));
    act(() => harness.update([harness.rows()[0], message('persisted', 35, 'answer')]));
    assert.equal(harness.state().hasNewMessagesBelow, false);
  } finally { harness.close(); }
});

test('switching sessions clears an existing unread badge', async () => {
  const harness = await setup();
  try {
    act(() => harness.update([...harness.rows(), message('new', 40)]));
    assert.equal(harness.state().hasNewMessagesBelow, true);
    await harness.switchSession();
    assert.equal(harness.state().hasNewMessagesBelow, false);
  } finally { harness.close(); }
});

test('while following, new content does not create an unread badge', async () => {
  const harness = await setup();
  try {
    act(() => harness.state().setIsUserScrolledUp(false));
    act(() => harness.update([...harness.rows(), message('new', 40)]));
    assert.equal(harness.state().hasNewMessagesBelow, false);
  } finally { harness.close(); }
});

test('tail-window replacement notices a new message even with an unchanged count', async () => {
  const harness = await setup();
  try {
    act(() => harness.update([harness.rows()[1], message('new', 40, 'x')]));
    assert.equal(harness.state().hasNewMessagesBelow, true);
  } finally { harness.close(); }
});
