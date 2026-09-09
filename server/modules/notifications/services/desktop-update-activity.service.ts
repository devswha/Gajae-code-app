import { randomUUID } from 'node:crypto';

import type { DesktopWorkAdmission } from '@/shared/interfaces.js';

import type { DesktopOwnerActivity } from '../../../../shared/desktopUpdateProtocol.js';

const epoch = randomUUID();
let revision = 0n;
let active = 0;
let admission: DesktopWorkAdmission | undefined;

export function configureNotificationDesktopAdmission(value: DesktopWorkAdmission): void {
  if (admission && admission !== value) throw new Error('Notification admission already configured.');
  if (admission === value) return;
  admission = value;
  revision++;
}
export function enterNotificationActivity(owned = true): () => void {
  const release = owned ? admission?.enterCompletion('notification:completion') : admission?.enter('notification:dispatch');
  active++; revision++;
  let done = false;
  return () => { if (done) return; done = true; active--; revision++; release?.(); };
}
export const getNotificationActivityGeneration = (): string => `${epoch}:${revision}`;
export function snapshotNotificationActivity(): DesktopOwnerActivity {
  return { owner: 'notifications', generation: getNotificationActivityGeneration(), complete: true,
    starting: 0, queued: 0, running: active, settling: 0, approvals: 0, retained: 0, unknown: [] };
}
