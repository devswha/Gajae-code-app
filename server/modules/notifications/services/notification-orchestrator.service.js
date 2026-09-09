import { notificationPreferencesDb, sessionsDb } from '@/modules/database/index.js';
import { sendDesktopNotificationAndWait } from '@/modules/notifications/services/desktop-notification-clients.service.js';
import { enterNotificationActivity } from '@/modules/notifications/services/desktop-update-activity.service.js';

const eventPreferences = new Map([
  ['action_required', 'actionRequired'],
  ['stop', 'stop'],
  ['error', 'error'],
]);
const providerNames = { claude: 'Claude', cursor: 'Cursor', codex: 'Codex', gjc: 'GJC', system: 'System' };
const deliveredRecently = new Map();
const DEDUPE_WINDOW_MS = 20_000;

function createNotificationEvent({
  provider, kind = 'info', code = 'generic.info', severity = 'info',
  sessionId = null, meta = {}, dedupeKey = null, requiresUserAction = false,
}) {
  return { provider, sessionId, kind, code, meta, severity, requiresUserAction, dedupeKey, createdAt: new Date().toISOString() };
}

function appSessionFor(sessionId, provider) {
  if (!sessionId) return null;
  const direct = sessionsDb.getSessionById(sessionId);
  if (direct && (!provider || direct.provider === provider)) return direct;
  const byProviderId = provider ? sessionsDb.getSessionByProviderSessionId(provider, sessionId) : null;
  return byProviderId && (!provider || byProviderId.provider === provider) ? byProviderId : null;
}

function canonicalSession(event) {
  if (!event?.sessionId || !event.provider || event.provider === 'system') return event;
  const record = appSessionFor(event.sessionId, event.provider);
  return !record || record.session_id === event.sessionId ? event : { ...event, sessionId: record.session_id };
}

function conciseSessionName(value) {
  if (typeof value !== 'string') return null;
  const name = value.replace(/\s+/g, ' ').trim();
  if (!name) return null;
  return name.length > 80 ? `${name.slice(0, 77)}...` : name;
}

function sessionNameFor(event) {
  const supplied = conciseSessionName(event.meta?.sessionName);
  if (supplied) return supplied;
  if (!event.sessionId || !event.provider) return null;
  return conciseSessionName(sessionsDb.getSessionName(event.sessionId, event.provider));
}

function textFor(event) {
  const meta = event.meta;
  switch (event.code) {
    case 'permission.required':
      return meta?.toolName
        ? `Action Required: Tool "${meta.toolName}" needs approval`
        : 'Action Required: A tool needs your approval';
    case 'run.stopped':
      return meta?.stopReason || 'Run Stopped: The run has stopped';
    case 'run.failed':
      return meta?.error ? `Run Failed: ${meta.error}` : 'Run Failed: The run encountered an error';
    case 'agent.notification':
      return meta?.message ? String(meta.message) : 'You have a new notification';
    case 'push.enabled':
      return 'Push notifications are now enabled!';
    default:
      return 'You have a new notification';
  }
}

function buildNotificationPayload(event) {
  const current = canonicalSession(event);
  const sessionName = sessionNameFor(current);
  const provider = current.provider || 'assistant';
  const sessionId = current.sessionId || 'none';
  return {
    title: sessionName || 'Gajae Code App',
    body: `${providerNames[current.provider] || 'Assistant'}: ${textFor(current)}`,
    data: {
      sessionId: current.sessionId || null,
      code: current.code,
      provider: current.provider || null,
      sessionName,
      tag: `${provider}:${sessionId}:${current.code}`,
    },
  };
}

function eventIsAllowed(preferences, event) {
  const preference = eventPreferences.get(event.kind);
  return preference === undefined || Boolean(preferences?.events?.[preference]);
}

function wasDelivered(event) {
  const now = Date.now();
  for (const [key, recordedAt] of deliveredRecently) {
    if (now - recordedAt > DEDUPE_WINDOW_MS) deliveredRecently.delete(key);
  }
  const key = event.dedupeKey || `${event.provider}:${event.kind || 'info'}:${event.code || 'generic'}:${event.sessionId || 'none'}`;
  if (deliveredRecently.has(key)) return true;
  deliveredRecently.set(key, now);
  return false;
}

function reportDesktopFailure(error) {
  console.error('Notification channel "desktop" send error:', error);
}

function notifyUserIfEnabled({ userId, event }) {
  if (!userId || !event) return;
  const release = enterNotificationActivity();
  let pending;
  try {
    const current = canonicalSession(event);
    const preferences = notificationPreferencesDb.getPreferences(userId);
    if (!eventIsAllowed(preferences, current) || wasDelivered(current)) return;
    if (!preferences?.channels?.desktop) return;

    const payload = buildNotificationPayload(current);
    pending = Promise.resolve(sendDesktopNotificationAndWait(userId, payload)).catch(reportDesktopFailure).finally(release);
    return pending;
  } finally {
    if (!pending) release();
  }
}

function errorText(error) {
  if (typeof error === 'string') return error;
  if (error && typeof error.message === 'string') return error.message;
  return error == null ? 'Unknown error' : String(error);
}

function notifyRunStopped({ userId, provider, sessionId = null, stopReason = 'completed', sessionName = null }) {
  return notifyUserIfEnabled({
    userId,
    event: createNotificationEvent({
      provider, sessionId, kind: 'stop', code: 'run.stopped', meta: { stopReason, sessionName }, severity: 'info',
      dedupeKey: `${provider}:run:stop:${sessionId || 'none'}:${stopReason}`,
    }),
  });
}

function notifyRunFailed({ userId, provider, sessionId = null, error, sessionName = null }) {
  const message = errorText(error);
  return notifyUserIfEnabled({
    userId,
    event: createNotificationEvent({
      provider, sessionId, kind: 'error', code: 'run.failed', meta: { error: message, sessionName }, severity: 'error',
      dedupeKey: `${provider}:run:error:${sessionId || 'none'}:${message}`,
    }),
  });
}

export { buildNotificationPayload, createNotificationEvent, notifyUserIfEnabled, notifyRunStopped, notifyRunFailed };
