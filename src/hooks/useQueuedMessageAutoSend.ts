import { useEffect, useRef } from 'react';

import { classifyCommandInput, isAutoSendable } from '../components/chat/commandDispatchPolicy';
import { readQueuedMessages, subscribeQueuedMessages, type StoredQueuedMessage, writeQueuedMessages } from '../components/chat/utils/chatStorage';

import type { MarkSessionProcessing, SessionActivityMap } from './useSessionProtection';

interface UseQueuedMessageAutoSendArgs {
  processingSessions: SessionActivityMap;
  activeSessionId: string | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => boolean | void;
  markSessionProcessing: MarkSessionProcessing;
}

export type QueuedDispatchDecision =
  | { action: 'send'; content: string; options: Record<string, unknown> }
  | { action: 'hold'; reason: 'no-draft' | 'socket-closed' | 'needs-session-ui' | 'awaiting-steer' };

const hold = (reason: Extract<QueuedDispatchDecision, { action: 'hold' }>['reason']): QueuedDispatchDecision => ({
  action: 'hold',
  reason,
});

export function decideQueuedDispatch(
  queued: StoredQueuedMessage | null | undefined,
  socketOpen: boolean,
): QueuedDispatchDecision {
  if (queued === null || queued === undefined) return hold('no-draft');
  if (!socketOpen) return hold('socket-closed');
  if (queued.pendingSteer) return hold('awaiting-steer');
  // This background path has no attachment upload/review surface. Text-only
  // durable queues retain their existing automatic dispatch behavior.
  if (queued.attachmentCount || queued.requiresReview) return hold('needs-session-ui');

  const command = classifyCommandInput(queued.content);
  if (!isAutoSendable(command)) return hold('needs-session-ui');

  return { action: 'send', content: queued.content, options: { ...queued.options } };
}

function completedSessionIds(
  previous: ReadonlySet<string>,
  active: ReadonlySet<string>,
  visibleSessionId: string | null,
): string[] {
  return [...previous].filter((sessionId) => !active.has(sessionId) && sessionId !== visibleSessionId);
}

export function useQueuedMessageAutoSend({
  processingSessions,
  activeSessionId,
  ws,
  sendMessage,
  markSessionProcessing,
}: UseQueuedMessageAutoSendArgs) {
  const knownProcessing = useRef<ReadonlySet<string>>(new Set());
  const waitingForConnection = useRef(new Set<string>());

  useEffect(() => {
    const active = new Set(processingSessions.keys());
    const completed = completedSessionIds(knownProcessing.current, active, activeSessionId);
    knownProcessing.current = active;
    completed.forEach((sessionId) => waitingForConnection.current.add(sessionId));
    const dispatchWaiting = () => {
      const socketOpen = ws !== null && ws.readyState === WebSocket.OPEN;
      for (const sessionId of waitingForConnection.current) {
        // The visible composer owns its queue, and a newly running session
        // must wait for that run to finish before it earns another dispatch.
        if (active.has(sessionId) || sessionId === activeSessionId) {
          waitingForConnection.current.delete(sessionId);
          continue;
        }
        const queued = readQueuedMessages(sessionId);
        const dispatch = decideQueuedDispatch(queued[0], socketOpen);
        if (dispatch.action === 'hold') {
          if (dispatch.reason !== 'socket-closed' && dispatch.reason !== 'awaiting-steer') waitingForConnection.current.delete(sessionId);
          continue;
        }
        const sent = sendMessage({
          type: 'chat.send',
          sessionId,
          content: dispatch.content,
          options: { ...dispatch.options, images: [] },
        });
        if (sent === false) continue;
        waitingForConnection.current.delete(sessionId);
        writeQueuedMessages(sessionId, queued.slice(1));
        markSessionProcessing(sessionId, { statusText: null, canInterrupt: true });
      }
    };
    dispatchWaiting();
    const unsubscribe = subscribeQueuedMessages((sessionId) => {
      if (waitingForConnection.current.has(sessionId)) dispatchWaiting();
    });
    ws?.addEventListener('open', dispatchWaiting);
    return () => {
      unsubscribe();
      ws?.removeEventListener('open', dispatchWaiting);
    };
  }, [activeSessionId, markSessionProcessing, processingSessions, sendMessage, ws]);
}
