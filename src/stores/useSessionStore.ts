import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { JobProjectionErrorCode, JobProjectionEvent, JobSnapshot, JobState, JobTerminalPayload } from '../../shared/gjc-job-projection-protocol';
import type { LLMProvider } from '../types/app';
import { authenticatedFetch } from '../utils/api';

import { buildRefreshMessagesUrl, shareMessageWindow } from './sessionMessageFetch';

type MessageKind = 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'stream_delta' | 'stream_end' | 'error' | 'complete' | 'status' | 'permission_request' | 'permission_cancelled' | 'session_created' | 'interactive_prompt' | 'task_notification' | 'system_notice';
export interface NormalizedMessage {
  id: string; sessionId: string; timestamp: string; provider: LLMProvider; kind: MessageKind; seq?: number; replayGeneration?: string;
  role?: 'user' | 'assistant'; content?: string; displayText?: string; commandName?: string; commandMessage?: string; commandArgs?: string;
  isLocalCommand?: boolean; isLocalCommandStdout?: boolean; isCompactSummary?: boolean; images?: Array<{ path?: string; data?: string; name?: string }>;
  toolName?: string; toolInput?: unknown; toolId?: string; toolResult?: { content: string; isError: boolean; isFinal?: boolean; toolUseResult?: unknown } | null; toolUseResult?: unknown;
  toolResultTruncated?: boolean; toolResultBytes?: number; isError?: boolean; level?: 'info' | 'warning' | 'error'; text?: string; tokens?: number;
  canInterrupt?: boolean; tokenBudget?: unknown; requestId?: string; input?: unknown; context?: unknown; newSessionId?: string; status?: string;
  summary?: string; exitCode?: number; actualSessionId?: string; parentToolUseId?: string; subagentTools?: unknown[]; isFinal?: boolean; sequence?: number; rowid?: number;
}
export type SessionStatus = 'idle' | 'loading' | 'streaming' | 'error';
export type ChatReplayCursor = { replayGeneration: string | null; lastSeq: number };
export interface SessionSlot {
  serverMessages: NormalizedMessage[]; realtimeMessages: NormalizedMessage[]; merged: NormalizedMessage[];
  receivedEventIds: Set<string>;
  replayCursor: ChatReplayCursor; retiredReplayGenerations: Set<string>;
  _lastServerRef: NormalizedMessage[]; _lastRealtimeRef: NormalizedMessage[]; _fetchSeq: number; _fetchMoreTicket: number | null;
  _pendingRequests: number; _loadingTicket: number | null; _includeImages: boolean; status: SessionStatus; fetchedAt: number;
  total: number; hasMore: boolean; offset: number; tokenUsage: unknown;
}
export type MessagesWindow = { messages: NormalizedMessage[]; total: number; hasMore: boolean; offset: number; tokenUsage?: unknown };
export type FetchMoreResult = { failed: false; addedCount: number; hasMore: boolean; total: number } | { failed: true } | null;
export type JobProjectionSlot = { snapshot: JobSnapshot | null; lastAppliedSequence: number; eventsBySequence: Map<number, JobProjectionEvent>; orderedTail: JobProjectionEvent[]; status: 'idle' | 'subscribed' | 'error'; error: JobProjectionErrorCode | 'protocol_violation' | null };

const EMPTY: NormalizedMessage[] = [];
const MAX_REALTIME_MESSAGES = 500;
const MAX_RECEIVED_EVENT_IDS = 5000;
const MAX_SESSION_SLOTS = 50;
const STALE_THRESHOLD_MS = 30_000;
const LOCAL_ACTIVITY_WINDOW = 5 * 60 * 1000;
const CLOCK_TOLERANCE = 10_000;

const messageKey = (message: NormalizedMessage) => message.id ? `id:${message.id}` : typeof message.sequence === 'number' && Number.isFinite(message.sequence) ? `sequence:${message.sessionId}:${message.sequence}` : null;
const messageTime = (message: NormalizedMessage) => {
  const parsed = Date.parse(message.timestamp);
  return Number.isFinite(parsed) ? parsed : null;
};
const chronological = (left: NormalizedMessage, right: NormalizedMessage) => (messageTime(left) ?? 0) - (messageTime(right) ?? 0);
const userContent = (message: NormalizedMessage) => message.kind === 'text' && message.role === 'user' && message.content?.trim() ? message.content.trim() : null;

type ToolResultUpdate = Pick<NormalizedMessage, 'content' | 'isError' | 'isFinal' | 'toolUseResult'>;

/** Partial details patch records; arrays and explicit null remain replacements. */
function mergeToolDetails(previous: unknown, update: unknown): unknown {
  if (update === undefined) return previous;
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!record(previous) || !record(update)) return update;
  return Object.fromEntries([
    ...Object.entries(previous),
    ...Object.entries(update).map(([key, value]) => [key, mergeToolDetails(Object.prototype.hasOwnProperty.call(previous, key) ? previous[key] : undefined, value)]),
  ]);
}

function mergeToolUpdate(previous: ToolResultUpdate | undefined, update: NormalizedMessage): NormalizedMessage {
  // Missing isFinal is the legacy final-result contract. Only explicit partial
  // frames are patches; a final result can clear text and replace all details.
  if (!previous || update.isFinal !== false) return update;
  return {
    ...update,
    content: update.content || previous.content || '',
    toolUseResult: mergeToolDetails(previous.toolUseResult, update.toolUseResult),
    isError: previous.isError === true || update.isError === true,
    isFinal: previous.isFinal !== false,
  };
}

function withoutRepeatedIds(messages: NormalizedMessage[]) {
  const retained = new Set<string>();
  return messages.filter((message) => {
    if (!message.id) return true;
    if (retained.has(message.id)) return false;
    retained.add(message.id);
    return true;
  });
}

function localUserIsPersisted(local: NormalizedMessage, server: NormalizedMessage[]) {
  const text = userContent(local);
  const sentAt = messageTime(local);
  if (!text || sentAt === null) return false;
  return server.some((candidate) => {
    const recordedAt = messageTime(candidate);
    return userContent(candidate) === text && recordedAt !== null && recordedAt >= sentAt - CLOCK_TOLERANCE && recordedAt - sentAt <= LOCAL_ACTIVITY_WINDOW;
  });
}

function assistantEchoesPersisted(message: NormalizedMessage, server: NormalizedMessage[], realtime: NormalizedMessage[]) {
  const content = message.content?.trim();
  const targetAt = messageTime(message);
  if (!content || targetAt === null) return false;
  const diskIds = new Set(server.map(row => row.id).filter(Boolean));
  const pendingUsers = realtime.filter(row => userContent(row)
    && !diskIds.has(row.id)
    && !(row.id?.startsWith('local_') && localUserIsPersisted(row, server)));
  const users = [...server.filter(row => userContent(row)), ...pendingUsers].sort(chronological);
  let anchor: NormalizedMessage | undefined;
  for (const user of users) {
    const at = messageTime(user);
    if (at !== null && at <= targetAt) anchor = user;
  }
  // A new, unpersisted question is a distinct turn, even when its answer
  // repeats older prose. Without an anchor, the loaded prefix is the tail of
  // the turn whose question fell outside the bounded history window.
  const anchorIndex = anchor ? server.indexOf(anchor) : -1;
  if (anchor && anchorIndex < 0) return false;
  const began = anchorIndex + 1;
  let end = server.length;
  for (let index = began; index < server.length; index += 1) {
    if (server[index].kind === 'text' && server[index].role === 'user') { end = index; break; }
  }
  return server.slice(began, end).some((row) => (message.kind === 'thinking'
    ? row.kind === 'thinking'
    : row.kind === 'text' && row.role === 'assistant') && row.content?.trim() === content);
}

/**
 * Deltas for a session nobody was watching land one frame at a time, a word
 * or two per row; merged back in on return they used to render as dozens of
 * tiny messages (and the wildly different height broke scroll anchoring).
 * Consecutive deltas of one session are one stream, so they merge into one
 * row before the final-text reconciliation runs.
 */
function coalesceStreamDeltas(rows: NormalizedMessage[]): NormalizedMessage[] {
  const result: NormalizedMessage[] = [];
  for (const row of rows) {
    const prior = result.at(-1);
    if (prior?.kind === 'stream_delta' && row.kind === 'stream_delta' && prior.sessionId === row.sessionId && prior.replayGeneration === row.replayGeneration) {
      result[result.length - 1] = { ...prior, content: (prior.content ?? '') + (row.content ?? '') };
      continue;
    }
    result.push(row);
  }
  return result;
}

function collapseStreamTransition(rows: NormalizedMessage[]) {
  rows = coalesceStreamDeltas(rows);
  const result: NormalizedMessage[] = [];
  const used = new Set<string>();
  // Replayed deltas can precede their persisted answer with reasoning or tool
  // events between them. Match the entire user turn, not just adjacent rows.
  const answers = new Map<number, string[]>();
  let turn = 0;
  for (const row of rows) {
    if (row.kind === 'text' && row.role === 'user') turn += 1;
    else if (row.kind === 'text' && row.role === 'assistant' && row.content?.trim()) {
      const texts = answers.get(turn) ?? [];
      texts.push(row.content.trim());
      answers.set(turn, texts);
    }
  }
  turn = 0;
  rows.forEach((row) => {
    if (row.id && used.has(row.id)) return;
    if (row.kind === 'text' && row.role === 'user') turn += 1;
    if (row.kind === 'stream_delta' && row.content?.trim()) {
      const delta = row.content.trim();
      if (answers.get(turn)?.some(answer => answer.includes(delta))) return;
    }
    if (row.id) used.add(row.id);
    result.push(row);
  });
  return result;
}

function retainUnpersisted(server: NormalizedMessage[], realtime: NormalizedMessage[]) {
  if (!realtime.length) return realtime;
  const diskIds = new Set(server.map((row) => row.id).filter(Boolean));
  return realtime.filter((row) => {
    if (row.id && diskIds.has(row.id)) return false;
    if (row.id?.startsWith('local_')) return !localUserIsPersisted(row, server);
    if (row.kind === 'thinking' || (row.kind === 'stream_delta' || row.id === `__streaming_${row.sessionId}`) || (row.kind === 'text' && row.role === 'assistant' && row.id?.startsWith('text_'))) return !assistantEchoesPersisted(row, server, realtime);
    return !(row.kind === 'tool_use' && row.toolId && server.some((saved) => saved.kind === 'tool_use' && saved.toolId === row.toolId));
  });
}

function mergeWindows(server: NormalizedMessage[], realtime: NormalizedMessage[]) {
  if (!realtime.length) return server;
  if (!server.length) return collapseStreamTransition(realtime);
  const savedIds = new Set(server.map((row) => row.id).filter(Boolean));
  const observed = new Set<string>();
  const additions = realtime.filter((row) => {
    if (row.id && observed.has(row.id)) return false;
    if (row.id) observed.add(row.id);
    if (row.id && savedIds.has(row.id)) return false;
    if (row.id?.startsWith('local_') && localUserIsPersisted(row, server)) return false;
    return !((row.kind === 'thinking' || (row.kind === 'text' && row.role === 'assistant' && row.id?.startsWith('text_'))) && assistantEchoesPersisted(row, server, realtime));
  });
  return additions.length ? collapseStreamTransition([...server, ...additions].sort(chronological)) : server;
}

function refreshMerged(slot: SessionSlot) {
  const server = slot.serverMessages;
  if (server === slot._lastServerRef && slot.realtimeMessages === slot._lastRealtimeRef) return false;
  slot._lastServerRef = server;
  slot._lastRealtimeRef = slot.realtimeMessages;
  slot.merged = mergeWindows(server, slot.realtimeMessages);
  return true;
}

function newJobSlot(): JobProjectionSlot {
  return { snapshot: null, lastAppliedSequence: 0, eventsBySequence: new Map(), orderedTail: [], status: 'idle', error: null };
}

function newSlot(sessionId: string, client: QueryClient): SessionSlot {
  const key = ['messages', sessionId] as const;
  const slot = { realtimeMessages: EMPTY, merged: EMPTY, receivedEventIds: new Set<string>(), replayCursor: { replayGeneration: null, lastSeq: 0 }, retiredReplayGenerations: new Set<string>(), _lastServerRef: EMPTY, _lastRealtimeRef: EMPTY, _fetchSeq: 0, _fetchMoreTicket: null, _pendingRequests: 0, _loadingTicket: null, _includeImages: true, status: 'idle' } as SessionSlot;
  const window = () => client.getQueryData<MessagesWindow>(key);
  Object.defineProperties(slot, {
    serverMessages: { enumerable: true, get: () => window()?.messages ?? EMPTY }, total: { enumerable: true, get: () => window()?.total ?? 0 }, hasMore: { enumerable: true, get: () => window()?.hasMore ?? false }, offset: { enumerable: true, get: () => window()?.offset ?? 0 }, tokenUsage: { enumerable: true, get: () => window()?.tokenUsage }, fetchedAt: { enumerable: true, get: () => client.getQueryState(key)?.dataUpdatedAt ?? 0 },
  });
  return slot;
}

async function reconcile(sessionId: string, slot: SessionSlot): Promise<MessagesWindow> {
  const count = slot.serverMessages.length + slot.realtimeMessages.length;
  const response = await authenticatedFetch(buildRefreshMessagesUrl(sessionId, count, slot._includeImages));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  const data = body?.data ?? body;
  const messages: NormalizedMessage[] = data.messages || [];
  return { messages: withoutRepeatedIds(messages), total: data.total ?? messages.length, hasMore: Boolean(data.hasMore), offset: messages.length, tokenUsage: data.tokenUsage || slot.tokenUsage };
}

export function useSessionStore() {
  const queryClient = useQueryClient();
  // Defaults must exist before imperative writes, including inactive session windows.
  const configuredClient = useRef<QueryClient | null>(null);
  if (configuredClient.current !== queryClient) {
    queryClient.setQueryDefaults(['messages'], { structuralSharing: shareMessageWindow });
    configuredClient.current = queryClient;
  }
  const slots = useRef(new Map<string, SessionSlot>());
  const jobs = useRef(new Map<string, JobProjectionSlot>());
  const activeSession = useRef<string | null>(null);
  const activeJob = useRef<string | null>(null);
  const [observedSession, setObservedSession] = useState<string | null>(null);
  const [, redraw] = useState(0);
  // Consumers that are not on the store owner's render path (the workspace
  // panel reads a session's messages through stable props, which the compiler
  // memoizes) subscribe per session instead of relying on the owner's redraw.
  const sessionListeners = useRef(new Map<string, Set<() => void>>());
  const subscribeSession = useCallback((id: string, listener: () => void) => {
    const listeners = sessionListeners.current.get(id) ?? new Set<() => void>();
    listeners.add(listener);
    sessionListeners.current.set(id, listeners);
    return () => { listeners.delete(listener); if (listeners.size === 0) sessionListeners.current.delete(id); };
  }, []);
  const emitSession = useCallback((id: string) => {
    if (activeSession.current === id) redraw((version) => version + 1);
    sessionListeners.current.get(id)?.forEach((listener) => listener());
  }, []);
  const emitJob = useCallback((id: string) => { if (activeJob.current === id) redraw((version) => version + 1); }, []);

  const evict = useCallback((keep?: string) => {
    while (slots.current.size > MAX_SESSION_SLOTS) {
      const victim = [...slots.current].find(([id, slot]) => id !== keep && id !== activeSession.current && slot.status !== 'streaming' && slot._pendingRequests === 0);
      if (!victim) return;
      slots.current.delete(victim[0]);
    }
  }, []);
  const remember = useCallback((id: string, slot: SessionSlot) => { slots.current.delete(id); slots.current.set(id, slot); evict(id); }, [evict]);
  const getSlot = useCallback((id: string) => { const slot = slots.current.get(id) ?? newSlot(id, queryClient); remember(id, slot); return slot; }, [queryClient, remember]);
  const acceptRealtimeEvent = useCallback((id: string, eventId: unknown) => {
    if (typeof eventId !== 'string' || !eventId) return true;
    const received = getSlot(id).receivedEventIds;
    if (received.has(eventId)) return false;
    received.add(eventId);
    if (received.size > MAX_RECEIVED_EVENT_IDS) received.delete(received.values().next().value!);
    return true;
  }, [getSlot]);
  const getReplayCursor = useCallback((id: string): ChatReplayCursor => ({ ...getSlot(id).replayCursor }), [getSlot]);
  const trackReplayFrame = useCallback((id: string, frame: { kind?: string; seq?: number; replayGeneration?: string | null }) => {
    const subscribed = frame.kind === 'chat_subscribed';
    const slot = getSlot(id);
    const generation = typeof frame.replayGeneration === 'string' && frame.replayGeneration ? frame.replayGeneration : null;
    if (generation !== null && slot.retiredReplayGenerations.has(generation)) return false;
    if (!subscribed && (!Number.isSafeInteger(frame.seq) || frame.seq! < 1)) return true;
    // Legacy frames remain displayable, but their unscoped sequence must not
    // become a reconnect cursor or contaminate an established generation.
    if (!subscribed && generation === null) return slot.replayCursor.replayGeneration === null;
    if (slot.replayCursor.replayGeneration !== generation) {
      if (slot.replayCursor.replayGeneration !== null) slot.retiredReplayGenerations.add(slot.replayCursor.replayGeneration);
      slot.replayCursor = { replayGeneration: generation, lastSeq: 0 };
    }
    // The subscription's lastSeq is an advertised high-water mark, not proof
    // that replay was received. Only actual registered frames advance it.
    if (!subscribed && generation !== null) slot.replayCursor.lastSeq = Math.max(slot.replayCursor.lastSeq, frame.seq!);
    return true;
  }, [getSlot]);
  const begin = useCallback((id: string) => { const slot = slots.current.get(id) ?? newSlot(id, queryClient); slot._pendingRequests += 1; remember(id, slot); return slot; }, [queryClient, remember]);
  const has = useCallback((id: string) => slots.current.has(id), []);

  const getJobSlot = useCallback((id: string) => { const slot = jobs.current.get(id) ?? newJobSlot(); jobs.current.set(id, slot); return slot; }, []);
  const setActiveJob = useCallback((id: string | null) => { activeJob.current = id; redraw((version) => version + 1); }, []);
  const applyJobSubscribed = useCallback((id: string, snapshot: JobSnapshot) => { const slot = getJobSlot(id); slot.snapshot = snapshot; slot.status = 'subscribed'; slot.error = null; emitJob(id); }, [emitJob, getJobSlot]);
  const applyEvent = useCallback((id: string, event: JobProjectionEvent) => {
    const slot = getJobSlot(id); const prior = slot.eventsBySequence.get(event.sequence);
    if (event.sequence <= slot.lastAppliedSequence) {
      if (!prior || prior.eventId === event.eventId) return true;
      slot.status = 'error'; slot.error = 'protocol_violation'; emitJob(id); return false;
    }
    if (event.sequence !== slot.lastAppliedSequence + 1 || prior) { slot.status = 'error'; slot.error = 'protocol_violation'; emitJob(id); return false; }
    const payload = event.payload as Partial<JobTerminalPayload> | null;
    if (payload && typeof payload === 'object' && payload.schemaVersion === 1 && payload.kind === 'job_terminal' && (payload.jobState === 'succeeded' || payload.jobState === 'failed' || payload.jobState === 'aborted' || payload.jobState === 'interrupted') && slot.snapshot) slot.snapshot = { ...slot.snapshot, state: payload.jobState as JobState };
    slot.eventsBySequence.set(event.sequence, event); slot.orderedTail = [...slot.orderedTail, event]; slot.lastAppliedSequence = event.sequence; slot.status = 'subscribed'; slot.error = null; emitJob(id); return true;
  }, [emitJob, getJobSlot]);
  const applyJobReplayChunk = useCallback((id: string, events: JobProjectionEvent[]) => events.every((event) => applyEvent(id, event)), [applyEvent]);
  const applyJobLiveEvent = useCallback((id: string, event: JobProjectionEvent) => applyEvent(id, event), [applyEvent]);
  const getJobCursor = useCallback((id: string) => jobs.current.get(id)?.lastAppliedSequence ?? 0, []);
  const setJobError = useCallback((id: string, error: JobProjectionErrorCode | 'protocol_violation') => { const slot = getJobSlot(id); slot.status = 'error'; slot.error = error; emitJob(id); }, [emitJob, getJobSlot]);
  const clearJobs = useCallback(() => { const wasActive = activeJob.current !== null; jobs.current.clear(); activeJob.current = null; if (wasActive) redraw((version) => version + 1); }, []);

  const setActiveSession = useCallback((id: string | null) => { activeSession.current = id; setObservedSession(id); if (id) { const slot = slots.current.get(id); if (slot) remember(id, slot); } evict(); }, [evict, remember]);
  const observerSlot = observedSession ? slots.current.get(observedSession) : undefined;
  const observedWindow = useQuery({
    queryKey: ['messages', observedSession ?? '__no_active_session__'], staleTime: Infinity,
    enabled: Boolean(observedSession && observerSlot && observerSlot.status !== 'streaming' && queryClient.getQueryData<MessagesWindow>(['messages', observedSession]) !== undefined),
    queryFn: async () => { const id = activeSession.current; const slot = id ? slots.current.get(id) : undefined; if (!id || !slot) throw new Error('no active session window'); return reconcile(id, slot); },
  });
  const windowUpdatedAt = observedWindow.dataUpdatedAt;
  useEffect(() => { const id = activeSession.current; const slot = id ? slots.current.get(id) : undefined; if (!slot || !id) return; const remaining = retainUnpersisted(slot.serverMessages, slot.realtimeMessages); if (remaining.length !== slot.realtimeMessages.length) slot.realtimeMessages = remaining; if (refreshMerged(slot)) emitSession(id); }, [emitSession, windowUpdatedAt]);

  const fetchFromServer = useCallback(async (id: string, options: { limit?: number | null; offset?: number; includeImages?: boolean } = {}) => {
    const slot = begin(id); if (typeof options.includeImages === 'boolean') slot._includeImages = options.includeImages;
    const ticket = ++slot._fetchSeq; if (slot.status !== 'streaming') { slot.status = 'loading'; slot._loadingTicket = ticket; } emitSession(id);
    try {
      const params = new URLSearchParams(); if (options.limit !== null && options.limit !== undefined) { params.set('limit', String(options.limit)); params.set('offset', String(options.offset ?? 0)); } if (!slot._includeImages) params.set('includeImages', 'false');
      const response = await authenticatedFetch(`/api/providers/sessions/${encodeURIComponent(id)}/messages${params.size ? `?${params}` : ''}`); if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json(); const data = body?.data ?? body; const messages: NormalizedMessage[] = data.messages || [];
      if (ticket !== slot._fetchSeq) return null;
      queryClient.setQueryData<MessagesWindow>(['messages', id], { messages: withoutRepeatedIds(messages), total: data.total ?? messages.length, hasMore: Boolean(data.hasMore), offset: (options.offset ?? 0) + messages.length, tokenUsage: data.tokenUsage || slot.tokenUsage });
      if (slot.status === 'loading' && slot._loadingTicket === ticket) slot.status = 'idle'; refreshMerged(slot); emitSession(id); return slot;
    } catch (error) {
      console.error(`[SessionStore] fetch failed for ${id}:`, error); if (ticket === slot._fetchSeq && slot.status === 'loading' && slot._loadingTicket === ticket) { slot.status = 'error'; emitSession(id); } return null;
    } finally { slot._pendingRequests -= 1; if (slot._loadingTicket === ticket) slot._loadingTicket = null; evict(); }
  }, [begin, emitSession, evict, queryClient]);

  // `null` means nothing happened (no older rows, a page already in flight, or
  // a newer fetch superseded this one); only a failed request reports `failed`.
  const fetchMore = useCallback(async (id: string, options: { limit?: number; includeImages?: boolean } = {}): Promise<FetchMoreResult> => {
    const slot = slots.current.get(id) ?? newSlot(id, queryClient); if (typeof options.includeImages === 'boolean') slot._includeImages = options.includeImages;
    if (!slot.hasMore || slot._fetchMoreTicket !== null) { remember(id, slot); return null; }
    const offset = slot.offset; const ticket = ++slot._fetchSeq; slot._fetchMoreTicket = ticket; slot._pendingRequests += 1; remember(id, slot); if (slot.status === 'loading') slot._loadingTicket = ticket;
    try {
      const params = new URLSearchParams({ limit: String(options.limit ?? 20), offset: String(offset) }); if (!slot._includeImages) params.set('includeImages', 'false');
      const response = await authenticatedFetch(`/api/providers/sessions/${encodeURIComponent(id)}/messages?${params}`); if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json(); const data = body?.data ?? body; const older: NormalizedMessage[] = data.messages || [];
      if (ticket !== slot._fetchSeq || slot._fetchMoreTicket !== ticket || slot.offset !== offset) return null;
      const beforeCount = slot.serverMessages.length;
      const messages = withoutRepeatedIds([...older, ...slot.serverMessages]);
      queryClient.setQueryData<MessagesWindow>(['messages', id], { messages, total: data.total ?? slot.total, hasMore: Boolean(data.hasMore), offset: offset + older.length, tokenUsage: slot.tokenUsage });
      if (slot.status === 'loading' && slot._loadingTicket === ticket) slot.status = 'idle';
      refreshMerged(slot);
      emitSession(id);
      return { failed: false, addedCount: messages.length - beforeCount, hasMore: slot.hasMore, total: slot.total };
    } catch (error) {
      console.error(`[SessionStore] fetchMore failed for ${id}:`, error); if (ticket === slot._fetchSeq && slot.status === 'loading' && slot._loadingTicket === ticket) { slot.status = 'idle'; emitSession(id); } return { failed: true };
    } finally { slot._pendingRequests -= 1; if (slot._fetchMoreTicket === ticket) slot._fetchMoreTicket = null; if (slot._loadingTicket === ticket) slot._loadingTicket = null; evict(); }
  }, [emitSession, evict, queryClient, remember]);

  const append = useCallback((id: string, messages: NormalizedMessage[]) => {
    if (!messages.length) return;
    const slot = getSlot(id);
    refreshMerged(slot);
    const results = new Map<string, ToolResultUpdate>();
    for (const row of slot.merged) {
      if (!row.toolId) continue;
      if (row.kind === 'tool_use' && row.toolResult) results.set(row.toolId, row.toolResult);
      else if (row.kind === 'tool_result') results.set(row.toolId, row);
    }
    const index = new Map<string, number>();
    const next = [...slot.realtimeMessages];
    next.forEach((row, position) => { const key = messageKey(row); if (key) index.set(key, position); });
    messages.forEach((row) => {
      let normalized = row.sessionId === id ? row : { ...row, sessionId: id };
      if (normalized.toolId && normalized.kind === 'tool_result') {
        normalized = mergeToolUpdate(results.get(normalized.toolId), normalized);
        results.set(normalized.toolId!, normalized);
      } else if (normalized.toolId && normalized.kind === 'tool_use' && normalized.toolResult) {
        results.set(normalized.toolId, normalized.toolResult);
      }
      const key = messageKey(normalized);
      const position = key ? index.get(key) : undefined;
      if (position === undefined) { if (key) index.set(key, next.length); next.push(normalized); }
      else next[position] = normalized;
    });
    slot.realtimeMessages = next.length > MAX_REALTIME_MESSAGES ? next.slice(-MAX_REALTIME_MESSAGES) : next;
    refreshMerged(slot);
    emitSession(id);
  }, [emitSession, getSlot]);
  const appendRealtime = useCallback((id: string, message: NormalizedMessage) => append(id, [message]), [append]);
  const appendRealtimeBatch = useCallback((id: string, messages: NormalizedMessage[]) => append(id, messages), [append]);

  const refreshFromServer = useCallback(async (id: string, options: { includeImages?: boolean } = {}) => {
    const slot = begin(id); if (typeof options.includeImages === 'boolean') slot._includeImages = options.includeImages; const ticket = ++slot._fetchSeq; if (slot.status === 'loading') slot._loadingTicket = ticket;
    try { const window = await reconcile(id, slot); if (ticket !== slot._fetchSeq) return; queryClient.setQueryData<MessagesWindow>(['messages', id], window); if (slot.status === 'loading' && slot._loadingTicket === ticket) slot.status = 'idle'; slot.realtimeMessages = retainUnpersisted(slot.serverMessages, slot.realtimeMessages); refreshMerged(slot); emitSession(id); }
    catch (error) { console.error(`[SessionStore] refresh failed for ${id}:`, error); if (ticket === slot._fetchSeq && slot.status === 'loading' && slot._loadingTicket === ticket) { slot.status = 'idle'; emitSession(id); } }
    finally { slot._pendingRequests -= 1; if (slot._loadingTicket === ticket) slot._loadingTicket = null; evict(); }
  }, [begin, emitSession, evict, queryClient]);

  const setStatus = useCallback((id: string, status: SessionStatus) => { const slot = getSlot(id); slot._loadingTicket = null; slot.status = status; emitSession(id); }, [emitSession, getSlot]);
  const isStale = useCallback((id: string) => { const slot = slots.current.get(id); return !slot || Date.now() - slot.fetchedAt > STALE_THRESHOLD_MS; }, []);
  // The row keeps the timestamp of its first delta: the work block above it
  // measures its duration to the moment the prose began, and a clock that
  // moved with every delta would tick that duration up as the answer streams.
  const updateStreaming = useCallback((id: string, content: string, provider: LLMProvider, timestamp?: unknown) => { const slot = getSlot(id); const streamId = `__streaming_${id}`; const position = slot.realtimeMessages.findIndex((message) => message.id === streamId); const startedAt = typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp)) ? timestamp : new Date().toISOString(); const row: NormalizedMessage = { id: streamId, sessionId: id, timestamp: position < 0 ? startedAt : slot.realtimeMessages[position].timestamp, provider, kind: 'stream_delta', content }; slot.realtimeMessages = position < 0 ? [...slot.realtimeMessages, row] : slot.realtimeMessages.map((message, index) => index === position ? row : message); refreshMerged(slot); emitSession(id); }, [emitSession, getSlot]);
  const finalizeStreaming = useCallback((id: string) => { const slot = slots.current.get(id); if (!slot) return; const streamId = `__streaming_${id}`; const position = slot.realtimeMessages.findIndex((message) => message.id === streamId); if (position < 0) return; slot.realtimeMessages = slot.realtimeMessages.map((message, index) => index === position ? { ...message, id: `text_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, kind: 'text', role: 'assistant' } : message); refreshMerged(slot); emitSession(id); }, [emitSession]);
  const clearRealtime = useCallback((id: string) => { const slot = slots.current.get(id); if (!slot) return; slot.realtimeMessages = []; refreshMerged(slot); emitSession(id); }, [emitSession]);
  const clear = useCallback(() => { const hadActive = activeSession.current !== null; slots.current.clear(); queryClient.removeQueries({ queryKey: ['messages'] }); activeSession.current = null; setObservedSession(null); if (hadActive) redraw((version) => version + 1); }, [queryClient]);
  const getMessages = useCallback((id: string) => { const slot = slots.current.get(id); if (!slot) return EMPTY; refreshMerged(slot); return slot.merged; }, []);
  const getSessionSlot = useCallback((id: string) => { const slot = slots.current.get(id); if (slot) refreshMerged(slot); return slot; }, []);

  return useMemo(() => ({ getSlot, acceptRealtimeEvent, getReplayCursor, trackReplayFrame, has, fetchFromServer, fetchMore, appendRealtime, appendRealtimeBatch, refreshFromServer, setActiveSession, setStatus, isStale, updateStreaming, finalizeStreaming, clearRealtime, clear, getJobSlot, getJobCursor, setActiveJob, applyJobSubscribed, applyJobReplayChunk, applyJobLiveEvent, setJobError, clearJobs, getMessages, getSessionSlot, subscribeSession }), [getSlot, acceptRealtimeEvent, getReplayCursor, trackReplayFrame, has, fetchFromServer, fetchMore, appendRealtime, appendRealtimeBatch, refreshFromServer, setActiveSession, setStatus, isStale, updateStreaming, finalizeStreaming, clearRealtime, clear, getJobSlot, getJobCursor, setActiveJob, applyJobSubscribed, applyJobReplayChunk, applyJobLiveEvent, setJobError, clearJobs, getMessages, getSessionSlot, subscribeSession]);
}

export type SessionStore = ReturnType<typeof useSessionStore>;
