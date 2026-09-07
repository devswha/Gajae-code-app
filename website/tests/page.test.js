import assert from 'node:assert/strict';
import test from 'node:test';

import { renderLandingPage } from '../src/page.js';
import { APPLE_GATEKEEPER_HELP_URL, DOWNLOADS, RELEASE } from '../src/releases.js';

test('landing page exposes the pinned GitHub download buttons', () => {
  const html = renderLandingPage();
  assert.match(html, /id="download"/);
  assert.match(html, new RegExp(DOWNLOADS.macosArm64.href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(html, new RegExp(DOWNLOADS.linuxServer.href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(html, /Download for Mac/);
  assert.equal(html.includes('Windows용 내려받기'), false);
  assert.equal(html.includes('Download for Windows'), false);
  assert.equal(html.includes('/latest/download/'), false);
  assert.match(html, new RegExp(RELEASE.tag.replace('.', '\\.')));
});

test('states that the macOS beta is notarized and keeps the legacy Gatekeeper path for older builds', () => {
  const html = renderLandingPage();
  assert.match(html, /Public beta/);
  assert.match(html, /Apple Silicon · macOS 13\+ · Notarized by Apple/);
  assert.equal(html.includes('Not notarized'), false);
  assert.equal(html.includes('has not been notarized'), false);
  assert.match(html, /System Settings → Privacy &amp; Security/);
  assert.match(html, /Open Anyway/);
  assert.match(html, new RegExp(APPLE_GATEKEEPER_HELP_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(html, /aria-describedby="macos-beta-notice"/);
  assert.match(html, /id="macos-install"/);
});

test('uses screenshots of the current release and none of the retired media', () => {
  const html = renderLandingPage();
  assert.ok(html.includes('screenshots/session-review.jpg'));
  assert.ok(html.includes('screenshots/permission-card.jpg'));
  assert.ok(html.includes('screenshots/model-picker.jpg'));
  assert.equal(html.includes('demos/'), false);
  assert.equal(html.includes('-light.jpg'), false);
  assert.equal(html.includes('<video'), false);
  assert.match(html, /Watch the work happen, then review it\./);
  assert.match(html, /Commands wait for you\./);
  assert.match(html, /Match the model to the task\./);
  assert.equal(html.includes('Sol'), false);
  assert.equal(html.includes('Daymark'), false);
});
