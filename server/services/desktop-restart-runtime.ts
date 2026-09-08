import { DesktopRestartAuthority, type DesktopRestartAuthorityOptions, type DesktopRestartOwnerReader } from './desktop-restart-authority.js';

// A fixed inventory is deliberate: implementing one reader must not silently
// remove every owner which is still unaccounted for from the all-idle proof.
export const DESKTOP_RESTART_REQUIRED_OWNERS = Object.freeze([
  'chat', 'worktrees', 'orchestrator', 'native-jobs', 'gjc-worker',
  'automation', 'browser', 'computer', 'shell', 'native-clients',
  'watchers', 'notifications', 'http-callbacks', 'internal-producers', 'ui-drafts',
] as const);

/** Composition only. Missing/incomplete owners keep prepare fail-closed. */
export function createDesktopRestartRuntime(
  ownerReaders: Readonly<Record<string, DesktopRestartOwnerReader | undefined>> = {},
  preparationFence?: DesktopRestartAuthorityOptions['preparationFence'],
): DesktopRestartAuthority {
  return new DesktopRestartAuthority({ requiredOwners: DESKTOP_RESTART_REQUIRED_OWNERS, ownerReaders, preparationFence });
}
