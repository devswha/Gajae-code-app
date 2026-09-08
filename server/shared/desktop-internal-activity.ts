import { randomUUID } from 'node:crypto';

import type { DesktopOwnerActivity } from '../../shared/desktopUpdateProtocol.js';

import type { DesktopWorkAdmission } from './interfaces.js';

const epoch = randomUUID();
let revision = 0n;
let active = 0;
let admission: DesktopWorkAdmission | undefined;
const uncertainty = new Set<string>();

export function configureInternalDesktopAdmission(value: DesktopWorkAdmission): void {
  if (admission && admission !== value) throw new Error('Internal desktop admission already configured.');
  if (admission === value) return;
  admission = value;
  revision++;
}

/** Server-owned source names only. Acquire synchronously before the first await.
 * Release after real settlement, or a synchronous transfer to a counted owner.
 * `owned` is for a proven existing continuation, never a request-payload flag. */
export function enterInternalActivity(source: string, owned = false): () => void {
  if (!/^[a-z][a-z0-9:_-]{0,127}$/u.test(source)) throw new TypeError('An internal activity source is required.');
  const release = owned ? admission?.enterCompletion(source) : admission?.enter(source);
  active++;
  revision++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active--;
    revision++;
    release?.();
  };
}

export async function withInternalActivity<T>(source: string, action: () => T | Promise<T>, owned = false): Promise<T> {
  const release = enterInternalActivity(source, owned);
  try { return await action(); }
  finally { release(); }
}

/** Bounded reason codes only; failed cleanup must not become an idle proof. */
export function markInternalActivityUncertain(reason: string): void {
  if (!/^[a-z][a-z0-9:_-]{0,127}$/u.test(reason)) throw new TypeError('An internal uncertainty code is required.');
  if (uncertainty.has(reason)) return;
  const code = uncertainty.size < 31 ? reason : 'internal_uncertainty_overflow';
  if (!uncertainty.has(code)) { uncertainty.add(code); revision++; }
}

export const getInternalActivityGeneration = (): string => `${epoch}:${revision}`;

/** Only audited callers of this primitive, NOT an all-backend idle certificate.
 * Child generations/native clients and other execution owners remain separate. */
export function snapshotInternalActivity(): DesktopOwnerActivity {
  return {
    owner: 'internal-producers', generation: getInternalActivityGeneration(), complete: uncertainty.size === 0,
    starting: 0, queued: 0, running: active, settling: 0, approvals: 0, retained: 0,
    unknown: [...uncertainty],
  };
}
