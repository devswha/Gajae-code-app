import {
  DESKTOP_UPDATE_BRIDGE_EVENT, DESKTOP_UPDATE_BRIDGE_NAME, DESKTOP_UPDATE_PROTOCOL,
  isDesktopUpdateCommand, isDesktopUpdateSnapshot,
  type DesktopUpdateBridge, type DesktopUpdateCommand, type DesktopUpdateSnapshot,
} from '../../shared/desktopUpdateProtocol';

type ConnectionError = 'unavailable' | 'invalidResponse' | 'timeout';
export type DesktopUpdateError = 'busy' | 'changed' | 'failed';
export type DesktopUpdateState = {
  bridgeActive: boolean;
  connected: boolean;
  snapshot: DesktopUpdateSnapshot | null;
  pending: DesktopUpdateCommand['action'] | null;
  error: ConnectionError | null;
  awaitingOperation: boolean;
  updating: boolean;
  updateError: DesktopUpdateError | null;
};
const initial = (): DesktopUpdateState => ({ bridgeActive: false, connected: false, snapshot: null,
  pending: null, error: null, awaitingOperation: false, updating: false, updateError: null });
export const desktopUpdateServerState = initial();
const isBridge = (value: unknown): value is DesktopUpdateBridge => value !== null && typeof value === 'object'
  && (value as DesktopUpdateBridge).protocolVersion === DESKTOP_UPDATE_PROTOCOL
  && typeof (value as DesktopUpdateBridge).request === 'function';
function updateFailure(reason: unknown): DesktopUpdateError {
  if (typeof reason !== 'string') return 'failed';
  if (['updater_busy', 'updater_runtime_changed', 'updater_draft_busy', 'updater_draft_changed'].includes(reason)) return 'busy';
  if (['updater_target_changed', 'candidate_changed', 'candidate_ineligible', 'updater_target_mismatch'].includes(reason)) return 'changed';
  return 'failed';
}

/** One connection and click intent per document, shared by Sidebar and About.
 * A disconnected/unmounted/replaced document never resumes an old install click. */
export function createDesktopUpdateClient(host: Window) {
  let state = initial();
  const listeners = new Set<() => void>();
  let disposed = true;
  let epoch = 0;
  let current: unknown;
  let authenticated = false;
  let snapshot: DesktopUpdateSnapshot | null = null;
  let poll: number | undefined;
  type Request = { promise: Promise<void>; finish: () => void; timedOut: boolean };
  type Intent = { targetId: string; epoch: number; stage: 'download' | 'restart'; accepted: boolean };
  let active: Request | null = null;
  let operation: Request | null = null;
  let intent: Intent | null = null;
  const injection = () => (host as unknown as Record<string, unknown>)[DESKTOP_UPDATE_BRIDGE_NAME];
  const publish = (patch: Partial<DesktopUpdateState>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };
  const clearIntent = (error: DesktopUpdateError | null) => {
    intent = null;
    publish({ updating: false, updateError: error });
  };
  function observeIntent(value: DesktopUpdateSnapshot) {
    if (!intent || intent.stage === 'restart') return;
    if (intent.epoch !== epoch || value.targetId !== intent.targetId) { clearIntent('changed'); return; }
    if (['disabled', 'idle', 'deferred', 'error', 'recovery'].includes(value.phase)) clearIntent(updateFailure(value.reason));
  }
  function advance() {
    if (disposed || !intent || intent.stage !== 'download' || !intent.accepted
      || intent.epoch !== epoch || active || operation || !authenticated || !snapshot) return;
    if (snapshot.targetId !== intent.targetId) { clearIntent('changed'); return; }
    if (snapshot.phase !== 'ready') return;
    if (!snapshot.installationAvailable) { clearIntent('failed'); return; }
    // Claim once before issuing a mutation. Later status events cannot retry.
    intent.stage = 'restart';
    void send({ action: 'restart', targetId: intent.targetId });
  }
  function send(command: DesktopUpdateCommand): Promise<void> {
    if (disposed || !isDesktopUpdateCommand(command)) return Promise.resolve();
    if (injection() !== current) { attach(); return active?.promise ?? Promise.resolve(); }
    if (!isBridge(current)) return Promise.resolve();
    if (command.action !== 'status') {
      if (!authenticated || !snapshot || operation) return Promise.resolve();
      if (['disabled', 'recovery', 'applying', 'restarting'].includes(snapshot.phase)) return Promise.resolve();
      if (intent && !['download', 'restart'].includes(command.action)) return Promise.resolve();
      if (command.action === 'restart' || command.action === 'download') {
        if (!snapshot.installationAvailable || snapshot.targetId !== command.targetId
          || snapshot.phase !== (command.action === 'restart' ? 'ready' : 'available')) return Promise.resolve();
      }
    }
    if (active) return active.promise;
    const bridge = current;
    const requestEpoch = epoch;
    const requestIntent = intent;
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    const token: Request = { promise, finish, timedOut: false };
    active = token;
    if (command.action !== 'status') operation = token;
    const timeout = host.setTimeout(() => {
      if (!ownsRequest()) return;
      token.timedOut = true;
      authenticated = false;
      if (intent) clearIntent('failed');
      publish({ connected: false, pending: null, error: 'timeout', awaitingOperation: operation === token });
      finish();
    }, 10_000);
    publish({ pending: command.action });
    function finish() { host.clearTimeout(timeout); if (active === token) active = null; resolve(); }
    function sameEpoch() {
      if (disposed || requestEpoch !== epoch) return false;
      if (injection() !== bridge) { attach(); return false; }
      return true;
    }
    function ownsRequest() { return sameEpoch() && active === token; }
    function fail(error: ConnectionError, reason?: unknown) {
      if (!ownsRequest()) return;
      authenticated = false;
      if (intent) clearIntent(updateFailure(reason));
      publish({ connected: false, pending: null, error });
    }
    // The UI timeout does not cancel native work or permit a duplicate write.
    void Promise.resolve().then(() => ownsRequest() ? bridge.request(command) : undefined).then(value => {
      if (!ownsRequest()) return;
      if (!isDesktopUpdateSnapshot(value)) { fail('invalidResponse'); return; }
      snapshot = Object.freeze({ ...value });
      if (command.action === 'status') authenticated = true;
      if (requestIntent && intent === requestIntent) {
        if (command.action === 'download') requestIntent.accepted = true;
        if (command.action === 'restart') clearIntent(
          ['applying', 'restarting'].includes(value.phase) ? null : updateFailure(value.reason),
        );
      }
      observeIntent(value);
      publish({ connected: true, snapshot, pending: null, error: operation?.timedOut ? 'timeout' : null });
    }, error => {
      const reason = error instanceof Error ? error.message : undefined;
      if (ownsRequest() && requestIntent && intent === requestIntent
        && (reason === 'updater_busy' || reason === 'updater_retry_later')) {
        // An authenticated refusal is not a lost desktop connection. Retire
        // this click and let the user retry; never schedule another attempt.
        clearIntent(updateFailure(reason));
        publish({ pending: null, error: null });
        return;
      }
      fail('unavailable', reason);
    }).finally(() => {
      finish();
      if (!sameEpoch()) return;
      if (operation === token) {
        operation = null;
        publish({ awaitingOperation: false });
        if (token.timedOut) void send({ action: 'status' });
      }
      advance();
    });
    return promise;
  }
  function attach() {
    if (disposed) return;
    epoch += 1;
    active?.finish();
    operation = null;
    authenticated = false;
    host.clearInterval(poll);
    current = injection();
    const interrupted = intent !== null;
    intent = null;
    publish({ bridgeActive: state.bridgeActive || current !== undefined, connected: false,
      pending: null, awaitingOperation: false, updating: false,
      updateError: interrupted ? 'changed' : null,
      error: isBridge(current) ? null : (state.bridgeActive || current !== undefined ? 'unavailable' : null) });
    if (isBridge(current)) {
      void send({ action: 'status' });
      const pollEpoch = epoch;
      poll = host.setInterval(() => { if (epoch === pollEpoch) void send({ action: 'status' }); }, 3_000);
    }
  }
  function stop() {
    disposed = true;
    epoch += 1;
    active?.finish();
    host.clearInterval(poll);
    host.removeEventListener(DESKTOP_UPDATE_BRIDGE_EVENT, attach);
    intent = null; operation = null; authenticated = false; snapshot = null;
    state = initial();
  }
  function update() {
    if (disposed || active || operation || intent || !authenticated || !snapshot
      || !snapshot.installationAvailable || !snapshot.targetId
      || !['available', 'ready'].includes(snapshot.phase)) return Promise.resolve();
    if (injection() !== current) { attach(); return Promise.resolve(); }
    intent = { targetId: snapshot.targetId, epoch, stage: snapshot.phase === 'ready' ? 'restart' : 'download', accepted: false };
    publish({ updating: true, updateError: null });
    return send({ action: intent.stage === 'restart' ? 'restart' : 'download', targetId: intent.targetId });
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (disposed) {
        disposed = false;
        host.addEventListener(DESKTOP_UPDATE_BRIDGE_EVENT, attach);
        attach();
      }
      return () => { listeners.delete(listener); if (listeners.size === 0) stop(); };
    },
    refresh: () => send({ action: 'status' }),
    check: () => send({ action: 'check' }),
    setAutomatic: (automatic: boolean) => send({ action: 'setAutomatic', automatic }),
    restart: () => snapshot?.phase === 'ready' ? update() : Promise.resolve(),
    update,
  };
}
