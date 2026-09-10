export const PRODUCT_NAME = 'Gajae Code App';
export const REPOSITORY_URL = 'https://github.com/devswha/gajae-code-app';
export const RELEASES_URL = `${REPOSITORY_URL}/releases`;
export const ISSUES_URL = `${REPOSITORY_URL}/issues`;
export const LICENSE_URL = `${REPOSITORY_URL}/blob/main/LICENSE`;
export const DOCS_INSTALL_URL = `${REPOSITORY_URL}/blob/main/docs/INSTALL.md`;
export const DOCS_SELF_HOST_URL = `${REPOSITORY_URL}/blob/main/docs/SELF-HOST.md`;
export const DOCS_LINUX_INSTALL_URL = `${REPOSITORY_URL}/blob/main/docs/DESKTOP-LINUX.md#install-or-launch-a-local-build`;
export const GAJAE_CODE_URL = 'https://github.com/devswha/gajae-code';
export const APPLE_GATEKEEPER_HELP_URL = 'https://support.apple.com/102445';

export const RELEASE = {
  version: '2.0.0-beta.14',
  tag: 'v2.0.0-beta.14',
  channel: 'beta',
  publishedLabel: '2026-09-10',
};

/**
 * Linux desktop packages are built only on owner request and did not ship with
 * every release. Pin their links to the last release that published them.
 */
export const LINUX_DESKTOP_RELEASE = {
  version: '2.0.0-beta.12',
  tag: 'v2.0.0-beta.12',
};

function releaseDownloadBase(tag = RELEASE.tag) {
  return `${RELEASES_URL}/download/${tag}`;
}

export function desktopDmgName(version = RELEASE.version) {
  return `gajae-app-desktop-${version}-macos-arm64.dmg`;
}

export function desktopDebName(version = LINUX_DESKTOP_RELEASE.version) {
  return `gajae-app-desktop-${version}-linux-x64.deb`;
}

export function desktopAppImageName(version = LINUX_DESKTOP_RELEASE.version) {
  return `gajae-app-desktop-${version}-linux-x64.AppImage`;
}

export function serverArchiveName(version = RELEASE.version) {
  return `gajae-app-server-${version}-linux-x64-node22.tar.gz`;
}

export function checksumName(artifactName) {
  return `${artifactName}.sha256`;
}

export function downloadUrl(fileName, tag = RELEASE.tag) {
  return `${releaseDownloadBase(tag)}/${fileName}`;
}

export function buildDownloads(release = RELEASE, linuxDesktopRelease = LINUX_DESKTOP_RELEASE) {
  const dmg = desktopDmgName(release.version);
  const deb = desktopDebName(linuxDesktopRelease.version);
  const appImage = desktopAppImageName(linuxDesktopRelease.version);
  const server = serverArchiveName(release.version);
  return {
    tagUrl: `${RELEASES_URL}/tag/${release.tag}`,
    macosArm64: {
      label: dmg,
      href: downloadUrl(dmg, release.tag),
      checksumHref: downloadUrl(checksumName(dmg), release.tag),
      checksumFile: checksumName(dmg),
      verifyCommand: `shasum -a 256 -c ${checksumName(dmg)}`,
    },
    linuxDesktopVersion: linuxDesktopRelease.version,
    linuxDeb: {
      label: deb,
      href: downloadUrl(deb, linuxDesktopRelease.tag),
      checksumHref: downloadUrl(checksumName(deb), linuxDesktopRelease.tag),
      checksumFile: checksumName(deb),
      verifyCommand: `sha256sum --check ${checksumName(deb)}`,
    },
    linuxAppImage: {
      label: appImage,
      href: downloadUrl(appImage, linuxDesktopRelease.tag),
      checksumHref: downloadUrl(checksumName(appImage), linuxDesktopRelease.tag),
      checksumFile: checksumName(appImage),
      verifyCommand: `sha256sum --check ${checksumName(appImage)}`,
    },
    linuxServer: {
      label: server,
      href: downloadUrl(server, release.tag),
      checksumHref: downloadUrl(checksumName(server), release.tag),
      checksumFile: checksumName(server),
      verifyCommand: `sha256sum --check ${checksumName(server)}`,
    },
  };
}

export const DOWNLOADS = buildDownloads();
