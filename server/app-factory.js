import http from 'node:http';

import cors from 'cors';
import express from 'express';

import { parseAllowedHosts } from '../shared/networkHosts.js';
import { isDesktopUpdateCommand } from '../shared/desktopUpdateProtocol.js';

import { createDesktopAuth, DESKTOP_BOOTSTRAP_PATH } from './middleware/desktop-auth.js';
import { createWebSocketServer } from './modules/websocket/index.js';
import { createGjcJobsRouter } from './routes/gjc-jobs.js';
import { isAllowedRequestOrigin } from './shared/request-origin.js';

/**
 * Builds the production GJC HTTP and WebSocket composition with explicit
 * dependencies so integration tests exercise the same route and gateway.
 */
export function createGjcAppFactory({
  authority,
  orchestrator,
  gitService,
  projection,
  terminalNotificationAdapter,
  authenticateWebSocket,
  authenticateGjcRoute,
  validateApiKey,
  chat,
  shell,
  browser = undefined,
  desktopUpdateRelay = undefined,
}) {
  orchestrator.deps.broadcast = (jobId, event) => {
    try { projection.publish(jobId, event); } catch { /* Durable replay recovers isolated websocket fan-out failures. */ }
    try { terminalNotificationAdapter?.onCommittedEvent(jobId, event); } catch { /* Notification delivery is isolated from durable job state. */ }
  };
  void terminalNotificationAdapter?.startupCatchUp().catch(() => {});

  const app = express();
  app.set('trust proxy', 1);
  const server = http.createServer(app);
  const desktopAuth = createDesktopAuth({ server });
  const wss = createWebSocketServer(server, {
    verifyClient: { authenticateWebSocket, desktopAuth },
    chat,
    shell,
    browser,
  });
  app.locals.wss = wss;

  // The owner is implicit, so reaching the API is the whole of being authorized
  // to use it. A cross-origin `fetch` is *sent* regardless of CORS - CORS only
  // decides whether the caller may read the reply - so a hostile page could
  // otherwise start turns and delete sessions on a loopback-bound server, and
  // read every project and transcript besides. Rejecting the request is the
  // check; the CORS headers below merely stop describing this as public.
  const originPolicy = (request) => ({
    hostHeader: request.headers.host,
    allowedHosts: parseAllowedHosts(process.env.ALLOWED_HOSTS),
  });
  app.use(desktopAuth.corsOptions
    ? cors(desktopAuth.corsOptions)
    // The delegate form is what gives the decision the request's Host, which is
    // what makes the dev client on another port work without opening the door
    // to every other origin.
    : cors((request, callback) => callback(null, {
      origin: isAllowedRequestOrigin(request.headers.origin, originPolicy(request)),
    })));
  app.use((request, response, next) => {
    if (isAllowedRequestOrigin(request.headers.origin, originPolicy(request))) {
      return next();
    }
    console.log('[WARN] Request rejected for origin:', request.headers.origin);
    return response.status(403).json({ error: 'Forbidden origin' });
  });
  if (desktopAuth.enabled) {
    app.get(DESKTOP_BOOTSTRAP_PATH, desktopAuth.bootstrap);
    app.use((request, response, next) => {
      if (request.path === '/health') {
        return next();
      }
      return request.path === '/api' || request.path.startsWith('/api/')
        ? desktopAuth.authenticateHttp(request, response, next)
        : desktopAuth.authenticatePage(request, response, next);
    });
  }
  app.use(express.json({
    limit: '50mb',
    type: (req) => {
      const contentType = req.headers['content-type'] || '';
      return !contentType.includes('multipart/form-data') && contentType.includes('json');
    },
  }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));
  app.post('/api/desktop/update', (request, response) => {
    response.set('Cache-Control', 'no-store');
    if (!desktopAuth.enabled || !desktopUpdateRelay?.isAvailable()) return response.status(404).json({ error: 'updater_unavailable' });
    if (request.headers.origin !== desktopAuth.expectedOrigin()
      || typeof request.headers['x-gajae-update-view'] !== 'string') return response.status(403).json({ error: 'updater_unauthorized' });
    if (!isDesktopUpdateCommand(request.body)) return response.status(400).json({ error: 'updater_invalid_command' });
    void desktopUpdateRelay.request(request.body, request.headers['x-gajae-update-view'], request.headers.origin)
      .then((snapshot) => response.json(snapshot))
      .catch((error) => response.status(error.message === 'updater_unauthorized' ? 403 : 503).json({ error: /^[a-z_]{1,64}$/.test(error.message) ? error.message : 'updater_unavailable' }));
  });
  app.use('/api', validateApiKey);
  app.use('/api/gjc', authenticateGjcRoute, createGjcJobsRouter({ authority, orchestrator, gitService }));

  return { app, server, wss };
}
