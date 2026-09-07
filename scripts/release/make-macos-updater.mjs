#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { constants, createReadStream, realpathSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { PRODUCT_NAME } from '../../shared/productIdentity.js';

import { releaseCommand } from './local-release-command.mjs';
import { verifyMacosApp, verifyMacosRelease } from './local-release-macos.mjs';
import { assertOutOfTree } from './out-of-tree.mjs';
import { compareAppInventories, createUpdaterArchive, inventoryApp } from './updater-archive.mjs';
import { assetNames, buildDesktopUpdateManifest, UPDATER_ASSET_LIMITS } from './updater-artifacts.mjs';
import { readUpdaterSidecar, verifyUpdaterSignature } from './updater-signature.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const signer = fileURLToPath(new URL('../../node_modules/@tauri-apps/cli/tauri.js', import.meta.url));
const demand = (condition, message) => { if (!condition) throw new Error(message); };

async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Build six macOS assets from one already signed, notarized, stapled app. */
export async function makeMacosUpdater({
  app, dmg, outputDirectory, productVersion, desktopVersion, commit,
  minimumSystemVersion, teamId, publicKeyFile, notes, pubDate,
}, { run = releaseCommand, verifyApp = verifyMacosApp, verifyMac = verifyMacosRelease } = {}) {
  const names = assetNames({ productVersion });
  demand(/^[a-f0-9]{40}$/.test(commit ?? ''), 'The exact build commit is required.');
  demand(/^[A-Z0-9]{10}$/.test(teamId ?? ''), 'An explicit Developer ID team is required.');
  demand(typeof outputDirectory === 'string' && outputDirectory.length > 0, 'A fresh output directory is required.');
  const requestedOutput = resolve(outputDirectory);
  const output = join(await realpath(dirname(requestedOutput)), basename(requestedOutput));
  const sourceApp = await realpath(app);
  demand(output !== sourceApp && !output.startsWith(`${sourceApp}/`), 'Output must not modify the finalized source app.');
  const appIdentity = { teamId, version: productVersion, desktopVersion, minimumSystemVersion };
  const publicKey = await readUpdaterSidecar(publicKeyFile, UPDATER_ASSET_LIMITS.maxSignatureBytes);
  const sourceInventory = await inventoryApp(app);
  const dmgStat = await stat(dmg);
  demand(dmgStat.isFile() && dmgStat.size > 0 && dmgStat.size <= UPDATER_ASSET_LIMITS.maxDmgBytes,
    'The finalized DMG must be a bounded nonempty file.');
  const work = await realpath(await mkdtemp(join(tmpdir(), 'gajae-updater-build-')));
  let preserveDirectory = false;
  let outputCreated = false;
  let complete = false;
  try {
    await assertOutOfTree(work, 'Updater artifact verification');
    const copyRoot = join(work, 'app-copy');
    await mkdir(copyRoot, { mode: 0o700 });
    const checkedApp = join(copyRoot, `${PRODUCT_NAME}.app`);
    await run('ditto', [app, checkedApp]);
    await run('xattr', ['-w', 'com.apple.quarantine', '0081;00000000;GajaeLocalRelease;', checkedApp]);
    compareAppInventories(sourceInventory, await inventoryApp(checkedApp));
    await verifyApp({ app: checkedApp, ...appIdentity }, { run });

    const assets = join(work, 'assets');
    await mkdir(assets, { mode: 0o700 });
    const archive = join(assets, names.macos.archive);
    await createUpdaterArchive({ appPath: app, archivePath: archive });
    compareAppInventories(sourceInventory, await inventoryApp(app));
    // The official signer obtains its key/password only through its supported
    // environment. No private key or password is placed on argv or reported.
    await run(process.execPath, [signer, 'signer', 'sign', archive]);
    const signatureText = await readUpdaterSidecar(`${archive}.sig`, UPDATER_ASSET_LIMITS.maxSignatureBytes);
    const signature = signatureText.trim();
    const archiveHash = await fileHash(archive);
    const verified = await verifyUpdaterSignature({ archivePath: archive, signature, publicKey,
      root: work, expectedSha256: archiveHash }, { run });
    const stagedDmg = join(assets, names.macos.dmg);
    await copyFile(dmg, stagedDmg, constants.COPYFILE_EXCL);
    demand((await stat(stagedDmg)).size === dmgStat.size, 'The finalized DMG changed while copying.');
    const dmgHash = await fileHash(stagedDmg);
    await verifyMac({ dmg: stagedDmg, root: work, ...appIdentity, updaterArchivePath: verified.archivePath }, { run });
    const manifest = buildDesktopUpdateManifest({ productVersion, desktopVersion, commit,
      minimumSystemVersion, notes, pubDate, signature });
    const expectedHashes = { [names.macos.archive]: archiveHash, [names.macos.dmg]: dmgHash,
      [names.macos.archiveSignature]: createHash('sha256').update(signatureText).digest('hex') };
    const sidecars = {
      [names.macos.manifest]: `${JSON.stringify(manifest, null, 2)}\n`,
      [names.macos.archiveChecksum]: `${archiveHash}  ${names.macos.archive}\n`,
      [names.macos.dmgChecksum]: `${dmgHash}  ${names.macos.dmg}\n`,
    };
    for (const [name, text] of Object.entries(sidecars)) {
      await writeFile(join(assets, name), text, { flag: 'wx', mode: 0o600 });
      expectedHashes[name] = createHash('sha256').update(text).digest('hex');
    }
    // Recheck exact signed bytes after every verifier. Never recompress or
    // modify the archive after signing, even to normalize its metadata.
    demand(await fileHash(archive) === archiveHash, 'Signed archive changed during final verification.');
    demand(await fileHash(stagedDmg) === dmgHash, 'Verified DMG changed during final verification.');
    await mkdir(output, { mode: 0o700 });
    outputCreated = true;
    for (const name of Object.values(names.macos)) {
      await copyFile(join(assets, name), join(output, name), constants.COPYFILE_EXCL);
      demand(await fileHash(join(output, name)) === expectedHashes[name], 'Final artifact copy differs from its verified bytes.');
    }
    complete = true;
    return { outputDirectory: output, assets: Object.values(names.macos), productVersion, desktopVersion,
      commit, hashes: { [names.macos.archive]: archiveHash, [names.macos.dmg]: dmgHash } };
  } catch (error) {
    preserveDirectory = error.preserveDirectory === true;
    throw error;
  } finally {
    if (outputCreated && !complete) await rm(output, { recursive: true, force: true });
    if (!preserveDirectory) await rm(work, { recursive: true, force: true });
  }
}

const usage = `Usage: node scripts/release/make-macos-updater.mjs
  --app FINAL_APP --dmg FINAL_DMG --output NEW_DIRECTORY --commit FULL_SHA
  --team-id TEAMID1234 --updater-public-key-file PUBLIC_KEY_FILE --notes-file NOTES_FILE
  --pub-date ISO_UTC_TIMESTAMP

Requires macOS arm64, official Minisign0.12, and the official Tauri signer's
TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH environment.
Encrypted keys also require TAURI_SIGNING_PRIVATE_KEY_PASSWORD. Never pass secrets
on argv. Product/desktop versions and OS floor come from the checked-out commit.
Does not sign/notarize the app, install it, or upload/publish anything.
`;

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: {
      ...Object.fromEntries(['app', 'dmg', 'output', 'commit', 'team-id', 'updater-public-key-file', 'notes-file', 'pub-date']
        .map(name => [name, { type: 'string' }])), help: { type: 'boolean' },
    } }));
    if (values.help) { process.stdout.write(usage); return; }
    demand(['app', 'dmg', 'output', 'commit', 'team-id', 'updater-public-key-file', 'notes-file', 'pub-date']
      .every(name => typeof values[name] === 'string' && values[name].length > 0), 'Missing arguments.');
  } catch {
    process.stderr.write(usage);
    process.exitCode = 2;
    return;
  }
  try {
    demand(process.platform === 'darwin' && process.arch === 'arm64', 'Updater artifact creation requires macOS arm64.');
    demand(process.env.TAURI_SIGNING_PRIVATE_KEY?.trim() || process.env.TAURI_SIGNING_PRIVATE_KEY_PATH?.trim(),
      'Configure the official updater signing key through its environment.');
    demand((await releaseCommand('minisign', ['-v'])).stdout.trim() === 'minisign 0.12', 'Official Minisign0.12 is required.');
    const head = (await releaseCommand('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim();
    demand(head === values.commit, 'The checkout must match the exact supplied build commit.');
    const source = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'));
    const config = JSON.parse(await readFile(join(repository, 'src-tauri/tauri.conf.json'), 'utf8'));
    const result = await makeMacosUpdater({
      app: values.app, dmg: values.dmg, outputDirectory: values.output, commit: values.commit,
      teamId: values['team-id'], publicKeyFile: values['updater-public-key-file'],
      productVersion: source.version, desktopVersion: source.desktopVersion,
      minimumSystemVersion: config.bundle?.macOS?.minimumSystemVersion,
      notes: await readUpdaterSidecar(values['notes-file'], UPDATER_ASSET_LIMITS.maxManifestBytes), pubDate: values['pub-date'],
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: 'blocked', error: error.message })}\n`);
    process.exitCode = 1;
  }
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isDirectInvocation()) await main();
