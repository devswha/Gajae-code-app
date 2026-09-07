import { useEffect, useRef, useState } from 'react';

import {
  DESKTOP_UPDATE_BRIDGE_EVENT,
  DESKTOP_UPDATE_BRIDGE_NAME,
  DESKTOP_UPDATE_PROTOCOL,
  isDesktopUpdateCommand,
  isDesktopUpdateSnapshot,
  type DesktopUpdateBridge,
  type DesktopUpdateCommand,
  type DesktopUpdateSnapshot,
} from '../../shared/desktopUpdateProtocol';

const POLL_INTERVAL = 3_000;
const REQUEST_TIMEOUT = 10_000;
type ConnectionError = 'unavailable' | 'invalidResponse' | 'timeout';
type UpdateState = {
  bridgeActive: boolean;
  connected: boolean;
  snapshot: DesktopUpdateSnapshot | null;
  pending: DesktopUpdateCommand['action'] | null;
  error: ConnectionError | null;
  awaitingOperation: boolean;
};

function injection(): unknown {
  return typeof window === 'undefined' ? undefined
    : (window as unknown as Record<string, unknown>)[DESKTOP_UPDATE_BRIDGE_NAME];
}

function isBridge(value: unknown): value is DesktopUpdateBridge {
  return value !== null && typeof value === 'object'
    && (value as DesktopUpdateBridge).protocolVersion === DESKTOP_UPDATE_PROTOCOL
    && typeof (value as DesktopUpdateBridge).request === 'function';
}

export function useDesktopUpdate() {
  const [state, setState] = useState<UpdateState>(() => ({
    bridgeActive: injection() !== undefined, connected: false, snapshot: null,
    pending: null, error: null, awaitingOperation: false,
  }));
  const dispatch = useRef<(command: DesktopUpdateCommand) => Promise<void>>(async () => {});

  useEffect(() => {
    let disposed = false;
    let epoch = 0;
    let current: unknown;
    let authenticated = false;
    let snapshot: DesktopUpdateSnapshot | null = null;
    let poll: number | undefined;
    type Request = { promise: Promise<void>; finish: () => void; timedOut: boolean };
    let active: Request | null = null;
    let operation: Request | null = null;

    function send(command: DesktopUpdateCommand): Promise<void> {
      if (disposed || !isDesktopUpdateCommand(command)) return Promise.resolve();
      if (injection() !== current) {
        attach();
        return active?.promise ?? Promise.resolve();
      }
      if (!isBridge(current)) return Promise.resolve();
      if (command.action !== 'status') {
        if (!authenticated || !snapshot || operation) return Promise.resolve();
        if (['disabled', 'recovery', 'applying', 'restarting'].includes(snapshot.phase)) return Promise.resolve();
        if (command.action === 'restart' && (!snapshot.installationAvailable || snapshot.phase !== 'ready')) return Promise.resolve();
      }
      if (active) return active.promise;

      const bridge = current;
      const requestEpoch = epoch;
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      const token: Request = { promise, finish, timedOut: false };
      active = token;
      if (command.action !== 'status') operation = token;
      setState((previous) => ({ ...previous, pending: command.action }));
      const timeout = window.setTimeout(() => {
        if (!ownsRequest()) return;
        token.timedOut = true;
        authenticated = false;
        setState((previous) => ({ ...previous, connected: false, pending: null,
          error: 'timeout', awaitingOperation: operation === token }));
        finish();
      }, REQUEST_TIMEOUT);

      function finish() {
        window.clearTimeout(timeout);
        if (active === token) active = null;
        resolve();
      }
      function sameEpoch() {
        if (disposed || requestEpoch !== epoch) return false;
        if (injection() !== bridge) { attach(); return false; }
        return true;
      }
      function ownsRequest() { return sameEpoch() && active === token; }
      function fail(error: ConnectionError) {
        if (!ownsRequest()) return;
        authenticated = false;
        setState((previous) => ({ ...previous, connected: false, pending: null, error }));
      }

      // The bridge owns authentication and native execution. A UI deadline does
      // not cancel that execution, and a timed-out write is never reissued here.
      void Promise.resolve().then(() => {
        if (!ownsRequest()) return undefined;
        return bridge.request(command);
      }).then((value: unknown) => {
        if (!ownsRequest()) return;
        if (!isDesktopUpdateSnapshot(value)) { fail('invalidResponse'); return; }
        snapshot = { ...value };
        if (command.action === 'status') authenticated = true;
        setState((previous) => ({ ...previous, connected: true, snapshot, pending: null,
          error: operation?.timedOut ? 'timeout' : null }));
      }, () => fail('unavailable')).finally(() => {
        finish();
        if (sameEpoch() && operation === token) {
          operation = null;
          setState((previous) => ({ ...previous, awaitingOperation: false }));
          // Ignore a late command result; obtain a new authoritative snapshot.
          if (token.timedOut) void send({ action: 'status' });
        }
      });
      return promise;
    }

    function attach() {
      if (disposed) return;
      epoch += 1;
      active?.finish();
      operation = null;
      authenticated = false;
      window.clearInterval(poll);
      current = injection();
      setState((previous) => ({ ...previous,
        bridgeActive: previous.bridgeActive || current !== undefined,
        connected: false, pending: null, awaitingOperation: false,
        error: isBridge(current) ? null : (previous.bridgeActive || current !== undefined ? 'unavailable' : null),
      }));
      if (isBridge(current)) {
        void send({ action: 'status' });
        const pollEpoch = epoch;
        poll = window.setInterval(() => { if (epoch === pollEpoch) void send({ action: 'status' }); }, POLL_INTERVAL);
      }
    }

    dispatch.current = send;
    attach();
    window.addEventListener(DESKTOP_UPDATE_BRIDGE_EVENT, attach);
    return () => {
      disposed = true;
      epoch += 1;
      active?.finish();
      window.clearInterval(poll);
      window.removeEventListener(DESKTOP_UPDATE_BRIDGE_EVENT, attach);
      dispatch.current = async () => {};
    };
  }, []);

  return {
    ...state,
    refresh: () => dispatch.current({ action: 'status' }),
    check: () => dispatch.current({ action: 'check' }),
    setAutomatic: (automatic: boolean) => dispatch.current({ action: 'setAutomatic', automatic }),
    restart: () => dispatch.current({ action: 'restart' }),
  };
}
