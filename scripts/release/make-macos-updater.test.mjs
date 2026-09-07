import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { PRODUCT_NAME } from '../../shared/productIdentity.js';

import { makeMacosUpdater } from './make-macos-updater.mjs';
import { inventoryApp, compareAppInventories } from './updater-archive.mjs';
import { assetNames, validateDesktopUpdateManifest } from './updater-artifacts.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const signature = Buffer.from('injected official-signer signature fixture').toString('base64');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'gajae-updater-builder-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, `${PRODUCT_NAME}.app`);
  await mkdir(join(app, 'Contents'), { recursive: true });
  await writeFile(join(app, 'Contents', 'payload'), 'final app bytes');
  const dmg = join(root, 'final.dmg');
  await writeFile(dmg, 'final DMG fixture');
  const publicKeyFile = join(root, 'public.key');
  await writeFile(publicKeyFile, Buffer.from('injected public key fixture').toString('base64'));
  const input = { app, dmg, publicKeyFile, outputDirectory: join(root, 'output'),
    productVersion: '2.0.0-beta.10', desktopVersion: '0.2.4', commit: 'a'.repeat(40),
    minimumSystemVersion: '11.0', teamId: 'AB12345678', notes: 'Reviewed fixture notes', pubDate: '2026-09-06T00:00:00Z' };
  const state = { input, events: [], original: await inventoryApp(app) };
  state.dependencies = {
    run: async (program, args) => {
      if (program === 'ditto') {
        await cp(args[0], args[1], { recursive: true });
        state.events.push('copy');
      } else if (program === 'xattr') {
        assert.equal(args[1], 'com.apple.quarantine');
        assert.notEqual(args.at(-1), app);
        state.events.push('quarantine');
      } else if (program === process.execPath) {
        assert.equal(state.events.at(-1), 'verify-app');
        assert.deepEqual(args.slice(1, 3), ['signer', 'sign']);
        assert.equal(args.length, 4, 'No private key/password may appear on argv.');
        state.signedArchive = args[3];
        state.signedBytes = await readFile(state.signedArchive);
        await writeFile(`${state.signedArchive}.sig`, `${signature}\n`, { flag: 'wx' });
        state.events.push('sign');
      } else if (program === 'minisign') {
        assert.deepEqual(args.slice(0, 3), ['-V', '-H', '-m']);
        assert.notEqual(args[3], state.signedArchive);
        assert.deepEqual(await readFile(args[3]), state.signedBytes);
        state.events.push('verify-signature');
        if (state.signatureFailure) throw new Error('cryptographic verifier rejected archive');
      } else assert.fail(`Unexpected command ${program}`);
      return { stdout: '', stderr: '' };
    },
    verifyApp: async ({ app: copy }) => {
      assert.deepEqual(state.events, ['copy', 'quarantine']);
      compareAppInventories(state.original, await inventoryApp(copy));
      state.events.push('verify-app');
    },
    verifyMac: async ({ dmg: copiedDmg, updaterArchivePath }) => {
      assert.equal(state.events.at(-1), 'verify-signature');
      assert.notEqual(updaterArchivePath, state.signedArchive);
      assert.deepEqual(await readFile(updaterArchivePath), state.signedBytes);
      assert.deepEqual(await readFile(copiedDmg), await readFile(dmg));
      state.events.push('verify-equivalence');
      if (state.mutateArchive) await writeFile(state.signedArchive, 'changed after signature');
      if (state.mutateDmg) await writeFile(copiedDmg, 'changed after assessment');
    },
  };
  return state;
}

test('builder stages exactly six assets only after signed snapshot and full equivalence verification', async t => {
  const state = await fixture(t);
  const result = await makeMacosUpdater(state.input, state.dependencies);
  const names = assetNames({ productVersion: state.input.productVersion });
  assert.deepEqual((await readdir(result.outputDirectory)).sort(), Object.values(names.macos).sort());
  assert.deepEqual(state.events, ['copy', 'quarantine', 'verify-app', 'sign', 'verify-signature', 'verify-equivalence']);
  const archive = await readFile(join(result.outputDirectory, names.macos.archive));
  assert.deepEqual(archive, state.signedBytes);
  assert.equal(result.hashes[names.macos.archive], hash(archive));
  assert.equal(await readFile(join(result.outputDirectory, names.macos.archiveChecksum), 'utf8'), `${hash(archive)}  ${names.macos.archive}\n`);
  validateDesktopUpdateManifest(JSON.parse(await readFile(join(result.outputDirectory, names.macos.manifest), 'utf8')),
    { productVersion: state.input.productVersion, desktopVersion: state.input.desktopVersion, expectedSignature: signature });
  compareAppInventories(state.original, await inventoryApp(state.input.app));
});

test('signature failure or post-verification payload mutation never exposes final assets', async t => {
  for (const flag of ['signatureFailure', 'mutateArchive', 'mutateDmg']) {
    const state = await fixture(t);
    state[flag] = true;
    await assert.rejects(makeMacosUpdater(state.input, state.dependencies), /rejected|changed/);
    await assert.rejects(readdir(state.input.outputDirectory), { code: 'ENOENT' });
    compareAppInventories(state.original, await inventoryApp(state.input.app));
  }
});

test('existing output and source-app output paths are never overwritten', async t => {
  const state = await fixture(t);
  await mkdir(state.input.outputDirectory);
  await writeFile(join(state.input.outputDirectory, 'user-file'), 'preserve');
  await assert.rejects(makeMacosUpdater(state.input, state.dependencies), { code: 'EEXIST' });
  assert.equal(await readFile(join(state.input.outputDirectory, 'user-file'), 'utf8'), 'preserve');
  await assert.rejects(makeMacosUpdater({ ...state.input, outputDirectory: join(state.input.app, 'output') }, state.dependencies), /source app/);
  compareAppInventories(state.original, await inventoryApp(state.input.app));
});

test('artifact builder CLI rejects incomplete or secret-bearing arguments without echoing them', () => {
  const script = new URL('./make-macos-updater.mjs', import.meta.url);
  for (const args of [[], ['--private-key', 'DO-NOT-PRINT']]) {
    const result = spawnSync(process.execPath, [script.pathname, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.ok(!`${result.stdout}${result.stderr}`.includes('DO-NOT-PRINT'));
  }
});
