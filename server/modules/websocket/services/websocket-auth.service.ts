import type { VerifyClientCallbackSync } from 'ws';

import { hasValidApiKey } from '@/middleware/auth.js';
import { isAllowedRequestOrigin } from '@/shared/request-origin.js';
import type { DesktopWorkAdmission } from '@/shared/interfaces.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

import { parseAllowedHosts } from '../../../../shared/networkHosts.js';

type AuthenticatedOwner = Record<string, unknown> & {
  id?: number | string;
  userId?: number | string;
  username?: string;
};

type WebSocketAuthDependencies = Readonly<{
  authenticateWebSocket: () => AuthenticatedOwner | null;
  desktopAuth?: { authenticateWebSocket: (request: { headers: { origin?: string; cookie?: string } }) => boolean };
  /** Raw `ALLOWED_HOSTS`; defaults to the process environment. */
  allowedHosts?: string | undefined;
  desktopRestartAdmission?: DesktopWorkAdmission;
}>;

function acceptsOrigin(request: AuthenticatedWebSocketRequest, configuredHosts?: string): boolean {
  const allowedHosts = parseAllowedHosts(configuredHosts ?? process.env.ALLOWED_HOSTS);
  return isAllowedRequestOrigin(request.headers.origin, {
    hostHeader: request.headers.host,
    allowedHosts,
  });
}

function requestPath(request: AuthenticatedWebSocketRequest): string | null {
  const target = request.url ?? '/';
  // Upgrade requests use origin-form targets. Reject authority/absolute forms
  // before URL parsing, which can otherwise throw out of ws's verify callback.
  if (!target.startsWith('/') || target.startsWith('//')) return null;
  try {
    return new URL(target, 'http://localhost').pathname;
  } catch {
    return null;
  }
}

export function verifyWebSocketClient(info: Parameters<VerifyClientCallbackSync<AuthenticatedWebSocketRequest>>[0], dependencies: WebSocketAuthDependencies): boolean {
  const upgradeRequest = info.req as AuthenticatedWebSocketRequest;
  const pathname = requestPath(upgradeRequest);
  if (pathname === null) return false;
  console.log('WebSocket connection attempt to:', pathname);

  if (!acceptsOrigin(upgradeRequest, dependencies.allowedHosts)) {
    console.log('[WARN] WebSocket upgrade rejected for origin:', upgradeRequest.headers.origin);
    return false;
  }

  // Desktop credentials are checked before the owner is attached to an upgrade request.
  if (dependencies.desktopAuth && !dependencies.desktopAuth.authenticateWebSocket(upgradeRequest)) return false;
  // HTTP middleware does not run during an upgrade. Apply the deployment key
  // here too, before any chat, terminal, or browser socket gains owner access.
  if (!hasValidApiKey(upgradeRequest)) return false;

  let release: (() => void) | undefined;
  let owner: AuthenticatedOwner | null;
  try {
    release = dependencies.desktopRestartAdmission?.enter('ws:authenticate');
    owner = dependencies.authenticateWebSocket();
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'DESKTOP_RESTART_FENCED') return false;
    throw error;
  } finally {
    release?.();
  }
  if (!owner) {
    console.log('[WARN] Rejected WebSocket upgrade: no authenticated user');
    return false;
  }

  upgradeRequest.user = owner;
  console.log('[OK] WebSocket authenticated for user:', owner.username);
  return true;
}
