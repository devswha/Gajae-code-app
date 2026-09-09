import { useEffect } from 'react';

import { isBrowserSessionState } from '../../../../shared/browserSessionState';
import { browserSocketUrl } from '../browserSocketUrl';
import type { WorkspaceTab } from '../workspacePanelState';

/** Watch metadata even when the panel is unmounted, without launching a browser. */
export function useBrowserAutoReveal(sessionId: string | undefined, openPanel: (tab: WorkspaceTab) => void) {
  useEffect(() => {
    if (!sessionId) return undefined;
    let disposed = false;
    let socket: WebSocket;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // Keep this across reconnects: title/loading updates must not undo a user's
    // close or switch away. A newly opened active tab is a new reveal request.
    let seenTabs = new Set<string>();
    const connect = () => {
      if (disposed) return;
      let current: WebSocket;
      try {
        current = new WebSocket(browserSocketUrl(sessionId, 'state'));
      } catch {
        retry = setTimeout(connect, 1_000);
        return;
      }
      socket = current;
      current.onmessage = (event) => {
        if (disposed || socket !== current || typeof event.data !== 'string') return;
        try {
          const message = JSON.parse(event.data) as { type?: unknown; sessionId?: unknown; payload?: unknown };
          if (message.type !== 'state' || message.sessionId !== sessionId
            || !isBrowserSessionState(message.payload) || message.payload.sessionId !== sessionId) return;
          const state = message.payload;
          const active = state.tabs.find((tab) => tab.id === state.activeTabId);
          const shouldReveal = active && !seenTabs.has(active.id);
          seenTabs = new Set(state.tabs.map((tab) => tab.id));
          if (shouldReveal) openPanel('browser');
        } catch {
          // Ignore malformed/foreign messages; they cannot open UI surfaces.
        }
      };
      current.onclose = () => {
        if (!disposed && socket === current) retry = setTimeout(connect, 1_000);
      };
    };
    connect();
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, [sessionId, openPanel]);
}
