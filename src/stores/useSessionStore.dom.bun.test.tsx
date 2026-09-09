import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';

import { useLastTurnChanges, type LastTurnFile } from '../components/workspace/hooks/useLastTurnChanges';
import { normalizedToChatMessages } from '../components/chat/hooks/useChatMessages';
import { isToolCallRunning } from '../components/chat/utils/toolActivity';

import { useSessionStore, type NormalizedMessage, type SessionSlot, type SessionStore } from './useSessionStore';

type PendingRequest = {
  url: string;
  resolve: (response: Response) => void;
};

function response(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200 });
}

function createHarness(): { store: SessionStore; queryClient: QueryClient } {
  let store: SessionStore | undefined;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function StoreHarness() {
    store = useSessionStore();
    return null;
  }
  render(createElement(QueryClientProvider, { client: queryClient }, createElement(StoreHarness)));
  assert.ok(store);
  return { store, queryClient };
}

function createStore(): SessionStore {
  return createHarness().store;
}

afterEach(cleanup);

for (const delivery of ['live', 'replay'] as const) {
  test(`${delivery} metadata-only tool updates retain output and merge partial details until final completion`, () => {
    const store = createStore();
    const base = { sessionId: 'session', timestamp: '2026-09-06T00:00:00Z', provider: 'gjc' as const, toolId: 'tool-1' };
    const frames: NormalizedMessage[] = [
      { ...base, id: 'call', kind: 'tool_use', toolName: 'bash', toolInput: { command: 'pwd' } },
      { ...base, id: 'output', kind: 'tool_result', content: 'Already streamed output', isError: false, isFinal: false,
        toolUseResult: { async: { jobId: 'job-1', type: 'bash' }, files: ['old'] } },
      { ...base, id: 'metadata', kind: 'tool_result', content: '', isError: false, isFinal: false,
        toolUseResult: { terminalId: 'terminal-1', async: { state: 'running' }, files: ['new'] } },
    ];
    act(() => {
      if (delivery === 'replay') store.appendRealtimeBatch('session', frames);
      else frames.forEach((frame) => store.appendRealtime('session', frame));
    });
    const [running] = normalizedToChatMessages(store.getMessages('session'));
    assert.equal(running.toolResult?.content, 'Already streamed output');
    assert.equal(running.toolResult?.isFinal, false);
    assert.equal(isToolCallRunning(running), true);
    assert.deepEqual(running.toolResult?.toolUseResult, {
      terminalId: 'terminal-1', async: { jobId: 'job-1', type: 'bash', state: 'running' }, files: ['new'],
    });
    assert.deepEqual(frames[1].toolUseResult, { async: { jobId: 'job-1', type: 'bash' }, files: ['old'] }, 'earlier frames stay immutable');
    assert.equal(normalizedToChatMessages(store.getMessages('session'))[0], running, 'unchanged merged rows retain render identity');

    act(() => store.appendRealtime('session', { ...base, id: 'more-output', kind: 'tool_result', content: 'New output', isError: false, isFinal: false }));
    const updated = normalizedToChatMessages(store.getMessages('session'))[0];
    assert.equal(updated.toolResult?.content, 'New output', 'nonempty partial output replaces the cumulative display');
    assert.deepEqual(updated.toolResult?.toolUseResult, running.toolResult?.toolUseResult, 'omitted details preserve the previous result');

    act(() => store.appendRealtime('session', { ...base, id: 'final', kind: 'tool_result', content: '', isError: false, isFinal: true, toolUseResult: { exitCode: 0 } }));
    const finished = normalizedToChatMessages(store.getMessages('session'))[0];
    assert.equal(finished.toolResult?.content, '', 'an authoritative final result can deliberately clear output');
    assert.deepEqual(finished.toolResult?.toolUseResult, { exitCode: 0 }, 'final details replace partial metadata');
    assert.equal(isToolCallRunning(finished), false);

    act(() => store.appendRealtime('session', { ...base, id: 'late-metadata', kind: 'tool_result', content: '', isError: false, isFinal: false, toolUseResult: { async: { state: 'completed' } } }));
    const late = normalizedToChatMessages(store.getMessages('session'))[0];
    assert.equal(late.toolResult?.isFinal, true, 'late metadata does not reopen a finished invocation');
    assert.deepEqual(late.toolResult?.toolUseResult, { exitCode: 0, async: { state: 'completed' } });
  });
}

test('replacing a realtime tool result ID retains its earlier output and details', () => {
  const store = createStore();
  const base = { sessionId: 'session', timestamp: '2026-09-06T00:00:00Z', provider: 'gjc' as const, toolId: 'tool-1' };
  act(() => store.appendRealtimeBatch('session', [
    { ...base, id: 'call', kind: 'tool_use', toolName: 'read', toolInput: { path: 'a.ts' } },
    { ...base, id: 'result', kind: 'tool_result', content: 'file text', isError: false, isFinal: false, toolUseResult: { resolvedPath: '/repo/a.ts' } },
    { ...base, id: 'result', kind: 'tool_result', content: '', isError: false, isFinal: false, toolUseResult: { truncated: true } },
  ]));
  const messages = store.getMessages('session');
  assert.equal(messages.length, 2);
  const result = normalizedToChatMessages(messages)[0].toolResult;
  assert.equal(result?.content, 'file text');
  assert.deepEqual(result?.toolUseResult, { resolvedPath: '/repo/a.ts', truncated: true });
});

test('a shared session store exposes completed mutations to the Last turn hook', () => {
  let store: SessionStore | undefined;
  let files: LastTurnFile[] = [];
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  function SharedStoreHarness() {
    store = useSessionStore();
    files = useLastTurnChanges(store, 'session', true).files;
    return null;
  }

  render(createElement(QueryClientProvider, { client: queryClient }, createElement(SharedStoreHarness)));
  assert.ok(store);
  act(() => {
    store!.setActiveSession('session');
    store!.appendRealtimeBatch('session', [
      { id: 'user', sessionId: 'session', timestamp: '2026-01-01T00:00:00Z', provider: 'gjc', kind: 'text', role: 'user', content: 'write it' },
      { id: 'write', sessionId: 'session', timestamp: '2026-01-01T00:00:01Z', provider: 'gjc', kind: 'tool_use', toolId: 'write-1', toolName: 'write', toolInput: { path: 'done.ts', content: 'done' } },
      { id: 'result', sessionId: 'session', timestamp: '2026-01-01T00:00:02Z', provider: 'gjc', kind: 'tool_result', toolId: 'write-1', content: 'ok', isError: false, isFinal: true },
    ]);
  });

  assert.deepEqual(files.map((file) => file.path), ['done.ts']);
});

test('settled server windows live in the query cache with referentially stable slot reads', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => response({
    messages: [{ id: 'cached', sessionId: 'session', timestamp: '2026-01-01T00:00:00Z', kind: 'text', provider: 'gjc' }],
    total: 1,
    hasMore: false,
  })) as typeof fetch;

  try {
    const { store, queryClient } = createHarness();
    await store.fetchFromServer('session');

    const slot = store.getSessionSlot('session')!;
    const cachedWindow = queryClient.getQueryData(['messages', 'session']);
    assert.equal(slot.serverMessages, (cachedWindow as { messages: SessionSlot['serverMessages'] }).messages);
    assert.equal(slot.serverMessages, slot.serverMessages);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LRU slot eviction leaves its settled message window in the query cache', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => response({
    messages: [{ id: 'cached', sessionId: 'evicted', timestamp: '2026-01-01T00:00:00Z', kind: 'text', provider: 'gjc' }],
    total: 1,
    hasMore: false,
  })) as typeof fetch;

  try {
    const { store, queryClient } = createHarness();
    await store.fetchFromServer('evicted');
    for (let index = 0; index < 60; index++) {
      store.getSlot(`inactive-${index}`);
    }

    assert.equal(store.getSessionSlot('evicted'), undefined);
    assert.deepEqual(
      (queryClient.getQueryData(['messages', 'evicted']) as { messages: SessionSlot['serverMessages'] }).messages.map((message) => message.id),
      ['cached'],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('clear removes every settled message window from the query cache', () => {
  const { store, queryClient } = createHarness();
  queryClient.setQueryData(['messages', 'one'], {
    messages: [],
    total: 0,
    hasMore: false,
    offset: 0,
  });
  queryClient.setQueryData(['messages', 'two'], {
    messages: [],
    total: 0,
    hasMore: false,
    offset: 0,
  });

  store.clear();

  assert.equal(queryClient.getQueryData(['messages', 'one']), undefined);
  assert.equal(queryClient.getQueryData(['messages', 'two']), undefined);
});

test('fetchMore serializes a captured offset and deduplicates only matching message ids', async () => {
  const originalFetch = globalThis.fetch;
  const pending: PendingRequest[] = [];
  globalThis.fetch = ((url: string) => new Promise<Response>((resolve) => {
    pending.push({ url, resolve });
  })) as typeof fetch;

  try {
    const store = createStore();
    const initial = store.fetchFromServer('session', { limit: 2 });
    pending.shift()!.resolve(response({
      messages: [
        { id: 'new-1', sessionId: 'session', timestamp: '2026-01-01T00:01:00Z', kind: 'text', provider: 'claude' },
        { id: 'new-2', sessionId: 'session', timestamp: '2026-01-01T00:02:00Z', kind: 'text', provider: 'claude' },
      ],
      total: 4,
      hasMore: true,
    }));
    await initial;

    const firstPage = store.fetchMore('session');
    const duplicatePage = store.fetchMore('session');
    assert.equal(pending.length, 1, 'only one request may use the captured offset');
    assert.match(pending[0].url, /offset=2/);

    pending.shift()!.resolve(response({
      messages: [
        { id: 'old-1', sessionId: 'session', timestamp: '2026-01-01T00:00:00Z', kind: 'text', provider: 'claude' },
        { id: 'new-1', sessionId: 'session', timestamp: '2026-01-01T00:01:00Z', kind: 'text', provider: 'claude' },
      ],
      total: 4,
      hasMore: false,
    }));
    const [accepted, duplicate] = await Promise.all([firstPage, duplicatePage]);
    assert.deepEqual(accepted, { failed: false, addedCount: 1, hasMore: false, total: 4 });
    assert.equal(duplicate, null);

    const slot = store.getSessionSlot('session')!;
    assert.deepEqual(slot.serverMessages.map(message => message.id), ['old-1', 'new-1', 'new-2']);
    assert.equal(slot.offset, 4, 'the offset advances by the accepted response window');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('failed, empty and superseded older pages never report an insertion', async () => {
  const originalFetch = globalThis.fetch;
  const pending: PendingRequest[] = [];
  globalThis.fetch = ((url: string) => new Promise<Response>((resolve) => pending.push({ url, resolve }))) as typeof fetch;
  try {
    const store = createStore();
    const initial = store.fetchFromServer('session', { limit: 1 });
    const saved = { id: 'saved', sessionId: 'session', timestamp: '2026-01-01T00:00:00Z', kind: 'text', provider: 'gjc' };
    pending.shift()!.resolve(response({ messages: [saved], total: 3, hasMore: true }));
    await initial;
    const failed = store.fetchMore('session');
    pending.shift()!.resolve(new Response('', { status: 500 }));
    assert.deepEqual(await failed, { failed: true }, 'a failed request is distinguishable from a superseded one');
    assert.equal(store.getSessionSlot('session')!.offset, 1);

    const obsolete = store.fetchMore('session');
    const oldRequest = pending.shift()!;
    const refresh = store.refreshFromServer('session');
    pending.shift()!.resolve(response({ messages: [saved], total: 3, hasMore: true }));
    await refresh;
    oldRequest.resolve(response({ messages: [{ ...saved, id: 'old' }], total: 3, hasMore: true }));
    assert.equal(await obsolete, null);

    const empty = store.fetchMore('session');
    pending.shift()!.resolve(response({ messages: [], total: 1, hasMore: false }));
    assert.deepEqual(await empty, { failed: false, addedCount: 0, hasMore: false, total: 1 });
    assert.deepEqual(store.getMessages('session').map(row => row.id), ['saved']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('newer accepted pagination and refresh settle loading and reset the pagination offset', async () => {
  const originalFetch = globalThis.fetch;
  const pending: PendingRequest[] = [];
  globalThis.fetch = ((url: string) => new Promise<Response>((resolve) => {
    pending.push({ url, resolve });
  })) as typeof fetch;

  try {
    const store = createStore();
    const initial = store.fetchFromServer('session', { limit: 2 });
    pending.shift()!.resolve(response({
      messages: [{ id: 'a', sessionId: 'session', timestamp: '2026-01-01T00:00:00Z', kind: 'text', provider: 'claude' }],
      total: 2,
      hasMore: true,
    }));
    await initial;

    const supersededFullFetch = store.fetchFromServer('session', { limit: 2 });
    const page = store.fetchMore('session');
    assert.equal(store.getSessionSlot('session')!.status, 'loading');
    assert.equal(pending.length, 2);
    const [fullRequest, pageRequest] = pending.splice(0);
    pageRequest.resolve(response({
      messages: [{ id: 'older', sessionId: 'session', timestamp: '2025-12-31T23:59:00Z', kind: 'text', provider: 'claude' }],
      total: 2,
      hasMore: false,
    }));
    await page;
    assert.equal(store.getSessionSlot('session')!.status, 'idle');

    fullRequest.resolve(response({
      messages: [{ id: 'stale', sessionId: 'session', timestamp: '2026-01-01T00:00:00Z', kind: 'text', provider: 'claude' }],
      total: 1,
      hasMore: false,
    }));
    await supersededFullFetch;
    assert.deepEqual(store.getSessionSlot('session')!.serverMessages.map(message => message.id), ['older', 'a']);

    const refresh = store.refreshFromServer('session');
    pending.shift()!.resolve(response({
      messages: [
        { id: 'r1', sessionId: 'session', timestamp: '2026-01-01T00:00:00Z', kind: 'text', provider: 'claude' },
        { id: 'r1', sessionId: 'session', timestamp: '2026-01-01T00:01:00Z', kind: 'text', provider: 'claude' },
        { id: 'r2', sessionId: 'session', timestamp: '2026-01-01T00:02:00Z', kind: 'text', provider: 'claude' },
      ],
      total: 3,
      hasMore: true,
    }));
    await refresh;
    const slot = store.getSessionSlot('session')!;
    assert.deepEqual(slot.serverMessages.map(message => message.id), ['r1', 'r2']);
    assert.equal(slot.offset, 3, 'refresh offset follows the replacement response window');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('inactive session slots are LRU-bounded while active and streaming slots survive until clear', () => {
  const store = createStore();
  act(() => {
    store.getSlot('active');
    store.setActiveSession('active');
    store.getSlot('streaming').status = 'streaming';
    for (let index = 0; index < 60; index++) {
      store.getSlot(`inactive-${index}`);
    }
  });

  assert.ok(store.getSessionSlot('active'));
  assert.ok(store.getSessionSlot('streaming'));
  assert.equal(store.getSessionSlot('inactive-0'), undefined);

  act(() => {
    store.clear();
  });
  assert.equal(store.has('active'), false);
  assert.equal(store.has('streaming'), false);
});

test('persisted assistant rows with distinct ids are preserved and realtime replay is idempotent', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => response({
    messages: [
      {
        id: 'assistant-1',
        sessionId: 'session',
        timestamp: '2026-01-01T00:00:00Z',
        kind: 'text',
        role: 'assistant',
        content: 'same answer',
        provider: 'claude',
      },
      {
        id: 'assistant-2',
        sessionId: 'session',
        timestamp: '2026-01-01T00:01:00Z',
        kind: 'text',
        role: 'assistant',
        content: 'same answer',
        provider: 'claude',
      },
      {
        id: '',
        sessionId: 'session',
        timestamp: '2026-01-01T00:01:30Z',
        kind: 'text',
        role: 'assistant',
        content: 'legacy server row',
        provider: 'claude',
      },
    ],
    total: 3,
    hasMore: false,
  })) as typeof fetch;

  try {
    const store = createStore();
    await store.fetchFromServer('session');
    assert.deepEqual(
      store.getSessionSlot('session')!.merged.map(message => message.id),
      ['assistant-1', 'assistant-2', ''],
    );

    const realtimeMessage = {
      id: 'realtime-1',
      sessionId: 'session',
      timestamp: '2026-01-01T00:02:00Z',
      kind: 'tool_use' as const,
      provider: 'claude' as const,
    };
    store.appendRealtime('session', realtimeMessage);
    store.appendRealtimeBatch('session', [realtimeMessage, realtimeMessage]);

    assert.equal(
      store.getSessionSlot('session')!.realtimeMessages.filter(message => message.id === 'realtime-1').length,
      1,
    );

    store.appendRealtime('session', {
      id: '',
      sessionId: 'session',
      timestamp: '2026-01-01T00:03:00Z',
      kind: 'text',
      role: 'assistant',
      content: 'distinct realtime row',
      provider: 'claude',
    });
    assert.deepEqual(
      store.getSessionSlot('session')!.merged
        .filter(message => message.id === '')
        .map(message => message.content),
      ['legacy server row', 'distinct realtime row'],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('server fetch cannot overwrite streaming status and pending slots resist LRU eviction', async () => {
  const originalFetch = globalThis.fetch;
  let resolveRequest: ((response: Response) => void) | undefined;
  globalThis.fetch = (() => new Promise<Response>((resolve) => {
    resolveRequest = resolve;
  })) as typeof fetch;

  try {
    const store = createStore();
    store.setStatus('pending', 'streaming');
    const fetchRequest = store.fetchFromServer('pending');

    for (let index = 0; index < 60; index++) {
      store.getSlot(`inactive-${index}`);
    }
    assert.ok(store.getSessionSlot('pending'));

    assert.ok(resolveRequest);
    resolveRequest(response({ messages: [], total: 0, hasMore: false }));
    await fetchRequest;
    assert.equal(store.getSessionSlot('pending')?.status, 'streaming');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a request protects a newly created slot before saturated LRU trimming', async () => {
  const originalFetch = globalThis.fetch;
  let resolveRequest: ((response: Response) => void) | undefined;
  globalThis.fetch = (() => new Promise<Response>((resolve) => {
    resolveRequest = resolve;
  })) as typeof fetch;

  try {
    const store = createStore();
    for (let index = 0; index < 50; index++) {
      store.getSlot(`streaming-${index}`).status = 'streaming';
    }
    store.appendRealtime('realtime-overflow', {
      id: 'overflow-message',
      sessionId: 'realtime-overflow',
      timestamp: '2026-01-01T00:00:00Z',
      kind: 'text',
      role: 'assistant',
      content: 'retained',
      provider: 'claude',
    });
    assert.equal(
      store.getSessionSlot('realtime-overflow')?.realtimeMessages[0]?.id,
      'overflow-message',
    );

    const request = store.fetchFromServer('new-pending');
    assert.ok(store.getSessionSlot('new-pending'));
    assert.ok(resolveRequest);
    resolveRequest(response({ messages: [], total: 0, hasMore: false }));
    await request;
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Regression: the store signals changes by bumping an internal tick (a
// re-render) while its object identity stays stable, so consumers must read
// getMessages() fresh on every render instead of memoizing on the store
// identity. The chat pane once froze on its pre-fetch empty window because a
// useMemo keyed on [sessionId, sessionStore] never recomputed after the
// fetch landed. These assertions pin the two halves of that contract.
test('getMessages reflects a completed fetch and keeps empty reads identity-stable', async () => {
  const originalFetch = globalThis.fetch;
  let resolveRequest: ((response: Response) => void) | undefined;
  globalThis.fetch = (() => new Promise<Response>((resolve) => {
    resolveRequest = resolve;
  })) as typeof fetch;

  try {
    const store = createStore();
    act(() => {
      store.setActiveSession('session');
    });

    // Empty reads (unknown session, pre-fetch) share one stable identity so
    // per-render reads do not churn downstream memos.
    assert.equal(store.getMessages('missing'), store.getMessages('missing'));
    const preFetch = store.getMessages('session');
    assert.equal(preFetch.length, 0);
    assert.equal(store.getMessages('session'), preFetch);

    let request: ReturnType<SessionStore['fetchFromServer']>;
    act(() => {
      request = store.fetchFromServer('session', { limit: 20, offset: 0 });
    });
    assert.ok(resolveRequest);
    await act(async () => {
      resolveRequest!(response({
        messages: [
          { id: 'm-1', sessionId: 'session', timestamp: '2026-01-01T00:00:00Z', kind: 'text', role: 'user', content: 'hi', provider: 'gjc' },
          { id: 'm-2', sessionId: 'session', timestamp: '2026-01-01T00:01:00Z', kind: 'text', role: 'assistant', content: 'hello', provider: 'gjc' },
        ],
        total: 2,
        hasMore: false,
      }));
      await request!;
    });

    // A fresh read after the fetch settles must expose the loaded window —
    // no other invalidation signal exists for render-time consumers.
    const postFetch = store.getMessages('session');
    assert.equal(postFetch.length, 2);
    assert.equal(postFetch[0]?.id, 'm-1');
    assert.notEqual(postFetch, preFetch, 'loaded window replaces the empty identity');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('invalidating the active window runs one bounded reconcile and the result reaches getMessages', async () => {
  const originalFetch = globalThis.fetch;
  const pending: PendingRequest[] = [];
  globalThis.fetch = ((url: string) => new Promise<Response>((resolve) => {
    pending.push({ url, resolve });
  })) as typeof fetch;

  try {
    const { store, queryClient } = createHarness();
    let initial: Promise<unknown>;
    act(() => {
      store.setActiveSession('session');
      initial = store.fetchFromServer('session', { limit: 20, offset: 0 });
    });
    await act(async () => {
      pending.shift()!.resolve(response({
        messages: [{ id: 'v1', sessionId: 'session', timestamp: '2026-01-01T00:00:00Z', kind: 'text', role: 'assistant', content: 'first', provider: 'gjc' }],
        total: 1,
        hasMore: false,
      }));
      await initial!;
    });
    // Flush a render so the observer sees the existing window and mounts enabled.
    await act(async () => {});
    assert.equal(pending.length, 0, 'a fresh window must not refetch on its own');

    let invalidated: Promise<unknown>;
    act(() => {
      invalidated = queryClient.invalidateQueries({ queryKey: ['messages', 'session'] });
    });
    await act(async () => {
      assert.equal(pending.length, 1, 'invalidation must trigger exactly one reconcile fetch');
      assert.match(pending[0].url, /limit=20/, 'the reconcile is bounded to the loaded window');
      pending.shift()!.resolve(response({
        messages: [
          { id: 'v1', sessionId: 'session', timestamp: '2026-01-01T00:00:00Z', kind: 'text', role: 'assistant', content: 'first', provider: 'gjc' },
          { id: 'v2', sessionId: 'session', timestamp: '2026-01-01T00:01:00Z', kind: 'text', role: 'user', content: 'external edit', provider: 'gjc' },
        ],
        total: 2,
        hasMore: false,
      }));
      await invalidated!;
    });

    assert.deepEqual(store.getMessages('session').map((message) => message.id), ['v1', 'v2']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a streaming slot defers the reconcile until streaming ends', async () => {
  const originalFetch = globalThis.fetch;
  const pending: PendingRequest[] = [];
  globalThis.fetch = ((url: string) => new Promise<Response>((resolve) => {
    pending.push({ url, resolve });
  })) as typeof fetch;

  try {
    const { store, queryClient } = createHarness();
    let initial: Promise<unknown>;
    act(() => {
      store.setActiveSession('session');
      initial = store.fetchFromServer('session', { limit: 20, offset: 0 });
    });
    await act(async () => {
      pending.shift()!.resolve(response({
        messages: [{ id: 's1', sessionId: 'session', timestamp: '2026-01-01T00:00:00Z', kind: 'text', role: 'user', content: 'hi', provider: 'gjc' }],
        total: 1,
        hasMore: false,
      }));
      await initial!;
    });

    act(() => {
      store.setStatus('session', 'streaming');
    });
    await act(async () => {
      void queryClient.invalidateQueries({ queryKey: ['messages', 'session'] });
    });
    assert.equal(pending.length, 0, 'no reconcile may run while the session streams');

    act(() => {
      store.setStatus('session', 'idle');
    });
    await act(async () => {});
    assert.equal(pending.length, 1, 'the stale mark survives streaming and refetches on idle');
    await act(async () => {
      pending.shift()!.resolve(response({
        messages: [{ id: 's1', sessionId: 'session', timestamp: '2026-01-01T00:00:00Z', kind: 'text', role: 'user', content: 'hi', provider: 'gjc' }],
        total: 1,
        hasMore: false,
      }));
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an out-of-band cache write reaches getMessages through the lazy recompute', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => response({
    messages: [{ id: 'w1', sessionId: 'session', timestamp: '2026-01-01T00:00:00Z', kind: 'text', role: 'user', content: 'hi', provider: 'gjc' }],
    total: 1,
    hasMore: false,
  })) as typeof fetch;

  try {
    const { store, queryClient } = createHarness();
    await store.fetchFromServer('session');
    assert.deepEqual(store.getMessages('session').map((message) => message.id), ['w1']);

    queryClient.setQueryData(['messages', 'session'], {
      messages: [
        { id: 'w1', sessionId: 'session', timestamp: '2026-01-01T00:00:00Z', kind: 'text', role: 'user', content: 'hi', provider: 'gjc' },
        { id: 'w2', sessionId: 'session', timestamp: '2026-01-01T00:01:00Z', kind: 'text', role: 'assistant', content: 'folded', provider: 'gjc' },
      ],
      total: 2,
      hasMore: false,
      offset: 2,
    });

    assert.deepEqual(store.getMessages('session').map((message) => message.id), ['w1', 'w2']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a realtime row without an id cannot break the merge on a later turn', async () => {
  // A provider runtime that writes plain `{ kind, ... }` events instead of going
  // through the envelope helper produces id-less realtime rows. The first turn
  // survived only because the merge short-circuits while the server window is
  // empty; on the next turn the unguarded `id` deref threw out of
  // `appendRealtime` into the websocket handler and froze the composer.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => response({
    messages: [{ id: 's-1', sessionId: 'sess', timestamp: '2026-01-01T00:00:00Z', kind: 'text', role: 'user', provider: 'gjc', content: 'hi' }],
    total: 1,
    hasMore: false,
  })) as typeof fetch;

  try {
    const store = createStore();
    const idless = (extra: Record<string, unknown>) => ({
      sessionId: 'sess',
      timestamp: '2026-01-01T00:00:01Z',
      provider: 'gjc',
      ...extra,
    } as unknown as Parameters<SessionStore['appendRealtime']>[1]);

    store.appendRealtime('sess', idless({ kind: 'tool_use', toolId: 't1', toolName: 'bash' }));
    store.appendRealtime('sess', idless({ kind: 'tool_result', toolId: 't1', content: 'ok' }));

    // `complete` refreshes history, which fills the server window.
    await store.refreshFromServer('sess');

    // The next turn merges realtime against a non-empty server window.
    store.appendRealtime('sess', idless({ kind: 'text', role: 'assistant', content: 'second turn' }));

    const merged = store.getMessages('sess');
    assert.ok(
      merged.some((message) => message.content === 'second turn'),
      'the second turn must still reach the transcript',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('deltas a background session collected merge back as one row, and the final text replaces them', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => response({
    messages: [
      { id: 'user-1', sessionId: 'session', timestamp: '2026-01-01T00:00:00Z', kind: 'text', role: 'user', content: 'count', provider: 'gjc' },
      { id: 'assistant-1', sessionId: 'session', timestamp: '2026-01-01T00:00:05Z', kind: 'text', role: 'assistant', content: 'one two three four five six', provider: 'gjc' },
    ],
    total: 2,
    hasMore: false,
  })) as typeof fetch;

  try {
    const store = createStore();
    // The session was viewed by nobody: its frames landed one delta at a time.
    const deltas = ['one ', 'two ', 'three ', 'four ', 'five ', 'six'].map((content, index) => ({
      id: `delta-${index}`, sessionId: 'session', timestamp: `2026-01-01T00:00:0${index}Z`,
      kind: 'stream_delta' as const, content, provider: 'gjc' as const,
    }));
    store.appendRealtimeBatch('session', deltas);

    // Before history arrives: the chunks are one stream, not six messages.
    const interim = store.getSessionSlot('session')!.merged;
    assert.equal(interim.filter((message) => message.kind === 'stream_delta').length, 1);
    assert.equal(interim.find((message) => message.kind === 'stream_delta')?.content, 'one two three four five six');

    await store.fetchFromServer('session');
    const settled = store.getSessionSlot('session')!.merged;
    assert.equal(settled.filter((message) => message.kind === 'stream_delta').length, 0, 'the final text outranks the stream');
    assert.equal(settled.filter((message) => message.content === 'one two three four five six').length, 1, 'the answer renders exactly once');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a viewer that joined mid-turn keeps only the final text, not the stream tail it caught', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => response({
    messages: [
      { id: 'assistant-1', sessionId: 'session', timestamp: '2026-01-01T00:00:05Z', kind: 'text', role: 'assistant', content: 'the quick brown fox jumps over the lazy dog', provider: 'gjc' },
    ],
    total: 1,
    hasMore: false,
  })) as typeof fetch;

  try {
    const store = createStore();
    store.appendRealtimeBatch('session', ['lazy ', 'dog'].map((content, index) => ({
      id: `delta-${index}`, sessionId: 'session', timestamp: `2026-01-01T00:00:0${index}Z`,
      kind: 'stream_delta' as const, content, provider: 'gjc' as const,
    })));
    await store.fetchFromServer('session');
    const settled = store.getSessionSlot('session')!.merged;
    assert.equal(settled.filter((message) => message.kind === 'stream_delta').length, 0, 'the tail is inside the final text');
    assert.equal(settled.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a replayed complete answer is reconciled when the user anchor is outside the history window', () => {
  const { store, queryClient } = createHarness();
  act(() => {
    store.setActiveSession('session');
    queryClient.setQueryData(['messages', 'session'], {
      messages: [{ id: 'disk-answer', sessionId: 'session', timestamp: '2026-01-01T00:00:05Z', kind: 'text', role: 'assistant', content: 'Interview threshold: 5%', provider: 'gjc' }],
      total: 42, hasMore: true, offset: 1,
    });
    store.updateStreaming('session', 'Interview threshold: 5%', 'gjc');
    store.finalizeStreaming('session');
  });
  assert.equal(store.getMessages('session').filter(message => message.content === 'Interview threshold: 5%').length, 1);
});

test('a new user turn preserves an identical reply when the older user anchor is outside the window', () => {
  const { store, queryClient } = createHarness();
  act(() => {
    store.setActiveSession('session');
    queryClient.setQueryData(['messages', 'session'], {
      messages: [{ id: 'disk-answer', sessionId: 'session', timestamp: '2026-01-01T00:00:05Z', kind: 'text', role: 'assistant', content: 'Yes.', provider: 'gjc' }],
      total: 42, hasMore: true, offset: 1,
    });
    store.appendRealtime('session', { id: 'local_new-question', sessionId: 'session', timestamp: '2026-01-01T00:01:00Z', kind: 'text', role: 'user', content: 'And the other one?', provider: 'gjc' });
    store.updateStreaming('session', 'Yes.', 'gjc');
    store.finalizeStreaming('session');
  });
  assert.equal(store.getMessages('session').filter(message => message.content === 'Yes.').length, 2);
});

test('old replay uses its event time to reconcile before a newer persisted question', () => {
  const { store, queryClient } = createHarness();
  act(() => {
    store.setActiveSession('session');
    queryClient.setQueryData(['messages', 'session'], {
      messages: [
        { id: 'disk-answer', sessionId: 'session', timestamp: '2026-01-01T00:00:05Z', kind: 'text', role: 'assistant', content: 'Earlier answer.', provider: 'gjc' },
        { id: 'next-question', sessionId: 'session', timestamp: '2026-01-01T00:01:00Z', kind: 'text', role: 'user', content: 'Another question.', provider: 'gjc' },
        { id: 'next-answer', sessionId: 'session', timestamp: '2026-01-01T00:01:05Z', kind: 'text', role: 'assistant', content: 'Later answer.', provider: 'gjc' },
      ],
      total: 42, hasMore: true, offset: 3,
    });
    store.updateStreaming('session', 'Earlier answer.', 'gjc', '2026-01-01T00:00:04Z');
    store.finalizeStreaming('session');
  });
  assert.deepEqual(store.getMessages('session').map(message => message.id), ['disk-answer', 'next-question', 'next-answer']);
});

test('background replay separated from its persisted answer by reasoning never duplicates prose', () => {
  const { store, queryClient } = createHarness();
  const common = { sessionId: 'session', provider: 'gjc' as const };
  act(() => {
    store.setActiveSession('session');
    queryClient.setQueryData(['messages', 'session'], {
      messages: [
        { ...common, id: 'disk-thought', timestamp: '2026-01-01T00:00:05Z', kind: 'thinking', content: 'Reasoning.' },
        { ...common, id: 'disk-answer', timestamp: '2026-01-01T00:00:05Z', kind: 'text', role: 'assistant', content: 'Complete answer.' },
      ], total: 42, hasMore: true, offset: 2,
    });
    store.appendRealtimeBatch('session', [
      { ...common, id: 'delta-1', timestamp: '2026-01-01T00:00:01Z', kind: 'stream_delta', content: 'Complete ' },
      { ...common, id: 'delta-2', timestamp: '2026-01-01T00:00:02Z', kind: 'stream_delta', content: 'answer.' },
      { ...common, id: 'live-thought', timestamp: '2026-01-01T00:00:05Z', kind: 'thinking', content: 'Reasoning.' },
    ]);
    store.updateStreaming('session', 'Complete answer.', 'gjc', '2026-01-01T00:00:06Z');
    store.finalizeStreaming('session');
  });
  assert.equal(store.getMessages('session').filter(message => message.content === 'Complete answer.').length, 1);
  assert.equal(store.getMessages('session').filter(message => message.content === 'Reasoning.').length, 1);
});

test('thinking reconciliation preserves repeated reasoning in a new turn and never matches assistant prose', () => {
  const { store, queryClient } = createHarness();
  const common = { sessionId: 'session', provider: 'gjc' as const };
  act(() => {
    queryClient.setQueryData(['messages', 'session'], {
      messages: [
        { ...common, id: 'prior-thought', timestamp: '2026-01-01T00:00:05Z', kind: 'thinking', content: 'Repeated reasoning.' },
        { ...common, id: 'prior-thought-2', timestamp: '2026-01-01T00:00:06Z', kind: 'thinking', content: 'Repeated reasoning.' },
        { ...common, id: 'prior-text', timestamp: '2026-01-01T00:00:07Z', kind: 'text', role: 'assistant', content: 'Prose is separate.' },
      ], total: 42, hasMore: true, offset: 3,
    });
    store.appendRealtimeBatch('session', [
      { ...common, id: 'thinking-prose', timestamp: '2026-01-01T00:00:07Z', kind: 'thinking', content: 'Prose is separate.' },
      { ...common, id: 'local_next', timestamp: '2026-01-01T00:01:00Z', kind: 'text', role: 'user', content: 'Next question' },
      { ...common, id: 'next-thought', timestamp: '2026-01-01T00:01:05Z', kind: 'thinking', content: 'Repeated reasoning.' },
    ]);
  });
  assert.deepEqual(store.getMessages('session').map(row => row.id), [
    'prior-thought', 'prior-thought-2', 'prior-text', 'thinking-prose', 'local_next', 'next-thought',
  ]);
});
