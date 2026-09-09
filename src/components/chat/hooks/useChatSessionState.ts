import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type { MarkSessionIdle, SessionActivityMap } from '../../../hooks/useSessionProtection';
import type { LLMProvider, Project, ProjectSession } from '../../../types/app';
import type { NormalizedMessage, SessionStore } from '../../../stores/useSessionStore';
import type { ChatMessage } from '../types/types';
import { createCachedDiffCalculator, type DiffCalculator } from '../utils/messageTransforms';
import { getIntrinsicMessageKey } from '../utils/messageKeys';

import { normalizedToChatMessages } from './useChatMessages';
import { useChatFollowScroll } from './useChatFollowScroll';

const PAGE_SIZE = 20;
const FIRST_VISIBLE_COUNT = 100;
const NO_MESSAGES: NormalizedMessage[] = [];

type Props = {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  newSessionTrigger?: number;
  processingSessions?: SessionActivityMap;
  onSessionIdle?: MarkSessionIdle;
  resetStreamingState: () => void;
  statusCheckSentAtRef: MutableRefObject<Map<string, number>>;
  sessionStore: SessionStore;
  showImagePreviews?: boolean;
};

type SearchRequest = { timestamp?: string; uuid?: string; snippet?: string };

export function shouldRefreshCachedImageWindow(
  previousSessionKey: string | null,
  previousEnabled: boolean,
  nextSessionKey: string,
  nextEnabled: boolean,
  hasCachedSession: boolean,
): boolean {
  return hasCachedSession && nextEnabled && !previousEnabled && previousSessionKey === nextSessionKey;
}

function normalizeLocalMessage(message: ChatMessage, sessionId: string): NormalizedMessage {
  const id = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const timestamp = message.timestamp instanceof Date
    ? message.timestamp.toISOString()
    : typeof message.timestamp === 'number'
      ? new Date(message.timestamp).toISOString()
      : String(message.timestamp);
  const common = { id, sessionId, timestamp, provider: 'gjc' as LLMProvider };

  if (message.isToolUse) {
    return { ...common, kind: 'tool_use', toolName: message.toolName, toolInput: message.toolInput, toolId: message.toolId || id };
  }
  if (message.isThinking) return { ...common, kind: 'thinking', content: message.content || '' };
  if (message.isInteractivePrompt) return { ...common, kind: 'interactive_prompt', content: message.content || '' };
  if ((message as { isTaskNotification?: boolean }).isTaskNotification) {
    const task = message as ChatMessage & { taskStatus?: string };
    return { ...common, kind: 'task_notification', status: task.taskStatus || 'completed', summary: message.content || '' };
  }
  if (message.type === 'error') return { ...common, kind: 'error', content: message.content || '' };
  return {
    ...common,
    kind: 'text',
    role: message.type === 'user' ? 'user' : 'assistant',
    content: message.content || '',
    images: Array.isArray(message.images) && message.images.length ? message.images : undefined,
  };
}

function hasNewTailContent(previous: ChatMessage[], next: ChatMessage[]): boolean {
  const before = previous.at(-1);
  const after = next.at(-1);
  if (!before || !after) return false;
  const beforeKey = getIntrinsicMessageKey(before);
  const afterKey = getIntrinsicMessageKey(after);
  if (before === after || (beforeKey !== null && beforeKey === afterKey)) {
    return (after.content?.length ?? 0) > (before.content?.length ?? 0);
  }
  // Rewind/removal exposes a message we already had, not a new arrival.
  if (afterKey !== null && previous.some(message => getIntrinsicMessageKey(message) === afterKey)) return false;
  // Prepending history leaves the old tail last; appending puts a row after it.
  if (beforeKey !== null && next.some(message => getIntrinsicMessageKey(message) === beforeKey)) return true;
  // A refreshed window can replace IDs (notably a stream's persisted final row).
  // Equal final text is reconciliation, while a genuinely newer tail is an arrival.
  if (before.isStreaming && after.type === before.type && after.content === before.content) return false;
  return new Date(after.timestamp).getTime() > new Date(before.timestamp).getTime()
    || (Boolean(before.isStreaming) && after.type === before.type
      && Boolean(after.content?.startsWith(before.content ?? ''))
      && (after.content?.length ?? 0) > (before.content?.length ?? 0));
}

function clearTimer(timer: MutableRefObject<ReturnType<typeof setTimeout> | null>) {
  if (timer.current) clearTimeout(timer.current);
  timer.current = null;
}

export function useChatSessionState({
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  newSessionTrigger,
  processingSessions,
  onSessionIdle: _onSessionIdle,
  resetStreamingState,
  statusCheckSentAtRef,
  sessionStore,
  showImagePreviews = true,
}: Props) {
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(selectedSession?.id || null);
  const [isLoadingSessionMessages, setIsLoadingSessionMessages] = useState(false);
  const [isLoadingMoreMessages, setIsLoadingMoreMessages] = useState(false);
  const [historyLoadError, setHistoryLoadError] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [totalMessages, setTotalMessages] = useState(0);
  const [hasNewMessagesBelow, setHasNewMessagesBelow] = useState(false);
  const [tokenBudget, setTokenBudget] = useState<Record<string, unknown> | null>(null);
  const [sessionState, setSessionState] = useState<Record<string, unknown> | null>(null);
  const [visibleMessageCount, setVisibleMessageCount] = useState(FIRST_VISIBLE_COUNT);
  const [allMessagesLoaded, setAllMessagesLoaded] = useState(false);
  const [isLoadingAllMessages, setIsLoadingAllMessages] = useState(false);
  const [loadAllJustFinished, setLoadAllJustFinished] = useState(false);
  const [showLoadAllOverlay, setShowLoadAllOverlay] = useState(false);
  const [viewHiddenCount, setViewHiddenCount] = useState(0);
  const [pendingUserMessage, setPendingUserMessage] = useState<ChatMessage | null>(null);
  const [searchTarget, setSearchTarget] = useState<SearchRequest | null>(null);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const activeSession = selectedSession?.id || currentSessionId || null;
  const activeSessionRef = useRef(activeSession);
  activeSessionRef.current = activeSession;
  // A response belongs to one visit, including when the user returns to the
  // same session while an earlier visit still has requests in flight.
  const viewKey = `${selectedProject?.projectId ?? ''}:${activeSession ?? ''}:${newSessionTrigger ?? 0}`;
  const requestViewRef = useRef({ key: viewKey });
  if (requestViewRef.current.key !== viewKey) requestViewRef.current = { key: viewKey };
  const activityMapRef = useRef(processingSessions);
  activityMapRef.current = processingSessions;
  const storeSessionRef = useRef<string | null>(null);
  const pendingEchoRef = useRef<ChatMessage | null>(null);
  const messageLengthRef = useRef(0);
  const priorContentRef = useRef<{ sessionId: string | null; messages: ChatMessage[] }>({ sessionId: null, messages: [] });
  const previousTriggerRef = useRef(newSessionTrigger ?? 0);
  const imageStateRef = useRef({ sessionKey: null as string | null, enabled: showImagePreviews });
  const loadedKeyRef = useRef<string | null>(null);
  const initialScrollRef = useRef(true);
  const searchInProgressRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const historyLoadErrorRef = useRef(false);
  const loadedAllRef = useRef(false);
  const ignoredOffsetRef = useRef(0);
  const finishedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const createDiff = useMemo<DiffCalculator>(createCachedDiffCalculator, []);

  const resetPagination = useCallback((resetVisibility: boolean) => {
    ignoredOffsetRef.current = 0;
    loadingMoreRef.current = false;
    historyLoadErrorRef.current = false;
    setHistoryLoadError(false);
    setIsLoadingMoreMessages(false);
    loadedAllRef.current = false;

    setHasMoreMessages(false);
    setTotalMessages(0);
    setAllMessagesLoaded(false);
    setIsLoadingAllMessages(false);
    setLoadAllJustFinished(false);
    setShowLoadAllOverlay(false);
    if (resetVisibility) setVisibleMessageCount(FIRST_VISIBLE_COUNT);
    clearTimer(finishedTimerRef);
  }, []);

  useEffect(() => {
    const incoming = newSessionTrigger ?? 0;
    if (incoming === previousTriggerRef.current) return;
    previousTriggerRef.current = incoming;
    resetStreamingState();
    setCurrentSessionId(null);
    setPendingUserMessage(null);
    setTokenBudget(null);
    setSessionState(null);
    setViewHiddenCount(0);
    setSearchTarget(null);
    initialScrollRef.current = true;
    searchInProgressRef.current = false;
    loadedKeyRef.current = null;
    imageStateRef.current = { sessionKey: null, enabled: showImagePreviews };
    resetPagination(true);
  }, [_onSessionIdle, newSessionTrigger, resetPagination, resetStreamingState, showImagePreviews]);

  const sessionActivity = activeSession ? processingSessions?.get(activeSession) || null : null;
  const isProcessing = sessionActivity !== null;
  const canAbortSession = Boolean(isProcessing && sessionActivity.canInterrupt);

  if (storeSessionRef.current !== activeSession) {
    storeSessionRef.current = activeSession;
    sessionStore.setActiveSession(activeSession);
  }
  const storedMessages = activeSession ? sessionStore.getMessages(activeSession) : NO_MESSAGES;
  if (messageLengthRef.current !== storedMessages.length) {
    messageLengthRef.current = storedMessages.length;
    if (viewHiddenCount) setViewHiddenCount(0);
  }

  useEffect(() => {
    if (!pendingUserMessage) {
      pendingEchoRef.current = null;
      return;
    }
    if (!activeSession || pendingEchoRef.current === pendingUserMessage) return;
    sessionStore.appendRealtime(activeSession, normalizeLocalMessage(pendingUserMessage, activeSession));
    pendingEchoRef.current = pendingUserMessage;
    setPendingUserMessage(null);
  }, [activeSession, pendingUserMessage, sessionStore]);

  const chatMessages = useMemo(() => {
    const converted = normalizedToChatMessages(storedMessages);
    if (!converted.length && pendingUserMessage) return [pendingUserMessage];
    return viewHiddenCount > 0 && viewHiddenCount < converted.length
      ? converted.slice(0, converted.length - viewHiddenCount)
      : converted;
  }, [pendingUserMessage, storedMessages, viewHiddenCount]);

  const addMessage = useCallback((message: ChatMessage) => {
    if (!activeSessionRef.current) {
      setPendingUserMessage(message);
      return;
    }
    const id = activeSessionRef.current;
    sessionStore.appendRealtime(id, normalizeLocalMessage(message, id));
  }, [sessionStore]);
  const clearMessages = useCallback(() => {
    if (activeSessionRef.current) sessionStore.clearRealtime(activeSessionRef.current);
  }, [sessionStore]);
  const rewindMessages = useCallback((count: number) => setViewHiddenCount(count), []);
  const followScrollEnabled = !isLoadingMoreMessages && !isLoadingAllMessages && !searchInProgressRef.current;
  const {
    isFollowing,
    setFollowing,
    scrollToBottom,
  } = useChatFollowScroll({ scrollContainerRef, enabled: followScrollEnabled });
  const isUserScrolledUp = !isFollowing;
  const setIsUserScrolledUp = useCallback<Dispatch<SetStateAction<boolean>>>((value) => {
    setFollowing(previous => {
      const scrolledUp = typeof value === 'function' ? value(!previous) : value;
      return !scrolledUp;
    });
  }, [setFollowing]);
  const isNearBottom = useCallback(() => {
    const node = scrollContainerRef.current;
    return Boolean(node && node.scrollHeight - node.scrollTop - node.clientHeight < 50);
  }, []);
  const scrollToBottomAndReset = useCallback(() => {
    scrollToBottom();
    setHasNewMessagesBelow(false);
    if (allMessagesLoaded) {
      loadedAllRef.current = false;
      setAllMessagesLoaded(false);
      setVisibleMessageCount(FIRST_VISIBLE_COUNT);
    }
  }, [allMessagesLoaded, scrollToBottom]);

  const loadOlderMessages = useCallback(async () => {
    if (loadingMoreRef.current || historyLoadErrorRef.current || isLoadingMoreMessages || loadedAllRef.current || !hasMoreMessages || !selectedSession || !selectedProject) return false;
    const requestId = selectedSession.id;
    loadingMoreRef.current = true;
    setIsLoadingMoreMessages(true);
    const requestView = requestViewRef.current;
    setFollowing(false);
    try {
      const page = await sessionStore.fetchMore(requestId, { limit: PAGE_SIZE, includeImages: showImagePreviews });
      if (requestViewRef.current !== requestView) return false;
      // A superseded or no-op page is not a failure; a reconcile after a live
      // turn may discard an in-flight page and the next scroll asks again.
      if (!page) return false;
      if (page.failed || (page.addedCount === 0 && page.hasMore)) {
        // Never spin at one offset or pretend unreachable history is complete.
        historyLoadErrorRef.current = true;
        setHistoryLoadError(true);
        return false;
      }
      setHasMoreMessages(page.hasMore);
      setTotalMessages(page.total);
      if (page.addedCount > 0) setVisibleMessageCount(value => value + page.addedCount);
      if (!page.hasMore) {
        loadedAllRef.current = true;
        setAllMessagesLoaded(true);
        setShowLoadAllOverlay(false);
      }
      return page.addedCount > 0;
    } finally {
      if (requestViewRef.current === requestView) {
        loadingMoreRef.current = false;
        setIsLoadingMoreMessages(false);
      }
    }
  }, [hasMoreMessages, isLoadingMoreMessages, selectedProject, selectedSession, sessionStore, setFollowing, showImagePreviews]);

  const retryOlderMessages = useCallback(() => {
    historyLoadErrorRef.current = false;
    setHistoryLoadError(false);
    void loadOlderMessages();
  }, [loadOlderMessages]);

  const handleScroll = useCallback(async () => {
    const node = scrollContainerRef.current;
    if (!node) return;
    const bottom = isNearBottom();
    if (!bottom) initialScrollRef.current = false;
    if (bottom) setHasNewMessagesBelow(false);
    // The in-flight request guard is enough. Requiring a trip away from the
    // top after every page forces a second gesture before history can continue.
    if (node.scrollTop >= 100) return;
    if (chatMessages.length > visibleMessageCount) {
      setFollowing(false);
      setVisibleMessageCount(count => count + 100);
      return;
    }
    await loadOlderMessages();
  }, [chatMessages.length, isNearBottom, loadOlderMessages, setFollowing, visibleMessageCount]);

  useEffect(() => {
    if (!searchInProgressRef.current) {
      initialScrollRef.current = true;
      setVisibleMessageCount(FIRST_VISIBLE_COUNT);
    }
    setIsUserScrolledUp(false);
  }, [selectedProject?.projectId, selectedSession?.id, setIsUserScrolledUp]);

  useEffect(() => {
    if (!isFollowing) {
      initialScrollRef.current = false;
      return;
    }
    if (!initialScrollRef.current || isLoadingSessionMessages || !scrollContainerRef.current) return;
    if (!chatMessages.length || searchInProgressRef.current) {
      initialScrollRef.current = false;
      return;
    }
    const node = scrollContainerRef.current;
    let frames = 0;
    let unchanged = 0;
    let height = 0;
    let frameId = 0;
    const settle = () => {
      if (!initialScrollRef.current || !scrollContainerRef.current) return;
      node.scrollTop = node.scrollHeight;
      if (node.scrollHeight === height) unchanged += 1;
      else {
        height = node.scrollHeight;
        unchanged = 0;
      }
      frames += 1;
      if (unchanged < 3 && frames < 60) frameId = requestAnimationFrame(settle);
      else initialScrollRef.current = false;
    };
    frameId = requestAnimationFrame(settle);
    return () => cancelAnimationFrame(frameId);
  }, [chatMessages.length, isFollowing, isLoadingSessionMessages]);

  useEffect(() => {
    if (!selectedProject || !selectedSession) {
      if (currentSessionId && activityMapRef.current?.has(currentSessionId)) return;
      resetStreamingState();
      setCurrentSessionId(null);
      setTokenBudget(null);
      setSessionState(null);
      resetPagination(true);
      setIsLoadingSessionMessages(false);
      loadedKeyRef.current = null;
      imageStateRef.current = { sessionKey: null, enabled: showImagePreviews };
      return;
    }
    const sessionId = selectedSession.id;
    const key = `${sessionId}:${selectedProject.projectId}`;
    const oldImageState = imageStateRef.current;
    const refreshImages = shouldRefreshCachedImageWindow(oldImageState.sessionKey, oldImageState.enabled, key, showImagePreviews, sessionStore.has(sessionId));
    imageStateRef.current = { sessionKey: key, enabled: showImagePreviews };
    const subscribe = () => {
      if (!ws) return;
      statusCheckSentAtRef.current.set(sessionId, Date.now());
      sendMessage({ type: 'chat.subscribe', sessions: [{ sessionId, ...sessionStore.getReplayCursor(sessionId) }] });
    };
    if (loadedKeyRef.current === key && sessionStore.has(sessionId) && !sessionStore.isStale(sessionId)) {
      subscribe();
      if (refreshImages) void sessionStore.refreshFromServer(sessionId, { includeImages: true });
      return;
    }
    const changed = currentSessionId !== null && currentSessionId !== sessionId;
    if (changed) resetStreamingState();
    resetPagination(true);
    setViewHiddenCount(0);
    if (changed) {
      searchInProgressRef.current = false;
      setSearchTarget(null);
    }
    if (changed) {
      setTokenBudget(null);
      setSessionState(null);
    }
    setCurrentSessionId(sessionId);
    subscribe();
    loadedKeyRef.current = key;
    setIsLoadingSessionMessages(true);
    const requestView = requestViewRef.current;
    sessionStore.fetchFromServer(sessionId, { limit: PAGE_SIZE, offset: 0, includeImages: showImagePreviews })
      .then(window => {
        if (requestViewRef.current !== requestView) return;
        if (window) {
          setHasMoreMessages(window.hasMore);
          setTotalMessages(window.total);
          if (window.tokenUsage) setTokenBudget(window.tokenUsage as Record<string, unknown>);
        }
        setIsLoadingSessionMessages(false);
      })
      .catch(() => {
        if (requestViewRef.current === requestView) setIsLoadingSessionMessages(false);
      });
  }, [currentSessionId, resetPagination, resetStreamingState, selectedProject, selectedSession, sendMessage, sessionStore, showImagePreviews, statusCheckSentAtRef, ws]);

  useEffect(() => {
    const session = selectedSession as (ProjectSession & { __searchTargetSnippet?: unknown; __searchTargetTimestamp?: unknown }) | null;
    if (typeof session?.__searchTargetSnippet !== 'string' || !session.__searchTargetSnippet) return;
    searchInProgressRef.current = true;
    setSearchTarget({ snippet: session.__searchTargetSnippet, timestamp: typeof session.__searchTargetTimestamp === 'string' ? session.__searchTargetTimestamp : undefined });
  }, [selectedSession]);

  useEffect(() => {
    if (!searchTarget || !chatMessages.length || isLoadingSessionMessages) return;
    const request = searchTarget;
    const requestView = requestViewRef.current;
    setSearchTarget(null);
    const findElement = (node: HTMLDivElement): Element | null => {
      if (request.snippet) {
        const phrase = request.snippet.replace(/^\.{3}/, '').replace(/\.{3}$/, '').trim().slice(0, 80).toLowerCase();
        if (phrase.length >= 10) {
          for (const element of node.querySelectorAll('.chat-message')) {
            if ((element.textContent || '').toLowerCase().includes(phrase)) return element;
          }
        }
      }
      if (!request.timestamp) return null;
      const targetTime = new Date(request.timestamp).getTime();
      let match: Element | null = null;
      let distance = Infinity;
      for (const element of node.querySelectorAll('[data-message-timestamp]')) {
        const value = element.getAttribute('data-message-timestamp');
        if (!value) continue;
        const candidate = Math.abs(new Date(value).getTime() - targetTime);
        if (candidate < distance) {
          distance = candidate;
          match = element;
        }
      }
      return match;
    };
    const navigate = async () => {
      if (!loadedAllRef.current && selectedSession && selectedProject) {
        try {
          const window = await sessionStore.fetchFromServer(selectedSession.id, { limit: null, offset: 0, includeImages: showImagePreviews });
          if (requestViewRef.current !== requestView) return;
          if (window) {
            setHasMoreMessages(false);
            setTotalMessages(window.total);
            ignoredOffsetRef.current = window.total;
            setVisibleMessageCount(Infinity);
            setAllMessagesLoaded(true);
            loadedAllRef.current = true;
            await new Promise(resolve => setTimeout(resolve, 300));
          }
        } catch {
          // The currently rendered message window remains searchable.
        }
      }
      if (requestViewRef.current !== requestView) return;
      setVisibleMessageCount(Infinity);
      const attempt = (remaining: number) => {
        if (requestViewRef.current !== requestView) return;
        const node = scrollContainerRef.current;
        if (!node) return;
        const element = findElement(node);
        if (element) {
          element.scrollIntoView({ block: 'center', behavior: 'smooth' });
          element.classList.add('search-highlight-flash');
          setTimeout(() => element.classList.remove('search-highlight-flash'), 4000);
          searchInProgressRef.current = false;
        } else if (remaining) {
          setTimeout(() => attempt(remaining - 1), 200);
        } else searchInProgressRef.current = false;
      };
      setTimeout(() => attempt(15), 150);
    };
    void navigate();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMessages.length, isLoadingSessionMessages, searchTarget]);

  useEffect(() => {
    if (!selectedProject || !selectedSession?.id) {
      setTokenBudget(null);
      setSessionState(null);
      return;
    }
    let cancelled = false;
    const loadUsage = async () => {
      try {
        const response = await authenticatedFetch(`/api/projects/${selectedProject.projectId}/sessions/${selectedSession.id}/token-usage`);
        if (response.ok) {
          const budget = await response.json();
          if (!cancelled) setTokenBudget(budget);
        }
        else {
          if (cancelled) return;
          setTokenBudget(null);
          setSessionState(null);
        }
      } catch (error) {
        console.error('Failed to fetch initial token usage:', error);
      }
    };
    void loadUsage();
    return () => { cancelled = true; };
  }, [selectedProject, selectedSession?.id]);

  const visibleMessages = useMemo(() => chatMessages.length <= visibleMessageCount ? chatMessages : chatMessages.slice(-visibleMessageCount), [chatMessages, visibleMessageCount]);

  useEffect(() => {
    const before = priorContentRef.current;
    priorContentRef.current = { sessionId: activeSession, messages: chatMessages };
    if (before.sessionId !== activeSession) {
      setHasNewMessagesBelow(false);
      return;
    }
    if (isLoadingSessionMessages || searchInProgressRef.current || isFollowing) return;
    // Loading flags cannot identify insertion direction: pagination and realtime
    // updates may commit together, or a genuine arrival may happen mid-request.
    if (hasNewTailContent(before.messages, chatMessages)) setHasNewMessagesBelow(true);
  }, [activeSession, chatMessages, isFollowing, isLoadingSessionMessages]);
  useEffect(() => {
    const node = scrollContainerRef.current;
    if (!node) return;
    node.addEventListener('scroll', handleScroll);
    return () => node.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  const loadAllMessages = useCallback(async () => {
    if (!selectedProject || !selectedSession || isLoadingAllMessages) return;
    const requestId = selectedSession.id;
    const requestView = requestViewRef.current;
    loadedAllRef.current = true;
    loadingMoreRef.current = true;
    setIsLoadingAllMessages(true);
    setShowLoadAllOverlay(true);
    setFollowing(false);
    try {
      const window = await sessionStore.fetchFromServer(requestId, { limit: null, offset: 0, includeImages: showImagePreviews });
      if (requestViewRef.current !== requestView) return;
      if (!window) {
        // Too large to serve at once, or otherwise refused: say so and offer
        // the paged path instead of quietly dropping the request.
        loadedAllRef.current = false;
        setShowLoadAllOverlay(false);
        historyLoadErrorRef.current = true;
        setHistoryLoadError(true);
        return;
      }
      setHasMoreMessages(false);
      setTotalMessages(window.total);
      ignoredOffsetRef.current = window.total;
      setVisibleMessageCount(Infinity);
      setAllMessagesLoaded(true);
      setLoadAllJustFinished(true);
      clearTimer(finishedTimerRef);
      finishedTimerRef.current = setTimeout(() => {
        setLoadAllJustFinished(false);
        setShowLoadAllOverlay(false);
        finishedTimerRef.current = null;
      }, 2500);
    } catch (error) {
      if (requestViewRef.current !== requestView) return;
      console.error('Error loading all messages:', error);
      loadedAllRef.current = false;
      setShowLoadAllOverlay(false);
      historyLoadErrorRef.current = true;
      setHistoryLoadError(true);
    } finally {
      if (requestViewRef.current === requestView) {
        loadingMoreRef.current = false;
        setIsLoadingAllMessages(false);
      }
    }
  }, [isLoadingAllMessages, selectedProject, selectedSession, sessionStore, setFollowing, showImagePreviews]);
  // Reveals rows already loaded first; once the loaded window is fully shown,
  // the same control pages further back so every history state has a click path.
  const loadEarlierMessages = useCallback(() => {
    if (visibleMessageCount < chatMessages.length) {
      setVisibleMessageCount(count => count + 100);
      return;
    }
    void loadOlderMessages();
  }, [chatMessages.length, loadOlderMessages, visibleMessageCount]);

  return {
    chatMessages,
    addMessage,
    clearMessages,
    rewindMessages,
    sessionActivity,
    isProcessing,
    canAbortSession,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    isLoadingMoreMessages,
    historyLoadError,
    retryOlderMessages,
    hasMoreMessages,
    totalMessages,
    isUserScrolledUp,
    hasNewMessagesBelow,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    sessionState,
    setSessionState,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    loadAllMessages,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    isNearBottom,
    handleScroll,
  };
}
