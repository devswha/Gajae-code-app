import {
  registerDesktopNotificationClient as registerClient,
  sendDesktopNotification as sendToDesktop,
  unregisterDesktopNotificationClient as unregisterClient,
} from '@/modules/notifications/services/desktop-notification-clients.service.js';
import {
  buildNotificationPayload as buildPayload,
  createNotificationEvent as createEvent,
  notifyRunFailed as notifyFailure,
  notifyRunStopped as notifyStop,
  notifyUserIfEnabled as notifyEnabledUser,
} from '@/modules/notifications/services/notification-orchestrator.service.js';
import { handleDesktopNotificationsConnection as handleDesktopConnection } from '@/modules/notifications/websocket/desktop-notifications-websocket.service.js';
export {
  configureNotificationDesktopAdmission,
  getNotificationActivityGeneration,
  snapshotNotificationActivity,
} from './services/desktop-update-activity.service.js';

export {
  buildPayload as buildNotificationPayload,
  createEvent as createNotificationEvent,
  handleDesktopConnection as handleDesktopNotificationsConnection,
  notifyEnabledUser as notifyUserIfEnabled,
  notifyFailure as notifyRunFailed,
  notifyStop as notifyRunStopped,
  registerClient as registerDesktopNotificationClient,
  sendToDesktop as sendDesktopNotification,
  unregisterClient as unregisterDesktopNotificationClient,
};
