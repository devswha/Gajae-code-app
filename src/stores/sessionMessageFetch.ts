import { replaceEqualDeep } from '@tanstack/react-query';

// Reconcile fetch sizing for the session message store.
//
// refreshFromServer() re-fetches the server transcript after streaming, a WS
// reconnect, or a realtime event to reconcile optimistic/realtime rows. It used
// to request the endpoint with NO limit, so the backend returned the ENTIRE
// transcript (route defaults limit=null) — a 766-message session was pulled in
// full on every refresh, which is what made opening large sessions heavy.
//
// The backend already paginates identically for every provider (readline stream
// + tail page + total/hasMore), so the fix is to make the reconcile fetch honor
// that contract: request only the currently-loaded window (never fewer than
// REFRESH_RECONCILE_MIN_MESSAGES). Older messages stay reachable via scroll-up
// (fetchMore) because total/hasMore are unchanged.

export const REFRESH_RECONCILE_MIN_MESSAGES = 20;

function isMessageWindow(value: unknown): value is { messages: unknown[]; [key: string]: unknown } {
  return value !== null && typeof value === 'object' && 'messages' in value && Array.isArray(value.messages);
}

function persistedMessageId(value: unknown): string | null {
  return value !== null && typeof value === 'object' && 'id' in value && typeof value.id === 'string' && value.id.length > 0
    ? value.id
    : null;
}

/** Query structural sharing by persisted row identity, not its position in the window. */
export function shareMessageWindow(oldData: unknown, newData: unknown): unknown {
  if (oldData === newData || !isMessageWindow(oldData) || !isMessageWindow(newData)) return newData;

  const { messages: oldMessages, ...oldFields } = oldData;
  const { messages: newMessages, ...newFields } = newData;
  const previousById = new Map<string, unknown>();
  for (const message of oldMessages) {
    const id = persistedMessageId(message);
    if (id !== null) previousById.set(id, message);
  }

  let sameMessages = oldMessages.length === newMessages.length;
  const messages = newMessages.map((message, index) => {
    const id = persistedMessageId(message);
    const previous = id === null ? undefined : previousById.get(id);
    const shared = previous === undefined ? message : replaceEqualDeep(previous, message);
    if (shared !== oldMessages[index]) sameMessages = false;
    return shared;
  });

  // Do not deep-share the message array by index after matching rows by ID:
  // a prepend shifts indices, and ID-less rows must not alias unrelated rows.
  const fields = replaceEqualDeep(oldFields, newFields);
  if (sameMessages && fields === oldFields) return oldData;
  return { ...fields, messages: sameMessages ? oldMessages : messages };
}

/**
 * Builds the bounded reconcile URL for refreshFromServer.
 *
 * @param sessionId   provider session id
 * @param loadedCount how many messages are currently loaded/shown for the session
 *                    (server rows + realtime rows); the reconcile fetch is sized to
 *                    this so it never shrinks the visible window nor pulls the whole
 *                    transcript.
 */
export function buildRefreshMessagesUrl(
  sessionId: string,
  loadedCount: number,
  includeImages = true,
): string {
  const safeLoaded = Number.isFinite(loadedCount) ? Math.max(0, Math.floor(loadedCount)) : 0;
  const reconcileLimit = Math.max(safeLoaded, REFRESH_RECONCILE_MIN_MESSAGES);
  const params = new URLSearchParams({ limit: String(reconcileLimit), offset: '0' });
  if (!includeImages) params.set('includeImages', 'false');
  return `/api/providers/sessions/${encodeURIComponent(sessionId)}/messages?${params.toString()}`;
}
