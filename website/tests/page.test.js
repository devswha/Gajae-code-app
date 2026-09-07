import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { renderLandingPage } from '../src/page.js';
import {
  APPLE_GATEKEEPER_HELP_URL,
  DOCS_LINUX_INSTALL_URL,
  DOWNLOADS,
  GAJAE_CODE_URL,
  RELEASE,
  REPOSITORY_URL,
} from '../src/releases.js';

function section(html, id) {
  const match = html.match(new RegExp(`<section[^>]*id="${id}"[^>]*>([\\s\\S]*?)</section>`));
  assert.ok(match, `section #${id} exists`);
  return match[1];
}

test('landing page exposes the pinned GitHub download buttons', () => {
  const html = renderLandingPage();
  assert.match(html, /id="download"/);
  for (const key of ['macosArm64', 'linuxDeb', 'linuxAppImage', 'linuxServer']) {
    assert.ok(html.includes(`href="${DOWNLOADS[key].href}"`), `${key} download is linked`);
    assert.ok(html.includes(`href="${DOWNLOADS[key].checksumHref}"`), `${key} checksum is linked`);
  }
  assert.match(html, /Download for macOS/);
  assert.match(html, /Download for Linux/);
  assert.equal(html.includes('Windows용 내려받기'), false);
  assert.equal(html.includes('Download for Windows'), false);
  assert.equal(html.includes('/latest/download/'), false);
  assert.match(html, new RegExp(RELEASE.tag.replace('.', '\\.')));
});

test('introduces the desktop app for Gajae Code without positioning it as a separate agent', () => {
  const hero = section(renderLandingPage(), 'top');
  assert.match(hero, /<h1>The desktop app<br \/>for Gajae Code\.<\/h1>/);
  assert.match(hero, /Open projects, resume sessions, and review changes—all in one local workspace\./);
  assert.ok(hero.includes(`href="${GAJAE_CODE_URL}">About Gajae Code</a>`));
});

test('makes the two desktop platforms primary and source and server setup secondary', () => {
  const hero = section(renderLandingPage(), 'top');
  const primary = hero.slice(hero.indexOf('class="cta-row"'), hero.indexOf('class="hero-links"'));
  assert.ok(primary.includes(`href="${DOWNLOADS.macosArm64.href}"`));
  assert.match(primary, /href="#linux-download"/);
  assert.equal(primary.includes(DOWNLOADS.linuxServer.href), false);
  assert.equal(primary.includes(REPOSITORY_URL + '"'), false);
  assert.equal(hero.includes('button-icon'), false);
  assert.match(hero, /href="#self-host">Server setup/);
  assert.ok(hero.includes(`href="${REPOSITORY_URL}">Source code</a>`));
});

test('separates the Linux desktop packages from self-hosted server downloads', () => {
  const html = renderLandingPage();
  const desktop = section(html, 'download');
  const selfHost = section(html, 'self-host');
  assert.match(desktop, /Linux desktop/);
  assert.match(desktop, /Download \.deb/);
  assert.match(desktop, /Download AppImage/);
  assert.ok(desktop.includes(DOCS_LINUX_INSTALL_URL));
  assert.ok(desktop.includes(DOWNLOADS.linuxDeb.href));
  assert.ok(desktop.includes(DOWNLOADS.linuxAppImage.href));
  assert.equal(desktop.includes(DOWNLOADS.linuxServer.href), false);
  assert.match(desktop, /Intel Mac and Windows builds are not available yet\./);
  assert.equal(html.includes('Linux desktop builds are not available yet'), false);
  assert.ok(selfHost.includes(DOWNLOADS.linuxServer.href));
  assert.match(selfHost, /Requires Node\.js 22\.22\.2\+ \(22\.x\)/);
  assert.equal(selfHost.includes(DOWNLOADS.linuxDeb.href), false);
});

test('gives each checksum link a distinct accessible name', () => {
  const html = renderLandingPage();
  for (const [key, label] of [
    ['macosArm64', 'macOS DMG'],
    ['linuxDeb', 'Linux .deb'],
    ['linuxAppImage', 'Linux AppImage'],
    ['linuxServer', 'Linux server archive'],
  ]) {
    assert.ok(html.includes(`href="${DOWNLOADS[key].checksumHref}" aria-label="SHA-256 for ${label}"`));
  }
});

test('every in-page link and accessibility reference has a unique target', () => {
  const html = renderLandingPage();
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const [, target] of html.matchAll(/(?:href="#|aria-describedby="|aria-labelledby=")([^"]+)"/g)) {
    assert.ok(ids.includes(target), `#${target} exists`);
  }
  assert.match(html, /id="linux-download" tabindex="-1"/);
});

test('keeps page and social metadata aligned with the desktop app positioning', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<title>Gajae Code App — The desktop app for Gajae Code<\/title>/);
  assert.match(html, /property="og:title" content="Gajae Code App — The desktop app for Gajae Code"/);
  assert.match(html, /Available for macOS and Linux\./);
  assert.equal(html.includes('with a desktop'), false);
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

test('puts the real session screenshot immediately after the hero and before its explanation', () => {
  const html = renderLandingPage();
  const overview = section(html, 'features');
  assert.match(overview, /^\s*<img[^>]+session-review\.jpg[^>]+fetchpriority="high"/);
  assert.ok(overview.indexOf('session-review.jpg') < overview.indexOf('product-overview-copy'));
  assert.match(html, /<\/section>\s*<section class="product-overview"/);
  assert.match(html, /permission-card\.jpg[^>]+loading="lazy"/);
  assert.match(html, /model-picker\.jpg[^>]+loading="lazy"/);
});
