import { queuedMessageKey, readQueuedMessages, type StoredQueuedMessage } from './chatStorage';
import { COMPOSER_STORAGE_LIMITS, ComposerStorageError, composerRouteKey, type ComposerRoute } from './composerDraftStorage';

export const composerQueueOwnerKey = (sessionId: string) => `composer_queue_owner_${sessionId}`;

/** All-or-nothing migration/read. Never clip a legacy queue and overwrite it. */
export function readComposerQueueProjection(route: ComposerRoute): { raw: string | null; queue: StoredQueuedMessage[]; foreign: boolean } {
  if (!route.conversation || typeof localStorage === 'undefined') return { raw: null, queue: [], foreign: false };
  const raw = localStorage.getItem(queuedMessageKey(route.conversation));
  const owner = localStorage.getItem(composerQueueOwnerKey(route.conversation));
  if (owner && owner !== composerRouteKey(route)) return { raw, queue: [], foreign: true };
  if (!raw) return { raw, queue: [], foreign: false };
  if (raw.length > COMPOSER_STORAGE_LIMITS.textLength * 2) throw new ComposerStorageError('limit');
  let decoded: unknown;
  try { decoded = JSON.parse(raw); } catch { decoded = raw; }
  if (typeof decoded !== 'string') {
    const entries = Array.isArray(decoded) ? decoded : [decoded];
    if (entries.length > COMPOSER_STORAGE_LIMITS.queueLength) throw new ComposerStorageError('limit');
    const ids = new Set<string>();
    for (const value of entries) {
      if (!value || typeof value !== 'object') throw new ComposerStorageError('invalid');
      const item = value as StoredQueuedMessage;
      if (typeof item.content !== 'string' || (!item.content.trim() && !item.attachmentCount)) throw new ComposerStorageError('invalid');
      if (item.content.length > COMPOSER_STORAGE_LIMITS.textLength) throw new ComposerStorageError('limit');
      if (item.id !== undefined && (typeof item.id !== 'string' || !item.id || ids.has(item.id))) throw new ComposerStorageError('invalid');
      if (item.id) ids.add(item.id);
      if (item.composerRoute && item.composerRoute !== composerRouteKey(route)) return { raw, queue: [], foreign: true };
    }
  }
  const queue = readQueuedMessages(route.conversation);
  return { raw, queue, foreign: false };
}
