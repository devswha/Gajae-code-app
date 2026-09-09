import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { waitFor } from '@testing-library/react';

import { browserComposerDraftRepository, boundedComposerDraft, COMPOSER_STORAGE_LIMITS, composerRouteKey, ComposerStorageError, composerStorageReason, type ComposerDraft, type StoredComposerDraft } from './composerDraftStorage';
import { installComposerDraftStorageTestDriver } from './composerDraftStorage.testDriver';
import { verifyCommittedComposerDraft } from './composerDraftVerification';

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

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
const svg = () => new File(['<svg xmlns="http://www.w3.org/2000/svg"><text>picker-like fixture</text></svg>'.padEnd(172, ' ')], 'fixture.svg', { type: 'image/svg+xml', lastModified: 1234567 });
const completeDraft = (): ComposerDraft => ({ ...draft(), images: [svg()], queue: [
  { id: 'queued-1', content: 'follow up', images: [new File([new Uint8Array([0, 255, 42, 0])], '한글.png', { type: 'image/png', lastModified: -42 })], options: { model: 'fixture/model', effort: 'xhigh', sessionSummary: 'queued summary' }, pendingSteer: true, requiresReview: true },
  { id: 'queued-2', content: 'text only', images: [], options: { effort: 'default' } },
] });
type WireFile = { name: string; type: string; size: number; lastModified: number; bytes: ArrayBuffer };
type WireRecord = Omit<StoredComposerDraft, 'images' | 'queue'> & { schemaVersion: number; images: WireFile[]; queue: Array<Omit<ComposerDraft['queue'][number], 'images'> & { images: WireFile[] }> };
const rawRecord = (driver: ReturnType<typeof installComposerDraftStorageTestDriver>, value: ComposerDraft) => driver.records.get(composerRouteKey(value)) as WireRecord;
function seedLegacy(driver: ReturnType<typeof installComposerDraftStorageTestDriver>, value = completeDraft()) {
  const record = { ...value, revision: 7 };
  const key = composerRouteKey(value);
  driver.records.set(key, record);
  driver.sizes.set(key, { bytes: boundedComposerDraft(value).bytes, revision: 7 });
  driver.sizes.set('composer-clock', { clock: 7, absenceEpoch: 0 });
  return record;
}

test('real repository stores only v2 byte payloads and round-trips exact active/queued File metadata', async () => {
  const driver = installComposerDraftStorageTestDriver(); const value = completeDraft();
  const revision = await browserComposerDraftRepository.save({ ...value, transcript: ['excluded'] } as ComposerDraft, 0);
  const raw = rawRecord(driver, value);
  assert.equal(raw.schemaVersion, 2); assert.equal('transcript' in raw, false);
  const sourceFiles = [...value.images, ...value.queue.flatMap((item) => item.images)];
  const rawFiles = [...raw.images, ...raw.queue.flatMap((item) => item.images)];
  for (let index = 0; index < sourceFiles.length; index += 1) {
    const file = sourceFiles[index]; const encoded = rawFiles[index];
    assert.equal(encoded instanceof File, false); assert.ok(encoded.bytes instanceof ArrayBuffer);
    assert.deepEqual(encoded, { name: file.name, type: file.type, size: file.size, lastModified: file.lastModified, bytes: await file.arrayBuffer() });
  }
  const reopened = (await browserComposerDraftRepository.load(value))!;
  assert.notEqual(reopened.images[0], value.images[0]); assert.ok(reopened.images[0] instanceof File);
  assert.deepEqual(reopened.queue.map(({ images: _images, ...item }) => item), value.queue.map(({ images: _images, ...item }) => item));
  await verifyCommittedComposerDraft(browserComposerDraftRepository, value, revision);
  assert.deepEqual(driver.transactions.filter((item) => item.mode === 'readwrite'), [{ mode: 'readwrite', options: { durability: 'strict' } }]);
  assert.equal(driver.closes, driver.opens);
});

test('rewrite/reopen keeps previously loaded Files independent of the overwritten record and buffers', async () => {
  const driver = installComposerDraftStorageTestDriver(); driver.controls.invalidateLegacyOnPut = true;
  const value = completeDraft();
  await browserComposerDraftRepository.save(value, 0);
  const retained = (await browserComposerDraftRepository.load(value))!;
  const revision = await browserComposerDraftRepository.save(retained, retained.revision);
  const reopened = (await browserComposerDraftRepository.load(value))!;
  assert.notEqual(reopened.images[0], retained.images[0]);
  await verifyCommittedComposerDraft(browserComposerDraftRepository, retained, revision);
  // Mutating the synthetic backing record cannot mutate either loaded File.
  new Uint8Array(rawRecord(driver, value).images[0].bytes).fill(0);
  assert.deepEqual(await retained.images[0].arrayBuffer(), await value.images[0].arrayBuffer());
  assert.deepEqual(await reopened.images[0].arrayBuffer(), await value.images[0].arrayBuffer());
});

test('readable legacy Files detach before a CAS rewrite migrates the complete record to v2', async () => {
  const driver = installComposerDraftStorageTestDriver(); driver.controls.invalidateLegacyOnPut = true;
  const legacy = seedLegacy(driver);
  const restored = (await browserComposerDraftRepository.load(legacy))!;
  assert.equal(driver.commits, 0, 'loading/migration decoding is read-only');
  assert.equal(driver.records.get(composerRouteKey(legacy)), legacy);
  assert.equal(restored.revision, 7);
  const revision = await browserComposerDraftRepository.save(restored, 7);
  assert.equal(revision, 8); assert.equal(rawRecord(driver, legacy).schemaVersion, 2);
  await verifyCommittedComposerDraft(browserComposerDraftRepository, restored, revision);
  await verifyCommittedComposerDraft(browserComposerDraftRepository, legacy, revision);
  assert.deepEqual(await restored.images[0].arrayBuffer(), await legacy.images[0].arrayBuffer());
  assert.deepEqual(await restored.queue[0].images[0].arrayBuffer(), await legacy.queue[0].images[0].arrayBuffer());
});

for (const location of ['active', 'queued'] as const) {
  test(`unreadable ${location} legacy File rejects load and rewrite without changing its record or revision`, async () => {
    const driver = installComposerDraftStorageTestDriver(); const legacy = seedLegacy(driver);
    const file = location === 'active' ? legacy.images[0] : legacy.queue[0].images[0];
    const failure = new DOMException('Synthetic missing picker-backed Blob', 'NotFoundError');
    file.arrayBuffer = async () => { throw failure; };
    const rejects = (error: unknown) => error instanceof ComposerStorageError && error.reason === 'storage' && error.cause === failure;
    await assert.rejects(browserComposerDraftRepository.load(legacy), rejects);
    const opens = driver.opens;
    await assert.rejects(browserComposerDraftRepository.save(legacy, 7), rejects);
    assert.equal(driver.opens, opens, 'all File bytes must be copied before opening a write connection');
    assert.equal(driver.commits, 0); assert.equal(driver.records.get(composerRouteKey(legacy)), legacy);
    assert.equal((driver.sizes.get(composerRouteKey(legacy)) as { revision: number }).revision, 7);
  });
}

test('CAS is checked after pre-transaction File reads, so a concurrent writer cannot be overwritten', async () => {
  const driver = installComposerDraftStorageTestDriver(); const value = completeDraft();
  const gate = deferred(); let reading = false;
  const file = value.images[0]; const arrayBuffer = file.arrayBuffer.bind(file);
  file.arrayBuffer = async () => { reading = true; await gate.promise; return arrayBuffer(); };
  const pending = browserComposerDraftRepository.save(value, 0);
  const rejected = assert.rejects(pending, (error) => composerStorageReason(error) === 'conflict');
  await waitFor(() => assert.equal(reading, true)); assert.equal(driver.opens, 0);
  const winner = { ...completeDraft(), input: 'other writer' };
  await browserComposerDraftRepository.save(winner, 0);
  gate.resolve(); await rejected;
  assert.equal(driver.commits, 1); assert.equal(rawRecord(driver, winner).input, 'other writer');
  assert.equal(rawRecord(driver, winner).revision, 1);
});

test('missing, truncated, and oversized File reads cannot open a write or replace old bytes', async () => {
  for (const bytes of [new ArrayBuffer(0), new ArrayBuffer(3), new ArrayBuffer(173)]) {
    const driver = installComposerDraftStorageTestDriver(); const value = completeDraft();
    value.images[0].arrayBuffer = async () => bytes;
    await assert.rejects(browserComposerDraftRepository.save(value, 0), (error) => composerStorageReason(error) === 'conflict');
    assert.equal(driver.opens, 0); assert.equal(driver.records.size, 0);
  }
});

test('stalled File copying times out without a write transaction or a late write after recovery', async () => {
  const driver = installComposerDraftStorageTestDriver(); const value = completeDraft(); const gate = deferred();
  const file = value.images[0]; const arrayBuffer = file.arrayBuffer.bind(file);
  file.arrayBuffer = async () => { await gate.promise; return arrayBuffer(); };
  await assert.rejects(browserComposerDraftRepository.save(value, 0), (error) => composerStorageReason(error) === 'timeout');
  gate.resolve(); await tick();
  assert.equal(driver.opens, 0); assert.equal(driver.records.size, 0);
});

test('unsupported strict durability fails closed without a fallback write or migrated legacy record', async () => {
  const driver = installComposerDraftStorageTestDriver(); const legacy = seedLegacy(driver);
  const restored = (await browserComposerDraftRepository.load(legacy))!;
  const failure = new TypeError('Synthetic unsupported strict transaction'); driver.controls.strictFailure = failure;
  await assert.rejects(browserComposerDraftRepository.save(restored, 7), (error) => error instanceof ComposerStorageError && error.reason === 'storage' && error.cause === failure);
  assert.equal(driver.commits, 0); assert.equal(driver.records.get(composerRouteKey(legacy)), legacy);
  assert.equal(driver.closes, driver.opens);
});

for (const malformed of ['version', 'buffer length', 'buffer type', 'metadata', 'MIME case', 'file count', 'file bytes', 'queue options'] as const) {
  test(`v2 ${malformed} corruption is rejected rather than normalized into a partial draft`, async () => {
    const driver = installComposerDraftStorageTestDriver(); const value = completeDraft();
    await browserComposerDraftRepository.save(value, 0);
    const raw = rawRecord(driver, value);
    if (malformed === 'version') raw.schemaVersion = 99;
    if (malformed === 'buffer length') raw.images[0].bytes = new ArrayBuffer(0);
    if (malformed === 'buffer type') Object.assign(raw.images[0], { bytes: new Uint8Array(172) });
    if (malformed === 'metadata') raw.images[0].lastModified = NaN;
    if (malformed === 'MIME case') raw.images[0].type = 'image/SVG+XML';
    if (malformed === 'file count') raw.images = Array.from({ length: 6 }, () => raw.images[0]);
    if (malformed === 'file bytes') raw.images[0].size = COMPOSER_STORAGE_LIMITS.fileBytes + 1;
    if (malformed === 'queue options') Object.assign(raw.queue[0], { options: [] });
    await assert.rejects(browserComposerDraftRepository.load(value), (error) => ['invalid', 'limit'].includes(composerStorageReason(error)));
    assert.equal(driver.commits, 1, 'failed decoding must not repair, delete, or migrate a record');
    assert.equal(driver.records.get(composerRouteKey(value)), raw);
  });
}

test('byte-backed records still clear into CAS tombstones and never turn a corrupt present record into absence', async () => {
  const driver = installComposerDraftStorageTestDriver(); const value = completeDraft();
  const first = await browserComposerDraftRepository.save(value, 0);
  const second = await browserComposerDraftRepository.save({ ...value, input: '', images: [], queue: [] }, first);
  assert.equal(driver.records.size, 0);
  const cleared = (await browserComposerDraftRepository.load(value))!;
  assert.equal(cleared.revision, second); assert.equal(cleared.absent, undefined);
  await assert.rejects(browserComposerDraftRepository.save(value, first), (error) => composerStorageReason(error) === 'conflict');
  driver.records.set(composerRouteKey(value), null);
  await assert.rejects(browserComposerDraftRepository.load(value), (error) => composerStorageReason(error) === 'invalid');
});
