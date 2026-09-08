import { captureComposerProjections, verifyComposerProjectionCoverage } from '../components/chat/utils/composerDraftVerification';
import { ComposerStorageError } from '../components/chat/utils/composerDraftStorage';
import type { DesktopDraftFreezeRequest, DesktopDraftReceipt, DesktopDraftFreezeReceipt } from '../../shared/desktopUpdateProtocol';

/** Page-local admission and durability evidence only. This module cannot install,
 * restart, authenticate a native caller, or attest to another window/server. */
export type ComposerFreezeRequest = DesktopDraftFreezeRequest;
export type ComposerDraftReceipt = DesktopDraftReceipt;
export type ComposerFreezeReceipt = DesktopDraftFreezeReceipt;
type Participant = { flushAndVerify(isCurrent: () => boolean): Promise<ComposerDraftReceipt[]>; dispose?(): void };
export class ComposerFreezeError extends Error {
  constructor(public readonly reason: 'busy' | 'changed' | 'cancelled' | 'timeout' | 'stale' | 'invalid' | 'sealed') {
    super(`Composer freeze: ${reason}`);
    this.name = 'ComposerFreezeError';
  }
}
type Lease = {
  request: ComposerFreezeRequest; expiresAt: number; deadline: number; timer: ReturnType<typeof setTimeout>;
  source: ComposerFreezeRequest;
  sealed?: boolean;
  invalidated?: boolean;
  releaseInput?: () => void;
  reject(error: unknown): void; cleanup?(): void; receipt?: ComposerFreezeReceipt;
  projections?: ReturnType<typeof captureComposerProjections>;
};
const participants = new Set<Participant>();
const operations = new Map<string, { kind: string }>();
// Exact-ID protocol acknowledgements have no separate lifetime nonce. Never
// reuse an admitted ID within this page, including after its operation settles.
const usedOperationIds = new Set<string>();
const listeners = new Set<() => void>();
let lease: Lease | undefined;
let lastEpoch = -1;
let rollbackOwner: object | undefined;
const inputValues = new WeakMap<HTMLInputElement | HTMLTextAreaElement, () => string>();
let inputGuardUsers = 0;
let removeInputGuard: (() => void) | undefined;
const publish = () => listeners.forEach((listener) => listener());
export const subscribeComposerFreeze = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const isComposerFrozen = () => Boolean(lease);
export const isComposerSealed = () => lease?.sealed === true;
const expired = (current: Lease) => Date.now() >= current.expiresAt || performance.now() >= current.deadline;

function thaw(reason: ComposerFreezeError['reason'], rollback = false) {
  if (!lease) return;
  if (lease.sealed && !rollback) {
    // Native may already have committed. Report invalidation, never reopen.
    if (!lease.invalidated) { lease.invalidated = true; publish(); }
    return;
  }
  const prior = lease;
  lease = undefined;
  clearTimeout(prior.timer);
  prior.cleanup?.();
  prior.releaseInput?.();
  prior.reject(new ComposerFreezeError(reason));
  publish();
}
/** Edits revoke an unsealed preparation. Sealed invalidation is reported without
 * reopening input; native may already have committed the restart. */
export function invalidateComposerFreeze() { thaw('changed'); }
/** A registration may additionally bind cleanup to its exact preparation object,
 * so a rejected/stale attempt cannot cancel another caller's matching keys. */
export function cancelComposerFreeze(request: Pick<ComposerFreezeRequest, 'token' | 'epoch'>, source?: ComposerFreezeRequest): boolean {
  if (isComposerSealed()) return false;
  if (!lease || lease.request.token !== request.token || lease.request.epoch !== request.epoch) return false;
  if (source && lease.source !== source) return false;
  thaw('cancelled');
  return true;
}

/** Page-local capability, held privately by the current injected registration.
 * It is not installation authority. Only an explicit native rollback uses it;
 * generic cleanup deliberately has no path through this capability. */
export function registerComposerSealRollbackOwner(isCurrentOwner: () => boolean) {
  const owner = {};
  rollbackOwner = owner;
  return {
    cancel(request: Pick<ComposerFreezeRequest, 'token' | 'epoch'>): boolean {
      if (!request || rollbackOwner !== owner || !isCurrentOwner() || rollbackOwner !== owner) return false;
      const current = lease;
      if (!current?.sealed || current.request.token !== request.token || current.request.epoch !== request.epoch) return false;
      if (lease !== current || rollbackOwner !== owner) return false;
      thaw('cancelled', true);
      return true;
    },
    unregister() { if (rollbackOwner === owner) rollbackOwner = undefined; },
  };
}

/** A controlled field registers its committed render value. Capture handlers
 * can then repair even an input event whose browser mutation already happened. */
export function registerComposerInputValue(input: HTMLInputElement | HTMLTextAreaElement, read: () => string): () => void {
  const release = installComposerSealInputGuard();
  inputValues.set(input, read);
  return () => { if (inputValues.get(input) === read) inputValues.delete(input); release(); };
}

/** Root/field owners install capture before any event can initiate a seal. The
 * sealed lease holds its own reference, so root retirement cannot remove it. */
export function installComposerSealInputGuard(): () => void {
  if (typeof window === 'undefined') return () => {};
  inputGuardUsers += 1;
  if (!removeInputGuard) removeInputGuard = sealInputEvents();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inputGuardUsers -= 1;
    if (!inputGuardUsers) { removeInputGuard?.(); removeInputGuard = undefined; }
  };
}

function sealInputEvents(): () => void {
  const events = ['beforeinput', 'input', 'change', 'paste', 'cut', 'drop', 'keydown', 'keypress', 'compositionstart', 'compositionupdate', 'compositionend', 'click', 'submit'];
  const block = (event: Event) => {
    if (!isComposerSealed()) return;
    const target = event.composedPath().find((item): item is Element => item instanceof Element);
    if (!target?.closest('[data-composer-root], [data-slot="prompt-input"], [data-composer-attachment-picker]')) return;
    if (event instanceof KeyboardEvent && (event.ctrlKey || event.metaKey) && ['a', 'c'].includes(event.key.toLowerCase())) return;
    if (event.type === 'input' || event.type === 'change') {
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        target.value = target instanceof HTMLInputElement && target.type === 'file' ? '' : inputValues.get(target)?.() ?? target.defaultValue;
      }
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  // Root/field owners install on Window ahead of React delegation and before
  // an input event can initiate seal(); the sealed lease retains the guard.
  for (const name of events) window.addEventListener(name, block, { capture: true, passive: false });
  return () => { for (const name of events) window.removeEventListener(name, block, true); };
}
export function registerComposerFreezeParticipant(participant: Participant): () => void {
  invalidateComposerFreeze();
  participants.add(participant);
  return () => { participants.delete(participant); };
}
/** A lease covers the entire accepted operation, including upload/allocation and
 * cleanup. Freeze never aborts it. Steer leases survive until their reply. */
export function beginComposerOperation(kind: 'send' | 'steer' | 'queue-dispatch' | 'voice' | 'attachment', id: string = crypto.randomUUID()): (() => void) | null {
  if (lease || !id || usedOperationIds.has(id)) return null;
  const entry = { kind };
  usedOperationIds.add(id);
  operations.set(id, entry);
  return () => { if (operations.get(id) === entry) operations.delete(id); };
}
export function finishComposerOperation(id: string) { operations.delete(id); }

/** Must be rechecked immediately before handing evidence to native admission.
 * Serialized/forged receipts and receipts from an expired/replaced lease fail. */
export function isComposerFreezeCurrent(receipt: ComposerFreezeReceipt): boolean {
  if (lease && expired(lease)) thaw('timeout');
  if (lease?.receipt === receipt && lease.projections) {
    try { verifyComposerProjectionCoverage(lease.projections, [...receipt.drafts]); } catch { thaw('changed'); }
  }
  return Boolean(lease && !lease.invalidated && lease.receipt === receipt);
}

/** Final barrier before native commit. Returning true means both the mutation
 * gate and Window input capture are closed, not merely queued for React paint. */
export function sealComposerFreeze(receipt: ComposerFreezeReceipt): boolean {
  if (!isComposerFreezeCurrent(receipt) || !lease || operations.size) return false;
  const current = lease;
  if (!current.sealed) {
    current.sealed = true;
    clearTimeout(current.timer);
    current.releaseInput = installComposerSealInputGuard();
    publish();
  }
  return lease === current && !current.invalidated && !expired(current);
}

/** Epochs strictly increase within this page; TTL is 1..60,000 ms. Admission
 * closes before return. An ACK keeps the lease closed until matching cancel,
 * expiry, supersession, or new input. Rejections reopen it; callers inspect
 * `.reason`. A subsequent seal survives all automatic cleanup and requires an
 * explicit native rollback. Native still owns installation admission. */
export function prepareComposerFreeze(request: ComposerFreezeRequest): Promise<ComposerFreezeReceipt> {
  if (isComposerSealed()) return Promise.reject(new ComposerFreezeError('sealed'));
  if (typeof window === 'undefined') return Promise.reject(new ComposerStorageError('unavailable'));
  if (!request || typeof request.token !== 'string' || !request.token || request.token.length > 256 || !Number.isSafeInteger(request.epoch) || request.epoch < 0
    || !Number.isFinite(request.ttlMs) || request.ttlMs < 1 || request.ttlMs > 60_000) return Promise.reject(new ComposerFreezeError('invalid'));
  if (request.epoch <= lastEpoch) return Promise.reject(new ComposerFreezeError('stale'));
  lastEpoch = request.epoch;
  thaw('stale');
  // Set admission synchronously, before any persistence await or notification.
  return new Promise((resolve, reject) => {
    const current: Lease = {
      source: request,
      request: { ...request }, expiresAt: Date.now() + request.ttlMs, deadline: performance.now() + request.ttlMs, reject,
      timer: setTimeout(() => { if (lease === current) thaw('timeout'); }, request.ttlMs),
    };
    lease = current;
    publish();
    if (lease !== current) return;
    if (operations.size) { thaw('busy'); return; }
    const sources = [...participants];
    const storageChanged = () => invalidateComposerFreeze();
    window.addEventListener('storage', storageChanged);
    current.cleanup = () => window.removeEventListener('storage', storageChanged);
    let projections: ReturnType<typeof captureComposerProjections>;
    void Promise.resolve().then(() => {
      projections = captureComposerProjections();
      return Promise.all(sources.map((participant) => participant.flushAndVerify(() => lease === current && !expired(current))));
    }).then((results) => {
      if (lease !== current) return;
      if (expired(current)) { thaw('timeout'); return; }
      if (operations.size) { thaw('busy'); return; }
      verifyComposerProjectionCoverage(projections, results.flat());
      current.projections = projections;
      current.receipt = Object.freeze({ token: current.request.token, epoch: current.request.epoch, expiresAt: current.expiresAt,
        scope: 'page', installerAuthority: false, drafts: Object.freeze(results.flat().map((item) => Object.freeze(item))) });
      resolve(current.receipt);
    }).catch((error: unknown) => {
      if (lease !== current) return;
      if (current.sealed) { thaw('changed'); reject(error); return; }
      lease = undefined;
      clearTimeout(current.timer);
      current.cleanup?.();
      reject(error);
      publish();
    });
  });
}

/** Test isolation only; production callers use token-bound cancellation. */
export function resetComposerFreezeForTests() {
  thaw('cancelled', true);
  rollbackOwner = undefined;
  for (const participant of participants) participant.dispose?.();
  participants.clear();
  operations.clear();
  usedOperationIds.clear();
  lastEpoch = -1;
}
