/** Native-owned updater state. This protocol never grants installation authority. */
export const DESKTOP_UPDATE_PROTOCOL = 1 as const;
export const DESKTOP_UPDATE_BRIDGE_EVENT = 'gajae:desktop-update-ready';
export const DESKTOP_UPDATE_BRIDGE_NAME = '__GJC_DESKTOP_UPDATE__';

export type DesktopUpdateCommand =
  | { action: 'status' | 'check' | 'restart' }
  | { action: 'setAutomatic'; automatic: boolean };

export const DESKTOP_UPDATE_PHASES = ['disabled', 'idle', 'checking', 'downloading', 'verifying', 'ready', 'deferred', 'error', 'applying', 'restarting', 'recovery'] as const;
export type DesktopUpdateSnapshot = {
  protocolVersion: typeof DESKTOP_UPDATE_PROTOCOL;
  phase: typeof DESKTOP_UPDATE_PHASES[number];
  automatic: boolean;
  productVersion: string;
  desktopVersion: string;
  targetProductVersion: string | null;
  targetDesktopVersion: string | null;
  discoveryIncomplete: boolean;
  reason: string | null;
  installationAvailable: boolean;
  downloadedBytes: number | null;
  totalBytes: number | null;
  notes: string | null;
};

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function isDesktopUpdateCommand(value: unknown): value is DesktopUpdateCommand {
  if (!record(value)) return false;
  if (value.action === 'setAutomatic') return Object.keys(value).length === 2 && typeof value.automatic === 'boolean';
  return Object.keys(value).length === 1 && (value.action === 'status' || value.action === 'check' || value.action === 'restart');
}

export function isDesktopUpdateSnapshot(value: unknown): value is DesktopUpdateSnapshot {
  const keys = ['protocolVersion', 'phase', 'automatic', 'productVersion', 'desktopVersion', 'targetProductVersion', 'targetDesktopVersion', 'discoveryIncomplete', 'reason', 'installationAvailable', 'downloadedBytes', 'totalBytes', 'notes'];
  if (!record(value) || Object.keys(value).length !== keys.length || !keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    || value.protocolVersion !== DESKTOP_UPDATE_PROTOCOL
    || !DESKTOP_UPDATE_PHASES.some((phase) => phase === value.phase)
    || typeof value.automatic !== 'boolean' || typeof value.discoveryIncomplete !== 'boolean'
    || typeof value.installationAvailable !== 'boolean') return false;
  for (const key of ['productVersion', 'desktopVersion']) {
    if (typeof value[key] !== 'string' || value[key].length === 0 || value[key].length > 256) return false;
  }
  for (const key of ['targetProductVersion', 'targetDesktopVersion', 'reason', 'notes']) {
    const field = value[key];
    if (field !== null && (typeof field !== 'string' || field.length > (key === 'notes' ? 16_384 : 256))) return false;
  }
  for (const key of ['downloadedBytes', 'totalBytes']) {
    const field = value[key];
    if (field !== null && (typeof field !== 'number' || !Number.isSafeInteger(field) || field < 0)) return false;
  }
  return value.downloadedBytes === null || value.totalBytes === null || (value.downloadedBytes as number) <= (value.totalBytes as number);
}

/** Supplied only to the current native-owned main document. Presence is not authentication. */
export type DesktopUpdateBridge = {
  protocolVersion: typeof DESKTOP_UPDATE_PROTOCOL;
  request(command: DesktopUpdateCommand): Promise<DesktopUpdateSnapshot>;
};

export type DesktopOwnerActivity = {
  owner: string;
  generation: string;
  complete: boolean;
  starting: number;
  queued: number;
  running: number;
  settling: number;
  approvals: number;
  retained: number;
  unknown: readonly string[];
};
