import type { ComposerDraftReceipt } from '../../../shared/composerFreeze';

import { boundedComposerDraft, composerRouteKey, ComposerStorageError, normalizeComposerStorageError, readComposerFileBytes, type ComposerDraft, type ComposerDraftRepository } from './composerDraftStorage';

/** Read committed data back, including every File byte (metadata alone is not
 * attachment durability). Never use localStorage as a durability receipt. */
export async function verifyCommittedComposerDraft(repository: ComposerDraftRepository, expected: ComposerDraft, revision: number) {
  try { await verifyDraft(repository, expected, revision); } catch (error) { throw normalizeComposerStorageError(error); }
}

async function verifyDraft(repository: ComposerDraftRepository, expected: ComposerDraft, revision: number) {
  const record = await repository.load(expected);
  if (!record) {
    if (revision === 0 && !expected.input && !expected.images.length && !expected.queue.length) return;
    throw new ComposerStorageError('conflict');
  }
  if (record.revision !== revision) throw new ComposerStorageError('conflict');
  const { draft: actual } = boundedComposerDraft(record);
  const metadata = (draft: ComposerDraft) => JSON.stringify(draft, (_key, value: unknown) => value instanceof File
    ? { name: value.name, type: value.type, size: value.size, lastModified: value.lastModified } : value);
  if (metadata(boundedComposerDraft(expected).draft) !== metadata(actual)) throw new ComposerStorageError('conflict');
  const files = (draft: ComposerDraft) => [...draft.images, ...draft.queue.flatMap((item) => item.images)];
  const originals = files(expected);
  const stored = files(actual);
  for (let index = 0; index < originals.length; index += 1) {
    const left = new Uint8Array(await readComposerFileBytes(originals[index]));
    const right = new Uint8Array(await readComposerFileBytes(stored[index]));
    if (left.length !== right.length || left.some((byte, offset) => byte !== right[offset])) throw new ComposerStorageError('conflict');
  }
}

/** An orphan legacy projection is not proof that its full intent was saved.
 * Refuse restart until a composer has hydrated/migrated that route. */
export function captureComposerProjections(): Map<string, { raw: string; owner: string | null }> {
  if (typeof localStorage === 'undefined') throw new ComposerStorageError('unavailable');
  const result = new Map<string, { raw: string; owner: string | null }>();
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key || (!key.startsWith('draft_input_') && !key.startsWith('queued_message_'))) continue;
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    const ownerKey = key.startsWith('draft_input_') ? `composer_owner_${key}` : `composer_queue_owner_${key.slice('queued_message_'.length)}`;
    result.set(key, { raw, owner: localStorage.getItem(ownerKey) });
  }
  return result;
}
export function verifyComposerProjectionCoverage(before: ReturnType<typeof captureComposerProjections>, receipts: ComposerDraftReceipt[]) {
  const after = captureComposerProjections();
  if (before.size !== after.size) throw new ComposerStorageError('conflict');
  const routes = new Set(receipts.map((item) => item.routeKey));
  for (const [key, value] of after) {
    if (value.raw !== before.get(key)?.raw || value.owner !== before.get(key)?.owner) throw new ComposerStorageError('conflict');
    if (!value.owner || !routes.has(value.owner)) throw new ComposerStorageError('unavailable');
    // Validate the owner schema too; never turn arbitrary web strings into a
    // route identity or native authority.
    let route: unknown;
    try { route = JSON.parse(value.owner); } catch { throw new ComposerStorageError('invalid'); }
    if (!Array.isArray(route) || route.length !== 2 || typeof route[0] !== 'string' || (route[1] !== null && typeof route[1] !== 'string')
      || composerRouteKey({ projectId: route[0], conversation: route[1] }) !== value.owner) throw new ComposerStorageError('invalid');
  }
}
