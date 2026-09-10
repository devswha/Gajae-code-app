import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DOWNLOADS,
  RELEASE,
  RELEASES_URL,
  buildDownloads,
  checksumName,
  desktopDmgName,
  downloadUrl,
  serverArchiveName,
} from '../src/releases.js';

/**
 * Reviewed public-release fixture: promote this with the verified beta.14 assets.
 * A local/test candidate can advance package.json before publication; coupling
 * the page to that version would advertise download URLs that do not exist.
 * Update this fixture with RELEASE only after verifying the new public assets.
 */
const publishedVersion = '2.0.0-beta.14';
const publishedTag = `v${publishedVersion}`;

test('pins the published release and its GitHub URLs independently of local candidates', () => {
  assert.equal(RELEASE.version, publishedVersion);
  assert.equal(RELEASE.tag, `v${publishedVersion}`);
  assert.equal(desktopDmgName(), `gajae-app-desktop-${publishedVersion}-macos-arm64.dmg`);
  assert.equal(serverArchiveName(), `gajae-app-server-${publishedVersion}-linux-x64-node22.tar.gz`);
  assert.equal(
    downloadUrl(desktopDmgName()),
    `${RELEASES_URL}/download/v${publishedVersion}/gajae-app-desktop-${publishedVersion}-macos-arm64.dmg`,
  );
  assert.equal(
    DOWNLOADS.macosArm64.checksumHref,
    `${RELEASES_URL}/download/v${publishedVersion}/${checksumName(desktopDmgName())}`,
  );
  assert.match(DOWNLOADS.macosArm64.verifyCommand, /shasum -a 256 -c /);
});

test('ships macOS DMG and Linux server artifacts only', () => {
  assert.deepEqual(Object.keys(DOWNLOADS).sort(), ['linuxServer', 'macosArm64', 'tagUrl']);
  for (const key of ['macosArm64', 'linuxServer']) {
    assert.ok(DOWNLOADS[key].label.startsWith('gajae-app-'));
  }
  for (const key of ['macosArm64', 'linuxServer']) {
    const download = DOWNLOADS[key];
    assert.equal(download.href.startsWith(`${RELEASES_URL}/download/${publishedTag}/`), true);
    assert.equal(download.checksumHref, `${download.href}.sha256`);
    assert.equal(download.checksumFile, `${download.label}.sha256`);
  }
});

test('keeps every artifact and checksum on the supplied release when the version changes', () => {
  const release = { version: '9.9.9-test', tag: 'v9.9.9-test' };
  const downloads = buildDownloads(release);
  assert.equal(downloads.tagUrl, `${RELEASES_URL}/tag/${release.tag}`);
  for (const [key, suffix] of [
    ['macosArm64', 'desktop-9.9.9-test-macos-arm64.dmg'],
    ['linuxServer', 'server-9.9.9-test-linux-x64-node22.tar.gz'],
  ]) {
    const download = downloads[key];
    assert.equal(download.label, `gajae-app-${suffix}`);
    assert.equal(download.href, `${RELEASES_URL}/download/${release.tag}/${download.label}`);
    assert.equal(download.checksumHref, `${download.href}.sha256`);
    assert.equal(download.checksumFile, `${download.label}.sha256`);
    assert.ok(download.verifyCommand.endsWith(download.checksumFile));
  }
});

test('does not invent artifacts for platforms other than macOS and the Linux server', () => {
  const downloads = buildDownloads();
  assert.deepEqual(Object.keys(downloads).sort(), ['linuxServer', 'macosArm64', 'tagUrl']);
  for (const key of ['windows', 'macosIntel']) {
    assert.equal(key in downloads, false, `${key} must not exist`);
  }
  assert.match(downloads.macosArm64.href, /-macos-arm64\.dmg$/);
  assert.ok(downloads.linuxServer.href.includes('linux-x64-node22'));
});
