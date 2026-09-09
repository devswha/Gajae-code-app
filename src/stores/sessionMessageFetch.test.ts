import assert from 'node:assert/strict';
import test from 'node:test';

import { QueryClient } from '@tanstack/react-query';

import { REFRESH_RECONCILE_MIN_MESSAGES, buildRefreshMessagesUrl, shareMessageWindow } from './sessionMessageFetch';

test('buildRefreshMessagesUrl always includes a bounded limit (never unbounded)', () => {
  const url = buildRefreshMessagesUrl('sess-1', 0);
  const params = new URL(url, 'http://x').searchParams;
  assert.equal(params.get('limit'), String(REFRESH_RECONCILE_MIN_MESSAGES));
  assert.equal(params.get('offset'), '0');
  assert.ok(url.startsWith('/api/providers/sessions/sess-1/messages?'));
});

test('buildRefreshMessagesUrl never shrinks below the currently-loaded window', () => {
  const url = buildRefreshMessagesUrl('sess-1', 200);
  const params = new URL(url, 'http://x').searchParams;
  assert.equal(params.get('limit'), '200', 'reconcile fetch must cover all loaded/shown messages');
});

test('buildRefreshMessagesUrl floors tiny/invalid loaded counts to the minimum', () => {
  for (const loaded of [5, -3, Number.NaN]) {
    const params = new URL(buildRefreshMessagesUrl('s', loaded as number), 'http://x').searchParams;
    assert.equal(params.get('limit'), String(REFRESH_RECONCILE_MIN_MESSAGES));
  }
});

test('buildRefreshMessagesUrl encodes the session id', () => {
  const url = buildRefreshMessagesUrl('a/b c', 0);
  assert.ok(url.includes('a%2Fb%20c'), 'session id must be URL-encoded');
});

test('buildRefreshMessagesUrl omits image data only when previews are disabled', () => {
  const withImages = new URL(buildRefreshMessagesUrl('s', 0, true), 'http://x').searchParams;
  assert.equal(withImages.get('includeImages'), null);

  const withoutImages = new URL(buildRefreshMessagesUrl('s', 0, false), 'http://x').searchParams;
  assert.equal(withoutImages.get('includeImages'), 'false');
});

test('shareMessageWindow preserves existing row references across prepend in the query cache', () => {
  const client = new QueryClient();
  client.setQueryDefaults(['messages'], { structuralSharing: shareMessageWindow });
  const key = ['messages', 'session'];
  const recent = { id: 'recent', content: 'recent', toolInput: { path: 'recent.ts' } };
  const latest = { id: 'latest', content: 'latest', toolInput: { path: 'latest.ts' } };
  const oldWindow = { messages: [recent, latest], total: 3, hasMore: true, offset: 2 };
  const older = { id: 'older', content: 'older', toolInput: { path: 'older.ts' } };
  const newWindow = { messages: [older, recent, latest], total: 3, hasMore: false, offset: 3 };

  try {
    client.setQueryData(key, oldWindow);
    client.setQueryData(key, newWindow);
    const shared = client.getQueryData<typeof newWindow>(key)!;

    assert.deepEqual(shared, newWindow);
    assert.equal(shared.messages[0], older);
    assert.equal(shared.messages[1], recent);
    assert.equal(shared.messages[2], latest);
    assert.deepEqual(oldWindow.messages, [recent, latest], 'sharing must not mutate the prior window');
  } finally {
    client.clear();
  }
});

test('shareMessageWindow matches refreshed rows by ID after a prepend, retaining unchanged metadata', () => {
  const oldWindow = {
    messages: [{ id: 'recent', content: 'same', images: [{ path: 'image.png' }] }],
    total: 3, hasMore: true, offset: 1, tokenUsage: { input: 100 },
  };
  const refreshed = {
    messages: [{ id: 'older', content: 'older', images: [] }, structuredClone(oldWindow.messages[0])],
    total: 3, hasMore: true, offset: 2, tokenUsage: { input: 100 },
  };
  const shared = shareMessageWindow(oldWindow, refreshed) as typeof refreshed;

  assert.deepEqual(shared, refreshed);
  assert.equal(shared.messages[0], refreshed.messages[0]);
  assert.equal(shared.messages[1], oldWindow.messages[0]);
  assert.equal(shared.tokenUsage, oldWindow.tokenUsage);
  assert.equal(shareMessageWindow(shared, structuredClone(shared)), shared, 'an unchanged refresh reuses the whole window');

  const metadataOnly = shareMessageWindow(shared, { ...structuredClone(shared), total: 4 }) as typeof shared;
  assert.equal(metadataOnly.total, 4);
  assert.equal(metadataOnly.messages, shared.messages, 'metadata changes do not replace unchanged rows or their array');
});

test('shareMessageWindow replaces changed same-ID rows while retaining equal nested fields', () => {
  const original = { id: 'call', content: 'before', toolInput: { path: 'file.ts' }, toolResult: { content: 'old', isError: false } };
  const untouched = { ...original, id: 'untouched', content: 'same' };
  const oldWindow = { messages: [original, untouched], total: 2, hasMore: false, offset: 2 };
  const updated = { ...structuredClone(original), content: 'after', toolResult: { content: 'new', isError: true } };
  const newWindow = { ...oldWindow, messages: [updated, structuredClone(untouched)] };
  const shared = shareMessageWindow(oldWindow, newWindow) as typeof newWindow;

  assert.deepEqual(shared, newWindow);
  assert.notEqual(shared.messages[0], original);
  assert.equal(shared.messages[0].content, 'after');
  assert.equal(shared.messages[0].toolInput, original.toolInput);
  assert.deepEqual(shared.messages[0].toolResult, updated.toolResult);
  assert.equal(shared.messages[1], untouched);
  assert.equal(original.content, 'before');
  assert.equal(original.toolResult.content, 'old');

  const withoutResult = { id: original.id, content: updated.content, toolInput: updated.toolInput };
  const removed = shareMessageWindow(shared, { ...shared, messages: [withoutResult, untouched] }) as { messages: object[] };
  assert.notEqual(removed.messages[0], shared.messages[0]);
  assert.equal('toolResult' in removed.messages[0], false, 'removed row fields must not survive reconciliation');
});

test('shareMessageWindow does not alias distinct rows without persisted IDs', () => {
  for (const id of [undefined, '']) {
    const original = { ...(id === undefined ? {} : { id }), content: 'identical' };
    const oldWindow = { messages: [original], total: 2, hasMore: true, offset: 1 };
    const prepended = { ...original };
    const newWindow = { messages: [prepended, original], total: 2, hasMore: false, offset: 2 };
    const shared = shareMessageWindow(oldWindow, newWindow) as typeof newWindow;

    assert.equal(shared.messages[0], prepended);
    assert.equal(shared.messages[1], original);
    assert.notEqual(shared.messages[0], shared.messages[1]);

    const refreshed = structuredClone(newWindow);
    const refreshedShared = shareMessageWindow(shared, refreshed) as typeof refreshed;
    assert.equal(refreshedShared.messages[0], refreshed.messages[0]);
    assert.equal(refreshedShared.messages[1], refreshed.messages[1]);
    assert.notEqual(refreshedShared.messages[0], prepended, 'equal ID-less rows are not matched by position');
    assert.notEqual(refreshedShared.messages[1], original, 'equal ID-less rows are not matched by content');
  }
});

test('shareMessageWindow returns incoming data when a message window is unavailable', () => {
  const window = { messages: [{ id: 'first', content: 'first' }], total: 1, hasMore: false, offset: 1 };
  for (const previous of [undefined, null, {}, { messages: null }]) {
    assert.equal(shareMessageWindow(previous, window), window);
  }
  for (const next of [undefined, null, 1, {}, { messages: null }]) {
    assert.equal(shareMessageWindow(window, next), next);
  }
});
