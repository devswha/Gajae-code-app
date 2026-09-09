import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ChatMessage } from '../types/types';

import { assignMessageKeys, getIntrinsicMessageKey } from './messageKeys';
import { reconcilePaneItemIdentities } from './paneItemIdentity';
import type { PaneItemIdentity } from './paneItemIdentity';
import { isToolGroupItem } from './toolGrouping';
import type { ToolOutputDensity } from './toolOutputDensity';
import { isTurnWorkBlockItem } from './turnWork';
import type { PaneListItem } from './turnWork';

const message = (id: string): ChatMessage => ({
  id,
  type: 'assistant',
  content: '',
  timestamp: '2026-09-06T00:00:00.000Z',
  isToolUse: true,
  toolName: 'read',
  toolId: 'provider-reuses-this-call-id',
});

const group = (kind: 'work' | 'tool', ids: string[]): PaneListItem => {
  const messages = ids.map(message);
  return kind === 'work'
    ? { _isWorkBlock: true, messages, timestamp: '', startedAt: null, endedAt: null, isTail: true }
    : { _isGroup: true, toolName: 'read', messages, timestamp: '' };
};

const reconcile = (
  items: PaneListItem[],
  previous: readonly PaneItemIdentity[] = [],
  density: ToolOutputDensity = 'balanced',
) => reconcilePaneItemIdentities(
  items,
  density,
  assignMessageKeys(items.flatMap((item) => isTurnWorkBlockItem(item) || isToolGroupItem(item) ? item.messages : [item])),
  previous,
);

for (const kind of ['work', 'tool'] as const) {
  test(`${kind} identity survives repeated prepend, append and cloned constituent messages`, () => {
    let identities = reconcile([group(kind, ['b', 'c'])]);
    const originalKey = identities[0].key;
    for (const ids of [['a', 'b', 'c'], ['a', 'b', 'c', 'd'], ['older', 'a', 'b', 'c', 'd', 'e']]) {
      identities = reconcile([group(kind, ids)], identities);
      assert.equal(identities[0].key, originalKey);
      assert.deepEqual(identities[0].messageKeys, ids.map((id) => getIntrinsicMessageKey(message(id))));
    }
  });

  test(`${kind} disjoint groups get unique identities and do not claim a retained group key`, () => {
    const previous = reconcile([group(kind, ['b', 'c'])]);
    const current = reconcile([
      group(kind, ['earlier']),
      group(kind, ['a', 'b', 'c', 'd']),
      group(kind, ['later']),
    ], previous);
    assert.equal(current[1].key, previous[0].key);
    assert.equal(new Set(current.map(({ key }) => key)).size, 3);
    const unrelated = reconcile([group(kind, ['replacement'])], current);
    assert.ok(current.every(({ key }) => key !== unrelated[0].key));
  });

  test(`${kind} split and merge never reuse one previous key for two current groups`, () => {
    const original = reconcile([group(kind, ['b', 'c'])]);
    const extended = reconcile([group(kind, ['a', 'b', 'c'])], original);
    // The first split retains a key originally seeded by b; the second starts
    // with b and must allocate a distinct key rather than stealing that key.
    const split = reconcile([group(kind, ['a']), group(kind, ['b', 'c'])], extended);
    assert.equal(split[0].key, original[0].key);
    assert.notEqual(split[0].key, split[1].key);
    const merged = reconcile([group(kind, ['a', 'b', 'c'])], split);
    assert.equal(merged[0].key, split[1].key, 'the largest constituent overlap wins a merge');
    const splitAgain = reconcile([group(kind, ['a', 'b']), group(kind, ['c'])], merged);
    assert.equal(new Set(splitAgain.map(({ key }) => key)).size, 2);
  });

  test(`${kind} density changes reset group identity without mutating the previous render`, () => {
    const items = [group(kind, ['a', 'b'])];
    const previous = reconcile(items);
    const snapshot = structuredClone(previous);
    const compact = reconcile(items, previous, 'compact');
    assert.notEqual(compact[0].key, previous[0].key);
    assert.deepEqual(previous, snapshot);
  });
}

test('ordinary pane messages retain their assigned IDs across prepend, content updates and density changes', () => {
  const existing: ChatMessage = { ...message('answer'), isToolUse: false, content: 'Initial answer' };
  const previous = reconcile([existing]);
  const changed = { ...existing, content: 'A completely revised answer', timestamp: '2026-09-07T00:00:00.000Z' };
  const earlier: ChatMessage = { ...message('earlier'), isToolUse: false };
  const current = reconcile([earlier, changed], previous, 'compact');
  assert.equal(current[1].key, getIntrinsicMessageKey(existing));
  assert.equal(current[1].key, previous[0].key);
  assert.notEqual(current[0].key, current[1].key);
});

test('an empty pending work block keeps a unique key only within the same density', () => {
  const pending = reconcile([group('work', [])]);
  const rerendered = reconcile([group('work', [])], pending);
  assert.equal(rerendered[0].key, pending[0].key);
  const compact = reconcile([group('work', [])], rerendered, 'compact');
  assert.notEqual(compact[0].key, pending[0].key);
});
