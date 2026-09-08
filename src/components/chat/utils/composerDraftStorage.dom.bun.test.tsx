import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { browserComposerDraftRepository, boundedComposerDraft, COMPOSER_STORAGE_LIMITS, composerStorageReason, type ComposerDraft } from './composerDraftStorage';

const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
afterEach(() => {
  if (originalIndexedDB) Object.defineProperty(globalThis, 'indexedDB', originalIndexedDB);
  else Reflect.deleteProperty(globalThis, 'indexedDB');
});
const draft = (): ComposerDraft => ({ projectId: 'qa', conversation: 'a', input: 'unsent', images: [new File(['image'], 'file.png', { type: 'image/png', lastModified: 42 })], queue: [] });

// A deliberately small event driver: request success and transaction completion
// are controlled separately. It is not an IndexedDB polyfill or clone proof.
function transactionDriver(sizeRows: Array<{ key: string; value: unknown }> = []) {
  const puts: unknown[] = [];
  const deletes: unknown[] = [];
  let options: IDBTransactionOptions | undefined;
  let cursorIndex = 0;
  let closed = false;
  let aborted = false;
  const cursorRequest = { result: null as unknown, onsuccess: null as (() => void) | null };
  const next = () => queueMicrotask(() => {
    const row = sizeRows[cursorIndex++];
    cursorRequest.result = row ? { ...row, continue: next } : null;
    cursorRequest.onsuccess?.();
  });
  const transaction = {
    error: null as DOMException | null,
    oncomplete: null as (() => void) | null,
    onabort: null as (() => void) | null,
    abort() { aborted = true; queueMicrotask(() => transaction.onabort?.()); },
    objectStore(store: string) { return { openCursor() { next(); return cursorRequest; }, put(value: unknown) { puts.push(value); return {}; }, delete(key: unknown) { deletes.push({ store, key }); return {}; } }; },
  };
  const db = {
    close() { closed = true; },
    transaction(_stores: string[], _mode: IDBTransactionMode, settings?: IDBTransactionOptions) { options = settings; return transaction; },
  };
  const factory = {
    open() {
      const request = { result: db, onsuccess: null as (() => void) | null };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  };
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: factory });
  return { transaction, puts, deletes, get options() { return options; }, get closed() { return closed; }, get aborted() { return aborted; } };
}
const tick = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };

test('put success cannot acknowledge persistence before the strict transaction completes', async () => {
  const driver = transactionDriver();
  let acknowledged = false;
  const result = browserComposerDraftRepository.save(draft(), 0).then((revision) => { acknowledged = true; return revision; });
  await tick();
  assert.equal(driver.puts.length, 3);
  assert.deepEqual(driver.options, { durability: 'strict' });
  assert.equal(acknowledged, false);
  assert.equal(driver.closed, false);
  driver.transaction.oncomplete?.();
  assert.equal(await result, 1);
  assert.equal(driver.closed, true);
});

test('quota abort after successful puts rejects instead of acknowledging saved data', async () => {
  const driver = transactionDriver();
  const result = browserComposerDraftRepository.save(draft(), 0);
  const rejected = assert.rejects(result, (error) => composerStorageReason(error) === 'quota');
  await tick();
  assert.equal(driver.puts.length, 3);
  driver.transaction.error = new DOMException('full', 'QuotaExceededError');
  driver.transaction.onabort?.();
  await rejected;
  assert.equal(driver.closed, true);
});

test('a conflicting revision is rejected before any File bytes are replaced', async () => {
  const driver = transactionDriver([{ key: JSON.stringify(['qa', 'a']), value: { bytes: 20, revision: 4 } }]);
  await assert.rejects(browserComposerDraftRepository.save(draft(), 3), (error) => composerStorageReason(error) === 'conflict');
  assert.equal(driver.aborted, true);
  assert.deepEqual(driver.puts, []);
});

test('the aggregate byte budget refuses new writes without evicting other drafts', async () => {
  const driver = transactionDriver([{ key: 'another draft', value: { bytes: COMPOSER_STORAGE_LIMITS.totalBytes, revision: 1 } }]);
  await assert.rejects(browserComposerDraftRepository.save(draft(), 0), (error) => composerStorageReason(error) === 'limit');
  assert.deepEqual(driver.puts, []);
});

test('schema copy retains File metadata and excludes unknown transcript fields', () => {
  const value = { ...draft(), transcript: [{ content: 'must not persist' }] };
  const { draft: copied } = boundedComposerDraft(value);
  assert.equal('transcript' in copied, false);
  assert.equal(copied.images[0].lastModified, 42);
  assert.throws(() => boundedComposerDraft({ ...draft(), queue: [{ id: 'x', content: '1', images: [] }, { id: 'x', content: '2', images: [] }] }), (error) => composerStorageReason(error) === 'invalid');
  assert.throws(() => boundedComposerDraft({ ...draft(), images: Array.from({ length: 6 }, () => draft().images[0]) }), (error) => composerStorageReason(error) === 'limit');
});

test('an empty visit does not allocate a record or consume a revision', async () => {
  const driver = transactionDriver();
  const result = browserComposerDraftRepository.save({ ...draft(), input: '', images: [] }, 0);
  await tick(); driver.transaction.oncomplete?.();
  assert.equal(await result, 0);
  assert.deepEqual(driver.puts, []);
  assert.deepEqual(driver.deletes, []);
});

test('clearing frees File payloads and bounds tombstones without revision-zero reuse', async () => {
  const key = JSON.stringify(['qa', 'a']);
  const rows = Array.from({ length: COMPOSER_STORAGE_LIMITS.tombstones }, (_, index) => ({ key: `cleared-${index}`, value: { bytes: 0, revision: index + 1, empty: true } }));
  const driver = transactionDriver([...rows, { key, value: { bytes: 100, revision: 129 } }]);
  const result = browserComposerDraftRepository.save({ ...draft(), input: '', images: [] }, 129);
  for (let i = 0; i < 20; i += 1) await tick();
  driver.transaction.oncomplete?.();
  assert.equal(await result, 130);
  assert.deepEqual(driver.deletes, [{ store: 'drafts', key }, { store: 'sizes', key: 'cleared-0' }]);
  assert.deepEqual(driver.puts, [{ bytes: 0, revision: 130, empty: true }, { clock: 130, absenceEpoch: 130 }]);
  const stale = transactionDriver([{ key: 'composer-clock', value: { clock: 130, absenceEpoch: 130 } }]);
  await assert.rejects(browserComposerDraftRepository.save(draft(), 0), (error) => composerStorageReason(error) === 'conflict');
  assert.deepEqual(stale.puts, []);
});
