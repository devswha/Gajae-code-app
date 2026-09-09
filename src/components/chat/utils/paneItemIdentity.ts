import type { ChatMessage } from '../types/types';

import { isToolGroupItem } from './toolGrouping';
import type { ToolOutputDensity } from './toolOutputDensity';
import { isTurnWorkBlockItem } from './turnWork';
import type { PaneListItem } from './turnWork';

export interface PaneItemIdentity {
  key: string;
  groupKind: string | null;
  messageKeys: readonly string[];
}

/**
 * Reconcile groups by their constituent message IDs, not either endpoint:
 * prepending changes the first call and streaming changes the last. A previous
 * key belongs to at most one current group, including when a group splits.
 * Callers retain only the previous render's identities in React state, and
 * clear them on session changes. Density is part of the group kind so changing
 * density deliberately resets folds. Ordinary messages keep their own keys.
 */
export function reconcilePaneItemIdentities(
  items: readonly PaneListItem[],
  density: ToolOutputDensity,
  getMessageKey: (message: ChatMessage) => string,
  previous: readonly PaneItemIdentity[] = [],
): PaneItemIdentity[] {
  const previousByMessage = new Map<string, PaneItemIdentity>();
  for (const identity of previous) {
    if (identity.groupKind === null) continue;
    for (const messageKey of identity.messageKeys) previousByMessage.set(messageKey, identity);
  }

  // Reserve previous keys before allocating new ones: a disjoint group added
  // above an existing group must not steal the latter's retained key.
  const reservedKeys = new Set(previous.map((identity) => identity.key));
  const claimed = new Set<PaneItemIdentity>();
  for (const item of items) {
    if (!isTurnWorkBlockItem(item) && !isToolGroupItem(item)) reservedKeys.add(getMessageKey(item));
  }

  return items.map((item) => {
    const groupKind = isTurnWorkBlockItem(item)
      ? `work-${density}`
      : isToolGroupItem(item) ? `tool-group-${density}-${item.toolName}` : null;
    if (!isTurnWorkBlockItem(item) && !isToolGroupItem(item)) {
      return { key: getMessageKey(item), groupKind: null, messageKeys: [] };
    }

    const messageKeys = item.messages.map(getMessageKey);
    const overlaps = new Map<PaneItemIdentity, number>();
    for (const messageKey of messageKeys) {
      const candidate = previousByMessage.get(messageKey);
      if (candidate?.groupKind === groupKind && !claimed.has(candidate)) {
        overlaps.set(candidate, (overlaps.get(candidate) ?? 0) + 1);
      }
    }
    let match: PaneItemIdentity | undefined;
    let largestOverlap = 0;
    for (const [candidate, count] of overlaps) {
      if (count > largestOverlap) {
        match = candidate;
        largestOverlap = count;
      }
    }
    if (messageKeys.length === 0) {
      match = previous.find((identity) => identity.groupKind === groupKind
        && identity.messageKeys.length === 0 && !claimed.has(identity));
    }
    if (match) {
      claimed.add(match);
      return { key: match.key, groupKind, messageKeys };
    }

    const baseKey = `${groupKind}-${messageKeys[0] ?? 'pending'}`;
    let key = baseKey;
    let suffix = 1;
    while (reservedKeys.has(key)) key = `${baseKey}__${suffix++}`;
    reservedKeys.add(key);
    return { key, groupKind, messageKeys };
  });
}
