import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeBrowserDeviceScaleFactor, toPuppeteerKeyInput } from './browser-sidecar.js';
import { isBrowserClipboardInput } from './browser-protocol.js';

test('maps editing and navigation keys to Puppeteer key inputs', () => {
  for (const key of [
    'Backspace', 'Delete', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown',
    'Home', 'End', 'PageUp', 'PageDown', 'Tab', 'Enter', 'Escape', 'Shift',
    'Control', 'Alt', 'Meta',
  ]) {
    assert.equal(toPuppeteerKeyInput(key), key);
  }
});

test('maps DOM key aliases and printable characters to Puppeteer key inputs', () => {
  assert.equal(toPuppeteerKeyInput('OS'), 'Meta');
  assert.equal(toPuppeteerKeyInput('Esc'), 'Escape');
  assert.equal(toPuppeteerKeyInput(' '), 'Space');
  assert.equal(toPuppeteerKeyInput('a'), 'a');
  assert.equal(toPuppeteerKeyInput('7'), '7');
});

test('maps function keys and rejects IME keys', () => {
  for (let index = 1; index <= 12; index += 1) {
    assert.equal(toPuppeteerKeyInput(`F${index}`), `F${index}`);
  }
  for (const key of ['Dead', 'Unidentified', 'Process']) {
    assert.equal(toPuppeteerKeyInput(key), null);
  }
});

test('bounds browser device scale factors without allowing invalid values', () => {
  assert.equal(normalizeBrowserDeviceScaleFactor(undefined), 1);
  assert.equal(normalizeBrowserDeviceScaleFactor(1.5), 1.5);
  assert.equal(normalizeBrowserDeviceScaleFactor(4), 2);
  assert.equal(normalizeBrowserDeviceScaleFactor(0), null);
  assert.equal(normalizeBrowserDeviceScaleFactor(Number.NaN), null);
});

test('requires clipboard operations to bind their tab and phase payload', () => {
  assert.equal(isBrowserClipboardInput({ kind: 'clipboard', event: 'read', tabId: 'tab-1' }), true);
  assert.equal(isBrowserClipboardInput({
    kind: 'clipboard',
    event: 'delete',
    tabId: 'tab-1',
    text: 'selected',
    selectionId: 'control:1:2',
  }), true);
  assert.equal(isBrowserClipboardInput({
    kind: 'clipboard',
    event: 'paste',
    tabId: 'tab-1',
    text: 'pasted',
  }), true);
  assert.equal(isBrowserClipboardInput({ kind: 'clipboard', event: 'read', tabId: 'other tab' }), false);
  assert.equal(isBrowserClipboardInput({
    kind: 'clipboard',
    event: 'delete',
    tabId: 'tab-1',
    text: 'selected',
  }), false);
});
