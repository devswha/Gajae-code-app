import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter as Router, Navigate, Route, Routes } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';

import { ThemeProvider } from './contexts/ThemeContext';
import { AuthProvider, ProtectedRoute } from './components/auth';
import { WebSocketProvider } from './contexts/WebSocketContext';
import AppContent from './components/app/AppContent';
import DesktopDeepLinkBridge from './components/app/DesktopDeepLinkBridge';
import { appShellRoutePaths, rootFallbackRoutePath } from './components/app/appRoutes';
import i18n from './i18n/config.js';
import { useComposerFreezeBridge } from './shared/composerFreezeBridge';


const DEPLOYMENT_ASSET_DIRECTORIES = new Set(['assets', 'static', 'icons', 'images']);
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

type AssetHint = { kind: 'manifest' | 'script' | 'icon'; value: string };

const stripAssetDirectories = (prefix: string) => {
  const parts = prefix.split('/').filter(Boolean);
  while (DEPLOYMENT_ASSET_DIRECTORIES.has(parts[parts.length - 1] ?? '')) parts.pop();
  return parts.length ? `/${parts.join('/')}` : '';
};

const pathPrefixFromHint = ({ kind, value }: AssetHint) => {
  const url = new URL(value, document.baseURI || window.location.href);
  if (url.origin !== window.location.origin) return '';

  const pathname = url.pathname.replace(/\/+$/, '');
  if (kind === 'script') return pathname.match(/^(.*)\/assets\//)?.[1]?.replace(/\/+$/, '') ?? '';

  const filenamePattern = kind === 'manifest'
    ? /^(.*)\/(?:manifest\.json|site\.webmanifest)$/
    : /^(.*)\/(?:favicon(?:\.[^/]+)?|apple-touch-icon(?:-[^/]+)?(?:\.[^/]+)?|mask-icon(?:\.[^/]+)?|[^/]*icon[^/]*)$/;
  const prefix = pathname.match(filenamePattern)?.[1];
  return prefix ? stripAssetDirectories(prefix) : '';
};

function deriveRouterBasename() {
  const configured = typeof window === 'undefined' ? '' : window.__ROUTER_BASENAME__ || '';
  if (configured) return configured.replace(/\/+$/, '');
  if (typeof window === 'undefined' || typeof document === 'undefined') return '';

  const singleHints: Array<{ kind: AssetHint['kind']; value: string | null | undefined }> = [
    { kind: 'manifest', value: document.querySelector('link[rel="manifest"]')?.getAttribute('href') },
    { kind: 'script', value: document.querySelector('script[type="module"][src]')?.getAttribute('src') },
  ];
  const iconHints = Array.from(document.querySelectorAll(
    'link[rel~="icon"][href], link[rel="apple-touch-icon"][href], link[rel="apple-touch-icon-precomposed"][href], link[rel="mask-icon"][href]'
  )).map((element) => ({ kind: 'icon' as const, value: element.getAttribute('href') }));
  const hints = [...singleHints, ...iconHints].filter((hint): hint is AssetHint => Boolean(hint.value));

  return hints.reduce((longest, hint) => {
    try {
      const candidate = pathPrefixFromHint(hint);
      return candidate.length > longest.length ? candidate : longest;
    } catch {
      return longest;
    }
  }, '');
}

type ApplicationLayoutProps = {
  routerBasename: string;
};

function ApplicationRoutes({ routerBasename }: ApplicationLayoutProps) {
  return <Router basename={routerBasename}>
    <DesktopDeepLinkBridge />
    <Routes>
      {appShellRoutePaths.map((path) => (
        <Route key={path} path={path} element={<AppContent />} />
      ))}
      <Route path={rootFallbackRoutePath} element={<Navigate to="/" replace />} />
    </Routes>
  </Router>;
}

function ApplicationLayout({ routerBasename }: ApplicationLayoutProps) {
  // Providers are intentionally ordered from environment-wide concerns toward
  // the authenticated live connection. Route components may rely on each.
  return (
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <WebSocketProvider>
              <ProtectedRoute>
                <ApplicationRoutes routerBasename={routerBasename} />
              </ProtectedRoute>
            </WebSocketProvider>
          </AuthProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </I18nextProvider>
  );
}

export default function App() {
  useComposerFreezeBridge();
  return <ApplicationLayout routerBasename={deriveRouterBasename()} />;
}
