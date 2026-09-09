import { useSyncExternalStore } from 'react';

import { DESKTOP_UPDATE_BRIDGE_NAME } from '../../shared/desktopUpdateProtocol';

import { createDesktopUpdateClient, desktopUpdateServerState } from './desktopUpdateClient';

type Client = ReturnType<typeof createDesktopUpdateClient>;
const clients = new WeakMap<Window, Client>();
const noop = async () => {};
const serverClient: Client = { getSnapshot: () => desktopUpdateServerState, subscribe: () => () => {},
  refresh: noop, check: noop, setAutomatic: noop, restart: noop, update: noop };

export function useDesktopUpdate() {
  let client = serverClient;
  if (typeof window !== 'undefined') {
    const existing = clients.get(window);
    if (existing) client = existing;
    else { client = createDesktopUpdateClient(window); clients.set(window, client); }
  }
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, () => desktopUpdateServerState);
  // Presence suppresses the web-only release check during the first render;
  // it still grants no command authority before native status authentication.
  const bridgeActive = state.bridgeActive || (typeof window !== 'undefined'
    && (window as unknown as Record<string, unknown>)[DESKTOP_UPDATE_BRIDGE_NAME] !== undefined);
  return { ...state, bridgeActive, refresh: client.refresh, check: client.check,
    setAutomatic: client.setAutomatic, restart: client.restart, update: client.update };
}
