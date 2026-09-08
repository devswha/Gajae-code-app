// Test-only event driver for the REAL browserComposerDraftRepository. Byte
// records use structuredClone; legacy Files have an optional synthetic backing
// resource lifetime. This is not WebKit/IndexedDB conformance certification.
export function installComposerDraftStorageTestDriver() {
  const records = new Map<string, unknown>();
  const sizes = new Map<string, unknown>();
  const epochs = new Map<string, number>();
  const transactions: Array<{ mode: IDBTransactionMode; options?: IDBTransactionOptions }> = [];
  let opens = 0; let closes = 0; let commits = 0; let aborts = 0;
  const controls = { invalidateLegacyOnPut: false, strictFailure: undefined as unknown };

  function clone(value: unknown, key: string): unknown {
    if (value instanceof File) {
      const file = new File([value], value.name, { type: value.type, lastModified: value.lastModified });
      const epoch = epochs.get(key) ?? 0;
      file.arrayBuffer = async () => {
        if (controls.invalidateLegacyOnPut && epoch !== (epochs.get(key) ?? 0)) throw new DOMException('Synthetic retired Blob backing resource', 'NotFoundError');
        return value.arrayBuffer();
      };
      return file;
    }
    if (value instanceof ArrayBuffer) return structuredClone(value);
    if (Array.isArray(value)) return value.map((item) => clone(item, key));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, clone(item, key)]));
    return value;
  }

  function transaction(_stores: string[], mode: IDBTransactionMode, options?: IDBTransactionOptions) {
    transactions.push({ mode, options });
    if (mode === 'readwrite' && controls.strictFailure) throw controls.strictFailure;
    const staged = { drafts: new Map(records), sizes: new Map(sizes) };
    const changed = new Set<string>();
    let active = true; let pending = 0;
    const tx = {
      error: null as DOMException | null,
      oncomplete: null as (() => void) | null,
      onabort: null as (() => void) | null,
      abort() {
        if (!active) return;
        active = false; aborts += 1;
        queueMicrotask(() => tx.onabort?.());
      },
      objectStore(store: string) {
        const data = staged[store as keyof typeof staged];
        if (!data) throw new Error('Unexpected test object store');
        return {
          get(key: string) {
            const request = { result: undefined as unknown, onsuccess: null as (() => void) | null };
            enqueue(() => { request.result = clone(data.get(key), key); request.onsuccess?.(); });
            return request;
          },
          openCursor() {
            const rows = [...data]; let position = 0;
            const request = { result: null as unknown, onsuccess: null as (() => void) | null };
            const next = () => enqueue(() => {
              const row = rows[position++];
              request.result = row ? { key: row[0], value: clone(row[1], row[0]), continue: next } : null;
              request.onsuccess?.();
            });
            next();
            return request;
          },
          put(value: unknown, key: string) {
            if (!active || mode !== 'readwrite') throw new DOMException('Inactive test transaction', 'InvalidStateError');
            data.set(key, clone(value, key));
            if (store === 'drafts') changed.add(key);
            return {};
          },
          delete(key: string) {
            if (!active || mode !== 'readwrite') throw new DOMException('Inactive test transaction', 'InvalidStateError');
            data.delete(key);
            if (store === 'drafts') changed.add(key);
            return {};
          },
        };
      },
    };
    function enqueue(work: () => void) {
      pending += 1;
      queueMicrotask(() => {
        if (!active) return;
        try { work(); } catch (error) { tx.error = error as DOMException; tx.abort(); }
        pending -= 1;
        queueMicrotask(() => {
          if (!active || pending) return;
          active = false;
          if (mode === 'readwrite') {
            records.clear(); sizes.clear();
            for (const [key, value] of staged.drafts) records.set(key, value);
            for (const [key, value] of staged.sizes) sizes.set(key, value);
            for (const key of changed) epochs.set(key, (epochs.get(key) ?? 0) + 1);
            commits += 1;
          }
          tx.oncomplete?.();
        });
      });
    }
    return tx;
  }
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: {
    open() {
      opens += 1;
      const request = { result: { close() { closes += 1; }, transaction }, onsuccess: null as (() => void) | null };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  } });
  return { records, sizes, transactions, controls, get opens() { return opens; }, get closes() { return closes; }, get commits() { return commits; }, get aborts() { return aborts; } };
}
