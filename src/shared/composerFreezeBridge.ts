import { useEffect } from 'react';

import {
  DESKTOP_UPDATE_BRIDGE_EVENT, DESKTOP_UPDATE_BRIDGE_NAME, DESKTOP_UPDATE_PROTOCOL,
  type DesktopDraftFreezeRequest, type DesktopDraftFreezeReceipt, type DesktopDraftOwner, type DesktopUpdateBridge,
} from '../../shared/desktopUpdateProtocol';

import { cancelComposerFreeze, ComposerFreezeError, installComposerSealInputGuard, isComposerFreezeCurrent, isComposerSealed, prepareComposerFreeze, registerComposerSealRollbackOwner, sealComposerFreeze } from './composerFreeze';

type Connection = { bridge: DesktopUpdateBridge; register: NonNullable<DesktopUpdateBridge['registerDraftOwner']> };
type Registration = Connection & { retire(): void };
type Attempt = { source: DesktopDraftFreezeRequest; receipt?: DesktopDraftFreezeReceipt };

function connection(): Connection | undefined {
  try {
    const value = (window as unknown as Record<string, unknown>)[DESKTOP_UPDATE_BRIDGE_NAME];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const bridge = value as DesktopUpdateBridge;
    if (bridge.protocolVersion !== DESKTOP_UPDATE_PROTOCOL || typeof bridge.request !== 'function') return;
    const register = bridge.registerDraftOwner;
    if (typeof register === 'function') return { bridge, register };
  } catch { /* An inaccessible/revoked injection is not a usable provider. */ }
}
const sameConnection = (left: Connection | undefined, right: Connection | undefined) => Boolean(left && right && left.bridge === right.bridge && left.register === right.register);

/** Root page registration only. Never calls bridge.request, fetch, postMessage,
 * or restart. Capability presence neither authenticates native nor freezes input. */
export function installComposerFreezeBridge(): () => void {
  if (typeof window === 'undefined') return () => {};
  const releaseInput = installComposerSealInputGuard();
  let disposed = false;
  let current: Registration | undefined;

  function attach() {
    if (disposed || sameConnection(current, connection())) return;
    const previous = current;
    current = undefined;
    previous?.retire();
    if (disposed) return;
    // An unsubscribe may synchronously announce a replacement provider.
    if (current) { if (!sameConnection(current, connection())) attach(); return; }
    const next = connection();
    if (!next) return;
    let active = true;
    let unsubscribe: (() => void) | undefined;
    const attempts = new Set<Attempt>();
    const registration: Registration = { ...next, retire };
    current = registration;
    const rollback = registerComposerSealRollbackOwner(attached);

    function attached(): boolean {
      if (!active || disposed || current !== registration) return false;
      if (!sameConnection(registration, connection())) { attach(); return false; }
      return true;
    }
    function retire() {
      if (!active) return;
      active = false;
      rollback.unregister();
      for (const attempt of attempts) cancelComposerFreeze(attempt.source, attempt.source);
      attempts.clear();
      const stop = unsubscribe;
      unsubscribe = undefined;
      try { stop?.(); } catch { /* Local ownership is already revoked. */ }
    }
    const owner: DesktopDraftOwner = {
      prepare(request) {
        if (!attached()) return Promise.reject(new ComposerFreezeError('stale'));
        // Bound request copies and original receipt identities never cross
        // registrations, even when an invalid retry repeats token/epoch values.
        let attempt: Attempt;
        try { attempt = { source: { ...request } }; } catch (error) { return Promise.reject(error); }
        for (const prior of attempts) if (prior.receipt && !isComposerFreezeCurrent(prior.receipt)) attempts.delete(prior);
        if (!attached()) return Promise.reject(new ComposerFreezeError('stale'));
        attempts.add(attempt);
        const pending = prepareComposerFreeze(attempt.source).then((receipt) => {
          if (!attached() || !isComposerFreezeCurrent(receipt)) throw new ComposerFreezeError('stale');
          attempt.receipt = receipt;
          return receipt;
        }).catch((error: unknown) => {
          cancelComposerFreeze(attempt.source, attempt.source);
          attempts.delete(attempt);
          throw error;
        });
        // A provider may throw during registration after beginning preparation.
        // Cleanup still rejects its promise, without an unhandled page rejection.
        void pending.catch(() => {});
        return pending;
      },
      isCurrent(receipt) {
        return attached() && [...attempts].some((attempt) => attempt.receipt === receipt) && isComposerFreezeCurrent(receipt);
      },
      seal(receipt) {
        return attached() && [...attempts].some((attempt) => attempt.receipt === receipt) && sealComposerFreeze(receipt);
      },
      cancel(request) {
        if (!attached() || !request) return false;
        // This explicit call is the authenticated native provider's confirmed
        // pre-commit rollback, including recovery after bridge replacement.
        // Retirement/unsubscribe/error cleanup never invokes it.
        if (isComposerSealed()) return rollback.cancel(request);
        let cancelled = false;
        for (const attempt of attempts) if (attempt.source.token === request.token && attempt.source.epoch === request.epoch) {
          cancelled = cancelComposerFreeze(attempt.source, attempt.source) || cancelled;
          attempts.delete(attempt);
        }
        return cancelled;
      },
    };
    try {
      const stop = next.register.call(next.bridge, owner);
      if (typeof stop !== 'function') throw new Error('Draft owner registration requires an unsubscribe function');
      if (active) unsubscribe = stop;
      else stop(); // Registration itself may have announced a replacement.
    } catch {
      if (current === registration) current = undefined;
      retire();
    }
  }

  window.addEventListener(DESKTOP_UPDATE_BRIDGE_EVENT, attach);
  attach();
  return () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener(DESKTOP_UPDATE_BRIDGE_EVENT, attach);
    const previous = current;
    current = undefined;
    previous?.retire();
    releaseInput();
  };
}

/** Mount once in App, outside route/settings/auth-dependent surfaces. */
export function useComposerFreezeBridge() { useEffect(installComposerFreezeBridge, []); }
