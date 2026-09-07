import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  DESKTOP_VERSION_BASELINE,
  MACOS_RUST_TARGET,
  MACOS_UPDATE_TARGET,
  UPDATER_ASSET_LIMITS,
  MAX_CHECKSUM_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_PAYLOAD_BYTES,
  MAX_RELEASE_PAYLOADS,
  MAX_SIGNATURE_BYTES,
  assetNames,
  buildDesktopUpdateManifest,
  compareDesktopUpdate,
  validateDesktopUpdateManifest,
  validateDesktopVersionFloor,
  validateReleaseAssets,
} from './updater-artifacts.mjs';

const productVersion = '2.0.0-beta.10';
const desktopVersion = '0.2.4';
const commit = 'a'.repeat(40);
const signature = 'A'.repeat(88);
const pubDate = '2026-09-06T00:00:00Z';
const sharedManifestFixture = JSON.parse(readFileSync(
  new URL('../../shared/fixtures/desktop-update-manifest.json', import.meta.url),
  'utf8',
));

function manifestFor(overrides = {}) {
  return buildDesktopUpdateManifest({
    productVersion,
    desktopVersion,
    notes: 'A signed release fixture.',
    pubDate,
    minimumSystemVersion: '13.0',
    commit,
    signature,
    ...overrides,
  });
}

function assetsFor(names, overrides = {}) {
  return names.map((name, index) => ({
    id: index + 1,
    name,
    size: name.endsWith('.sha256') ? 80 : name.endsWith('.sig') ? 100 : name === 'desktop-update.json' ? 500 : 1024,
    state: 'uploaded',
    digest: null,
    updated_at: pubDate,
    ...overrides,
  }));
}

function localPins(names, optional = []) {
  return new Map([
    [names.macos.dmg, '1'.repeat(64)],
    [names.macos.archive, '2'.repeat(64)],
    [names.server.archive, '3'.repeat(64)],
    ...optional.map((name, index) => [name, `${index + 4}`.repeat(64)]),
  ]);
}

test('assetNames derives the exact versioned CI set and known optional Linux names', () => {
  const names = assetNames({ productVersion });
  assert.equal(names.tag, `v${productVersion}`);
  assert.deepEqual(names.macos, {
    dmg: 'gajae-app-desktop-2.0.0-beta.10-macos-arm64.dmg',
    dmgChecksum: 'gajae-app-desktop-2.0.0-beta.10-macos-arm64.dmg.sha256',
    archive: 'gajae-app-desktop-2.0.0-beta.10-macos-arm64.app.tar.gz',
    archiveSignature: 'gajae-app-desktop-2.0.0-beta.10-macos-arm64.app.tar.gz.sig',
    archiveChecksum: 'gajae-app-desktop-2.0.0-beta.10-macos-arm64.app.tar.gz.sha256',
    manifest: 'desktop-update.json',
  });
  assert.deepEqual(names.ciAssets, [
    names.macos.dmg,
    names.macos.dmgChecksum,
    names.macos.archive,
    names.macos.archiveSignature,
    names.macos.archiveChecksum,
    names.macos.manifest,
    names.server.archive,
    names.server.checksum,
  ]);
  assert.equal(new Set(names.ciAssets).size, 8);
  assert.match(names.optional.linuxAppImage, /-linux-x64\.AppImage$/);
  assert.throws(() => assetNames({ productVersion: 'v2.0.0' }), /strict SemVer/);
  assert.throws(() => assetNames({ productVersion, tag: 'latest' }), /Release tag/);
});

test('CI allowlist requires exactly eight uploaded assets and rejects extras, duplicates, and bad bounds', () => {
  const names = assetNames({ productVersion });
  const manifest = manifestFor();
  const assets = assetsFor(names.ciAssets);
  const result = validateReleaseAssets({
    assets,
    productVersion,
    desktopVersion,
    commit,
    manifest,
    expectedSignature: signature,
  });
  assert.equal(result.mode, 'ci');
  assert.deepEqual(result.expectedNames, [...names.ciAssets].sort());
  assert.deepEqual(result.payloadNames, [names.macos.dmg, names.macos.archive, names.server.archive]);

  for (const change of [
    list => list.slice(1),
    list => [...list, { ...list[0], id: 99, name: 'gajae-app-desktop-2.0.0-beta.10-linux-x64.zip' }],
    list => list.map((asset, index) => index === 1 ? { ...asset, id: list[0].id } : asset),
    list => list.map((asset, index) => index === 1 ? { ...asset, name: list[0].name } : asset),
    list => list.map(asset => asset.name.endsWith('.sha256') ? { ...asset, size: MAX_CHECKSUM_BYTES + 1 } : asset),
    list => list.map(asset => asset.name.endsWith('.sig') ? { ...asset, size: MAX_SIGNATURE_BYTES + 1 } : asset),
    list => list.map(asset => asset.name === 'desktop-update.json' ? { ...asset, size: MAX_MANIFEST_BYTES + 1 } : asset),
    list => list.map(asset => asset.name === names.macos.dmg ? { ...asset, size: MAX_PAYLOAD_BYTES + 1 } : asset),
    list => list.map(asset => asset.name === names.macos.archiveSignature ? { ...asset, name: `${names.macos.dmg}.sig` } : asset),
    list => list.map(asset => asset.name === names.server.archive ? { ...asset, digest: 'sha256:bad' } : asset),
    list => list.map(asset => asset.name === names.server.archive ? { ...asset, state: 'starter' } : asset),
  ]) {
    assert.throws(() => validateReleaseAssets({
      assets: change(assets),
      productVersion,
      mode: 'ci',
    }));
  }
});

test('only the updater archive uses the compressed archive bound; server payload keeps the generic bound', () => {
  const names = assetNames({ productVersion });
  const sizeAboveUpdaterBound = UPDATER_ASSET_LIMITS.maxArchiveBytes + 1;
  const assets = assetsFor(names.ciAssets);
  assert.doesNotThrow(() => validateReleaseAssets({
    assets: assets.map(asset => asset.name === names.macos.archive
      ? { ...asset, size: UPDATER_ASSET_LIMITS.maxArchiveBytes }
      : asset),
    productVersion,
  }));
  const serverAboveUpdaterBound = assets.map(asset => asset.name === names.server.archive
    ? { ...asset, size: sizeAboveUpdaterBound }
    : asset);
  assert.doesNotThrow(() => validateReleaseAssets({
    assets: serverAboveUpdaterBound,
    productVersion,
  }));

  const updaterAboveBound = assets.map(asset => asset.name === names.macos.archive
    ? { ...asset, size: sizeAboveUpdaterBound }
    : asset);
  assert.throws(() => validateReleaseAssets({
    assets: updaterAboveBound,
    productVersion,
  }), /release size limit/);
});

test('local allowlist accepts only independently pinned canonical and explicitly pinned Linux pairs', () => {
  const names = assetNames({ productVersion });
  const optional = [names.optional.linuxDeb, names.optional.linuxAppImage];
  const pins = localPins(names, optional);
  const expected = [
    ...names.ciAssets,
    names.optional.linuxDeb,
    names.optional.linuxDebChecksum,
    names.optional.linuxAppImage,
    names.optional.linuxAppImageChecksum,
  ];
  const result = validateReleaseAssets({
    assets: assetsFor(expected),
    productVersion,
    mode: 'local',
    pins,
    manifest: manifestFor(),
    desktopVersion,
    commit,
    expectedSignature: signature,
  });
  assert.equal(result.mode, 'local');
  assert.equal(result.pins.size, 5);
  assert.equal(result.expectedNames.length, 12);

  assert.throws(() => validateReleaseAssets({
    assets: assetsFor([...names.ciAssets, names.optional.linuxDeb, names.optional.linuxDebChecksum]),
    productVersion,
    mode: 'local',
    pins: localPins(names),
  }), /pinned|exact expected/i);
  assert.throws(() => validateReleaseAssets({
    assets: assetsFor([...names.ciAssets, `${names.optional.linuxAppImage}.sig`]),
    productVersion,
    mode: 'local',
    pins: localPins(names, [names.optional.linuxAppImage]),
  }), /exact expected|Unlisted/);
  assert.throws(() => validateReleaseAssets({
    assets: assetsFor(names.ciAssets),
    productVersion,
    mode: 'local',
    pins: new Map([[names.macos.dmg, '1'.repeat(64)]]),
  }), /canonical payload/);
  assert.throws(() => validateReleaseAssets({
    assets: assetsFor(names.ciAssets),
    productVersion,
    mode: 'local',
    pins: new Map([[names.macos.dmg, '1'.repeat(64)], [names.macos.archive, '2'.repeat(64)],
      [names.server.archive, '3'.repeat(64)], [`${names.macos.dmg}.sha256`, '4'.repeat(64)]]),
  }), /sidecars/);
});

test('local releases preserve explicitly pinned additional payload pairs within the payload limit', () => {
  const names = assetNames({ productVersion });
  const pins = localPins(names);
  const expected = [...names.ciAssets];
  for (let index = 0; index < MAX_RELEASE_PAYLOADS - names.canonicalPayloads.length; index += 1) {
    const name = `gajae-app-extra-${productVersion}-reviewed-${index}.zip`;
    pins.set(name, '4'.repeat(64));
    expected.push(name, `${name}.sha256`);
  }
  const assets = assetsFor(expected);
  assert.doesNotThrow(() => validateReleaseAssets({ assets, productVersion, mode: 'local', pins }));
  assert.throws(() => validateReleaseAssets({ assets, productVersion, mode: 'ci', pins }), /canonical payloads/);
  for (const name of ['desktop-update.json', `${names.macos.archive}.sig`, '../outside.zip',
    'gajae-app-extra-1.0.0-wrong-version.zip']) {
    const invalid = new Map(localPins(names));
    invalid.set(name, '5'.repeat(64));
    assert.throws(() => validateReleaseAssets({ assets, productVersion, mode: 'local', pins: invalid }), /safe versioned payloads/);
  }
  pins.set(`gajae-app-extra-${productVersion}-overflow.zip`, '5'.repeat(64));
  assert.throws(() => validateReleaseAssets({ assets, productVersion, mode: 'local', pins }), /at most 16/);
});

test('manifest builder and validator bind product, channel, target, commit, URL, and bounded fields', () => {
  const manifest = manifestFor();
  assert.equal(manifest.version, desktopVersion);
  assert.equal(manifest.productVersion, productVersion);
  assert.equal(manifest.channel, 'beta');
  assert.equal(manifest.repository, 'devswha/gajae-code-app');
  assert.equal(Object.keys(manifest.platforms).length, 1);
  assert.equal(manifest.platforms[MACOS_UPDATE_TARGET].url,
    `https://github.com/devswha/gajae-code-app/releases/download/v${productVersion}/gajae-app-desktop-${productVersion}-macos-arm64.app.tar.gz`);
  assert.equal(manifest.build.target, MACOS_RUST_TARGET);
  assert.deepEqual(validateDesktopUpdateManifest(manifest, {
    productVersion,
    desktopVersion,
    commit,
    expectedSignature: signature,
  }), manifest);

  const mutate = (change) => {
    const copy = JSON.parse(JSON.stringify(manifest));
    change(copy);
    return copy;
  };
  for (const [change, expected] of [
    [copy => { copy.platforms[MACOS_UPDATE_TARGET].url = 'https://evil.example/app.tar.gz'; }, /canonical GitHub/],
    [copy => { copy.platforms[MACOS_UPDATE_TARGET].url += '?token=secret'; }, /canonical GitHub|credential-free/],
    [copy => { copy.platforms[MACOS_UPDATE_TARGET].url = copy.platforms[MACOS_UPDATE_TARGET].url.replace('https://', 'https://user:secret@'); }, /canonical GitHub|credential-free/],
    [copy => { copy.platforms[MACOS_UPDATE_TARGET].url += '#fragment'; }, /canonical GitHub|credential-free/],
    [copy => { copy.platforms['linux-x64'] = copy.platforms[MACOS_UPDATE_TARGET]; }, /unexpected or missing/],
    [copy => { copy.channel = 'stable'; }, /channel/],
    [copy => { copy.productVersion = '2.0.0-alpha.1'; }, /Only beta/],
    [copy => { copy.build.commit = 'B'.repeat(40); }, /lowercase/],
    [copy => { copy.build.target = 'x86_64-apple-darwin'; }, /canonical macOS/],
    [copy => { copy.platforms[MACOS_UPDATE_TARGET].signature = 'not-base64'; }, /base64/],
    [copy => { copy.notes = 'x'.repeat(MAX_MANIFEST_BYTES); }, /size limit|oversized/],
    [copy => { copy.pub_date = '2026-02-31T00:00:00Z'; }, /real UTC/],
    [copy => { copy.extra = true; }, /unexpected or missing/],
  ]) assert.throws(() => validateDesktopUpdateManifest(mutate(change)), expected);
  assert.throws(() => buildDesktopUpdateManifest({
    productVersion,
    desktopVersion,
    notes: 'missing commit',
    pubDate,
    minimumSystemVersion: '13.0',
    signature,
  }), /full commit/);
});

test('shared native fixture is the producer output and its signature is syntax-only', () => {
  const built = manifestFor();
  assert.deepEqual(sharedManifestFixture, built);
  assert.deepEqual(validateDesktopUpdateManifest(sharedManifestFixture, {
    productVersion,
    desktopVersion,
    commit,
    expectedSignature: signature,
  }), built);
  assert.equal(sharedManifestFixture.platforms[MACOS_UPDATE_TARGET].signature, signature);
  assert.equal(
    sharedManifestFixture.platforms[MACOS_UPDATE_TARGET].signature,
    'A'.repeat(88),
    'fixture signature is bounded base64 syntax only, not cryptographic acceptance',
  );
});

test('strict producer SemVer rejects normalized build metadata and adversarial manifest bounds', () => {
  assert.throws(() => manifestFor({
    productVersion: '2.0.0-beta.10+build.1',
  }), /strict SemVer/);
  for (const change of [
    copy => { copy.minimumSystemVersion = '13'; },
    copy => { copy.minimumSystemVersion = '013.0'; },
    copy => { copy.minimumSystemVersion = '13.00'; },
    copy => { copy.minimumSystemVersion = '13.0.0.1'; },
    copy => { copy.minimumSystemVersion = '1000.0'; },
    copy => { copy.minimumSystemVersion = '13.1000'; },
    copy => { copy.notes = 'ok\u000b'; },
    copy => { copy.platforms[MACOS_UPDATE_TARGET].signature = 'A'.repeat(MAX_SIGNATURE_BYTES + 1); },
    copy => { copy.pub_date = '2026-02-29T00:00:00Z'; },
    copy => { copy.pub_date = '2024-02-30T00:00:00Z'; },
  ]) {
    const copy = JSON.parse(JSON.stringify(sharedManifestFixture));
    change(copy);
    assert.throws(() => validateDesktopUpdateManifest(copy), /minimumSystemVersion|control|size|base64|real UTC/);
  }
});

test('historical floor requires an explicit complete mapping and compares prereleases with SemVer', () => {
  const history = [
    {
      id: 1,
      tag: 'v2.0.0-beta.9',
      productVersion: '2.0.0-beta.9',
      desktopVersion: DESKTOP_VERSION_BASELINE,
      commit: 'b'.repeat(40),
      publishedAt: '2026-08-01T00:00:00Z',
    },
    {
      id: 2,
      tag: 'v2.0.0-beta.10',
      productVersion: '2.0.0-beta.10',
      desktopVersion: '0.2.4-beta.9',
      commit: 'c'.repeat(40),
      publishedAt: '2026-09-01T00:00:00Z',
    },
  ];
  const result = validateDesktopVersionFloor({
    candidateDesktopVersion: '0.2.4-beta.10',
    priorPublished: history,
    historyComplete: true,
  });
  assert.equal(result.floor, '0.2.4-beta.9');
  assert.equal(result.candidateDesktopVersion, '0.2.4-beta.10');
  assert.equal(result.historyCount, 2);

  assert.throws(() => validateDesktopVersionFloor({
    candidateDesktopVersion: '0.2.4',
    priorPublished: history,
    historyComplete: false,
  }), /complete/i);
  assert.throws(() => validateDesktopVersionFloor({
    candidateDesktopVersion: '0.2.4-beta.10',
    priorPublished: [{ ...history[0], desktopVersion: undefined }],
    historyComplete: true,
  }), /strict SemVer/);
  assert.throws(() => validateDesktopVersionFloor({
    candidateDesktopVersion: '0.2.4-beta.9',
    priorPublished: history,
    historyComplete: true,
  }), /greater than historical floor/);
  assert.throws(() => validateDesktopVersionFloor({
    candidateDesktopVersion: '0.2.4',
    priorPublished: [{ ...history[0], id: 1 }, { ...history[1], id: 1 }],
    historyComplete: true,
  }), /Duplicate published history ID/);
  const repeatedAndBackfilled = validateDesktopVersionFloor({
    candidateDesktopVersion: '0.2.5',
    priorPublished: [
      ...history,
      {
        id: 3,
        tag: 'v2.0.0-beta.11',
        productVersion: '2.0.0-beta.11',
        desktopVersion: '0.2.4-beta.9',
        commit: 'd'.repeat(40),
        publishedAt: '2026-07-01T00:00:00Z',
      },
      {
        id: 4,
        tag: 'v1.9.9-beta.1',
        productVersion: '1.9.9-beta.1',
        desktopVersion: '0.2.3',
        commit: 'e'.repeat(40),
        publishedAt: '2026-10-01T00:00:00Z',
      },
    ],
    historyComplete: true,
  });
  assert.equal(repeatedAndBackfilled.floor, '0.2.4-beta.9');
  assert.equal(repeatedAndBackfilled.candidateDesktopVersion, '0.2.5');
  assert.throws(() => validateDesktopVersionFloor({
    candidateDesktopVersion: '0.2.4',
    priorPublished: history,
    historyComplete: true,
    baseline: '0.2.2',
  }), /baseline/);
});

test('update comparison applies true desktop SemVer and beta/stable channel policy', () => {
  const stableManifest = buildDesktopUpdateManifest({
    productVersion: '2.0.0',
    desktopVersion: '0.2.5',
    notes: 'Stable release.',
    pubDate,
    minimumSystemVersion: '13.0',
    commit,
    signature,
  });
  const betaCurrent = compareDesktopUpdate({
    currentProductVersion: '2.0.0-beta.9',
    currentDesktopVersion: '0.2.4-beta.9',
    candidateManifest: stableManifest,
  });
  assert.equal(betaCurrent.eligible, true);
  assert.equal(betaCurrent.relation, 'newer');
  assert.equal(betaCurrent.productRelation, 'newer');

  const lowerProduct = compareDesktopUpdate({
    currentProductVersion: '2.0.0-beta.10',
    currentDesktopVersion: '0.2.4',
    candidateManifest: manifestFor({
      productVersion: '1.9.9-beta.1',
      desktopVersion: '0.2.5',
    }),
  });
  assert.equal(lowerProduct.eligible, true);
  assert.equal(lowerProduct.reason, 'eligible');
  assert.equal(lowerProduct.productRelation, 'older');

  const betaManifest = manifestFor({
    productVersion: '2.0.1-beta.1',
    desktopVersion: '0.2.6',
  });
  const stableCurrent = compareDesktopUpdate({
    currentProductVersion: '2.0.0',
    currentDesktopVersion: '0.2.5',
    candidateManifest: betaManifest,
  });
  assert.equal(stableCurrent.eligible, false);
  assert.equal(stableCurrent.reason, 'stable-channel-excludes-beta');

  const higherProductEqualDesktop = compareDesktopUpdate({
    currentProductVersion: '1.9.9',
    currentDesktopVersion: '0.2.5',
    candidateManifest: stableManifest,
  });
  assert.equal(higherProductEqualDesktop.eligible, false);
  assert.equal(higherProductEqualDesktop.reason, 'desktop-version-equal');

  const same = compareDesktopUpdate({
    currentProductVersion: '2.0.0-beta.9',
    currentDesktopVersion: desktopVersion,
    candidateManifest: manifestFor(),
  });
  assert.equal(same.eligible, false);
  assert.equal(same.reason, 'desktop-version-equal');

  const olderManifest = manifestFor({
    productVersion: '2.0.0-beta.11',
    desktopVersion: '0.2.3',
  });
  const older = compareDesktopUpdate({
    currentProductVersion: '2.0.0-beta.10',
    currentDesktopVersion: desktopVersion,
    candidateManifest: olderManifest,
  });
  assert.equal(older.eligible, false);
  assert.equal(older.reason, 'desktop-version-older');
  assert.throws(() => compareDesktopUpdate({
    currentProductVersion: '2.0.0',
    currentDesktopVersion: '0.2.5',
    currentChannel: 'beta',
    candidateManifest: stableManifest,
  }), /Current channel/);
});
