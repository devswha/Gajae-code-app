import { isDesktopUpdateCommand, isDesktopUpdateSnapshot, type DesktopUpdateCommand, type DesktopUpdateSnapshot } from './desktopUpdateProtocol.js';

export const DESKTOP_RESTART_PROTOCOL = 1 as const;
export const DESKTOP_RESTART_PREPARE_MS = 5_000;
export const DESKTOP_RESTART_TOKEN_MS = 10_000;
export const isRestartId = (value: unknown): value is string => typeof value === 'string' && value.length === 64 && /^[a-f0-9]+$/u.test(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const positive = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum;
const token = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && /^[A-Za-z0-9]/u.test(value) && !/[^A-Za-z0-9._:-]/u.test(value);

/** Private exchanges used by the injected native wrapper, not new public UI commands. */
export type DesktopRestartCommand = { action: 'restartPrepared' | 'restartCancel'; attemptId: string; draftEpoch: number };
export type DesktopNativeCommand = DesktopUpdateCommand | DesktopRestartCommand;
export function isDesktopRestartCommand(value: unknown): value is DesktopRestartCommand {
  return object(value) && exact(value, ['action', 'attemptId', 'draftEpoch'])
    && (value.action === 'restartPrepared' || value.action === 'restartCancel')
    && isRestartId(value.attemptId) && positive(value.draftEpoch);
}
export const isDesktopNativeCommand = (value: unknown): value is DesktopNativeCommand => isDesktopUpdateCommand(value) || isDesktopRestartCommand(value);

export type DesktopRestartChallenge = {
  protocolVersion: 1; kind: 'restartChallenge'; attemptId: string; draftEpoch: number; ttlMs: number;
};
export type DesktopRestartDisposition = {
  protocolVersion: 1; kind: 'restartAborted' | 'restartUncertain'; attemptId: string; draftEpoch: number; snapshot: DesktopUpdateSnapshot;
};
export type DesktopNativeReply = DesktopUpdateSnapshot | DesktopRestartChallenge | DesktopRestartDisposition;
export function isDesktopNativeReply(value: unknown): value is DesktopNativeReply {
  if (isDesktopUpdateSnapshot(value)) return true;
  if (!object(value) || value.protocolVersion !== 1 || !isRestartId(value.attemptId) || !positive(value.draftEpoch)) return false;
  if (value.kind === 'restartChallenge') return exact(value, ['protocolVersion', 'kind', 'attemptId', 'draftEpoch', 'ttlMs'])
    && positive(value.ttlMs, DESKTOP_RESTART_PREPARE_MS);
  return (value.kind === 'restartAborted' || value.kind === 'restartUncertain')
    && exact(value, ['protocolVersion', 'kind', 'attemptId', 'draftEpoch', 'snapshot']) && isDesktopUpdateSnapshot(value.snapshot);
}

/** Native-only commands on the separately authenticated backend channel.
 * No browser route accepts these frames, and no command installs or kills. */
export type RestartControlCommand =
  | { action: 'status' }
  | { action: 'prepare'; attemptId: string; draftEpoch: number; remainingMs: number }
  | { action: 'commit'; attemptId: string; token: string }
  | { action: 'cancel'; attemptId: string };
export function isRestartControlCommand(value: unknown): value is RestartControlCommand {
  if (!object(value)) return false;
  if (value.action === 'status') return exact(value, ['action']);
  if (!isRestartId(value.attemptId)) return false;
  if (value.action === 'prepare') return exact(value, ['action', 'attemptId', 'draftEpoch', 'remainingMs'])
    && positive(value.draftEpoch) && positive(value.remainingMs, DESKTOP_RESTART_PREPARE_MS);
  if (value.action === 'commit') return exact(value, ['action', 'attemptId', 'token']) && token(value.token);
  return value.action === 'cancel' && exact(value, ['action', 'attemptId']);
}
export type RestartControlResult = {
  ok: boolean; state: 'open' | 'preparing' | 'prepared' | 'committed';
  attemptId: string | null; token: string | null; expiresInMs: number | null; error: string | null;
};
export function isRestartControlResult(value: unknown): value is RestartControlResult {
  return object(value) && exact(value, ['ok', 'state', 'attemptId', 'token', 'expiresInMs', 'error'])
    && typeof value.ok === 'boolean' && typeof value.state === 'string' && ['open', 'preparing', 'prepared', 'committed'].includes(value.state)
    && (value.attemptId === null || isRestartId(value.attemptId))
    && (value.token === null || token(value.token))
    && (value.expiresInMs === null || positive(value.expiresInMs, DESKTOP_RESTART_TOKEN_MS))
    && (value.error === null || (typeof value.error === 'string' && value.error.length > 0 && value.error.length <= 64 && !/[^a-z_]/u.test(value.error)))
    && (value.ok ? value.error === null : value.error !== null);
}
export type RestartControlFrame = { protocolVersion: 1; kind: 'restartControl'; id: number; epoch: string; command: RestartControlCommand };
export function isRestartControlFrame(value: unknown): value is RestartControlFrame {
  return object(value) && exact(value, ['protocolVersion', 'kind', 'id', 'epoch', 'command'])
    && value.protocolVersion === 1 && value.kind === 'restartControl' && positive(value.id)
    && isRestartId(value.epoch) && isRestartControlCommand(value.command);
}
