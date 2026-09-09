import express from 'express';

import { notificationChannelEndpointsDb, notificationPreferencesDb } from '@/modules/database/index.js';
import { asyncHandler } from '@/shared/utils.js';

const router = express.Router();

type AuthenticatedRequest = express.Request & { user?: { id?: unknown } };
type NotificationEndpoint = {
  channel: string;
  created_at: string;
  enabled: number;
  endpoint_id: string;
  id: number;
  label: string | null;
  last_seen_at: string;
  metadata_json: string | null;
  updated_at: string;
};

const requiredText = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

function authenticatedUserId(request: AuthenticatedRequest): number {
  const userId = Number(request.user?.id);
  if (!Number.isInteger(userId) || userId <= 0) throw new Error('Authenticated user is missing');
  return userId;
}

function endpointView(endpoint: NotificationEndpoint) {
  const {
    id, channel, endpoint_id: endpointId, label, metadata_json,
    enabled, last_seen_at, created_at, updated_at,
  } = endpoint;
  const view = {
    id, channel, endpointId, label,
    metadata: notificationChannelEndpointsDb.parseMetadata(metadata_json),
    enabled: Boolean(enabled),
    lastSeenAt: last_seen_at, createdAt: created_at, updatedAt: updated_at,
  };
  return view;
}

function syncChannelPreference(userId: number, channel: string): unknown {
  const current = notificationPreferencesDb.getPreferences(userId);
  const enabledForChannel = notificationChannelEndpointsDb.getEnabledEndpoints(userId, channel);
  const channels = { ...current.channels, [channel]: enabledForChannel.length > 0 };
  return notificationPreferencesDb.updatePreferences(userId, { ...current, channels });
}

function reportEndpointFailure(response: express.Response, error: unknown, logMessage: string, responseError: string): express.Response {
  console.error(logMessage, error);
  return response.status(500).json({ error: responseError });
}

// Every endpoint route shares the same failure contract: log the cause, answer
// with a stable 500 body. Centralizing it keeps the handlers to their intent.
function guardEndpointRoute(
  response: express.Response,
  failure: { log: string; body: string },
  work: () => express.Response,
): express.Response {
  try {
    return work();
  } catch (error) {
    return reportEndpointFailure(response, error, failure.log, failure.body);
  }
}

router.get('/endpoints', asyncHandler((request, response) => {
  const channel = requiredText(request.query.channel);
  if (!channel) return response.status(400).json({ error: 'channel is required' });

  return guardEndpointRoute(
    response,
    { log: 'Error fetching notification endpoints:', body: 'Failed to fetch notification endpoints' },
    () => {
      const endpoints = notificationChannelEndpointsDb.getEndpoints(authenticatedUserId(request), channel).map(endpointView);
      return response.json({ success: true, endpoints });
    },
  );
}));

router.post('/endpoints/current', asyncHandler((request, response) => {
  const input = request.body || {};
  const channel = requiredText(input.channel);
  const endpointId = requiredText(input.endpointId);
  if (!channel || !endpointId) {
    return response.status(400).json({ error: 'channel and endpointId are required' });
  }

  return guardEndpointRoute(
    response,
    { log: 'Error registering notification endpoint:', body: 'Failed to register notification endpoint' },
    () => {
      const userId = authenticatedUserId(request);
      const upsertRecord = {
        userId, channel, endpointId,
        label: input.label,
        metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
        enabled: input.enabled !== false,
      };
      const stored = notificationChannelEndpointsDb.upsertEndpoint(upsertRecord);
      return response.json({
        success: true,
        endpoint: endpointView(stored),
        preferences: syncChannelPreference(userId, channel),
      });
    },
  );
}));

router.patch('/endpoints/:channel/:endpointId', asyncHandler((request, response) => {
  if (typeof request.body?.enabled !== 'boolean') {
    return response.status(400).json({ error: 'enabled must be a boolean' });
  }

  return guardEndpointRoute(
    response,
    { log: 'Error updating notification endpoint:', body: 'Failed to update notification endpoint' },
    () => {
      const userId = authenticatedUserId(request);
      const { channel, endpointId } = request.params;
      const updated = notificationChannelEndpointsDb.setEndpointEnabled(userId, channel, endpointId, request.body.enabled);
      if (!updated) return response.status(404).json({ error: 'Notification endpoint not found' });

      const stored = notificationChannelEndpointsDb.getEndpoint(userId, channel, endpointId);
      return response.json({
        success: true,
        endpoint: stored ? endpointView(stored) : null,
        preferences: syncChannelPreference(userId, channel),
      });
    },
  );
}));

router.delete('/endpoints/:channel/:endpointId', asyncHandler((request, response) => {
  return guardEndpointRoute(
    response,
    { log: 'Error removing notification endpoint:', body: 'Failed to remove notification endpoint' },
    () => {
      const userId = authenticatedUserId(request);
      const { channel, endpointId } = request.params;
      const didRemove = notificationChannelEndpointsDb.removeEndpoint(userId, channel, endpointId);
      if (!didRemove) return response.status(404).json({ error: 'Notification endpoint not found' });

      return response.json({ success: true, preferences: syncChannelPreference(userId, channel) });
    },
  );
}));

export default router;
