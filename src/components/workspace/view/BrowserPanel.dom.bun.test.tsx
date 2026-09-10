import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';

import '../../../i18n/config';

import BrowserPanel from './BrowserPanel';

const originalFetch = globalThis.fetch;
const originalSocket = globalThis.WebSocket;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
const originalBounds = HTMLElement.prototype.getBoundingClientRect;
const originalResizeObserver = globalThis.ResizeObserver;
const originalDevicePixelRatio = window.devicePixelRatio;
const originalClipboard = navigator.clipboard;
const originalClipboardItem = globalThis.ClipboardItem;
const sockets: TestSocket[] = [];
class TestClipboardItem {
  constructor(readonly data: Record<string, unknown>) {}
}
class TestSocket {
  binaryType = '';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  closed = false;
  constructor(readonly url: string) { sockets.push(this); }
  close() { this.closed = true; this.onclose?.(); }
  state(sessionId: string, title: string) {
    this.onmessage?.({ data: JSON.stringify({ type: 'state', payload: browserState(sessionId, title) }) });
  }
  frame(sessionId: string, metadata?: { deviceWidth: number; deviceHeight: number }, tabId?: string) {
    const header = new TextEncoder().encode(JSON.stringify({ type: 'frame', sessionId, mimeType: 'image/jpeg', metadata, tabId }));
    const packet = new ArrayBuffer(4 + header.length + 4);
    new DataView(packet).setUint32(0, header.length);
    const bytes = new Uint8Array(packet);
    bytes.set(header, 4);
    bytes.set([0xff, 0xd8, 0xff, 0xd9], 4 + header.length);
    this.onmessage?.({ data: packet });
  }
}
const browserState = (sessionId: string, title: string) => ({
  sessionId, activeTabId: 'tab', tabs: [{ id: 'tab', title, url: `http://${sessionId}.localhost/`, loading: false, canGoBack: false, canGoForward: false }],
});
const status = { supported: true, browser: { installed: true, state: 'ready', buildId: 'test' } };

function installFetch(handler?: (url: string, init?: RequestInit) => Promise<Response> | undefined) {
  globalThis.WebSocket = TestSocket as unknown as typeof WebSocket;
  globalThis.fetch = async (url, init) => handler?.(String(url), init)
    ?? new Response(JSON.stringify(String(url).endsWith('/status') ? status : { urls: [] }));
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalSocket;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  HTMLElement.prototype.getBoundingClientRect = originalBounds;
  globalThis.ResizeObserver = originalResizeObserver;
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: originalDevicePixelRatio });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard });
  Object.defineProperty(globalThis, 'ClipboardItem', { configurable: true, value: originalClipboardItem });
  sockets.length = 0;
});

test('a late browser command cannot replace the tabs and address of another session', async () => {
  let resolveCommand!: (response: Response) => void;
  installFetch((url) => url.endsWith('/command') ? new Promise((resolve) => { resolveCommand = resolve; }) : undefined);
  const view = render(createElement(BrowserPanel, { sessionId: 'a' }));
  await screen.findByLabelText('Web address');
  act(() => sockets[0].state('a', 'Page A'));
  fireEvent.click(screen.getByLabelText('Reload page'));
  view.rerender(createElement(BrowserPanel, { sessionId: 'b' }));
  await screen.findByLabelText('Web address');
  act(() => sockets.at(-1)!.state('b', 'Page B'));
  await act(async () => { resolveCommand(new Response(JSON.stringify(browserState('a', 'Late A')))); });
  assert.equal((screen.getByLabelText('Web address') as HTMLInputElement).value, 'http://b.localhost/');
  assert.equal(screen.queryByText('Late A'), null);
  assert.ok(screen.getByText('Page B'));
});

test('a status failure is visible and can be retried instead of leaving a permanent spinner', async () => {
  let attempts = 0;
  installFetch((url) => url.endsWith('/status')
    ? Promise.resolve(new Response(JSON.stringify(attempts++ === 0 ? { error: 'Automation unavailable' } : status), { status: attempts === 1 ? 503 : 200 }))
    : undefined);
  render(createElement(BrowserPanel, { sessionId: 'a' }));
  await waitFor(() => assert.match(screen.getByRole('alert').textContent ?? '', /Automation unavailable/));
  fireEvent.click(screen.getByRole('button', { name: /retry/i }));
  await screen.findByLabelText('Web address');
  assert.equal(attempts, 2);
});

test('the preview reconnects after a dropped socket and cancels retries on unmount', async () => {
  installFetch();
  const view = render(createElement(BrowserPanel, { sessionId: 'a' }));
  await screen.findByLabelText('Web address');
  act(() => { sockets[0].onopen?.(); sockets[0].onclose?.(); });
  await waitFor(() => assert.equal(sockets.length, 2), { timeout: 3_000 });
  act(() => sockets[1].onclose?.());
  view.unmount();
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(sockets.length, 2);
});

function observeFrameUrls() {
  const created: string[] = [];
  const revoked: string[] = [];
  URL.createObjectURL = (blob) => {
    assert.ok(blob instanceof Blob);
    assert.equal(blob.type, 'image/jpeg');
    assert.equal(blob.size, 4, 'the binary frame packet has been decoded into its image payload');
    const url = `blob:browser-frame-${created.length + 1}`;
    created.push(url);
    return url;
  };
  URL.revokeObjectURL = (url) => { revoked.push(url); };
  return { created, revoked };
}

test('switching browser sessions revokes A last binary frame and unmounting revokes B last frame', async () => {
  installFetch();
  const { created, revoked } = observeFrameUrls();
  const view = render(createElement(BrowserPanel, { sessionId: 'a' }));
  await screen.findByLabelText('Web address');
  act(() => sockets[0].frame('a'));
  assert.equal(screen.getByAltText('Chromium live preview').getAttribute('src'), created[0]);
  view.rerender(createElement(BrowserPanel, { sessionId: 'b' }));
  await screen.findByLabelText('Web address');
  assert.deepEqual(revoked, [created[0]], 'keyed unmount must release A without executing another React state updater');
  act(() => { sockets[0].frame('a'); sockets[1].frame('b'); });
  assert.equal(created.length, 2, 'the retired socket cannot allocate another frame URL');
  assert.equal(screen.getByAltText('Chromium live preview').getAttribute('src'), created[1]);
  view.unmount();
  assert.deepEqual(revoked, created);
});

test('frame replacement and final unmount release every binary frame URL exactly once', async () => {
  installFetch();
  const { created, revoked } = observeFrameUrls();
  const view = render(createElement(BrowserPanel, { sessionId: 'a' }));
  await screen.findByLabelText('Web address');
  act(() => { sockets[0].frame('a'); sockets[0].frame('a'); });
  assert.equal(created.length, 2);
  assert.deepEqual(revoked, [created[0]]);
  view.unmount();
  assert.deepEqual(revoked, created, 'the latest frame remains live until cleanup and must then be released');
});

function viewportHarness() {
  const inputs: Record<string, unknown>[] = [];
  const observers: Array<{ resize: () => void; disconnected: boolean }> = [];
  globalThis.ResizeObserver = class {
    observer: { resize: () => void; disconnected: boolean };
    constructor(resize: () => void) { this.observer = { resize, disconnected: false }; observers.push(this.observer); }
    observe() {}
    unobserve() {}
    disconnect() { this.observer.disconnected = true; }
  } as unknown as typeof ResizeObserver;
  HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300,
    toJSON: () => ({}),
  });
  const capture = (url: string, init?: RequestInit) => {
    if (!url.endsWith('/input')) return undefined;
    inputs.push((JSON.parse(String(init?.body)) as { input: Record<string, unknown> }).input);
    return Promise.resolve(new Response('{"accepted":true}'));
  };
  return { inputs, observers, capture };
}

test('state arriving before status still attaches the viewport observer when the preview mounts', async () => {
  const { inputs, observers, capture } = viewportHarness();
  let resolveStatus!: (response: Response) => void;
  installFetch((url, init) => url.endsWith('/status')
    ? new Promise((resolve) => { resolveStatus = resolve; }) : capture(url, init));
  const view = render(createElement(BrowserPanel, { sessionId: 'a' }));
  act(() => sockets[0].state('a', 'Early state'));
  assert.equal(observers.length, 0, 'loading UI has no preview surface yet');
  await act(async () => resolveStatus(new Response(JSON.stringify(status))));
  await waitFor(() => assert.deepEqual(inputs, [{ kind: 'viewport', width: 400, height: 300 }]));
  assert.equal(observers.length, 1);
  view.unmount();
  assert.equal(observers[0].disconnected, true);
});

test('a new connection resends the viewport even for the same tab and size', async () => {
  const { inputs, capture } = viewportHarness();
  installFetch(capture);
  render(createElement(BrowserPanel, { sessionId: 'a' }));
  await screen.findByLabelText('Web address');
  act(() => { sockets[0].state('a', 'Same tab'); sockets[0].onopen?.(); });
  await waitFor(() => assert.equal(inputs.length, 1));
  act(() => sockets[0].onclose?.());
  await waitFor(() => assert.equal(sockets.length, 2), { timeout: 2_000 });
  inputs.length = 0;
  act(() => { sockets[1].state('a', 'Same tab'); sockets[1].onopen?.(); });
  await waitFor(() => assert.deepEqual(inputs, [{ kind: 'viewport', width: 400, height: 300 }]));
});

test('viewport sync sends a bounded device scale factor while keeping CSS dimensions', async () => {
  const { inputs, capture } = viewportHarness();
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2.5 });
  installFetch(capture);
  render(createElement(BrowserPanel, { sessionId: 'a' }));
  await screen.findByLabelText('Web address');
  act(() => sockets[0].state('a', 'Retina page'));
  await waitFor(() => assert.deepEqual(inputs, [{
    kind: 'viewport',
    width: 400,
    height: 300,
    deviceScaleFactor: 2,
  }]));
});

test('Ctrl and Cmd clipboard shortcuts bridge text only from the focused browser surface', async () => {
  const inputs: Record<string, unknown>[] = [];
  let resolveSelection!: (response: Response) => void;
  const localText = 'paste from host';
  const writes: ClipboardItem[] = [];
  Object.defineProperty(globalThis, 'ClipboardItem', { configurable: true, value: TestClipboardItem });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      readText: async () => localText,
      write: async (items: ClipboardItem[]) => { writes.push(...items); },
    },
  });
  installFetch((url, init) => {
    if (!url.endsWith('/input')) return undefined;
    const input = (JSON.parse(String(init?.body)) as { input: Record<string, unknown> }).input;
    inputs.push(input);
    if (input.kind === 'clipboard' && input.event === 'read') {
      return new Promise((resolve) => { resolveSelection = resolve; });
    }
    return Promise.resolve(new Response(JSON.stringify(
      input.event === 'delete' ? { accepted: true, deleted: true } : { accepted: true },
    )));
  });
  render(createElement(BrowserPanel, { sessionId: 'a' }));
  await screen.findByLabelText('Web address');
  act(() => sockets[0].state('a', 'Clipboard page'));
  const surface = document.querySelector('[tabindex="0"]') as HTMLElement;
  const address = screen.getByLabelText('Web address');

  fireEvent.keyDown(surface, { key: 'c', code: 'KeyC', ctrlKey: true });
  assert.equal(writes.length, 1, 'ClipboardItem write starts during the keyboard activation');
  assert.deepEqual(inputs[0], { kind: 'clipboard', event: 'read', tabId: 'tab' });
  await act(async () => resolveSelection(new Response(JSON.stringify({
    accepted: true,
    text: 'remote copy',
    editable: true,
    selectionId: 'selection-1',
  }))));
  fireEvent.keyUp(surface, { key: 'Control', code: 'ControlLeft' });
  assert.equal(screen.queryByRole('alert'), null);

  fireEvent.keyDown(address, { key: 'c', code: 'KeyC', ctrlKey: true });
  assert.equal(inputs.length, 1, 'address input shortcuts stay local');

  fireEvent.keyDown(surface, { key: 'x', code: 'KeyX', metaKey: true });
  await act(async () => resolveSelection(new Response(JSON.stringify({
    accepted: true,
    text: 'remote cut',
    editable: true,
    selectionId: 'selection-2',
  }))));
  await waitFor(() => assert.deepEqual(inputs.at(-1), {
    kind: 'clipboard',
    event: 'delete',
    tabId: 'tab',
    text: 'remote cut',
    selectionId: 'selection-2',
  }));
  fireEvent.keyUp(surface, { key: 'Meta', code: 'MetaLeft' });

  fireEvent.keyDown(surface, { key: 'v', code: 'KeyV', ctrlKey: true });
  await waitFor(() => assert.deepEqual(inputs.at(-1), {
    kind: 'clipboard',
    event: 'paste',
    tabId: 'tab',
    text: 'paste from host',
  }));
  fireEvent.keyUp(surface, { key: 'Control', code: 'ControlLeft' });
});

test('mixed clipboard and editing shortcuts keep the remote modifier lifecycle balanced', async () => {
  const inputs: Record<string, unknown>[] = [];
  Object.defineProperty(globalThis, 'ClipboardItem', { configurable: true, value: TestClipboardItem });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { write: async () => {}, readText: async () => '' },
  });
  installFetch((url, init) => {
    if (!url.endsWith('/input')) return undefined;
    const input = (JSON.parse(String(init?.body)) as { input: Record<string, unknown> }).input;
    inputs.push(input);
    if (input.kind === 'clipboard' && input.event === 'read') {
      return Promise.resolve(new Response(JSON.stringify({
        accepted: true,
        text: 'selected',
        editable: true,
        selectionId: 'selection-1',
      })));
    }
    return Promise.resolve(new Response('{"accepted":true}'));
  });
  render(createElement(BrowserPanel, { sessionId: 'a' }));
  await screen.findByLabelText('Web address');
  act(() => sockets[0].state('a', 'Modifier lifecycle'));
  const surface = document.querySelector('[tabindex="0"]') as HTMLElement;
  const keyInputs = () => inputs.filter((input) => input.kind === 'key');

  fireEvent.keyDown(surface, { key: 'Meta', code: 'MetaLeft', metaKey: true });
  fireEvent.keyDown(surface, { key: 'a', code: 'KeyA', metaKey: true });
  fireEvent.keyUp(surface, { key: 'a', code: 'KeyA', metaKey: true });
  fireEvent.keyDown(surface, { key: 'ㅊ', code: 'KeyC', metaKey: true });
  fireEvent.keyUp(surface, { key: 'ㅊ', code: 'KeyC', metaKey: true });
  fireEvent.keyUp(surface, { key: 'Meta', code: 'MetaLeft' });
  await waitFor(() => assert.deepEqual(keyInputs(), [
    { kind: 'key', event: 'down', key: 'Meta', code: 'MetaLeft', modifiers: 4 },
    { kind: 'key', event: 'down', key: 'a', code: 'KeyA', modifiers: 4 },
    { kind: 'key', event: 'up', key: 'a', code: 'KeyA', modifiers: 4 },
    { kind: 'key', event: 'up', key: 'Meta', code: 'MetaLeft', modifiers: 4 },
  ]));

  inputs.length = 0;
  fireEvent.keyDown(surface, { key: 'Meta', code: 'MetaLeft', metaKey: true });
  fireEvent.keyDown(surface, { key: 'ㅊ', code: 'KeyC', metaKey: true });
  fireEvent.keyUp(surface, { key: 'ㅊ', code: 'KeyC', metaKey: true });
  fireEvent.keyDown(surface, { key: 'a', code: 'KeyA', metaKey: true });
  fireEvent.keyUp(surface, { key: 'a', code: 'KeyA', metaKey: true });
  fireEvent.keyUp(surface, { key: 'Meta', code: 'MetaLeft' });
  await waitFor(() => assert.deepEqual(keyInputs(), [
    { kind: 'key', event: 'down', key: 'Meta', code: 'MetaLeft', modifiers: 4 },
    { kind: 'key', event: 'down', key: 'a', code: 'KeyA', modifiers: 4 },
    { kind: 'key', event: 'up', key: 'a', code: 'KeyA', modifiers: 4 },
    { kind: 'key', event: 'up', key: 'Meta', code: 'MetaLeft', modifiers: 4 },
  ]));
  assert.equal(inputs.some((input) => input.kind === 'key' && input.key === 'ㅊ'), false);
});

test('an empty remote selection rejects the pending clipboard item without cutting or replacing local text', async () => {
  const inputs: Record<string, unknown>[] = [];
  let resolveSelection!: (response: Response) => void;
  let itemTextPromise!: Promise<Blob>;
  let writeStarted = false;
  let localClipboard = 'existing local clipboard';
  Object.defineProperty(globalThis, 'ClipboardItem', { configurable: true, value: TestClipboardItem });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      readText: async () => localClipboard,
      write: async (items: TestClipboardItem[]) => {
        writeStarted = true;
        itemTextPromise = items[0].data['text/plain'] as Promise<Blob>;
        const blob = await itemTextPromise;
        localClipboard = await blob.text();
      },
    },
  });
  installFetch((url, init) => {
    if (!url.endsWith('/input')) return undefined;
    const input = (JSON.parse(String(init?.body)) as { input: Record<string, unknown> }).input;
    inputs.push(input);
    if (input.kind === 'clipboard' && input.event === 'read') {
      return new Promise((resolve) => { resolveSelection = resolve; });
    }
    return Promise.resolve(new Response('{"accepted":true}'));
  });
  render(createElement(BrowserPanel, { sessionId: 'a' }));
  await screen.findByLabelText('Web address');
  act(() => sockets[0].state('a', 'Empty selection'));
  const surface = document.querySelector('[tabindex="0"]') as HTMLElement;
  fireEvent.keyDown(surface, { key: 'x', code: 'KeyX', ctrlKey: true });
  assert.equal(writeStarted, true, 'the clipboard write starts during the transient keyboard activation');
  await act(async () => resolveSelection(new Response(JSON.stringify({
    accepted: true,
    text: '',
    editable: true,
    selectionId: 'selection-empty',
  }))));
  await assert.rejects(itemTextPromise, /browser_clipboard_no_selection/);
  await waitFor(() => assert.equal(inputs.some((input) => input.event === 'delete'), false));
  assert.equal(localClipboard, 'existing local clipboard');
  assert.equal(screen.queryByRole('alert'), null, 'the expected no-selection result is not surfaced as an error');
});

test('failed local clipboard writes leave the remote selection untouched and show the error', async () => {
  const inputs: Record<string, unknown>[] = [];
  let resolveSelection!: (response: Response) => void;
  Object.defineProperty(globalThis, 'ClipboardItem', { configurable: true, value: TestClipboardItem });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      write: async () => { throw new Error('Clipboard permission denied.'); },
      readText: async () => '',
    },
  });
  installFetch((url, init) => {
    if (!url.endsWith('/input')) return undefined;
    const input = (JSON.parse(String(init?.body)) as { input: Record<string, unknown> }).input;
    inputs.push(input);
    return input.event === 'read'
      ? new Promise((resolve) => { resolveSelection = resolve; })
      : Promise.resolve(new Response('{"accepted":true}'));
  });
  render(createElement(BrowserPanel, { sessionId: 'a' }));
  await screen.findByLabelText('Web address');
  act(() => sockets[0].state('a', 'Clipboard failure'));
  const surface = document.querySelector('[tabindex="0"]') as HTMLElement;
  fireEvent.keyDown(surface, { key: 'x', code: 'KeyX', ctrlKey: true });
  await act(async () => resolveSelection(new Response(JSON.stringify({
    accepted: true,
    text: 'must remain selected',
    editable: true,
    selectionId: 'selection-1',
  }))));
  await waitFor(() => assert.match(screen.getByRole('alert').textContent ?? '', /permission denied/i));
  assert.equal(inputs.some((input) => input.event === 'delete'), false);
});

test('click mapping follows the loaded frame, not the pending viewport resize or next frame', async () => {
  const { inputs, capture } = viewportHarness();
  installFetch(capture);
  observeFrameUrls();
  render(createElement(BrowserPanel, { sessionId: 'a' }));
  await screen.findByLabelText('Web address');
  act(() => { sockets[0].state('a', 'Page'); sockets[0].frame('a', { deviceWidth: 1000, deviceHeight: 600 }); });
  const preview = screen.getByAltText('Chromium live preview');
  Object.defineProperties(preview, { naturalWidth: { configurable: true, value: 1000 }, naturalHeight: { configurable: true, value: 600 } });
  fireEvent.load(preview);
  await waitFor(() => assert.ok(inputs.some((input) => input.kind === 'viewport')));
  const click = () => fireEvent(preview, new MouseEvent('pointerup', { bubbles: true, clientX: 200, clientY: 150 }));
  click();
  assert.deepEqual(inputs.at(-1), { kind: 'mouse', event: 'up', x: 500, y: 300, button: 'left' });
  act(() => sockets[0].frame('a', { deviceWidth: 800, deviceHeight: 400 }));
  click();
  assert.equal(inputs.at(-1)?.x, 500, 'an undecoded next frame must not change the pointer scale');
  Object.defineProperties(preview, { naturalWidth: { configurable: true, value: 800 }, naturalHeight: { configurable: true, value: 400 } });
  fireEvent.load(preview);
  click();
  assert.deepEqual(inputs.at(-1), { kind: 'mouse', event: 'up', x: 400, y: 200, button: 'left' });
  assert.match(preview.className, /absolute.*object-contain/);
  assert.match(preview.parentElement!.className, /overflow-hidden/);
});

test('tab switching never shows the previous tab image under the new address', async () => {
  installFetch();
  observeFrameUrls();
  render(createElement(BrowserPanel, { sessionId: 'a' }));
  await screen.findByLabelText('Web address');
  act(() => { sockets[0].state('a', 'Page'); sockets[0].frame('a', undefined, 'old-tab'); });
  assert.equal(screen.queryByAltText('Chromium live preview'), null);
  act(() => sockets[0].frame('a', undefined, 'tab'));
  assert.ok(screen.getByAltText('Chromium live preview'));
});
