import type { QueuedSendOptions } from './chatStorage';

// Unsent input only. Never pass provider messages/transcripts to this store.
export type DurableQueuedDraft = {
  id?: string;
  content: string;
  images: File[];
  options?: QueuedSendOptions;
  pendingSteer?: boolean;
  /** Recovered intents are not evidence that the previous process did not send. */
  requiresReview?: boolean;
};
export type ComposerRoute = { projectId: string; conversation: string | null };
export type ComposerDraft = ComposerRoute & {
  input: string;
  images: File[];
  queue: DurableQueuedDraft[];
};
export type StoredComposerDraft = ComposerDraft & { revision: number; absent?: true };
export interface ComposerDraftRepository {
  load(route: ComposerRoute): Promise<StoredComposerDraft | null>;
  /** Resolves after transaction completion, not after the put request succeeds. */
  save(draft: ComposerDraft, expectedRevision: number): Promise<number>;
}

export const composerRouteKey = (route: ComposerRoute) => JSON.stringify([route.projectId, route.conversation]);
export const COMPOSER_STORAGE_LIMITS = {
  records: 128,
  tombstones: 128,
  totalBytes: 128 * 1024 * 1024,
  recordBytes: 64 * 1024 * 1024,
  textLength: 512 * 1024,
  queueLength: 100,
  filesPerIntent: 5,
  fileBytes: 5 * 1024 * 1024,
  optionsLength: 16 * 1024,
  timeoutMs: 2000,
} as const;

export class ComposerStorageError extends Error {
  constructor(public readonly reason: 'unavailable' | 'quota' | 'limit' | 'invalid' | 'conflict' | 'timeout' | 'storage', public readonly cause?: unknown) {
    super(`Composer draft storage: ${reason}`);
    this.name = 'ComposerStorageError';
  }
}

export function composerStorageReason(error: unknown): ComposerStorageError['reason'] {
  if (error instanceof ComposerStorageError) return error.reason;
  if (error && typeof error === 'object' && 'name' in error && error.name === 'QuotaExceededError') return 'quota';
  return 'storage';
}

export const normalizeComposerStorageError = (error: unknown): ComposerStorageError => error instanceof ComposerStorageError
  ? error : new ComposerStorageError(composerStorageReason(error), error);

type FileMetadata = Pick<File, 'name' | 'type' | 'size' | 'lastModified'>;
type ByteFile = FileMetadata & { bytes: ArrayBuffer };
type DraftWithFiles<T> = Omit<ComposerDraft, 'images' | 'queue'> & {
  images: T[];
  queue: Array<Omit<DurableQueuedDraft, 'images'> & { images: T[] }>;
};
type ByteDraft = DraftWithFiles<ByteFile> & { schemaVersion: 2 };

/** One bound for both the live File schema and the persisted byte schema. On
 * load this runs before constructing any Files or copying attachment buffers. */
function boundDraft<T extends FileMetadata>(value: DraftWithFiles<T>, validateFile: (file: T) => void): { draft: DraftWithFiles<T>; bytes: number } {
  const limits = COMPOSER_STORAGE_LIMITS;
  let bytes = 0;
  const text = (item: unknown, max = limits.textLength): string => {
    if (typeof item !== 'string') throw new ComposerStorageError('invalid');
    if (item.length > max) throw new ComposerStorageError('limit');
    bytes += item.length * 2;
    return item;
  };
  const files = (items: T[]): T[] => {
    if (!Array.isArray(items)) throw new ComposerStorageError('invalid');
    if (items.length > limits.filesPerIntent) throw new ComposerStorageError('limit');
    return items.map((file) => {
      if (!file || typeof file !== 'object' || typeof file.type !== 'string' || !file.type.startsWith('image/')
        || !Number.isSafeInteger(file.size) || file.size <= 0 || !Number.isSafeInteger(file.lastModified)) throw new ComposerStorageError('invalid');
      if (file.size > limits.fileBytes) throw new ComposerStorageError('limit');
      text(file.name, 1024);
      text(file.type, 1024);
      validateFile(file);
      bytes += file.size;
      return file;
    });
  };
  if (!value || typeof value !== 'object') throw new ComposerStorageError('invalid');
  if (!Array.isArray(value.queue)) throw new ComposerStorageError('invalid');
  if (value.queue.length > limits.queueLength) throw new ComposerStorageError('limit');
  const ids = new Set<string>();
  const draft: DraftWithFiles<T> = {
    projectId: text(value.projectId, 2048),
    conversation: value.conversation === null ? null : text(value.conversation, 2048),
    input: text(value.input),
    images: files(value.images),
    queue: value.queue.map((item) => {
      if (!item || typeof item !== 'object') throw new ComposerStorageError('invalid');
      const id = item.id === undefined ? undefined : text(item.id, 256);
      if (id !== undefined && (!id || ids.has(id))) throw new ComposerStorageError('invalid');
      if (id) ids.add(id);
      // Queue options are small JSON metadata, never uploaded image bodies or a
      // second transcript. File bytes belong exclusively in `images`.
      const rawOptions = item.options === undefined ? undefined : JSON.stringify(item.options);
      if (rawOptions !== undefined) text(rawOptions, limits.optionsLength);
      const options: unknown = rawOptions === undefined ? undefined : JSON.parse(rawOptions);
      if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options))) throw new ComposerStorageError('invalid');
      return {
        ...(id ? { id } : {}), content: text(item.content), images: files(item.images),
        ...(options === undefined ? {} : { options: options as QueuedSendOptions }),
        ...(item.pendingSteer ? { pendingSteer: true } : {}),
        ...(item.requiresReview ? { requiresReview: true } : {}),
      };
    }),
  };
  if (!draft.projectId || bytes > limits.recordBytes) throw new ComposerStorageError('limit');
  return { draft, bytes };
}

/** Validate and copy only the supported draft schema before structured cloning. */
export function boundedComposerDraft(value: ComposerDraft): { draft: ComposerDraft; bytes: number } {
  return boundDraft(value, (file) => { if (!(file instanceof File)) throw new ComposerStorageError('invalid'); });
}

/** A metadata-only File is not durability evidence. Bound a stalled/unreadable
 * browser Blob read too, and never accept truncated (including empty) bytes. */
export function readComposerFileBytes(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => { finished = true; reject(new ComposerStorageError('timeout')); }, COMPOSER_STORAGE_LIMITS.timeoutMs);
    void Promise.resolve().then(() => file.arrayBuffer()).then((buffer) => {
      if (finished) return;
      if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== file.size) throw new ComposerStorageError('conflict');
      const copy = buffer.slice(0);
      finished = true;
      clearTimeout(timer);
      resolve(copy);
    }).catch((error: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(normalizeComposerStorageError(error));
    });
  });
}

async function encodeDraft(value: ComposerDraft): Promise<{ draft: ByteDraft; bytes: number }> {
  const { draft, bytes } = boundedComposerDraft(value);
  const encodeFiles = async (files: File[]): Promise<ByteFile[]> => {
    const result: ByteFile[] = [];
    for (const file of files) result.push({ name: file.name, type: file.type, size: file.size, lastModified: file.lastModified, bytes: await readComposerFileBytes(file) });
    return result;
  };
  const images = await encodeFiles(draft.images);
  const queue: ByteDraft['queue'] = [];
  for (const item of draft.queue) queue.push({ ...item, images: await encodeFiles(item.images) });
  return { draft: { ...draft, images, queue, schemaVersion: 2 }, bytes };
}

async function decodeRecord(value: unknown, route: ComposerRoute): Promise<StoredComposerDraft> {
  if (!value || typeof value !== 'object') throw new ComposerStorageError('invalid');
  const record = value as ByteDraft & { revision: number };
  if (composerRouteKey(record) !== composerRouteKey(route) || !Number.isSafeInteger(record.revision) || record.revision < 1) throw new ComposerStorageError('invalid');
  // Readable legacy Files are detached BEFORE any later save can overwrite
  // their IDB record (WebKit can revoke those Blob backing resources on put).
  // Loading never writes: the next successful CAS save migrates to v2. A
  // failed legacy read leaves the original record and revision untouched.
  if ('schemaVersion' in record && record.schemaVersion !== 2) throw new ComposerStorageError('invalid');
  const encoded = 'schemaVersion' in record ? record : (await encodeDraft(value as ComposerDraft)).draft;
  const { draft } = boundDraft(encoded, (file) => {
    if (!(file.bytes instanceof ArrayBuffer) || file.bytes.byteLength !== file.size
      || file.type !== file.type.toLowerCase() || /[^\x20-\x7e]/.test(file.type)) throw new ComposerStorageError('invalid');
  });
  const restoreFiles = (files: ByteFile[]) => files.map((file) => new File([file.bytes], file.name, { type: file.type, lastModified: file.lastModified }));
  return { ...draft, images: restoreFiles(draft.images), queue: draft.queue.map((item) => ({ ...item, images: restoreFiles(item.images) })), revision: record.revision };
}

const DATABASE = 'gajae-composer-drafts-v1';
const DRAFTS = 'drafts';
const SIZES = 'sizes';
const CLOCK = 'composer-clock';
type SizeRecord = { bytes: number; revision: number; empty?: boolean };
type StorageClock = { clock: number; absenceEpoch: number };
const emptyDraft = (draft: Pick<ComposerDraft, 'input'> & { images: unknown[]; queue: unknown[] }) => !draft.input.length && !draft.images.length && !draft.queue.length;

function validClock(value: StorageClock | undefined): StorageClock {
  if (value === undefined) return { clock: 0, absenceEpoch: 0 };
  if (!Number.isSafeInteger(value.clock) || value.clock < 0 || !Number.isSafeInteger(value.absenceEpoch) || value.absenceEpoch < 0 || value.absenceEpoch > value.clock) throw new ComposerStorageError('invalid');
  return value;
}

async function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') throw new ComposerStorageError('unavailable');
  return new Promise((resolve, reject) => {
    let finished = false;
    const request = indexedDB.open(DATABASE, 1);
    const fail = (error: unknown) => { finished = true; clearTimeout(timer); reject(error); };
    const timer = setTimeout(() => fail(new ComposerStorageError('timeout')), COMPOSER_STORAGE_LIMITS.timeoutMs);
    request.onblocked = () => fail(new ComposerStorageError('unavailable'));
    request.onerror = () => fail(request.error);
    request.onupgradeneeded = () => {
      if (finished) { request.transaction?.abort(); return; }
      request.result.createObjectStore(DRAFTS);
      request.result.createObjectStore(SIZES);
    };
    request.onsuccess = () => {
      const db = request.result;
      if (finished) { db.close(); return; }
      finished = true;
      clearTimeout(timer);
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

function transactionResult<T>(db: IDBDatabase, transaction: IDBTransaction, work: (set: (value: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let value: T;
    let failure: unknown;
    const timer = setTimeout(() => {
      failure = new ComposerStorageError('timeout');
      try { transaction.abort(); } catch { /* Already completed; never acknowledge from this timer. */ }
      db.close();
      reject(failure);
    }, COMPOSER_STORAGE_LIMITS.timeoutMs);
    const finish = () => { clearTimeout(timer); db.close(); };
    transaction.oncomplete = () => { finish(); if (failure) reject(failure); else resolve(value); };
    transaction.onabort = () => { finish(); reject(failure ?? transaction.error ?? new ComposerStorageError('storage')); };
    const fail = (error: unknown) => { failure = error; transaction.abort(); };
    try { work((next) => { value = next; }, fail); } catch (error) { fail(error); }
  });
}

const repository: ComposerDraftRepository = {
  async load(route) {
    const db = await openDatabase();
    let transaction: IDBTransaction;
    try { transaction = db.transaction([DRAFTS, SIZES], 'readonly'); } catch (error) { db.close(); throw error; }
    const result = await transactionResult<{ record: unknown } | { empty: StoredComposerDraft }>(db, transaction, (set, fail) => {
      const key = composerRouteKey(route);
      const request = transaction.objectStore(DRAFTS).get(key);
      request.onsuccess = () => {
        try {
          if (request.result === undefined) {
            const sizeRequest = transaction.objectStore(SIZES).get(key);
            sizeRequest.onsuccess = () => {
              const size = sizeRequest.result as SizeRecord | undefined;
              if (size && (size.empty !== true || size.bytes !== 0 || !Number.isSafeInteger(size.revision) || size.revision < 1)) { fail(new ComposerStorageError('invalid')); return; }
              const clockRequest = transaction.objectStore(SIZES).get(CLOCK);
              clockRequest.onsuccess = () => {
                try {
                  const { absenceEpoch } = validClock(clockRequest.result);
                  // Missing records carry an epoch, so pruning a bounded
                  // tombstone can never resurrect an old revision-zero writer.
                  set({ empty: { ...route, input: '', images: [], queue: [], revision: size?.revision ?? -absenceEpoch, ...(size ? {} : { absent: true as const }) } });
                } catch (error) { fail(error); }
              };
            };
            return;
          }
          set({ record: request.result });
        } catch (error) { fail(error); }
      };
    });
    return 'empty' in result ? result.empty : decodeRecord(result.record, route);
  },
  async save(value, expectedRevision) {
    // No File/Blob reaches IDB, and no await occurs inside the write transaction.
    // If ANY active/queued attachment cannot be copied, do not open a write at all.
    const { draft, bytes } = await encodeDraft(value);
    const key = composerRouteKey(draft);
    const db = await openDatabase();
    let transaction: IDBTransaction;
    try {
      // Unsupported strict durability is an honest persistence failure, not a
      // silently downgraded restart acknowledgement.
      transaction = db.transaction([DRAFTS, SIZES], 'readwrite', { durability: 'strict' });
    } catch (error) { db.close(); throw error; }
    return transactionResult(db, transaction, (set, fail) => {
      const sizes = transaction.objectStore(SIZES);
      let total = 0;
      let count = 0;
      let own: SizeRecord | undefined;
      let clock = 0;
      let absenceEpoch = 0;
      const tombstones: Array<{ key: IDBValidKey; revision: number }> = [];
      const cursor = sizes.openCursor();
      cursor.onsuccess = () => {
        try {
          const row = cursor.result;
          if (row) {
            if (row.key === CLOCK) {
              const meta = validClock(row.value);
              clock = Math.max(clock, meta.clock);
              absenceEpoch = meta.absenceEpoch;
              row.continue(); return;
            }
            const entry = row.value as SizeRecord;
            if (!Number.isSafeInteger(entry?.bytes) || entry.bytes < 0 || !Number.isSafeInteger(entry.revision) || entry.revision < 1) throw new ComposerStorageError('invalid');
            if (entry.empty && entry.bytes !== 0) throw new ComposerStorageError('invalid');
            clock = Math.max(clock, entry.revision);
            if (row.key === key) own = entry;
            else if (entry.empty) {
              if (entry.bytes !== 0) throw new ComposerStorageError('invalid');
              tombstones.push({ key: row.key, revision: entry.revision });
            } else { count += 1; total += entry.bytes; }
            if (count > COMPOSER_STORAGE_LIMITS.records || tombstones.length > COMPOSER_STORAGE_LIMITS.tombstones || total > COMPOSER_STORAGE_LIMITS.totalBytes) throw new ComposerStorageError('limit');
            row.continue();
            return;
          }
          if ((own?.revision ?? -absenceEpoch) !== expectedRevision) throw new ComposerStorageError('conflict');
          if (emptyDraft(draft) && (!own || own.empty)) { set(expectedRevision); return; }
          const revision = clock + 1;
          if (!Number.isSafeInteger(revision)) throw new ComposerStorageError('limit');
          if (emptyDraft(draft)) {
            // Delete payload bytes on explicit clear/send. Retain only bounded
            // revision tombstones; never evict a live unsent draft for quota.
            transaction.objectStore(DRAFTS).delete(key);
            while (tombstones.length >= COMPOSER_STORAGE_LIMITS.tombstones) {
              tombstones.sort((a, b) => a.revision - b.revision);
              sizes.delete(tombstones.shift()!.key);
              absenceEpoch = revision;
            }
            sizes.put({ bytes: 0, revision, empty: true }, key);
          } else {
            if (count >= COMPOSER_STORAGE_LIMITS.records || total + bytes > COMPOSER_STORAGE_LIMITS.totalBytes) throw new ComposerStorageError('limit');
            transaction.objectStore(DRAFTS).put({ ...draft, revision }, key);
            sizes.put({ bytes, revision }, key);
          }
          sizes.put({ clock: revision, absenceEpoch }, CLOCK);
          set(revision);
        } catch (error) { fail(error); }
      };
    });
  },
};

export const browserComposerDraftRepository: ComposerDraftRepository = {
  async load(route) {
    try { return await repository.load(route); } catch (error) { throw normalizeComposerStorageError(error); }
  },
  async save(draft, expectedRevision) {
    try { return await repository.save(draft, expectedRevision); } catch (error) { throw normalizeComposerStorageError(error); }
  },
};
