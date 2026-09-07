import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';

import { initDownloadPicker } from '../src/download-picker.js';
import { renderLandingPage } from '../src/page.js';
import { DOWNLOADS } from '../src/releases.js';

function setup(t) {
  const window = new Window();
  const document = window.document;
  document.body.innerHTML = renderLandingPage();
  const dispose = initDownloadPicker(document);
  t.after(async () => {
    dispose();
    await window.happyDOM.close();
  });

  const toggle = document.querySelector('[data-download-toggle]');
  const panel = document.querySelector('[data-download-panel]');
  const links = [...panel.querySelectorAll('a[href]')];
  const outside = document.querySelector('.hero-links a');
  function press(key) {
    const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    document.activeElement.dispatchEvent(event);
    return event;
  }
  function isOpen(expected) {
    assert.equal(panel.hidden, !expected);
    assert.equal(toggle.getAttribute('aria-expanded'), String(expected));
  }
  return { window, document, dispose, toggle, panel, links, outside, press, isOpen };
}

test('download disclosure starts closed and toggles with the button', (t) => {
  const { toggle, isOpen } = setup(t);
  isOpen(false);
  toggle.click();
  isOpen(true);
  toggle.click();
  isOpen(false);
});

test('each desktop option retains its own pinned installer URL', (t) => {
  const { panel } = setup(t);
  const choices = [...panel.querySelectorAll('.download-choice')];
  assert.deepEqual(choices.map((link) => link.getAttribute('href')), [
    DOWNLOADS.macosArm64.href,
    DOWNLOADS.linuxDeb.href,
    DOWNLOADS.linuxAppImage.href,
  ]);
  assert.ok(choices.every((link) => !link.hasAttribute('tabindex')));
});

test('ArrowDown and ArrowUp open the disclosure and enter its links', (t) => {
  const { document, toggle, links, press, isOpen } = setup(t);
  toggle.focus();
  assert.equal(press('ArrowDown').defaultPrevented, true);
  isOpen(true);
  assert.equal(document.activeElement, links[0]);
  press('Escape');
  press('ArrowUp');
  isOpen(true);
  assert.equal(document.activeElement, links.at(-1));
});

test('arrow keys wrap and Home/End move to the edges', (t) => {
  const { document, toggle, links, press } = setup(t);
  toggle.focus();
  press('ArrowDown');
  press('ArrowUp');
  assert.equal(document.activeElement, links.at(-1));
  press('ArrowDown');
  assert.equal(document.activeElement, links[0]);
  press('ArrowDown');
  assert.equal(document.activeElement, links[1]);
  press('End');
  assert.equal(document.activeElement, links.at(-1));
  press('Home');
  assert.equal(document.activeElement, links[0]);
});

test('Escape closes and restores focus to the download button', (t) => {
  const { document, toggle, press, isOpen } = setup(t);
  toggle.focus();
  press('ArrowDown');
  assert.equal(press('Escape').defaultPrevented, true);
  isOpen(false);
  assert.equal(document.activeElement, toggle);
  assert.equal(press('Escape').defaultPrevented, false);
});

test('Tab stays native and focus leaving the picker closes without stealing focus', (t) => {
  const { document, toggle, links, outside, press, isOpen } = setup(t);
  toggle.click();
  links[0].focus();
  assert.equal(press('Tab').defaultPrevented, false);
  outside.focus();
  isOpen(false);
  assert.equal(document.activeElement, outside);
});

test('clicking outside closes and does not leave focus in hidden content', (t) => {
  const { document, toggle, links, isOpen } = setup(t);
  toggle.click();
  links[0].focus();
  document.querySelector('h1').click();
  isOpen(false);
  assert.equal(document.activeElement, toggle);
});

test('clicking a nested option label dismisses without canceling its navigation', (t) => {
  const { window, document, toggle, links, isOpen } = setup(t);
  toggle.click();
  // Observe the event after the picker handles it, then prevent navigation only
  // in the test so no release artifact is downloaded by the DOM harness.
  let navigationAllowed = false;
  window.addEventListener('click', (event) => {
    navigationAllowed = !event.defaultPrevented;
    event.preventDefault();
  }, { once: true });
  links[0].querySelector('.download-detail').click();
  assert.equal(navigationAllowed, true);
  isOpen(false);
  assert.equal(document.activeElement, toggle);
});

test('installation link closes the disclosure without preventing its anchor navigation', (t) => {
  const { window, toggle, panel, isOpen } = setup(t);
  toggle.click();
  let navigationAllowed = false;
  window.addEventListener('click', (event) => {
    navigationAllowed = !event.defaultPrevented;
    event.preventDefault();
  }, { once: true });
  panel.querySelector('a[href="#download"]').click();
  isOpen(false);
  assert.equal(navigationAllowed, true);
});

test('cleanup removes listeners and allows a fresh initialization', (t) => {
  const { document, toggle, dispose, isOpen } = setup(t);
  toggle.click();
  dispose();
  isOpen(false);
  toggle.click();
  isOpen(false);
  const disposeAgain = initDownloadPicker(document);
  toggle.click();
  isOpen(true);
  disposeAgain();
  isOpen(false);
});

test('pages without a download picker need no initialization', async () => {
  const window = new Window();
  try {
    const dispose = initDownloadPicker(window.document);
    assert.doesNotThrow(dispose);
  } finally {
    await window.happyDOM.close();
  }
});
