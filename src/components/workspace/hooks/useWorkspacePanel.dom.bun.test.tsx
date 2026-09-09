import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';

import { WORKSPACE_PANEL_STORAGE_KEY } from '../workspacePanelState';

import { useWorkspacePanel } from './useWorkspacePanel';

const originalObserver = globalThis.ResizeObserver;
const originalBounds = HTMLElement.prototype.getBoundingClientRect;
let containerWidth = 1_600;
const observers: Array<{ resize: () => void; disconnected: boolean }> = [];
function setup() {
  localStorage.setItem(WORKSPACE_PANEL_STORAGE_KEY, JSON.stringify({ open: true, tab: 'browser', width: 1_200 }));
  globalThis.ResizeObserver = class {
    observer: { resize: () => void; disconnected: boolean };
    constructor(resize: () => void) { this.observer = { resize, disconnected: false }; observers.push(this.observer); }
    observe() {}
    unobserve() {}
    disconnect() { this.observer.disconnected = true; }
  } as unknown as typeof ResizeObserver;
  HTMLElement.prototype.getBoundingClientRect = () => ({ width: containerWidth }) as DOMRect;
}
function Harness({ attached = true, mobile = false }: { attached?: boolean; mobile?: boolean }) {
  const panel = useWorkspacePanel({ isMobile: mobile });
  return createElement('div', null,
    attached ? createElement('div', { ref: panel.containerRef }) : null,
    createElement('output', null, String(panel.width)),
    createElement('button', { onClick: panel.closePanel }, 'Close'),
    createElement('button', { onClick: () => panel.openPanel('browser') }, 'Open'),
  );
}
afterEach(() => {
  cleanup(); localStorage.removeItem(WORKSPACE_PANEL_STORAGE_KEY);
  globalThis.ResizeObserver = originalObserver;
  HTMLElement.prototype.getBoundingClientRect = originalBounds;
  containerWidth = 1_600; observers.length = 0;
});
test('saved wide panels follow window/sidebar shrink and never exceed the chat-safe row', () => {
  setup();
  const view = render(createElement(Harness));
  assert.equal(screen.getByRole('status').textContent, '1200');
  act(() => { containerWidth = 768; observers[0].resize(); });
  assert.equal(screen.getByRole('status').textContent, '568');
  act(() => { containerWidth = 488; observers[0].resize(); });
  assert.equal(screen.getByRole('status').textContent, '288');
  view.unmount();
  assert.equal(observers[0].disconnected, true);
});
test('a container attached after loading clamps the persisted panel immediately', () => {
  setup(); containerWidth = 768;
  const view = render(createElement(Harness, { attached: false }));
  assert.equal(observers.length, 0);
  view.rerender(createElement(Harness));
  assert.equal(screen.getByRole('status').textContent, '568');
  fireEvent.click(screen.getByText('Close'));
  assert.equal(observers[0].disconnected, true);
  containerWidth = 488;
  fireEvent.click(screen.getByText('Open'));
  assert.equal(screen.getByRole('status').textContent, '288');
});
test('mobile overlays do not overwrite the saved desktop width', () => {
  setup(); containerWidth = 390;
  render(createElement(Harness, { mobile: true }));
  assert.equal(observers.length, 0);
  assert.equal(JSON.parse(localStorage.getItem(WORKSPACE_PANEL_STORAGE_KEY)!).width, 1200);
});
