import type { IncomingMessage } from 'node:http';

import type WebSocket from 'ws';

import { isBrowserSessionState } from '../../../shared/browserSessionState.js';

import { safeSessionId } from './browser-protocol.js';
import { automationService } from './automation.service.js';

const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

type BrowserStreamingService = Pick<typeof automationService, 'subscribeBrowser'> & {
  browser: Pick<typeof automationService.browser, 'cachedState' | 'subscribeFrames' | 'unsubscribeFrames'>;
};

function binaryFrame(header: Record<string, unknown>, data: string): Buffer {
  const headerBytes = Buffer.from(JSON.stringify(header));
  const imageBytes = Buffer.from(data, 'base64');
  const packet = Buffer.allocUnsafe(4 + headerBytes.length + imageBytes.length);
  packet.writeUInt32BE(headerBytes.length, 0);
  headerBytes.copy(packet, 4);
  imageBytes.copy(packet, 4 + headerBytes.length);
  return packet;
}
export function handleBrowserConnection(
  ws: WebSocket,
  request: IncomingMessage,
  service: BrowserStreamingService = automationService,
): void {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const sessionId = url.searchParams.get('sessionId');
  if (!safeSessionId(sessionId)) {
    ws.close(1008, 'Invalid browser session.');
    return;
  }

  const stateOnly = url.searchParams.get('mode') === 'state';
  let streamSubscribed = false;
  let closed = false;
  const subscribeFrames = () => {
    if (closed || streamSubscribed) return;
    streamSubscribed = true;
    void service.browser.subscribeFrames(sessionId)
      .then((state) => {
        // A static page may not emit another state event after this websocket
        // attaches. Send the subscription snapshot so a remounted panel gets
        // its tab strip even when nothing in the page changes.
        if (!closed && ws.readyState === ws.OPEN && state && typeof state === 'object') {
          ws.send(JSON.stringify({ type: 'state', sessionId, payload: state }));
        }
      })
      .catch((error) => {
        streamSubscribed = false;
        if (!closed && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : 'Browser stream failed.' }));
      });
  };

  const unsubscribe = service.subscribeBrowser((event) => {
    if (closed || event.sessionId !== sessionId || ws.readyState !== ws.OPEN) return;
    if (stateOnly) {
      if (event.method === 'state' && isBrowserSessionState(event.payload, sessionId)) {
        ws.send(JSON.stringify({ type: 'state', sessionId, payload: event.payload }));
      }
      return;
    }
    if (event.method === 'frame') {
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES || typeof event.payload.data !== 'string') return;
      const { data, ...metadata } = event.payload;
      ws.send(binaryFrame({ type: 'frame', sessionId, ...metadata }, data), { binary: true });
      return;
    }
    if (event.method === 'state') {
      const activeTabId = typeof event.payload.activeTabId === 'string' ? event.payload.activeTabId : '';
      const tabs = Array.isArray(event.payload.tabs) ? event.payload.tabs : [];
      if (!activeTabId || !tabs.some((tab) => tab && typeof tab === 'object' && (tab as { id?: unknown }).id === activeTabId)) {
        // DELETE removes the sidecar session but intentionally leaves this UI
        // websocket connected. Mark the stream detached so a later agent-open
        // can subscribe the newly created sidecar session on the same socket.
        streamSubscribed = false;
      } else if (!streamSubscribed) {
        subscribeFrames();
      }
    }
    ws.send(JSON.stringify({ type: event.method, sessionId, payload: event.payload }));
  });

  const close = () => {
    if (closed) return;
    closed = true;
    streamSubscribed = false;
    unsubscribe();
    if (!stateOnly) void service.browser.unsubscribeFrames(sessionId).catch(() => {});
  };
  ws.once('close', close);
  ws.once('error', close);

  if (stateOnly) {
    // Watching for agent-open events must not create a browser session or alter
    // the screencast subscription owned by an actual preview socket.
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'state', sessionId, payload: service.browser.cachedState(sessionId) }));
    }
  } else {
    subscribeFrames();
  }
}
