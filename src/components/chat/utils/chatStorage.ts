import { invalidateComposerFreeze, isComposerSealed } from '../../../shared/composerFreeze';

const DRAFT_KEY_PREFIX = 'draft_input_';
const QUEUE_KEY_PREFIX = 'queued_message_';
const queuedMessageListeners = new Set<(sessionId: string) => void>();

/** Same-document queue changes, which the browser's storage event omits. */
export function subscribeQueuedMessages(listener: (sessionId: string) => void): () => void {
  queuedMessageListeners.add(listener);
  return () => { queuedMessageListeners.delete(listener); };
}

/** Publish only after the caller has successfully changed its queue projection. */
export function notifyQueuedMessages(sessionId: string): void {
  queuedMessageListeners.forEach((listener) => listener(sessionId));
}

const matchingKeys = (prefix: string, retained: string) => Object.keys(localStorage).filter((key) => key.startsWith(prefix) && key !== retained);
const removeKeys = (keys: string[]) => { keys.forEach((key) => localStorage.removeItem(key)); return keys.length; };

export const safeLocalStorage = {
  setItem: (key: string, value: string) => {
    if (isComposerSealed()) return;
    try { localStorage.setItem(key, value); return; } catch (error: any) {
      if (error?.name !== 'QuotaExceededError') { console.error('localStorage error:', error); return; }
    }
    const draftsRemoved = removeKeys(matchingKeys(DRAFT_KEY_PREFIX, key));
    if (draftsRemoved) {
      try { localStorage.setItem(key, value); return; } catch {
        // Queue entries are considered only after drafts could not free enough room.
      }
    }
    const queuesRemoved = removeKeys(matchingKeys(QUEUE_KEY_PREFIX, key));
    if (queuesRemoved) console.warn(`localStorage was full: discarded ${queuesRemoved} queued message(s) that had not been sent yet.`);
    try { localStorage.setItem(key, value); } catch (error) { console.error('Failed to save to localStorage even after cleanup:', error); }
  },
  getItem: (key: string): string | null => {
    try { return localStorage.getItem(key); } catch (error) { console.error('localStorage getItem error:', error); return null; }
  },
  removeItem: (key: string) => {
    if (isComposerSealed()) return;
    try { localStorage.removeItem(key); } catch (error) { console.error('localStorage removeItem error:', error); }
  },
};

export type QueuedSendOptions = Record<string, unknown>;
export type StoredQueuedMessage = { id?: string; content: string; options?: QueuedSendOptions; pendingSteer?: boolean; composerRoute?: string; attachmentCount?: number; requiresReview?: boolean };

const sessionDraftKey = (sessionId: string) => `${DRAFT_KEY_PREFIX}session_${sessionId}`;
export const queuedMessageKey = (sessionId: string) => `${QUEUE_KEY_PREFIX}${sessionId}`;
export const draftInputKey = (projectId: string, sessionId?: string | null) => sessionId ? sessionDraftKey(sessionId) : `${DRAFT_KEY_PREFIX}${projectId}`;

export function draftKeysToClear(projectId: string, sessionId?: string | null, settledSessionId?: string | null): string[] {
  const keys = new Set([draftInputKey(projectId, sessionId)]);
  if (settledSessionId) keys.add(draftInputKey(projectId, settledSessionId));
  return [...keys];
}

function validQueuedMessage(value: unknown): StoredQueuedMessage | null {
  if (!value || typeof value !== 'object') return null;
  const { id, content, options, pendingSteer, composerRoute, attachmentCount, requiresReview } = value as StoredQueuedMessage;
  if (typeof content !== 'string' || (!content.trim() && !attachmentCount)) return null;
  return { ...(typeof id === 'string' && id ? { id } : {}), content, ...(options === undefined ? {} : { options }), ...(pendingSteer === true ? { pendingSteer: true } : {}), ...(typeof composerRoute === 'string' ? { composerRoute } : {}), ...(typeof attachmentCount === 'number' && attachmentCount > 0 ? { attachmentCount } : {}), ...(requiresReview === true ? { requiresReview: true } : {}) };
}

export function readQueuedMessages(sessionId: string): StoredQueuedMessage[] {
  const raw = safeLocalStorage.getItem(queuedMessageKey(sessionId));
  if (!raw) return [];
  try {
    const decoded: unknown = JSON.parse(raw);
    if (Array.isArray(decoded)) return decoded.map(validQueuedMessage).filter((entry): entry is StoredQueuedMessage => entry !== null);
    const message = validQueuedMessage(decoded);
    if (message) return [message];
  } catch {
    // Before structured queues, the stored value was the message body itself.
  }
  return raw.trim() ? [{ content: raw }] : [];
}

export function writeQueuedMessages(sessionId: string, messages: StoredQueuedMessage[]): boolean {
  if (isComposerSealed()) return false;
  invalidateComposerFreeze();
  const queue = messages.filter((message) => message.content.trim() || message.attachmentCount);
  try {
    if (!queue.length) localStorage.removeItem(queuedMessageKey(sessionId));
    else localStorage.setItem(queuedMessageKey(sessionId), JSON.stringify(queue));
  } catch {
    console.warn('Queued messages could not be saved; no other drafts were removed.');
    return false;
  }
  notifyQueuedMessages(sessionId);
  return true;
}

export function clearQueuedMessages(sessionId: string): void { writeQueuedMessages(sessionId, []); }
export function forgetSessionStorage(sessionId: string): void { safeLocalStorage.removeItem(sessionDraftKey(sessionId)); clearQueuedMessages(sessionId); }

export function reorderQueue<T>(queue: readonly T[], from: number, to: number): T[] {
  const isPosition = (index: number) => index >= 0 && index < queue.length;
  if (!isPosition(from) || !isPosition(to) || from === to) return queue.slice();
  const result = [...queue];
  const [item] = result.splice(from, 1);
  result.splice(to, 0, item);
  return result;
}
