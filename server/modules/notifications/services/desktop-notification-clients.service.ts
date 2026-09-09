import type { WebSocket } from 'ws';

import { notificationChannelEndpointsDb } from '@/modules/database/index.js';

import { enterNotificationActivity } from './desktop-update-activity.service.js';

// The channel value is part of the endpoint rows in the database; only the
// constant's name is ours to choose.
const CHANNEL_DESKTOP = 'desktop';

type ClientRegistration = { endpointId: string; userId: number };
type DesktopClientRegistration = {
  ws: WebSocket; userId: number; deviceId: string;
  label?: string | null; platform?: string | null; appVersion?: string | null;
};

const registrationForSocket = new WeakMap<WebSocket, ClientRegistration>();
const clientsByUser = new Map<number, Map<string, WebSocket>>();

function userIdOrNull(value: unknown): number | null {
  const userId = Number(value);
  return Number.isInteger(userId) && userId > 0 ? userId : null;
}

function endpointIdFrom(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function clientsFor(userId: number): Map<string, WebSocket> {
  const existing = clientsByUser.get(userId);
  if (existing) return existing;

  const created = new Map<string, WebSocket>();
  clientsByUser.set(userId, created);
  return created;
}

function forgetClient(ws: WebSocket): void {
  const registration = registrationForSocket.get(ws);
  if (!registration) return;

  const userClients = clientsByUser.get(registration.userId);
  if (userClients?.get(registration.endpointId) === ws) {
    userClients.delete(registration.endpointId);
    if (userClients.size === 0) clientsByUser.delete(registration.userId);
  }
  registrationForSocket.delete(ws);
}

function serializeNotification(payload: unknown): string {
  const tag = (payload as { data?: { tag?: unknown } } | null)?.data?.tag;
  return JSON.stringify({
    type: 'notification',
    id: typeof tag === 'string' ? tag : `${Date.now()}`,
    payload,
  });
}

export function registerDesktopNotificationClient(registration: DesktopClientRegistration) {
  const { ws, userId, deviceId, label = null, platform = null, appVersion = null } = registration;
  const ownerId = userIdOrNull(userId);
  const endpointId = endpointIdFrom(deviceId);
  if (ownerId === null || !endpointId) return false;
  const release = enterNotificationActivity(false);
  try {
    const upsertRecord = {
      userId: ownerId, channel: CHANNEL_DESKTOP, endpointId, label,
      metadata: { platform, appVersion }, enabled: true,
    };
    const endpoint = notificationChannelEndpointsDb.upsertEndpoint(upsertRecord);

    const userClients = clientsFor(ownerId);
    const replacedSocket = userClients.get(endpointId);
    userClients.set(endpointId, ws);
    registrationForSocket.set(ws, { userId: ownerId, endpointId });
    if (replacedSocket && replacedSocket !== ws && replacedSocket.readyState === replacedSocket.OPEN) {
      try { replacedSocket.close(4000, 'Device reconnected'); } catch { /* The replacement is already registered. */ }
    }
    return endpoint;
  } finally { release(); }
}

export function unregisterDesktopNotificationClient(ws: WebSocket): void {
  if (!registrationForSocket.has(ws)) return;
  const release = enterNotificationActivity();
  try { forgetClient(ws); } finally { release(); }
}

type SendTally = { attempted: number; sent: number };
function dispatchDesktopNotification(userId: unknown, payload: unknown): { tally: SendTally; settled: Promise<void> } {
  const release = enterNotificationActivity();
  let settled: Promise<void> | undefined;
  const pending: Promise<void>[] = [];
  try {
    const ownerId = userIdOrNull(userId);
    const userClients = ownerId === null ? undefined : clientsByUser.get(ownerId);
    if (ownerId === null || !userClients?.size) return { tally: { attempted: 0, sent: 0 }, settled: Promise.resolve() };

    const enabledEndpoints = new Set(
      notificationChannelEndpointsDb.getEnabledEndpoints(ownerId, CHANNEL_DESKTOP).map(({ endpoint_id }) => endpoint_id),
    );
    const message = serializeNotification(payload);
    const tally = { attempted: 0, sent: 0 };

    for (const [endpointId, socket] of userClients) {
      if (!enabledEndpoints.has(endpointId)) continue;
      tally.attempted += 1;
      if (socket.readyState !== socket.OPEN) { forgetClient(socket); continue; }

      let finish!: () => void;
      pending.push(new Promise<void>((resolve) => { finish = resolve; }));
      let finished = false;
      const sent = (error?: Error): void => {
        if (finished) return;
        finished = true;
        // Transport completion is not evidence of presentation in the UI.
        try { if (error) forgetClient(socket); } finally { finish(); }
      };
      try { socket.send(message, sent); }
      catch { forgetClient(socket); sent(); continue; }
      try {
        notificationChannelEndpointsDb.touchEndpoint(ownerId, CHANNEL_DESKTOP, endpointId);
        tally.sent += 1;
      } catch { forgetClient(socket); }
    }
    settled = Promise.all(pending).then(() => undefined).finally(release);
    return { tally, settled };
  } finally {
    // A socket close or a caller dropping the synchronous tally cannot release
    // an issued send. Its callback owns the remaining lifetime.
    if (!settled) {
      if (pending.length) void Promise.all(pending).finally(release);
      else release();
    }
  }
}

/** Historical synchronous result: `sent` counts enqueue success, not UI delivery. */
export function sendDesktopNotification(userId: unknown, payload: unknown): SendTally {
  return dispatchDesktopNotification(userId, payload).tally;
}

/** Facades can retain the actual transport lifetime without changing the tally API. */
export function sendDesktopNotificationAndWait(userId: unknown, payload: unknown): Promise<SendTally> {
  const { tally, settled } = dispatchDesktopNotification(userId, payload);
  return settled.then(() => tally);
}
