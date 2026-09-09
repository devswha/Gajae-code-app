import semver from 'semver';

import {
  ARTIFACT_PREFIX,
  REPOSITORY_SLUG,
  REPOSITORY_URL,
} from '../../shared/productIdentity.js';

const SAFE_ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const UTC_DATE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const MACOS_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/;

/** The only updater platform represented by this contract. */
export const MACOS_UPDATE_TARGET = 'darwin-aarch64';
/** The Rust target encoded in a macOS updater build. */
export const MACOS_RUST_TARGET = 'aarch64-apple-darwin';
/** The desktop version shipped before the updater contract was introduced. */
export const DESKTOP_VERSION_BASELINE = '0.2.3';
/** Maximum number of payloads a local release may pin. */
export const MAX_RELEASE_PAYLOADS = 16;
/** Shared byte limits for release payloads and all updater sidecars. */
export const UPDATER_ASSET_LIMITS = Object.freeze({
  maxPayloadBytes: 2 * 1024 ** 3,
  maxArchiveBytes: 250 * 1024 ** 2,
  maxExpandedBytes: 1 * 1024 ** 3,
  maxDmgBytes: 250 * 1024 ** 2,
  maxChecksumBytes: 1024,
  maxSignatureBytes: 16 * 1024,
  maxManifestBytes: 64 * 1024,
});
/** Maximum bytes for any payload asset. */
export const MAX_PAYLOAD_BYTES = UPDATER_ASSET_LIMITS.maxPayloadBytes;
/** Maximum bytes for a signed updater archive. */
export const MAX_ARCHIVE_BYTES = UPDATER_ASSET_LIMITS.maxArchiveBytes;
/** Maximum expanded bytes permitted for the signed updater archive. */
export const MAX_EXPANDED_BYTES = UPDATER_ASSET_LIMITS.maxExpandedBytes;
/** Existing release limit for the macOS DMG. */
export const MAX_DMG_BYTES = UPDATER_ASSET_LIMITS.maxDmgBytes;
/** Maximum bytes for a checksum sidecar. */
export const MAX_CHECKSUM_BYTES = UPDATER_ASSET_LIMITS.maxChecksumBytes;
/** Maximum bytes for an updater signature sidecar or manifest signature field. */
export const MAX_SIGNATURE_BYTES = UPDATER_ASSET_LIMITS.maxSignatureBytes;
/** Maximum bytes for the desktop-update.json asset. */
export const MAX_MANIFEST_BYTES = UPDATER_ASSET_LIMITS.maxManifestBytes;

function demand(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  demand(JSON.stringify(actual) === JSON.stringify(wanted), `${label} contains unexpected or missing fields.`);
}

export function strictVersion(value, label) {
  demand(typeof value === 'string' && value.length <= 128 && semver.valid(value) === value,
    `${label} must be strict SemVer without a leading v.`);
  return value;
}

function canonicalTag(productVersion, tag) {
  strictVersion(productVersion, 'Product version');
  const expected = `v${productVersion}`;
  if (tag !== undefined) demand(typeof tag === 'string' && tag === expected, 'Release tag must exactly match the product version.');
  return expected;
}

function productChannel(productVersion) {
  const prerelease = semver.prerelease(strictVersion(productVersion, 'Product version'));
  if (prerelease === null) return 'stable';
  demand(prerelease[0] === 'beta', 'Only beta and stable product channels are supported.');
  return 'beta';
}

function boundedText(value, label, maxBytes, { empty = false, controls = true } = {}) {
  demand(typeof value === 'string' && (empty || value.length > 0)
    && Buffer.byteLength(value, 'utf8') <= maxBytes, `${label} is missing or oversized.`);
  if (controls) demand(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value), `${label} contains control characters.`);
  return value;
}

export function validUtcDate(value, label) {
  demand(typeof value === 'string' && value.length <= 32, `${label} must be a bounded UTC timestamp.`);
  const match = UTC_DATE.exec(value);
  demand(match, `${label} must be an ISO-8601 UTC timestamp.`);
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  const timestamp = date.getTime();
  demand(Number.isFinite(timestamp)
    && date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    && date.getUTCHours() === hour
    && date.getUTCMinutes() === minute
    && date.getUTCSeconds() === second, `${label} is not a real UTC timestamp.`);
  return value;
}

function validMacosVersion(value) {
  demand(typeof value === 'string' && MACOS_VERSION.test(value), 'minimumSystemVersion must be major.minor[.patch].');
  for (const component of value.split('.')) {
    demand(Number(component) <= 999, 'minimumSystemVersion contains an oversized component.');
  }
  return value;
}

function validCommit(value, label = 'Build commit') {
  demand(typeof value === 'string' && COMMIT.test(value), `${label} must be a lowercase full commit SHA.`);
  return value;
}

function validSignature(value, label = 'Updater signature') {
  boundedText(value, label, MAX_SIGNATURE_BYTES);
  demand(value.length >= 8 && value.length % 4 === 0 && BASE64.test(value), `${label} must be base64.`);
  return value;
}

function canonicalArchiveUrl(tag, archive) {
  return `${REPOSITORY_URL}/releases/download/${tag}/${archive}`;
}

/**
 * Return every release filename owned by the updater contract.
 *
 * `productVersion` is the package/GitHub version without its leading `v`.
 * The returned `ciAssets` is the exact eight-member CI set. `optional` names
 * describe the canonical optional Linux payloads. Local publishers may also
 * explicitly pin other existing versioned payload/checksum pairs.
 */
export function assetNames({ productVersion, tag } = {}) {
  const releaseTag = canonicalTag(productVersion, tag);
  const desktopStem = `${ARTIFACT_PREFIX}desktop-${productVersion}-macos-arm64`;
  const macos = {
    dmg: `${desktopStem}.dmg`,
    dmgChecksum: `${desktopStem}.dmg.sha256`,
    archive: `${desktopStem}.app.tar.gz`,
    archiveSignature: `${desktopStem}.app.tar.gz.sig`,
    archiveChecksum: `${desktopStem}.app.tar.gz.sha256`,
    manifest: 'desktop-update.json',
  };
  const server = {
    archive: `${ARTIFACT_PREFIX}server-${productVersion}-linux-x64-node22.tar.gz`,
    checksum: `${ARTIFACT_PREFIX}server-${productVersion}-linux-x64-node22.tar.gz.sha256`,
  };
  const optional = {
    linuxDeb: `${ARTIFACT_PREFIX}desktop-${productVersion}-linux-x64.deb`,
    linuxDebChecksum: `${ARTIFACT_PREFIX}desktop-${productVersion}-linux-x64.deb.sha256`,
    linuxAppImage: `${ARTIFACT_PREFIX}desktop-${productVersion}-linux-x64.AppImage`,
    linuxAppImageChecksum: `${ARTIFACT_PREFIX}desktop-${productVersion}-linux-x64.AppImage.sha256`,
  };
  const ciAssets = [
    macos.dmg,
    macos.dmgChecksum,
    macos.archive,
    macos.archiveSignature,
    macos.archiveChecksum,
    macos.manifest,
    server.archive,
    server.checksum,
  ];
  return Object.freeze({
    productVersion: strictVersion(productVersion, 'Product version'),
    tag: releaseTag,
    macos: Object.freeze(macos),
    server: Object.freeze(server),
    optional: Object.freeze(optional),
    ciAssets: Object.freeze(ciAssets),
    canonicalPayloads: Object.freeze([macos.dmg, macos.archive, server.archive]),
    optionalPayloads: Object.freeze([optional.linuxDeb, optional.linuxAppImage]),
  });
}

function payloadDefinitions(names, pins = new Map()) {
  const definitions = new Map([
    [names.macos.dmg, { sidecar: names.macos.dmgChecksum, maxBytes: MAX_DMG_BYTES }],
    [names.macos.archive, { sidecar: names.macos.archiveChecksum, maxBytes: MAX_ARCHIVE_BYTES }],
    [names.server.archive, { sidecar: names.server.checksum, maxBytes: MAX_PAYLOAD_BYTES }],
    [names.optional.linuxDeb, { sidecar: names.optional.linuxDebChecksum, maxBytes: MAX_PAYLOAD_BYTES }],
    [names.optional.linuxAppImage, { sidecar: names.optional.linuxAppImageChecksum, maxBytes: MAX_PAYLOAD_BYTES }],
  ]);
  for (const name of pins.keys()) {
    demand(SAFE_ASSET_NAME.test(name) && name.startsWith(ARTIFACT_PREFIX)
      && name.includes(`-${names.productVersion}-`) && !name.endsWith('.sha256') && !name.endsWith('.sig'),
    'Pins must name safe versioned payloads, not manifest, signature or checksum sidecars.');
    if (!definitions.has(name)) definitions.set(name, { sidecar: `${name}.sha256`, maxBytes: MAX_PAYLOAD_BYTES });
  }
  return definitions;
}

function normalizePins(pins) {
  if (pins === undefined || pins === null) return new Map();
  let entries;
  if (pins instanceof Map) {
    entries = [...pins.entries()];
  } else if (Array.isArray(pins)) {
    entries = pins.map((entry, index) => {
      demand(Array.isArray(entry) && entry.length === 2, `Pin ${index + 1} must be a [name, sha256] pair.`);
      return entry;
    });
  } else {
    demand(isRecord(pins), 'Pins must be a Map, object, or [name, sha256] list.');
    entries = Object.entries(pins);
  }
  const normalized = new Map();
  for (const [name, hash] of entries) {
    demand(typeof name === 'string' && !normalized.has(name), 'Payload pins must have unique names.');
    demand(typeof hash === 'string' && SHA256.test(hash), `Pin for ${name} must be a lowercase SHA-256.`);
    normalized.set(name, hash);
  }
  return normalized;
}

function expectedAssetNames(names, mode, pins) {
  demand(mode === 'ci' || mode === 'local', 'Asset validation mode must be ci or local.');
  if (mode === 'ci') {
    for (const name of pins.keys()) {
      demand(names.canonicalPayloads.includes(name), 'CI pins may only name canonical payloads.');
    }
    return new Set(names.ciAssets);
  }
  demand(pins.size <= MAX_RELEASE_PAYLOADS, `Local release may pin at most ${MAX_RELEASE_PAYLOADS} payloads.`);
  const definitions = payloadDefinitions(names, pins);
  for (const name of names.canonicalPayloads) {
    demand(pins.has(name), `Local release must explicitly pin canonical payload ${name}.`);
  }
  const expected = new Set(names.ciAssets);
  for (const name of pins.keys()) {
    expected.add(name);
    expected.add(definitions.get(name).sidecar);
  }
  return expected;
}

function validateAssetMetadata(asset, expected, definitions, pins, signatureName, manifestName) {
  demand(isRecord(asset), 'Release assets must be metadata objects.');
  const { name } = asset;
  demand(typeof name === 'string' && SAFE_ASSET_NAME.test(name), 'Release asset has an unsafe basename.');
  demand(expected.has(name), `Unlisted release asset is not allowed: ${name}`);
  demand(Number.isSafeInteger(asset.id) && asset.id > 0, `Asset ${name} must have a positive numeric ID.`);
  demand(Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= MAX_PAYLOAD_BYTES,
    `Asset ${name} has an invalid or oversized byte count.`);
  if ('state' in asset) demand(asset.state === 'uploaded', `Asset ${name} is not fully uploaded.`);
  else throw new Error(`Asset ${name} is missing its upload state.`);
  if ('digest' in asset && asset.digest !== null) {
    demand(typeof asset.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(asset.digest),
      `Asset ${name} has an invalid GitHub digest.`);
  }
  if ('updated_at' in asset && asset.updated_at !== null) validUtcDate(asset.updated_at, `${name} updated_at`);
  if ('label' in asset && asset.label !== null) boundedText(asset.label, `${name} label`, 256, { empty: true });

  const payload = definitions.get(name);
  if (payload) {
    demand(asset.size <= payload.maxBytes, `Payload ${name} exceeds its release size limit.`);
    const pinned = pins.get(name);
    if (pinned && asset.digest !== null && asset.digest !== undefined) {
      demand(asset.digest === `sha256:${pinned}`, `Asset ${name} disagrees with its independent pin.`);
    }
  } else if (name.endsWith('.sha256')) {
    demand(asset.size <= MAX_CHECKSUM_BYTES, `Checksum sidecar ${name} is oversized.`);
  } else if (name.endsWith('.sig')) {
    demand(name === signatureName,
      `Signature sidecar ${name} is not attached to the canonical updater archive.`);
    demand(asset.size <= MAX_SIGNATURE_BYTES, `Signature sidecar ${name} is oversized.`);
  } else if (name === manifestName) {
    demand(asset.size <= MAX_MANIFEST_BYTES, 'desktop-update.json is oversized.');
  }
  return {
    id: asset.id,
    name,
    size: asset.size,
    state: asset.state,
    digest: asset.digest ?? null,
    ...(asset.updated_at === undefined ? {} : { updated_at: asset.updated_at }),
  };
}

/**
 * Validate a GitHub-release asset list against the exact CI or local allowlist.
 *
 * `assets` contains GitHub metadata objects with numeric `id`, `name`, positive
 * `size`, `state: "uploaded"` and optional `digest`/`updated_at`/`label`.
 * CI accepts exactly eight names. Local requires independent SHA-256 `pins`
 * for the three canonical payloads and accepts only explicitly pinned extra
 * versioned payload/checksum pairs, including Linux, never extra signatures.
 *
 * This checks metadata and independent hash declarations only. It does not
 * verify archive bytes, checksums, or updater signatures.
 */
export function validateReleaseAssets({
  assets,
  productVersion,
  tag,
  mode = 'ci',
  pins,
  manifest,
  desktopVersion,
  commit,
  minimumSystemVersion,
  channel,
  expectedSignature,
} = {}) {
  const names = assetNames({ productVersion, tag });
  const normalizedPins = normalizePins(pins);
  const expected = expectedAssetNames(names, mode, normalizedPins);
  demand(Array.isArray(assets) && assets.length === expected.size, 'Release asset list does not have the exact expected cardinality.');
  const definitions = payloadDefinitions(names, normalizedPins);
  const seenNames = new Set();
  const seenIds = new Set();
  const normalized = [];
  for (const asset of assets) {
    const item = validateAssetMetadata(asset, expected, definitions, normalizedPins,
      names.macos.archiveSignature, names.macos.manifest);
    demand(!seenNames.has(item.name), `Duplicate release asset name: ${item.name}`);
    demand(!seenIds.has(item.id), `Duplicate release asset ID: ${item.id}`);
    seenNames.add(item.name);
    seenIds.add(item.id);
    normalized.push(item);
  }
  for (const name of expected) demand(seenNames.has(name), `Missing release asset: ${name}`);
  if (manifest !== undefined) {
    validateDesktopUpdateManifest(manifest, {
      productVersion,
      desktopVersion,
      tag: names.tag,
      commit,
      minimumSystemVersion,
      channel,
      expectedSignature,
    });
  }
  return Object.freeze({
    mode,
    productVersion: names.productVersion,
    tag: names.tag,
    names,
    expectedNames: Object.freeze([...expected].sort()),
    payloadNames: Object.freeze([...definitions.keys()].filter(name => normalizedPins.has(name) || names.canonicalPayloads.includes(name))),
    pins: new Map(normalizedPins),
    assets: Object.freeze(normalized.sort((a, b) => a.name.localeCompare(b.name))),
    manifestValidated: manifest !== undefined,
  });
}

/**
 * Build the canonical desktop-update.json object for one release.
 *
 * The archive URL, repository, channel, platform and target are derived from
 * shared product identity and the version/tag. The returned object is already
 * passed through strict metadata validation; this still makes no cryptographic
 * claim about the supplied signature.
 */
export function buildDesktopUpdateManifest({
  productVersion,
  desktopVersion,
  notes,
  pubDate,
  minimumSystemVersion,
  commit,
  signature,
  tag,
  channel,
  target = MACOS_RUST_TARGET,
} = {}) {
  const names = assetNames({ productVersion, tag });
  const derivedChannel = productChannel(productVersion);
  if (channel !== undefined) demand(channel === derivedChannel, 'Manifest channel does not match productVersion.');
  demand(target === MACOS_RUST_TARGET, 'Manifest build target is not the canonical macOS arm64 target.');
  const manifest = {
    version: desktopVersion,
    notes,
    pub_date: pubDate,
    platforms: {
      [MACOS_UPDATE_TARGET]: {
        url: canonicalArchiveUrl(names.tag, names.macos.archive),
        signature,
      },
    },
    productVersion,
    channel: derivedChannel,
    minimumSystemVersion,
    repository: REPOSITORY_SLUG,
    build: {
      commit,
      target: MACOS_RUST_TARGET,
    },
  };
  return validateDesktopUpdateManifest(manifest, {
    productVersion,
    desktopVersion,
    tag: names.tag,
    commit,
    minimumSystemVersion,
    channel: derivedChannel,
    expectedSignature: signature,
    target,
  });
}

/**
 * Strictly validate the bounded desktop-update.json object.
 *
 * The signature is checked only for bounded base64 syntax. Cryptographic
 * verification of the `.app.tar.gz` bytes is intentionally owned by the
 * subsequent archive-signing/verifier slice.
 */
export function validateDesktopUpdateManifest(manifest, {
  productVersion,
  desktopVersion,
  tag,
  commit,
  minimumSystemVersion,
  channel,
  expectedSignature,
  target = MACOS_RUST_TARGET,
} = {}) {
  demand(isRecord(manifest), 'desktop-update.json must be a plain object.');
  exactKeys(manifest, [
    'version',
    'notes',
    'pub_date',
    'platforms',
    'productVersion',
    'channel',
    'minimumSystemVersion',
    'repository',
    'build',
  ], 'desktop-update.json');
  let encoded;
  try {
    encoded = JSON.stringify(manifest);
  } catch {
    throw new Error('desktop-update.json must be JSON-serializable.');
  }
  demand(Buffer.byteLength(encoded, 'utf8') <= MAX_MANIFEST_BYTES, 'desktop-update.json exceeds its size limit.');

  const manifestProductVersion = strictVersion(manifest.productVersion, 'Manifest productVersion');
  const manifestTag = canonicalTag(manifestProductVersion, tag);
  if (productVersion !== undefined) {
    demand(strictVersion(productVersion, 'Expected productVersion') === manifestProductVersion,
      'Manifest productVersion does not match the release.');
  }
  const manifestDesktopVersion = strictVersion(manifest.version, 'Manifest version');
  if (desktopVersion !== undefined) {
    demand(strictVersion(desktopVersion, 'Expected desktopVersion') === manifestDesktopVersion,
      'Manifest version does not match the desktop build.');
  }
  validUtcDate(manifest.pub_date, 'Manifest pub_date');
  boundedText(manifest.notes, 'Manifest notes', MAX_MANIFEST_BYTES);

  const manifestChannel = productChannel(manifestProductVersion);
  demand(manifest.channel === manifestChannel, 'Manifest channel does not match productVersion.');
  if (channel !== undefined) demand(channel === manifestChannel, 'Manifest channel does not match the expected channel.');
  validMacosVersion(manifest.minimumSystemVersion);
  if (minimumSystemVersion !== undefined) {
    demand(validMacosVersion(minimumSystemVersion) === manifest.minimumSystemVersion,
      'Manifest minimumSystemVersion does not match the release.');
  }
  demand(manifest.repository === REPOSITORY_SLUG, 'Manifest repository is not the canonical repository.');

  demand(isRecord(manifest.platforms), 'Manifest platforms must be an object.');
  exactKeys(manifest.platforms, [MACOS_UPDATE_TARGET], 'Manifest platforms');
  const platform = manifest.platforms[MACOS_UPDATE_TARGET];
  demand(isRecord(platform), 'Manifest darwin-aarch64 platform must be an object.');
  exactKeys(platform, ['url', 'signature'], 'Manifest darwin-aarch64 platform');
  const names = assetNames({ productVersion: manifestProductVersion, tag: manifestTag });
  const expectedUrl = canonicalArchiveUrl(manifestTag, names.macos.archive);
  demand(typeof platform.url === 'string' && platform.url === expectedUrl, 'Manifest updater URL is not the canonical GitHub download URL.');
  let parsedUrl;
  try {
    parsedUrl = new URL(platform.url);
  } catch {
    throw new Error('Manifest updater URL is malformed.');
  }
  demand(parsedUrl.protocol === 'https:' && parsedUrl.username === '' && parsedUrl.password === ''
    && parsedUrl.search === '' && parsedUrl.hash === '' && parsedUrl.href === expectedUrl,
  'Manifest updater URL must be credential-free HTTPS without query or fragment data.');
  validSignature(platform.signature);
  if (expectedSignature !== undefined) {
    demand(validSignature(expectedSignature, 'Expected updater signature') === platform.signature,
      'Manifest updater signature does not match the staged signature.');
  }

  demand(isRecord(manifest.build), 'Manifest build must be an object.');
  exactKeys(manifest.build, ['commit', 'target'], 'Manifest build');
  validCommit(manifest.build.commit);
  if (commit !== undefined) demand(validCommit(commit, 'Expected build commit') === manifest.build.commit,
    'Manifest build commit does not match the release.');
  demand(manifest.build.target === target && target === MACOS_RUST_TARGET,
    'Manifest build target is not the canonical macOS arm64 target.');
  return Object.freeze({
    ...manifest,
    platforms: Object.freeze({
      [MACOS_UPDATE_TARGET]: Object.freeze({ ...platform }),
    }),
    build: Object.freeze({ ...manifest.build }),
  });
}

/**
 * Prove that a candidate desktopVersion clears the complete published history.
 *
 * `priorPublished` must be an explicit, complete mapping (including
 * pre-updater releases): each record has a stable numeric `id`, canonical
 * product `tag`/`productVersion`, mapped `desktopVersion`, full source
 * `commit`, and UTC `publishedAt`. `historyComplete` must be the literal
 * boolean true; a partial or unknown history is rejected.
 */
export function validateDesktopVersionFloor({
  candidateDesktopVersion,
  priorPublished,
  historyComplete,
  baseline = DESKTOP_VERSION_BASELINE,
} = {}) {
  demand(historyComplete === true, 'Complete published desktop-version history is required.');
  demand(strictVersion(baseline, 'Desktop version baseline') === DESKTOP_VERSION_BASELINE,
    `Desktop version baseline is fixed at ${DESKTOP_VERSION_BASELINE}.`);
  demand(Array.isArray(priorPublished), 'Published desktop-version history must be an array.');
  const candidate = strictVersion(candidateDesktopVersion, 'Candidate desktopVersion');
  let floor = semver.parse(DESKTOP_VERSION_BASELINE);
  const ids = new Set();
  const tags = new Set();
  for (const release of priorPublished) {
    demand(isRecord(release), 'Published history entries must be plain objects.');
    exactKeys(release, ['id', 'tag', 'productVersion', 'desktopVersion', 'commit', 'publishedAt'], 'Published history entry');
    demand(Number.isSafeInteger(release.id) && release.id > 0, 'Published history IDs must be positive numeric IDs.');
    demand(!ids.has(release.id), `Duplicate published history ID: ${release.id}`);
    ids.add(release.id);
    strictVersion(release.productVersion, 'Published productVersion');
    productChannel(release.productVersion);
    const releaseTag = canonicalTag(release.productVersion, release.tag);
    demand(!tags.has(releaseTag), `Duplicate published history tag: ${releaseTag}`);
    tags.add(releaseTag);
    const desktopVersion = strictVersion(release.desktopVersion, 'Published desktopVersion');
    validCommit(release.commit, 'Published source commit');
    validUtcDate(release.publishedAt, 'Published history timestamp');
    if (semver.gt(desktopVersion, floor)) floor = semver.parse(desktopVersion);
  }
  demand(semver.gt(candidate, floor), `Candidate desktopVersion ${candidate} must be greater than historical floor ${floor.version}.`);
  return Object.freeze({
    baseline: DESKTOP_VERSION_BASELINE,
    floor: floor.version,
    candidateDesktopVersion: candidate,
    historyCount: priorPublished.length,
    historyComplete: true,
  });
}

/**
 * Compare a validated candidate manifest using true SemVer and channel policy.
 *
 * Stable installations accept only stable candidates. Beta installations may
 * adopt beta or stable. Product SemVer identifies the release and channel;
 * desktopVersion is the sole install ordering authority.
 */
export function compareDesktopUpdate({
  currentProductVersion,
  currentDesktopVersion,
  currentChannel,
  candidateManifest,
  candidateProductVersion,
  candidateTag,
  candidateCommit,
  candidateMinimumSystemVersion,
  expectedSignature,
} = {}) {
  const currentProduct = strictVersion(currentProductVersion, 'Current productVersion');
  const currentDesktop = strictVersion(currentDesktopVersion, 'Current desktopVersion');
  const inferredCurrentChannel = productChannel(currentProduct);
  demand(currentChannel === undefined || currentChannel === inferredCurrentChannel,
    'Current channel does not match current productVersion.');
  const candidateProduct = candidateProductVersion ?? candidateManifest?.productVersion;
  const candidate = validateDesktopUpdateManifest(candidateManifest, {
    productVersion: candidateProduct,
    tag: candidateTag,
    commit: candidateCommit,
    minimumSystemVersion: candidateMinimumSystemVersion,
    expectedSignature,
  });
  const productRelation = semver.compare(candidate.productVersion, currentProduct);
  const desktopRelation = semver.compare(candidate.version, currentDesktop);
  const relation = desktopRelation > 0 ? 'newer' : desktopRelation < 0 ? 'older' : 'equal';
  let reason = 'eligible';
  let eligible = true;
  if (inferredCurrentChannel === 'stable' && candidate.channel === 'beta') {
    eligible = false;
    reason = 'stable-channel-excludes-beta';
  } else if (desktopRelation <= 0) {
    eligible = false;
    reason = relation === 'equal' ? 'desktop-version-equal' : 'desktop-version-older';
  }
  return Object.freeze({
    eligible,
    reason,
    relation,
    productRelation: productRelation > 0 ? 'newer' : productRelation < 0 ? 'older' : 'equal',
    current: Object.freeze({
      productVersion: currentProduct,
      desktopVersion: currentDesktop,
      channel: inferredCurrentChannel,
    }),
    candidate: Object.freeze({
      productVersion: candidate.productVersion,
      desktopVersion: candidate.version,
      channel: candidate.channel,
    }),
  });
}
