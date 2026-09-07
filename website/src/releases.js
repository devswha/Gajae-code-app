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
  version: '2.0.0-beta.10',
  tag: 'v2.0.0-beta.10',
  channel: 'beta',
  publishedLabel: '2026-09-07',
};

function releaseDownloadBase(tag = RELEASE.tag) {
  return `${RELEASES_URL}/download/${tag}`;
}

export function desktopDmgName(version = RELEASE.version) {
  return `gajae-app-desktop-${version}-macos-arm64.dmg`;
}

export function desktopDebName(version = RELEASE.version) {
  return `gajae-app-desktop-${version}-linux-x64.deb`;
}

export function desktopAppImageName(version = RELEASE.version) {
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

export function buildDownloads(release = RELEASE) {
  const dmg = desktopDmgName(release.version);
  const deb = desktopDebName(release.version);
  const appImage = desktopAppImageName(release.version);
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
    linuxDeb: {
      label: deb,
      href: downloadUrl(deb, release.tag),
      checksumHref: downloadUrl(checksumName(deb), release.tag),
      checksumFile: checksumName(deb),
      verifyCommand: `sha256sum --check ${checksumName(deb)}`,
    },
    linuxAppImage: {
      label: appImage,
      href: downloadUrl(appImage, release.tag),
      checksumHref: downloadUrl(checksumName(appImage), release.tag),
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
