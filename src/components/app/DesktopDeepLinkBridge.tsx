import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

import { routeExternalAnchors } from '../../utils/externalLink';

type TauriEventApi = {
  event?: {
    listen?: (
      name: string,
      handler: (event: { payload?: unknown }) => void,
    ) => Promise<() => void>;
  };
};

/**
 * Routes desktop deep links inside the packaged shell. The Rust side emits
 * `desktop://deep-link` with the raw `gajae-app://` URL after showing and
 * focusing the window; outside the desktop shell `window.__TAURI__` is absent
 * and this bridge renders nothing and subscribes to nothing.
 */
export function deepLinkPath(rawUrl: unknown): string | null {
  if (typeof rawUrl !== 'string') return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (rawUrl.length > 256 || url.protocol !== 'gajae-app:' || url.hostname !== 'open'
    || url.username || url.password || url.port || url.search || url.hash) return null;
  const segments = url.pathname.split('/');
  if (segments.length === 3 && segments[0] === '' && segments[1] === 'job' && /^[A-Za-z0-9._:-]{1,128}$/u.test(segments[2] ?? '')) {
    return '/';
  }
  return null;
}

export default function DesktopDeepLinkBridge() {
  const navigate = useNavigate();
  // Links that leave the app. The listener is installed unconditionally and
  // decides per click whether it is inside the desktop shell (known once the
  // auth bootstrap answers), so nothing depends on effect ordering.
  useEffect(() => routeExternalAnchors(document), []);
  useEffect(() => {
    const tauri = (window as { __TAURI__?: TauriEventApi }).__TAURI__;
    const listen = tauri?.event?.listen;
    if (!listen) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void listen('desktop://deep-link', (event) => {
      const path = deepLinkPath(event.payload);
      if (path) navigate(path);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [navigate]);
  return null;
}
