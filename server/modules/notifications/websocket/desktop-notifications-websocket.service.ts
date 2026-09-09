import type { WebSocket } from 'ws';

import { registerDesktopNotificationClient, unregisterDesktopNotificationClient } from '@/modules/notifications/services/desktop-notification-clients.service.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';
import { parseIncomingJsonObject } from '@/shared/utils.js';

type DesktopNotificationRegisterMessage = { appVersion?: unknown; deviceId?: unknown; kind?: unknown; label?: unknown; platform?: unknown; type?: unknown };

function nonEmptyText(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized === '' ? null : normalized;
}

function requestUserId(request: AuthenticatedWebSocketRequest): number | null {
  const account = request.user;
  let rawId: unknown = null;
  if (typeof account?.id === 'string' || typeof account?.id === 'number') rawId = account.id;
  else if (typeof account?.userId === 'string' || typeof account?.userId === 'number') rawId = account.userId;
  if (rawId === null) return null;
  const numericId = Number(rawId);
  return Number.isInteger(numericId) && numericId > 0 ? numericId : null;
}

function sendWhenOpen(ws: WebSocket, message: unknown): void {
  try { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message), () => {}); }
  catch { /* A failed control response must not crash an existing connection. */ }
}

function closeSafely(ws: WebSocket, code: number, reason: string): void {
  try { ws.close(code, reason); } catch { /* Socket teardown can race this callback. */ }
}

function registerCommand(message: DesktopNotificationRegisterMessage): string {
  return typeof message.type === 'string'
    ? message.type
    : typeof message.kind === 'string' ? message.kind : '';
}

export function handleDesktopNotificationsConnection(ws: WebSocket, request: AuthenticatedWebSocketRequest): void {
  const userId = requestUserId(request);
  if (userId === null) return closeSafely(ws, 1008, 'Missing authenticated user');

  let boundToClient = false;
  ws.on('message', (incoming) => {
    const message = parseIncomingJsonObject(incoming) as DesktopNotificationRegisterMessage | null;
    if (!message) return;

    const command = registerCommand(message);
    if (boundToClient || command === 'notification_ack' || command !== 'register') return;

    const deviceId = nonEmptyText(message.deviceId);
    if (deviceId === null) {
      const rejection = { type: 'error', code: 'DEVICE_ID_REQUIRED', message: 'Desktop notification registration requires deviceId.' };
      sendWhenOpen(ws, rejection);
      return closeSafely(ws, 1008, 'Missing deviceId');
    }

    const registration = {
      userId, deviceId, ws,
      label: nonEmptyText(message.label),
      platform: nonEmptyText(message.platform),
      appVersion: nonEmptyText(message.appVersion),
    };
    try {
      // Registration owns a fresh root on every message, not just at upgrade.
      const endpoint = registerDesktopNotificationClient(registration);
      if (!endpoint) return closeSafely(ws, 1011, 'Registration failed');
      boundToClient = true;
      const confirmation = { type: 'registered', deviceId: endpoint.endpoint_id, enabled: Boolean(endpoint.enabled) };
      sendWhenOpen(ws, confirmation);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'DESKTOP_RESTART_FENCED') {
        sendWhenOpen(ws, { type: 'error', code: 'DESKTOP_RESTART_FENCED', message: 'Desktop restart admission is fenced.' });
        return; // Leave the unbound connection able to retry after cancellation.
      }
      sendWhenOpen(ws, { type: 'error', code: 'REGISTRATION_FAILED', message: 'Desktop notification registration failed.' });
      closeSafely(ws, 1011, 'Registration failed');
    }
  });

  const unregister = (): void => {
    try { unregisterDesktopNotificationClient(ws); }
    catch (error) {
      // Precommit closes are owned completions. After commit, do not let a
      // rejected callback crash shutdown or resume notification work.
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'DESKTOP_RESTART_FENCED')) {
        console.error('Desktop notification unregister failed:', error);
      }
    }
  };
  ws.on('close', unregister);
  ws.on('error', unregister);
}
