function installDesktopUpdateBridge(token, origin, qaDiagnostics = false) {
  const name = '__GJC_DESKTOP_UPDATE__';
  const readyEvent = 'gajae:desktop-update-ready';
  let retired = false;
  let draftRegistration;
  let restartPromise;
  const outcomeEvent = `gajae:desktop-restart:${token}`;
  const id = (value) => typeof value === 'string' && value.length === 64 && /^[a-f0-9]+$/.test(value);
  const ensureCurrent = () => {
    if (retired || location.origin !== origin || window[name] !== bridge) {
      throw Error('updater_unauthorized');
    }
  };
  const rpc = async (command) => {
    ensureCurrent();
    const response = await fetch('/api/desktop/update', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Gajae-Update-View': token },
      body: JSON.stringify(command),
    });
    const data = await response.json();
    ensureCurrent();
    if (!response.ok) throw Error(data.error || 'updater_unavailable');
    return data;
  };
  const sameAttempt = (reply, request) => reply && reply.attemptId === request.token && reply.draftEpoch === request.epoch;
  const draftFailure = (error) => {
    // Surface a bounded diagnostic, never draft contents, paths or arbitrary
    // exception messages. A confirmed cancellation must not hide its cause.
    if (error?.name === 'ComposerFreezeError' && ['busy', 'changed', 'cancelled', 'timeout', 'stale', 'invalid', 'sealed'].includes(error.reason)) {
      return `updater_draft_${error.reason}`;
    }
    if (error?.name === 'ComposerStorageError' && ['unavailable', 'quota', 'limit', 'invalid', 'conflict', 'timeout', 'storage'].includes(error.reason)) {
      return `updater_draft_storage_${error.reason}`;
    }
    const browserErrors = { TypeError: 'type', ReferenceError: 'reference', SecurityError: 'security',
      DataCloneError: 'data_clone', NotReadableError: 'not_readable', NotFoundError: 'not_found', UnknownError: 'unknown',
      AbortError: 'abort', InvalidStateError: 'invalid_state' };
    if (Object.prototype.hasOwnProperty.call(browserErrors, error?.name)) return `updater_draft_browser_${browserErrors[error.name]}`;
    return error?.message === 'updater_draft_changed' ? 'updater_draft_changed' : 'updater_draft_prepare_failed';
  };
  const onAborted = (event) => {
    try {
      ensureCurrent();
      const reply = event.detail;
      if (reply?.kind !== 'restartAborted' || !id(reply.attemptId) || !Number.isSafeInteger(reply.draftEpoch) || reply.draftEpoch < 1) return;
      draftRegistration?.owner.cancel({ token: reply.attemptId, epoch: reply.draftEpoch });
    } catch { /* A retired/incompatible owner gains no editing or install authority. */ }
  };
  const restart = async () => {
    const registration = draftRegistration;
    if (!registration) throw Error('updater_draft_owner_unavailable');
    const challenge = await rpc({ action: 'restart' });
    if (challenge?.kind !== 'restartChallenge') return challenge;
    if (challenge.protocolVersion !== 1 || !id(challenge.attemptId)
      || !Number.isSafeInteger(challenge.draftEpoch) || challenge.draftEpoch < 1
      || !Number.isSafeInteger(challenge.ttlMs) || challenge.ttlMs < 1 || challenge.ttlMs > 5000) throw Error('updater_protocol_error');
    const request = { token: challenge.attemptId, epoch: challenge.draftEpoch, ttlMs: challenge.ttlMs };
    let prepared = false;
    try {
      const receipt = await registration.owner.prepare(request);
      ensureCurrent();
      if (draftRegistration !== registration || !registration.owner.isCurrent(receipt)
        || !registration.owner.seal(receipt)) throw Error('updater_draft_changed');
      prepared = true;
      const reply = await rpc({ action: 'restartPrepared', attemptId: request.token, draftEpoch: request.epoch });
      if (reply?.kind) {
        if (!sameAttempt(reply, request)) throw Error('updater_protocol_error');
        if (reply.kind === 'restartAborted') registration.owner.cancel(request);
        else if (reply.kind !== 'restartUncertain') throw Error('updater_protocol_error');
        return reply.snapshot;
      }
      return reply;
    } catch (error) {
      if (qaDiagnostics) console.warn('[updater-qa] restart preparation failed', error);
      // Native owns the transaction after the sealed ACK is sent. Its expected
      // Applying navigation can abort this document's fetch before pagehide;
      // cancelling here would race and cancel our own successful handoff.
      // Lost replies retain the seal until native confirms abort (or replaces
      // the document). Native deadlines also cover an ACK that never arrived.
      if (prepared) throw error;
      // A timeout/lost response is not cancellation: only native's exact
      // confirmed aborted reply/event may release the sealed page.
      try {
        const reply = await rpc({ action: 'restartCancel', attemptId: request.token, draftEpoch: request.epoch });
        if (sameAttempt(reply, request) && reply.kind === 'restartAborted') {
          registration.owner.cancel(request);
          return { ...reply.snapshot, reason: draftFailure(error) };
        }
        if (sameAttempt(reply, request) && reply.kind === 'restartUncertain') return reply.snapshot;
      } catch { /* Native's rollback event may still release the page later. */ }
      throw error;
    }
  };
  const request = (command) => {
    try {
      ensureCurrent();
      if (!command || typeof command !== 'object' || Array.isArray(command)
        || (command.action === 'setAutomatic' ? Object.keys(command).length !== 2 || typeof command.automatic !== 'boolean'
          : Object.keys(command).length !== 1 || !['status', 'check', 'restart'].includes(command.action))) {
        return Promise.reject(Error('updater_invalid_command'));
      }
      if (command.action !== 'restart') return rpc(command);
      if (!restartPromise) restartPromise = restart().finally(() => { restartPromise = undefined; });
      return restartPromise;
    } catch (error) { return Promise.reject(error); }
  };
  // Registration stores an in-page owner, not a durability acknowledgement.
  // No input is frozen and no restart is requested by registering this owner.
  const registerDraftOwner = (owner) => {
    ensureCurrent();
    if (!owner || typeof owner.prepare !== 'function' || typeof owner.isCurrent !== 'function'
      || typeof owner.seal !== 'function' || typeof owner.cancel !== 'function') throw Error('updater_invalid_draft_owner');
    if (draftRegistration) throw Error('updater_draft_owner_conflict');
    const registration = { owner };
    draftRegistration = registration;
    return () => {
      if (draftRegistration === registration) draftRegistration = undefined;
    };
  };
  const bridge = Object.freeze({ protocolVersion: 1, request, registerDraftOwner });
  const retire = () => {
    retired = true;
    draftRegistration = undefined;
    window.removeEventListener(readyEvent, replaced);
    window.removeEventListener('pagehide', retire);
    window.removeEventListener(outcomeEvent, onAborted);
  };
  const replaced = () => { if (window[name] !== bridge) retire(); };
  window.addEventListener(readyEvent, replaced);
  window.addEventListener('pagehide', retire);
  window.addEventListener(outcomeEvent, onAborted);
  Object.defineProperty(window, name, { configurable: true, value: bridge });
  window.dispatchEvent(new Event(readyEvent));
}
