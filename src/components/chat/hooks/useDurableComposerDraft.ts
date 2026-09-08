import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { SetStateAction } from 'react';

import { invalidateComposerFreeze, registerComposerFreezeParticipant, type ComposerDraftReceipt } from '../../../shared/composerFreeze';
import { draftInputKey, notifyQueuedMessages, queuedMessageKey, subscribeQueuedMessages } from '../utils/chatStorage';
import { composerQueueOwnerKey, readComposerQueueProjection } from '../utils/composerQueueProjection';
import { verifyCommittedComposerDraft } from '../utils/composerDraftVerification';
import {
  boundedComposerDraft, browserComposerDraftRepository, COMPOSER_STORAGE_LIMITS,
  composerRouteKey, composerStorageReason, ComposerStorageError,
  type ComposerDraft, type ComposerDraftRepository, type ComposerRoute, type DurableQueuedDraft,
} from '../utils/composerDraftStorage';

export type DraftPersistenceStatus = {
  phase: 'loading' | 'pending' | 'saved' | 'error' | 'unavailable';
  reason: ReturnType<typeof composerStorageReason> | null;
};
type Snapshot = ComposerDraft & { persistence: DraftPersistenceStatus };
type Entry = {
  snapshot: Snapshot;
  generation: number;
  revision: number;
  inputChanged: boolean;
  imagesChanged: boolean;
  queueChanged: boolean;
  loading?: Promise<void>;
  writing?: Promise<void>;
  retrying?: Promise<boolean>;
  loaded: boolean;
  loadFailed: boolean;
  writable: boolean;
  migrationBlocked: boolean;
  queueRaw: string | null;
  baseQueueIds: Set<string | undefined>;
};
const nextValue = <T,>(action: SetStateAction<T>, value: T): T => typeof action === 'function' ? (action as (old: T) => T)(value) : action;
export const newQueuedDraftId = () => `queued_${crypto.randomUUID()}`;
const retainedControllers = new Set<ComposerDraftController>();

/** A steer reply may reach a replacement composer after its owner unmounted.
 * The retained draft, not the replacement viewer's project, supplies the route. */
export function settleRetainedComposerSteer(sessionId: string, content: string, accepted: boolean): DurableQueuedDraft | undefined {
  for (const controller of retainedControllers) {
    const draft = controller.settleSteer(sessionId, content, accepted);
    if (draft) return draft;
  }
}

function legacyDraft(route: ComposerRoute): ComposerDraft {
  const empty: ComposerDraft = { ...route, input: '', images: [], queue: [] };
  if (!route.projectId || typeof localStorage === 'undefined') return empty;
  const inputKey = draftInputKey(route.projectId, route.conversation);
  const owner = localStorage.getItem(`composer_owner_${inputKey}`);
  const input = owner && owner !== composerRouteKey(route) ? '' : localStorage.getItem(inputKey) ?? '';
  const projection = readComposerQueueProjection(route);
  return { ...empty, input, queue: projection.foreign ? [] : projection.queue.map((item) => ({ ...item, images: [] })) };
}

/** One controller per mounted composer; records and async completions keep their own route. */
class ComposerDraftController {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  private publishing = false;
  private mounted = false;
  private unregister?: () => void;
  private disconnect?: () => void;
  constructor(private repository: ComposerDraftRepository) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private notify() { this.listeners.forEach((listener) => listener()); }
  entry(route: ComposerRoute): Entry {
    const key = composerRouteKey(route);
    let entry = this.entries.get(key);
    if (!entry) {
      const available = this.repository !== browserComposerDraftRepository || typeof indexedDB !== 'undefined';
      let initial: ComposerDraft = { ...route, input: '', images: [], queue: [] };
      let failure: ReturnType<typeof composerStorageReason> | null = null;
      let raw: string | null = null;
      try { initial = legacyDraft(route); raw = readComposerQueueProjection(route).raw; } catch (error) { failure = composerStorageReason(error); }
      entry = {
        snapshot: { ...initial, persistence: { phase: failure ? 'error' : available ? 'loading' : 'unavailable', reason: failure ?? (available ? null : 'unavailable') } },
        generation: 0, revision: 0, inputChanged: false, imagesChanged: false, queueChanged: false,
        loaded: !available, loadFailed: Boolean(failure), writable: available,
        migrationBlocked: Boolean(failure), queueRaw: raw, baseQueueIds: new Set(initial.queue.map((item) => item.id)),
      };
      this.entries.set(key, entry);
    }
    return entry;
  }
  private status(entry: Entry, persistence: DraftPersistenceStatus) {
    entry.snapshot = { ...entry.snapshot, persistence };
    this.notify();
  }
  connect() {
    this.mounted = true;
    this.retain();
    return () => { this.mounted = false; this.releaseEmpty(); };
  }
  private retain() {
    if (this.unregister || typeof window === 'undefined') return;
    retainedControllers.add(this);
    this.unregister = registerComposerFreezeParticipant(this);
    const refresh = (sessionId?: string) => {
      if (this.publishing) return;
      for (const entry of this.entries.values()) if (!sessionId || entry.snapshot.conversation === sessionId) {
        try { if (this.reconcile(entry)) this.schedule(entry); } catch (error) { this.failMigration(entry, error); }
      }
    };
    const unsubscribe = subscribeQueuedMessages(refresh);
    const storage = () => refresh();
    window.addEventListener('storage', storage);
    this.disconnect = () => { unsubscribe(); window.removeEventListener('storage', storage); };
  }
  dispose = () => {
    this.disconnect?.();
    this.disconnect = undefined;
    this.unregister?.();
    this.unregister = undefined;
    retainedControllers.delete(this);
  };
  private releaseEmpty() {
    if (this.mounted) return;
    for (const [key, entry] of this.entries) {
      if (entry.loading || entry.writing || entry.retrying || entry.snapshot.persistence.phase !== 'saved') continue;
      const live = entry.snapshot;
      const replaced = [...retainedControllers].some((other) => other !== this && other.mounted && other.repository === this.repository && other.entries.has(key));
      if (replaced || (!live.input && !live.images.length && !live.queue.length)) this.entries.delete(key);
    }
    if (!this.entries.size) this.dispose();
  }
  /** Retain unmounted dirty/error entries and their Files. A remount may replace
   * only a settled prior owner; CAS still rejects simultaneous live writers. */
  private retireSettledOwner(route: ComposerRoute) {
    const key = composerRouteKey(route);
    for (const prior of retainedControllers) {
      if (prior === this || prior.mounted || prior.repository !== this.repository) continue;
      const entry = prior.entries.get(key);
      if (!entry || entry.loading || entry.writing || entry.retrying || entry.snapshot.persistence.phase !== 'saved') continue;
      prior.entries.delete(key);
      prior.releaseEmpty();
    }
  }
  private failMigration(entry: Entry, error: unknown) {
    entry.migrationBlocked = true;
    entry.loadFailed = true;
    this.status(entry, { phase: 'error', reason: composerStorageReason(error) });
  }
  settleSteer(sessionId: string, content: string, accepted: boolean): DurableQueuedDraft | undefined {
    for (const entry of this.entries.values()) {
      if (entry.snapshot.conversation !== sessionId) continue;
      const draft = entry.snapshot.queue.find((item) => item.pendingSteer && item.content === content);
      if (!draft) continue;
      this.change(entry.snapshot, 'queue', (queue) => accepted
        ? queue.filter((item) => draft.id ? item.id !== draft.id : item !== draft)
        : queue.map((item) => (draft.id ? item.id === draft.id : item === draft) ? { ...item, pendingSteer: false } : item));
      return draft;
    }
  }
  /** The legacy consumer can retire a cached queue while another route is open. */
  private reconcile(entry: Entry): boolean {
    if (entry.migrationBlocked) return false;
    const projection = readComposerQueueProjection(entry.snapshot);
    if (projection.foreign || projection.raw === entry.queueRaw) return false;
    const remaining = [...entry.snapshot.queue];
    const queue = projection.queue.map((item) => {
      const index = remaining.findIndex((old) => item.id ? old.id === item.id : !old.id && old.content === item.content);
      const old = index < 0 ? undefined : remaining.splice(index, 1)[0];
      return { ...item, images: old?.images ?? [], ...(old?.requiresReview ? { requiresReview: true } : {}) };
    });
    entry.queueRaw = projection.raw;
    entry.queueChanged = true;
    entry.generation += 1;
    entry.snapshot = { ...entry.snapshot, queue };
    this.notify();
    return true;
  }
  activate(route: ComposerRoute) {
    invalidateComposerFreeze();
    this.retireSettledOwner(route);
    const entry = this.entry(route);
    try { if (this.reconcile(entry)) this.schedule(entry); } catch (error) { this.failMigration(entry, error); }
    void this.load(route);
  }
  load(route: ComposerRoute): Promise<void> {
    const entry = this.entry(route);
    if (entry.loading) return entry.loading;
    if (entry.loaded || entry.migrationBlocked || !route.projectId) return Promise.resolve();
    entry.loading = this.repository.load(route).then((record) => {
      if (record) entry.revision = record.revision;
      if (record && !record.absent) {
        const { draft } = boundedComposerDraft(record);
        if (composerRouteKey(draft) !== composerRouteKey(route)) throw new Error('Draft route mismatch');
        entry.snapshot = {
          ...entry.snapshot,
          // Typing/attachment events that beat IndexedDB always win. Never
          // restore an old draft over a newer keystroke or paste event.
          input: entry.inputChanged ? entry.snapshot.input : draft.input,
          images: entry.imagesChanged ? entry.snapshot.images : draft.images,
          queue: entry.queueChanged
            ? entry.snapshot.queue.map((item) => ({ ...item, images: item.images.length ? item.images : draft.queue.find((stored) => stored.id && stored.id === item.id)?.images ?? [], requiresReview: true }))
            : draft.queue.map((item) => ({ ...item, requiresReview: true })),
        };
        entry.baseQueueIds = new Set(draft.queue.map((item) => item.id));
      }
      entry.loaded = true;
      entry.loadFailed = false;
      // Recovered intents need review; newly queued text remains auto-sendable.
      this.mirror(entry);
      const needsSave = entry.generation > 0 || ((!record || record.absent) && Boolean(entry.snapshot.input || entry.snapshot.images.length || entry.snapshot.queue.length));
      this.status(entry, { phase: needsSave ? 'pending' : 'saved', reason: null });
      if (needsSave) this.schedule(entry);
    }).catch((error: unknown) => {
      entry.loadFailed = true;
      this.status(entry, { phase: 'error', reason: composerStorageReason(error) });
    }).finally(() => { entry.loading = undefined; });
    return entry.loading;
  }
  /** Compatibility projection only: never evict another draft to make room. */
  private mirror(entry: Entry) {
    const state = entry.snapshot;
    if (!state.projectId || typeof localStorage === 'undefined') return;
    if (entry.migrationBlocked) throw new ComposerStorageError(entry.snapshot.persistence.reason ?? 'invalid');
    boundedComposerDraft(state);
    const inputKey = draftInputKey(state.projectId, state.conversation);
    const routeKey = composerRouteKey(state);
    if (state.input) {
      localStorage.setItem(`composer_owner_${inputKey}`, routeKey);
      localStorage.setItem(inputKey, state.input);
    } else if (!localStorage.getItem(`composer_owner_${inputKey}`) || localStorage.getItem(`composer_owner_${inputKey}`) === routeKey) localStorage.removeItem(inputKey);
    if (state.conversation) {
      const key = queuedMessageKey(state.conversation);
      const prior = readComposerQueueProjection(state);
      if (prior.foreign && !state.queue.length) return;
      const projection = state.queue.map(({ id, content, options, pendingSteer, images, requiresReview }) => ({
          ...(id ? { id } : {}), content, ...(options === undefined ? {} : { options }),
          ...(pendingSteer ? { pendingSteer: true } : {}),
          ...(images.length ? { attachmentCount: images.length } : {}),
          ...(requiresReview ? { requiresReview: true } : {}),
          ...(entry.writable || images.length ? { composerRoute: routeKey } : {}),
        }));
      const raw = projection.length ? JSON.stringify(projection) : null;
      if (raw && raw.length > COMPOSER_STORAGE_LIMITS.textLength * 2) throw new ComposerStorageError('limit');
      localStorage.setItem(composerQueueOwnerKey(state.conversation), routeKey);
      if (raw === null) localStorage.removeItem(key); else localStorage.setItem(key, raw);
      entry.queueRaw = raw;
      if (prior.raw !== raw) {
        this.publishing = true;
        try { notifyQueuedMessages(state.conversation); } finally { this.publishing = false; }
        // A listener can synchronously send and consume this very projection.
        this.reconcile(entry);
      }
    }
  }
  change<K extends 'input' | 'images' | 'queue'>(route: ComposerRoute, field: K, action: SetStateAction<ComposerDraft[K]>) {
    invalidateComposerFreeze();
    this.retain();
    const entry = this.entry(route);
    try { this.reconcile(entry); } catch (error) { this.failMigration(entry, error); }
    const value = nextValue(action, entry.snapshot[field]);
    if (field === 'input') entry.inputChanged = true;
    if (field === 'images') entry.imagesChanged = true;
    if (field === 'queue') entry.queueChanged = true;
    if (value === entry.snapshot[field] && entry.loaded) return;
    entry.snapshot = { ...entry.snapshot, [field]: value };
    entry.generation += 1;
    try {
      this.mirror(entry);
      if (entry.loadFailed) this.notify();
      else this.status(entry, { phase: entry.writable ? 'pending' : 'unavailable', reason: entry.writable ? null : 'unavailable' });
    } catch (error) { this.status(entry, { phase: 'error', reason: composerStorageReason(error) }); }
    this.schedule(entry);
    // A captured voice/attachment callback may arrive after an empty owner was
    // unmounted and released. Its new route entry still needs an actual load.
    if (!entry.loaded) void this.load(route);
  }
  private schedule(entry: Entry) {
    if (!entry.writable || !entry.loaded || entry.loadFailed || entry.writing || !entry.snapshot.projectId) return;
    // Coalesce same-event text/files/queue mutations; never create an unbounded
    // promise backlog while typing. At most one write and one latest snapshot.
    entry.writing = Promise.resolve().then(async () => {
      let savedGeneration: number;
      do {
        this.reconcile(entry);
        this.mirror(entry);
        savedGeneration = entry.generation;
        const { draft } = boundedComposerDraft(entry.snapshot);
        entry.revision = await this.repository.save(draft, entry.revision);
      } while (savedGeneration !== entry.generation);
      this.status(entry, { phase: 'saved', reason: null });
    }).catch((error: unknown) => {
      const reason = composerStorageReason(error);
      // A concurrent writer is not permission to overwrite its newer revision.
      if (reason === 'conflict') entry.loadFailed = true;
      this.status(entry, { phase: 'error', reason });
    }).finally(() => { entry.writing = undefined; this.releaseEmpty(); });
  }
  flushAndVerify = async (isCurrent: () => boolean): Promise<ComposerDraftReceipt[]> => {
    const receipts: ComposerDraftReceipt[] = [];
    for (const entry of this.entries.values()) {
      if (!isCurrent()) return [];
      const route = entry.snapshot;
      if (!route.projectId) {
        if (route.input || route.images.length || route.queue.length) throw new ComposerStorageError('unavailable');
        continue;
      }
      await this.load(route);
      await entry.retrying;
      await entry.writing;
      if (!isCurrent()) return [];
      if (!entry.writable) throw new ComposerStorageError('unavailable');
      if (entry.loadFailed || entry.snapshot.persistence.phase === 'error') throw new ComposerStorageError(entry.snapshot.persistence.reason ?? 'storage');
      // Also commit recovered review flags and any offscreen queue retirement.
      // No retry/rebase here: a restart receipt cannot overwrite a CAS conflict.
      this.schedule(entry);
      await entry.writing;
      if (!isCurrent()) return [];
      if (entry.snapshot.persistence.phase !== 'saved') throw new ComposerStorageError(entry.snapshot.persistence.reason ?? 'storage');
      const { draft } = boundedComposerDraft(entry.snapshot);
      const generation = entry.generation;
      const revision = entry.revision;
      await verifyCommittedComposerDraft(this.repository, draft, revision);
      if (!isCurrent()) return [];
      if (generation !== entry.generation || revision !== entry.revision) throw new ComposerStorageError('conflict');
      receipts.push({ routeKey: composerRouteKey(draft), revision, generation,
        fileCount: draft.images.length + draft.queue.reduce((count, item) => count + item.images.length, 0), queuedIntentCount: draft.queue.length });
    }
    return receipts;
  };
  /** Explicit user retry, not a restart receipt. Rebase against the current CAS revision. */
  retry(route: ComposerRoute): Promise<boolean> {
    invalidateComposerFreeze();
    this.retain();
    const entry = this.entry(route);
    if (!entry.retrying) entry.retrying = this.retryOnce(route).finally(() => { entry.retrying = undefined; });
    return entry.retrying;
  }
  private async retryOnce(route: ComposerRoute): Promise<boolean> {
    const entry = this.entry(route);
    await entry.loading;
    await entry.writing;
    try {
      // Incomplete legacy migration cannot be made successful by overwriting
      // its raw source with the empty placeholder displayed by a failed load.
      const legacy = readComposerQueueProjection(route);
      const record = await this.repository.load(route);
      const stored = record && !record.absent ? boundedComposerDraft(record).draft : null;
      if (stored && composerRouteKey(stored) !== composerRouteKey(route)) throw new ComposerStorageError('invalid');
      const live = entry.snapshot;
      const liveIds = new Set(live.queue.map((item) => item.id));
      const deleted = new Set([...entry.baseQueueIds].filter((id) => id && !liveIds.has(id)));
      const canonical = stored?.queue ?? [];
      const canonicalIds = new Set(canonical.map((item) => item.id));
      const additions = live.queue.filter((item) => !entry.baseQueueIds.has(item.id) && !canonicalIds.has(item.id));
      const queue = stored
        ? [...canonical.filter((item) => !deleted.has(item.id)), ...additions].map((item) => ({ ...item, requiresReview: true }))
        : live.queue;
      entry.snapshot = { ...live,
        input: entry.loaded || entry.inputChanged ? live.input : stored?.input ?? live.input,
        images: entry.loaded || entry.imagesChanged ? live.images : stored?.images ?? live.images,
        queue,
      };
      entry.revision = record?.revision ?? 0;
      entry.baseQueueIds = new Set(canonical.map((item) => item.id));
      entry.queueRaw = legacy.raw;
      entry.loaded = true;
      entry.writable = true;
      entry.loadFailed = false;
      entry.migrationBlocked = false;
      entry.generation += 1;
      this.status(entry, { phase: 'pending', reason: null });
      this.schedule(entry);
      await entry.writing;
      return entry.snapshot.persistence.phase === 'saved';
    } catch (error) {
      entry.loadFailed = true;
      this.status(entry, { phase: 'error', reason: composerStorageReason(error) });
      return false;
    }
  }
}

/**
 * Unsent drafts only. The page registry includes offscreen entries and retains
 * unmounted pending writes. Neither `saved` nor its receipt grants native
 * restart authority, attests to other windows, or prevents browser eviction.
 */
export function useDurableComposerDraft(projectId: string | undefined, conversation: string | null, repository = browserComposerDraftRepository) {
  const [controller] = useState(() => new ComposerDraftController(repository));
  const routeProject = projectId ?? '';
  const snapshot = useSyncExternalStore(controller.subscribe,
    () => controller.entry({ projectId: routeProject, conversation }).snapshot,
    () => controller.entry({ projectId: routeProject, conversation }).snapshot);
  useEffect(() => controller.connect(), [controller]);
  useEffect(() => { controller.activate({ projectId: routeProject, conversation }); }, [controller, conversation, routeProject]);
  const setInput = useCallback((action: SetStateAction<string>) => controller.change({ projectId: routeProject, conversation }, 'input', action), [controller, conversation, routeProject]);
  const setImages = useCallback((action: SetStateAction<File[]>) => controller.change({ projectId: routeProject, conversation }, 'images', action), [controller, conversation, routeProject]);
  const setQueue = useCallback((action: SetStateAction<DurableQueuedDraft[]>) => controller.change({ projectId: routeProject, conversation }, 'queue', action), [controller, conversation, routeProject]);
  const getQueue = useCallback((route: ComposerRoute) => controller.entry(route).snapshot.queue, [controller]);
  const updateQueue = useCallback((route: ComposerRoute, action: SetStateAction<DurableQueuedDraft[]>) => {
    invalidateComposerFreeze();
    const entry = controller.entry(route);
    if (entry.loaded) controller.change(route, 'queue', action);
    else void controller.load(route).then(() => { if (!entry.loadFailed) controller.change(route, 'queue', action); });
  }, [controller]);
  const retryPersistence = useCallback(() => controller.retry({ projectId: routeProject, conversation }), [controller, conversation, routeProject]);
  const current = controller.entry({ projectId: routeProject, conversation });
  return { input: snapshot.input, images: snapshot.images, queue: snapshot.queue, persistence: snapshot.persistence, ready: current.loaded && !current.loadFailed, retryPersistence, setInput, setImages, setQueue, getQueue, updateQueue };
}
