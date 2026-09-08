import { captureComposerProjections, verifyComposerProjectionCoverage } from '../components/chat/utils/composerDraftVerification';
import { ComposerStorageError } from '../components/chat/utils/composerDraftStorage';

/** Page-local admission and durability evidence only. This module cannot install,
 * restart, authenticate a native caller, or attest to another window/server. */
export type ComposerFreezeRequest = { token: string; epoch: number; ttlMs: number };
export type ComposerDraftReceipt = {
  routeKey: string; revision: number; generation: number; fileCount: number; queuedIntentCount: number;
};
export type ComposerFreezeReceipt = Readonly<{
  token: string; epoch: number; expiresAt: number; scope: 'page'; installerAuthority: false;
  drafts: readonly Readonly<ComposerDraftReceipt>[];
}>;
type Participant = { flushAndVerify(isCurrent: () => boolean): Promise<ComposerDraftReceipt[]>; dispose?(): void };
export class ComposerFreezeError extends Error {
  constructor(public readonly reason: 'busy' | 'changed' | 'cancelled' | 'timeout' | 'stale' | 'invalid') {
    super(`Composer freeze: ${reason}`);
    this.name = 'ComposerFreezeError';
  }
}
type Lease = {
  request: ComposerFreezeRequest; expiresAt: number; deadline: number; timer: ReturnType<typeof setTimeout>;
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
const publish = () => listeners.forEach((listener) => listener());
export const subscribeComposerFreeze = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const isComposerFrozen = () => Boolean(lease);
const expired = (current: Lease) => Date.now() >= current.expiresAt || performance.now() >= current.deadline;

function thaw(reason: ComposerFreezeError['reason']) {
  if (!lease) return;
  const prior = lease;
  lease = undefined;
  clearTimeout(prior.timer);
  prior.cleanup?.();
  prior.reject(new ComposerFreezeError(reason));
  publish();
}
/** Input is never discarded to preserve an ACK. An edit revokes the lease first. */
export function invalidateComposerFreeze() { thaw('changed'); }
export function cancelComposerFreeze(request: Pick<ComposerFreezeRequest, 'token' | 'epoch'>): boolean {
  if (!lease || lease.request.token !== request.token || lease.request.epoch !== request.epoch) return false;
  thaw('cancelled');
  return true;
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
  return Boolean(lease && lease.receipt === receipt);
}

/** Epochs strictly increase within this page; TTL is 1..60,000 ms. Admission
 * closes before return. An ACK keeps the lease closed until matching cancel,
 * expiry, supersession, or new input. Rejections reopen it; callers inspect
 * `.reason`. Native must still own and validate installation admission. */
export function prepareComposerFreeze(request: ComposerFreezeRequest): Promise<ComposerFreezeReceipt> {
  if (typeof window === 'undefined') return Promise.reject(new ComposerStorageError('unavailable'));
  if (!request || typeof request.token !== 'string' || !request.token || request.token.length > 256 || !Number.isSafeInteger(request.epoch) || request.epoch < 0
    || !Number.isFinite(request.ttlMs) || request.ttlMs < 1 || request.ttlMs > 60_000) return Promise.reject(new ComposerFreezeError('invalid'));
  if (request.epoch <= lastEpoch) return Promise.reject(new ComposerFreezeError('stale'));
  lastEpoch = request.epoch;
  thaw('stale');
  // Set admission synchronously, before any persistence await or notification.
  return new Promise((resolve, reject) => {
    const current: Lease = {
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
  thaw('cancelled');
  for (const participant of participants) participant.dispose?.();
  participants.clear();
  operations.clear();
  usedOperationIds.clear();
  lastEpoch = -1;
}
