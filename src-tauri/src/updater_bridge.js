function installDesktopUpdateBridge(token, origin) {
  const name = '__GJC_DESKTOP_UPDATE__';
  const readyEvent = 'gajae:desktop-update-ready';
  let retired = false;
  let draftRegistration;
  const ensureCurrent = () => {
    if (retired || location.origin !== origin || window[name] !== bridge) {
      throw Error('updater_unauthorized');
    }
  };
  const request = async (command) => {
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
  // Registration stores an in-page owner, not a durability acknowledgement.
  // No input is frozen and no restart is requested by registering this owner.
  const registerDraftOwner = (owner) => {
    ensureCurrent();
    if (!owner || typeof owner.prepare !== 'function' || typeof owner.isCurrent !== 'function'
      || typeof owner.cancel !== 'function') throw Error('updater_invalid_draft_owner');
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
  };
  const replaced = () => { if (window[name] !== bridge) retire(); };
  window.addEventListener(readyEvent, replaced);
  window.addEventListener('pagehide', retire);
  Object.defineProperty(window, name, { configurable: true, value: bridge });
  window.dispatchEvent(new Event(readyEvent));
}
