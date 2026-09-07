import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, PointerEvent, WheelEvent } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Download,
  ExternalLink,
  LoaderCircle,
  MonitorDown,
  Plus,
  RefreshCw,
  RotateCcw,
  Square,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  browserFramePoint,
  DEFAULT_BROWSER_VIEWPORT,
  normalizeBrowserViewport,
  type BrowserViewportSize,
} from '../../../../shared/browserViewport';
import { openBrowserUrl } from '../../../utils/externalLink';
import { isBrowserSessionState, type BrowserSessionState as BrowserState } from '../../../../shared/browserSessionState';
import { browserSocketUrl } from '../browserSocketUrl';

type AutomationStatus = {
  supported: boolean;
  browser: { state: 'idle' | 'starting' | 'ready' | 'error'; installed: boolean; buildId: string; error?: string };
  cua: { installed: boolean; version?: string; daemon: string; accessibility?: boolean; screenRecording?: boolean };
};

type BrowserPanelProps = {
  sessionId: string;
  navigationRequest?: { id: number; url: string } | null;
  onNavigationHandled?: () => void;
};

const COMMON_LOCAL_URLS = ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:4173', 'http://localhost:8000'];

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}

export default function BrowserPanel(props: BrowserPanelProps) {
  // Keep HTTP continuations, frames and in-flight controls scoped to the
  // session that created them, including when the viewer returns to an old id.
  return <BrowserSession key={props.sessionId} {...props} />;
}

function BrowserSession({ sessionId, navigationRequest, onNavigationHandled }: BrowserPanelProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<AutomationStatus | null>(null);
  const [state, setState] = useState<BrowserState | null>(null);
  const [address, setAddress] = useState('http://localhost:5173');
  const [frame, setFrame] = useState<{ url: string; viewport: BrowserViewportSize; tabId?: string } | null>(null);
  const frameUrl = frame && (!frame.tabId || !state?.activeTabId || frame.tabId === state.activeTabId) ? frame.url : null;
  const [connection, setConnection] = useState<'connecting' | 'live' | 'offline'>('offline');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [localUrls, setLocalUrls] = useState(COMMON_LOCAL_URLS);
  const frameObjectUrlRef = useRef<string | null>(null);
  const frameRef = useRef<HTMLImageElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const frameViewportRef = useRef<BrowserViewportSize>(DEFAULT_BROWSER_VIEWPORT);
  const sentViewportRef = useRef<BrowserViewportSize | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const pointerFrameRef = useRef<number | null>(null);
  const acceptFramesRef = useRef(false);
  const handledNavigationRef = useRef<number | null>(null);

  const releaseFrameUrl = useCallback(() => {
    const previous = frameObjectUrlRef.current;
    frameObjectUrlRef.current = null;
    if (previous) URL.revokeObjectURL(previous);
  }, []);
  const replaceFrameUrl = useCallback((next: string | null, viewport = DEFAULT_BROWSER_VIEWPORT, tabId?: string) => {
    releaseFrameUrl();
    frameObjectUrlRef.current = next;
    setFrame(next ? { url: next, viewport, tabId } : null);
  }, [releaseFrameUrl]);

  const activeTab = useMemo(
    () => state?.tabs.find((tab) => tab.id === state.activeTabId) ?? null,
    [state],
  );

  const openInBrowser = async () => {
    if (activeTab && !await openBrowserUrl(activeTab.url)) setError(t('workspace.browser.error'));
  };

  useEffect(() => {
    if (activeTab?.url && activeTab.url !== 'about:blank') setAddress(activeTab.url);
  }, [activeTab?.url]);

  const loadStatus = useCallback(async () => {
    try {
      const next = await jsonRequest<AutomationStatus>('/api/automation/status');
      setStatus(next);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t('workspace.browser.error'));
    }
  }, [t]);

  useEffect(() => {
    void loadStatus();
    void jsonRequest<{ urls: string[] }>('/api/automation/local-sites')
      .then((result) => {
        if (result.urls.length > 0) setLocalUrls(result.urls);
      })
      .catch(() => {});
  }, [loadStatus]);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    // The sidecar can emit the first frame before its subscribe response/state
    // snapshot reaches React. The websocket is already session-scoped, so
    // accept that initial frame and let an explicit empty state disable frames.
    acceptFramesRef.current = true;
    replaceFrameUrl(null);
    setState(null);
    setError(null);
    setDownloadProgress(null);
    const connect = () => {
      if (disposed) return;
      let websocket: WebSocket;
      try {
        websocket = new WebSocket(browserSocketUrl(sessionId));
      } catch {
        setConnection('offline');
        reconnectTimer = setTimeout(connect, 1_000);
        return;
      }
      websocket.binaryType = 'arraybuffer';
      socketRef.current = websocket;
      setConnection('connecting');
      websocket.onopen = () => !disposed && socketRef.current === websocket && setConnection('live');
      websocket.onclose = () => {
        if (disposed || socketRef.current !== websocket) return;
        socketRef.current = null;
        setConnection('offline');
        reconnectTimer = setTimeout(connect, 1_000);
      };
      websocket.onerror = () => !disposed && setConnection('offline');
      websocket.onmessage = (event) => {
        if (disposed || socketRef.current !== websocket) return;
        if (typeof event.data === 'string') {
          const message = JSON.parse(event.data) as { type: string; payload?: Record<string, unknown>; message?: string };
          if (message.type === 'state' && isBrowserSessionState(message.payload, sessionId)) {
            const nextState = message.payload;
            const hasActiveTab = Boolean(
              nextState.activeTabId
              && nextState.tabs.some((tab) => tab.id === nextState.activeTabId),
            );
            acceptFramesRef.current = hasActiveTab;
            setState(nextState);
            if (!hasActiveTab) {
              replaceFrameUrl(null);
            }
          }
          if (message.type === 'error') {
            setError(
              typeof message.payload?.message === 'string'
                ? message.payload.message
                : message.message ?? t('workspace.browser.error'),
            );
          }
          if (message.type === 'download.progress' && message.payload) {
            const downloaded = Number(message.payload.downloadedBytes ?? 0);
            const total = Number(message.payload.totalBytes ?? 0);
            setDownloadProgress(total > 0 ? Math.round((downloaded / total) * 100) : null);
          }
          if (message.type === 'async' && message.payload?.type === 'download.attempt') {
            setError(t('workspace.browser.downloadBlocked', {
              filename: typeof message.payload.suggestedFilename === 'string'
                ? message.payload.suggestedFilename
                : t('workspace.browser.downloadUnknown'),
            }));
          }
          if (message.type === 'async' && message.payload?.type === 'dialog') {
            setError(t('workspace.browser.dialogDismissed', {
              message: typeof message.payload.message === 'string' ? message.payload.message : '',
            }));
          }
          if (message.type === 'async' && message.payload?.type === 'sidecar.recovered') setError(null);
          return;
        }
        if (!acceptFramesRef.current) return;
        const packet = event.data as ArrayBuffer;
        const view = new DataView(packet);
        if (view.byteLength < 4) return;
        const headerLength = view.getUint32(0);
        if (headerLength <= 0 || headerLength + 4 > view.byteLength) return;
        const header = JSON.parse(new TextDecoder().decode(packet.slice(4, 4 + headerLength))) as {
          type?: string;
          sessionId?: string;
          tabId?: string;
          mimeType?: string;
          metadata?: { deviceWidth?: unknown; deviceHeight?: unknown };
        };
        if (header.type !== 'frame' || header.sessionId !== sessionId) return;
        const frameViewport = normalizeBrowserViewport(
          header.metadata?.deviceWidth,
          header.metadata?.deviceHeight,
        );
        const nextUrl = URL.createObjectURL(new Blob([packet.slice(4 + headerLength)], { type: header.mimeType ?? 'image/jpeg' }));
        replaceFrameUrl(nextUrl, frameViewport ?? DEFAULT_BROWSER_VIEWPORT, header.tabId);
      };
    };
    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      acceptFramesRef.current = false;
      socketRef.current?.close();
      socketRef.current = null;
      if (pointerFrameRef.current !== null) cancelAnimationFrame(pointerFrameRef.current);
      pointerFrameRef.current = null;
      // A keyed unmount cannot rely on React executing another state updater.
      releaseFrameUrl();
    };
  }, [releaseFrameUrl, replaceFrameUrl, sessionId, t]);

  const open = useCallback(async (url: string, allowDownload = false) => {
    setBusy(true);
    setError(null);
    try {
      const next = await jsonRequest<BrowserState>(`/api/browser/${encodeURIComponent(sessionId)}/open`, {
        method: 'POST',
        body: JSON.stringify({ url, allowDownload }),
      });
      acceptFramesRef.current = Boolean(next.activeTabId && next.tabs.some((tab) => tab.id === next.activeTabId));
      setState(next);
      await loadStatus();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t('workspace.browser.error'));
    } finally {
      setBusy(false);
      setDownloadProgress(null);
    }
  }, [loadStatus, sessionId, t]);

  useEffect(() => {
    if (!navigationRequest || handledNavigationRef.current === navigationRequest.id) return;
    setAddress(navigationRequest.url);
    if (!status) return;
    handledNavigationRef.current = navigationRequest.id;
    onNavigationHandled?.();
    if (status.supported && status.browser.installed) void open(navigationRequest.url, false);
  }, [navigationRequest, onNavigationHandled, open, status]);

  const command = useCallback(async (commandValue: Record<string, unknown>) => {
    setError(null);
    try {
      const next = await jsonRequest<BrowserState>(`/api/browser/${encodeURIComponent(sessionId)}/command`, {
        method: 'POST',
        body: JSON.stringify({ command: commandValue }),
      });
      if (next?.tabs) setState(next);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t('workspace.browser.error'));
    }
  }, [sessionId, t]);

  const sendInput = useCallback((input: Record<string, unknown>) => {
    void jsonRequest(`/api/browser/${encodeURIComponent(sessionId)}/input`, {
      method: 'POST',
      body: JSON.stringify({ input }),
    }).catch((nextError) => setError(nextError instanceof Error ? nextError.message : t('workspace.browser.error')));
  }, [sessionId, t]);

  const activeTabId = activeTab?.id ?? null;
  const previewReady = Boolean(status?.supported && (status.browser.installed || state));
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || !activeTabId) return undefined;
    sentViewportRef.current = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const syncViewport = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const bounds = surface.getBoundingClientRect();
        const viewport = normalizeBrowserViewport(bounds.width, bounds.height);
        const previous = sentViewportRef.current;
        if (!viewport || (previous?.width === viewport.width && previous.height === viewport.height)) return;
        sentViewportRef.current = viewport;
        sendInput({ kind: 'viewport', ...viewport });
      }, 80);
    };
    syncViewport();
    const observer = new ResizeObserver(syncViewport);
    observer.observe(surface);
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [activeTabId, connection, previewReady, sendInput]);

  const framePoint = useCallback((event: PointerEvent<HTMLImageElement> | WheelEvent<HTMLImageElement>) => {
    const image = frameRef.current;
    if (!image) return null;
    const bounds = image.getBoundingClientRect();
    return browserFramePoint({
      clientX: event.clientX,
      clientY: event.clientY,
      boundsLeft: bounds.left,
      boundsTop: bounds.top,
      boundsWidth: bounds.width,
      boundsHeight: bounds.height,
      frameWidth: image.naturalWidth,
      frameHeight: image.naturalHeight,
      viewportWidth: frameViewportRef.current.width,
      viewportHeight: frameViewportRef.current.height,
    });
  }, []);

  const navigate = (event: FormEvent) => {
    event.preventDefault();
    if (activeTab) void command({ action: 'navigate', url: address });
    else void open(address, false);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.key.length !== 1) {
      event.preventDefault();
      sendInput({ kind: 'key', event: 'down', key: event.key, code: event.code, modifiers: (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0) });
      return;
    }
    event.preventDefault();
    sendInput({ kind: 'text', text: event.key });
  };

  const handleKeyUp = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.length === 1) return;
    event.preventDefault();
    sendInput({
      kind: 'key',
      event: 'up',
      key: event.key,
      code: event.code,
      modifiers: (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0),
    });
  };

  const stop = async () => {
    setBusy(true);
    acceptFramesRef.current = false;
    replaceFrameUrl(null);
    try {
      await jsonRequest(`/api/browser/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
      setState(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t('workspace.browser.error'));
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    if (error) return (
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm">
        <p className="text-destructive">{error}</p>
        <button type="button" onClick={() => void loadStatus()} className="rounded-md border border-border px-3 py-2 text-foreground hover:bg-muted">
          {t('buttons.retry', { defaultValue: 'Retry' })}
        </button>
      </div>
    );
    return (
      <div className="flex h-full items-center justify-center gap-2 p-6 text-sm text-muted-foreground" role="status">
        <LoaderCircle className="h-4 w-4 animate-spin" />
        {t('workspace.browser.connecting')}
      </div>
    );
  }

  if (!status.supported) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {t('workspace.browser.unsupported')}
      </div>
    );
  }

  if (!status.browser.installed && !state) {
    return (
      <div className="flex h-full items-center justify-center p-5">
        <div className="max-w-sm rounded-xl border border-border/70 bg-muted/20 p-5 text-center">
          <MonitorDown className="mx-auto h-8 w-8 text-muted-foreground" />
          <h3 className="mt-3 text-sm font-medium text-foreground">{t('workspace.browser.installTitle')}</h3>
          <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{t('workspace.browser.installDescription')}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void open(address, true)}
            className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {busy && downloadProgress === null
              ? t('workspace.browser.preparing')
              : downloadProgress === null
                ? t('workspace.browser.download')
                : t('workspace.browser.downloading', { progress: downloadProgress })}
          </button>
          {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-muted/10">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 p-1.5">
        <button type="button" disabled={!activeTab?.canGoBack} onClick={() => void command({ action: 'back' })} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted disabled:opacity-30" aria-label={t('workspace.browser.back')}><ArrowLeft className="h-3.5 w-3.5" /></button>
        <button type="button" disabled={!activeTab?.canGoForward} onClick={() => void command({ action: 'forward' })} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted disabled:opacity-30" aria-label={t('workspace.browser.forward')}><ArrowRight className="h-3.5 w-3.5" /></button>
        <button type="button" disabled={!state} onClick={() => void command({ action: 'reload' })} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted disabled:opacity-30" aria-label={t('workspace.browser.reload')}><RefreshCw className={`h-3.5 w-3.5 ${activeTab?.loading ? 'animate-spin' : ''}`} /></button>
        <form onSubmit={navigate} className="min-w-0 flex-1">
          <input value={address} onChange={(event) => setAddress(event.target.value)} aria-label={t('workspace.browser.address')} className="h-7 w-full rounded-md border border-border/70 bg-background px-2 text-xs text-foreground outline-hidden focus:border-primary" />
        </form>
        <span title={t(`workspace.browser.connection.${connection}`)} aria-label={t(`workspace.browser.connection.${connection}`)} className={`h-2 w-2 rounded-full ${connection === 'live' ? 'bg-primary' : connection === 'connecting' ? 'bg-foreground/50' : 'bg-muted-foreground/40'}`} />
        <button type="button" disabled={!activeTab} onClick={() => void openInBrowser()} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted disabled:opacity-30" aria-label={t('workspace.browser.external')}><ExternalLink className="h-3.5 w-3.5" /></button>
        <button type="button" disabled={!state || busy} onClick={() => void stop()} className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-30" aria-label={t('workspace.browser.stop')}><Square className="h-3.5 w-3.5" /></button>
      </div>

      {state && state.tabs.length > 0 && (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/60 px-1.5 py-1">
          {state.tabs.map((tab) => (
            <div key={tab.id} className={`flex max-w-48 min-w-0 items-center rounded ${tab.id === state.activeTabId ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50'}`}>
              <button type="button" onClick={() => void command({ action: 'selectTab', tabId: tab.id })} className="min-w-0 flex-1 truncate px-2 py-1 text-left text-[11px]">
                {tab.title || (tab.url === 'about:blank' ? t('workspace.browser.newTab') : new URL(tab.url).hostname)}
              </button>
              <button type="button" onClick={() => void command({ action: 'closeTab', tabId: tab.id })} className="mr-0.5 rounded p-0.5 hover:bg-background/70" aria-label={t('workspace.browser.closeTab')}>
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          <button type="button" onClick={() => void command({ action: 'newTab' })} className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={t('workspace.browser.newTab')}>
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div
        ref={surfaceRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden bg-background outline-hidden focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
      >
        {frameUrl ? (
          <img
            ref={frameRef}
            src={frameUrl}
            alt={t('workspace.browser.preview')}
            draggable={false}
            onLoad={() => {
              // Input follows the loaded image, not a requested resize whose
              // corresponding frame has not arrived yet.
              if (frame) frameViewportRef.current = frame.viewport;
            }}
            onPointerMove={(event) => {
              if (pointerFrameRef.current !== null) return;
              const { clientX, clientY } = event;
              pointerFrameRef.current = requestAnimationFrame(() => {
                pointerFrameRef.current = null;
                const image = frameRef.current;
                if (!image) return;
                const bounds = image.getBoundingClientRect();
                const point = browserFramePoint({
                  clientX,
                  clientY,
                  boundsLeft: bounds.left,
                  boundsTop: bounds.top,
                  boundsWidth: bounds.width,
                  boundsHeight: bounds.height,
                  frameWidth: image.naturalWidth,
                  frameHeight: image.naturalHeight,
                  viewportWidth: frameViewportRef.current.width,
                  viewportHeight: frameViewportRef.current.height,
                });
                if (!point) return;
                sendInput({
                  kind: 'mouse',
                  event: 'move',
                  ...point,
                });
              });
            }}
            onPointerDown={(event) => {
              surfaceRef.current?.focus();
              const point = framePoint(event);
              if (!point) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              sendInput({ kind: 'mouse', event: 'down', ...point, button: event.button === 2 ? 'right' : 'left' });
            }}
            onPointerUp={(event) => {
              const point = framePoint(event);
              if (point) sendInput({ kind: 'mouse', event: 'up', ...point, button: event.button === 2 ? 'right' : 'left' });
            }}
            onWheel={(event) => {
              const point = framePoint(event);
              if (!point) return;
              event.preventDefault();
              sendInput({ kind: 'wheel', ...point, deltaX: event.deltaX, deltaY: event.deltaY });
            }}
            onContextMenu={(event) => event.preventDefault()}
            className="absolute inset-0 block h-full w-full object-contain select-none"
          />
        ) : (
          <div className="m-auto p-6 text-center text-xs text-muted-foreground">
            <RotateCcw className="mx-auto mb-2 h-5 w-5" />
            <p>{t('workspace.browser.empty')}</p>
            <div className="mt-3 flex flex-wrap justify-center gap-1.5">
              {localUrls.map((url) => <button key={url} type="button" onClick={() => { setAddress(url); void open(url, false); }} className="rounded border border-border px-2 py-1 hover:bg-muted">{url.replace('http://', '')}</button>)}
            </div>
          </div>
        )}
      </div>
      {error && <div className="max-h-24 shrink-0 overflow-auto border-t border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-xs break-words text-destructive">{error}</div>}
      {status?.cua && (
        <div className="flex shrink-0 items-center justify-between border-t border-border/60 px-2.5 py-1 text-[10px] text-muted-foreground">
          <span>{t('workspace.browser.cua')}</span>
          <span>{status.cua.installed ? `${status.cua.version ?? 'Installed'} · ${status.cua.daemon}` : t('workspace.browser.cuaMissing')}</span>
        </div>
      )}
    </div>
  );
}
