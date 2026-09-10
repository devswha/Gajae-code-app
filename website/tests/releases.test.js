import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DOWNLOADS,
  LINUX_DESKTOP_RELEASE,
  RELEASE,
  RELEASES_URL,
  buildDownloads,
  checksumName,
  desktopAppImageName,
  desktopDebName,
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
/** Last release that published Linux desktop packages (built on owner request only). */
const linuxDesktopVersion = '2.0.0-beta.12';

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

test('pins both Linux desktop formats to the last release that shipped them', () => {
  assert.equal(LINUX_DESKTOP_RELEASE.version, linuxDesktopVersion);
  assert.equal(LINUX_DESKTOP_RELEASE.tag, `v${linuxDesktopVersion}`);
  assert.equal(DOWNLOADS.linuxDesktopVersion, linuxDesktopVersion);
  assert.equal(desktopDebName(), `gajae-app-desktop-${linuxDesktopVersion}-linux-x64.deb`);
  assert.equal(desktopAppImageName(), `gajae-app-desktop-${linuxDesktopVersion}-linux-x64.AppImage`);
  for (const [key, fileName] of [
    ['linuxDeb', desktopDebName()],
    ['linuxAppImage', desktopAppImageName()],
  ]) {
    const download = DOWNLOADS[key];
    assert.equal(download.label, fileName);
    assert.equal(download.href, `${RELEASES_URL}/download/${LINUX_DESKTOP_RELEASE.tag}/${fileName}`);
    assert.equal(download.checksumHref, `${download.href}.sha256`);
    assert.equal(download.checksumFile, `${fileName}.sha256`);
    assert.equal(download.verifyCommand, `sha256sum --check ${fileName}.sha256`);
  }
});

test('keeps every artifact and checksum on the supplied release when the version changes', () => {
  const release = { version: '9.9.9-test', tag: 'v9.9.9-test' };
  const downloads = buildDownloads(release, release);
  assert.equal(downloads.tagUrl, `${RELEASES_URL}/tag/${release.tag}`);
  for (const [key, suffix] of [
    ['macosArm64', 'desktop-9.9.9-test-macos-arm64.dmg'],
    ['linuxDeb', 'desktop-9.9.9-test-linux-x64.deb'],
    ['linuxAppImage', 'desktop-9.9.9-test-linux-x64.AppImage'],
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

test('does not invent Windows or Intel desktop artifacts', () => {
  const downloads = buildDownloads();
  assert.equal('windows' in downloads, false);
  assert.equal('macosIntel' in downloads, false);
  assert.ok(downloads.linuxServer.href.includes('linux-x64-node22'));
});
