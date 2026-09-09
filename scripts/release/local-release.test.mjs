import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { releaseCommand } from './local-release-command.mjs';
import { assertChecksum, processLocalRelease, releaseOptions } from './local-release.mjs';
import { assetNames, buildDesktopUpdateManifest } from './updater-artifacts.mjs';
import { resolveReleaseTag } from './updater-history.mjs';

const version = '2.0.0-beta.99';
const commit = 'a'.repeat(40);
const teamId = 'AB12345678';
const dmgName = `gajae-app-desktop-${version}-macos-arm64.dmg`;
const serverName = `gajae-app-server-${version}-linux-x64-node22.tar.gz`;
const names = assetNames({ productVersion: version });
const publicKey = Buffer.from('injected verifier public-key fixture').toString('base64');
const signature = 'A'.repeat(88);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const packageFor = value => ({ name: 'gajae-app', version: value, desktopVersion: '0.2.4' });

async function fixture(t, { serverVersion = version, serverPackage = 'gajae-app-server' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'gajae-release-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: serverPackage, version: serverVersion }));
  const archive = join(directory, serverName);
  await releaseCommand('tar', ['-czf', archive, '-C', directory, 'package.json']);
  const files = new Map([[dmgName, Buffer.from('signed image fixture')], [serverName, await readFile(archive)],
    [names.macos.archive, Buffer.from('injected verifier archive fixture')]]);
  const publicKeyFile = join(directory, 'updater.pub');
  await writeFile(publicKeyFile, publicKey);
  const values = { repo: 'devswha/gajae-code-app', tag: `v${version}`, commit, 'draft-id': '123', 'team-id': teamId,
    'updater-public-key-file': publicKeyFile,
    asset: [...files].map(([name, body]) => `${name}=${sha(body)}`) };
  for (const [name, body] of [...files]) files.set(`${name}.sha256`, Buffer.from(`${sha(body)}  ${name}\n`));
  files.set(names.macos.archiveSignature, Buffer.from(signature));
  files.set(names.macos.manifest, Buffer.from(JSON.stringify(buildDesktopUpdateManifest({
    productVersion: version, desktopVersion: '0.2.4', commit, signature,
    notes: 'Reviewed notes', pubDate: '2026-09-05T00:00:00Z', minimumSystemVersion: '11.0',
  }))));
  const state = {
    release: { id: 123, tag_name: values.tag, target_commitish: commit, draft: true,
      published_at: null, prerelease: true, name: 'Reviewed release', body: 'Reviewed notes',
      assets: [...files].map(([name, body], index) => ({ id: index + 1, name, label: '', size: body.length,
        state: 'uploaded', digest: `sha256:${sha(body)}`, updated_at: '2026-09-05T00:00:00Z' })) },
    files, values, calls: [], mutations: [], macChecked: 0, signatureChecked: 0, tag: [], source: packageFor(version), reads: 0,
    history: { priorPublished: [], historyComplete: true }, historyReads: 0,
  };
  state.run = async (program, args, options = {}) => {
    state.calls.push({ program, args, options });
    if (program !== 'gh') return releaseCommand(program, args, options);
    assert.deepEqual(args.slice(0, 3), ['api', '--hostname', 'github.com']);
    const path = args[3].replace('repos/devswha/gajae-code-app/', '');
    const json = value => ({ stdout: JSON.stringify(value), stderr: '' });
    if (args.includes('PATCH')) {
      state.mutations.push({ path, args });
      if (state.failPatch) throw new Error('simulated transport error');
      state.release.draft = false;
      state.release.published_at = '2026-09-05T01:00:00Z';
      if (state.afterPatch) state.afterPatch();
      return json(state.release);
    }
    if (path === 'releases/123') {
      state.reads++;
      if (state.reads === 2 && state.beforeRecheck) state.beforeRecheck();
      return json(state.release);
    }
    if (path === 'releases/123/assets') return json([state.release.assets]);
    if (path === `git/matching-refs/tags/v${version}`) return json([state.tag]);
    if (path === `git/commits/${commit}`) return json({ sha: commit });
    if (path === `contents/package.json?ref=${commit}`) return json(state.source);
    if (path === `contents/src-tauri/tauri.conf.json?ref=${commit}`) return json({ bundle: { macOS: { minimumSystemVersion: '11.0' } } });
    if (path.startsWith('releases/assets/')) {
      const asset = state.release.assets.find(item => item.id === Number(path.split('/').at(-1)));
      assert.ok(asset, 'Downloads must refer to known numeric asset IDs.');
      assert.equal(options.maxOutputBytes, asset.size, 'Every download must be streaming-bounded to the inspected size.');
      await writeFile(options.output, state.files.get(asset.name), { flag: 'wx' });
      return { stdout: '', stderr: '' };
    }
    assert.fail(`Unexpected API call ${path}`);
  };
  state.verifySignature = async input => {
    assert.equal(input.publicKey, publicKey);
    assert.equal(input.signature, signature);
    assert.equal(input.expectedSha256, sha(state.files.get(names.macos.archive)));
    state.signatureChecked++;
    if (state.signatureError) throw new Error(state.signatureError);
    const bytes = await readFile(input.archivePath);
    state.verifiedArchive = join(input.root, 'verified-updater.archive');
    await writeFile(state.verifiedArchive, bytes, { flag: 'wx' });
    return { archivePath: state.verifiedArchive, sha256: sha(bytes), size: bytes.length };
  };
  state.collectHistory = async () => {
    state.historyReads++;
    if (state.historyReads === 2 && state.beforeHistoryRecheck) state.beforeHistoryRecheck();
    return structuredClone(state.history);
  };
  state.verifyMac = async input => {
    assert.equal(input.teamId, teamId);
    assert.equal(input.version, version);
    assert.equal(input.desktopVersion, '0.2.4');
    assert.equal(input.minimumSystemVersion, '11.0');
    assert.equal(state.signatureChecked, 1);
    assert.equal(input.updaterArchivePath, state.verifiedArchive);
    assert.notEqual(input.updaterArchivePath, join(input.root, names.macos.archive));
    state.macChecked++;
    if (state.macError) throw new Error(state.macError);
  };
  state.execute = overrides => processLocalRelease(releaseOptions({ ...state.values, ...overrides }), {
    run: state.run, verifyMac: state.verifyMac, verifySignature: state.verifySignature,
    collectHistory: state.collectHistory, platform: 'darwin', arch: 'arm64',
  });
  return state;
}

test('default path verifies the downloaded bytes and versions without any release write', async t => {
  const state = await fixture(t);
  const result = await state.execute();
  assert.equal(result.status, 'verified-draft');
  assert.equal(state.macChecked, 1);
  assert.equal(state.reads, 2);
  assert.equal(state.historyReads, 2);
  assert.equal(state.signatureChecked, 1);
  assert.deepEqual(state.mutations, []);
  assert.equal(result.hashes[dmgName], sha(state.files.get(dmgName)));
  const output = state.calls.find(call => call.options.output).options.output;
  await assert.rejects(readFile(output), { code: 'ENOENT' }, 'Only disposable downloads are cleaned.');
  assert.ok(state.files.get(dmgName), 'The original asset is preserved.');
});

test('explicit publish performs exactly one draft=false PATCH by ID, after all verification', async t => {
  const state = await fixture(t);
  const result = await state.execute({ publish: true });
  assert.equal(result.status, 'published');
  assert.equal(state.macChecked, 1);
  assert.deepEqual(state.mutations, [{ path: 'releases/123', args: ['api', '--hostname', 'github.com',
    'repos/devswha/gajae-code-app/releases/123', '--method', 'PATCH', '--field', 'draft=false'] }]);
  assert.equal(state.release.name, 'Reviewed release');
  assert.equal(state.release.body, 'Reviewed notes');
  assert.equal(state.release.assets.length, 8);
});

test('ambiguous refs, omitted pins, duplicate names and unsafe filenames cannot enter publication', async t => {
  const state = await fixture(t);
  for (const overrides of [
    { commit: 'main' }, { commit: 'a'.repeat(7) }, { tag: 'latest' }, { 'draft-id': undefined },
    { 'draft-id': '0' }, { 'team-id': undefined }, { asset: [] },
    { asset: [...state.values.asset, state.values.asset[0]] },
    { asset: [...state.values.asset, `../evil=${'a'.repeat(64)}`] },
    { asset: [...state.values.asset, `gajae-app-extra-${version}-linux.zip=bad-hash`] },
  ]) assert.throws(() => releaseOptions({ ...state.values, ...overrides }));
  assert.equal(releaseOptions(state.values).publish, false);
  assert.equal(releaseOptions({ ...state.values, publish: 'true' }).publish, false);
});

test('public releases, wrong IDs/tags/commits and partial assets are refused before downloads', async t => {
  for (const change of [
    release => { release.draft = false; }, release => { release.published_at = '2026-09-01'; },
    release => { release.id = 999; }, release => { release.tag_name = 'v1.0.0'; },
    release => { release.target_commitish = 'main'; }, release => { release.prerelease = false; },
    release => { release.assets.pop(); }, release => { release.assets[0].state = 'starter'; },
    release => { release.assets[0].name = '../overwrite.dmg'; },
    release => { release.assets[0].id = release.assets[1].id; },
  ]) {
    const state = await fixture(t);
    change(state.release);
    await assert.rejects(state.execute({ publish: true }));
    assert.deepEqual(state.mutations, []);
    assert.ok(!state.calls.some(call => call.options.output));
  }
});

test('unreviewed additional assets remain untouched and block publication', async t => {
  const state = await fixture(t);
  state.release.assets.push({ ...state.release.assets[0], id: 90, name: `gajae-app-desktop-${version}-linux-x64.AppImage` });
  await assert.rejects(state.execute({ publish: true }), /exact expected|Unlisted/);
  assert.deepEqual(state.mutations, []);
  assert.equal(state.release.assets.length, 9);
});

test('additional Linux payloads can be explicitly pinned with their own checksum sidecar', async t => {
  const state = await fixture(t);
  const name = `gajae-app-desktop-${version}-linux-x64.AppImage`;
  const body = Buffer.from('separately accepted Linux build');
  state.values.asset.push(`${name}=${sha(body)}`);
  for (const [filename, data] of [[name, body], [`${name}.sha256`, Buffer.from(`${sha(body)}  ${name}\n`)]]) {
    state.files.set(filename, data);
    state.release.assets.push({ id: state.release.assets.length + 1, name: filename, size: data.length,
      state: 'uploaded', digest: `sha256:${sha(data)}`, updated_at: '2026-09-05T00:00:00Z' });
  }
  const result = await state.execute();
  assert.equal(Object.keys(result.hashes).length, 10);
  assert.deepEqual(state.mutations, []);
});

test('an attacker updating both the uploaded payload and its GitHub digest cannot bypass caller hash pins', async t => {
  const state = await fixture(t);
  const replacement = Buffer.from('replacement image');
  state.files.set(dmgName, replacement);
  Object.assign(state.release.assets[0], { digest: `sha256:${sha(replacement)}`, size: replacement.length });
  await assert.rejects(state.execute({ publish: true }), /independent pin/);
  assert.deepEqual(state.mutations, []);
});

test('missing GitHub digest remains safe with an independently pinned payload hash', async t => {
  const state = await fixture(t);
  for (const asset of state.release.assets) asset.digest = null;
  assert.equal((await state.execute()).status, 'verified-draft');
});

test('sidecars cannot redirect verification or list extra files', () => {
  const hash = 'a'.repeat(64);
  assertChecksum(`${hash}  ${dmgName}\n`, dmgName, hash);
  assertChecksum(`${hash} *${dmgName}\n`, dmgName, hash);
  for (const text of [`${hash}  /tmp/${dmgName}\n`, `${hash}  ../${dmgName}\n`,
    `${hash}  ${dmgName}\n${hash}  other\n`, `${'b'.repeat(64)}  ${dmgName}\n`]) {
    assert.throws(() => assertChecksum(text, dmgName, hash));
  }
});

test('source commit and server archive version mismatches prevent publication even with correct hashes', async t => {
  const wrongSource = await fixture(t);
  wrongSource.source.version = '1.0.0';
  await assert.rejects(wrongSource.execute({ publish: true }), /Pinned commit package/);
  assert.deepEqual(wrongSource.mutations, []);
  const wrongServer = await fixture(t, { serverVersion: '1.0.0' });
  await assert.rejects(wrongServer.execute({ publish: true }), /Server archive package/);
  assert.deepEqual(wrongServer.mutations, []);
  const sourcePackageInArchive = await fixture(t, { serverPackage: 'gajae-app' });
  await assert.rejects(sourcePackageInArchive.execute({ publish: true }), /Server archive package/);
  assert.deepEqual(sourcePackageInArchive.mutations, []);
});

test('macOS signature/acceptance failure never calls the publication API', async t => {
  const state = await fixture(t);
  state.macError = 'Gatekeeper rejected the copied app';
  await assert.rejects(state.execute({ publish: true }), /Gatekeeper/);
  assert.deepEqual(state.mutations, []);
});

test('updater cryptographic failure blocks app verification and publication', async t => {
  const state = await fixture(t);
  state.signatureError = 'Minisign rejected the archive';
  await assert.rejects(state.execute({ publish: true }), /Minisign/);
  assert.equal(state.signatureChecked, 1);
  assert.equal(state.macChecked, 0);
  assert.deepEqual(state.mutations, []);
});

test('manifest identity mismatches fail even when their uploaded digest is updated', async t => {
  for (const change of [
    manifest => { manifest.version = '0.2.5'; },
    manifest => { manifest.productVersion = '2.0.0-beta.98'; },
    manifest => { manifest.minimumSystemVersion = '12.0'; },
    manifest => { manifest.build.commit = 'b'.repeat(40); },
    manifest => { manifest.platforms['darwin-aarch64'].signature = 'B'.repeat(88); },
    manifest => { manifest.platforms['darwin-aarch64'].url = 'https://example.com/replacement.tar.gz'; },
  ]) {
    const state = await fixture(t);
    const manifest = JSON.parse(state.files.get(names.macos.manifest));
    change(manifest);
    const bytes = Buffer.from(JSON.stringify(manifest));
    state.files.set(names.macos.manifest, bytes);
    Object.assign(state.release.assets.find(asset => asset.name === names.macos.manifest),
      { size: bytes.length, digest: `sha256:${sha(bytes)}` });
    await assert.rejects(state.execute({ publish: true }));
    assert.equal(state.signatureChecked, 0);
    assert.equal(state.macChecked, 0);
    assert.deepEqual(state.mutations, []);
  }
});

test('missing history proof and nonadvancing desktop versions block all downloads', async t => {
  for (const change of [
    state => { state.history.historyComplete = false; },
    state => { state.source.desktopVersion = '0.2.3'; },
    state => { state.history.priorPublished.push({
      id: 1, tag: 'v2.0.0-beta.98', productVersion: '2.0.0-beta.98',
      desktopVersion: '0.2.4', commit: 'b'.repeat(40), publishedAt: '2026-09-04T00:00:00Z',
    }); },
  ]) {
    const state = await fixture(t);
    change(state);
    await assert.rejects(state.execute({ publish: true }));
    assert.ok(!state.calls.some(call => call.options.output));
    assert.deepEqual(state.mutations, []);
  }
});

test('new published history during verification prevents the final publication write', async t => {
  const state = await fixture(t);
  state.beforeHistoryRecheck = () => state.history.priorPublished.push({
    id: 1, tag: 'v2.0.0-beta.98', productVersion: '2.0.0-beta.98',
    desktopVersion: '0.2.3', commit: 'b'.repeat(40), publishedAt: '2026-09-04T00:00:00Z',
  });
  await assert.rejects(state.execute({ publish: true }), /history changed/);
  assert.equal(state.macChecked, 1);
  assert.equal(state.historyReads, 2);
  assert.deepEqual(state.mutations, []);
});

test('asset replacement, edited notes or newly public release during checks prevent publication', async t => {
  for (const change of [
    release => { release.assets[0].id = 999; }, release => { release.body = 'Unreviewed notes'; },
    release => { release.assets[0].updated_at = '2026-09-06T01:00:00Z'; }, release => { release.draft = false; },
  ]) {
    const state = await fixture(t);
    state.beforeRecheck = () => change(state.release);
    await assert.rejects(state.execute({ publish: true }));
    assert.deepEqual(state.mutations, []);
  }
});

test('an existing tag must resolve to the exact commit, and a tag created during verification is rejected', async t => {
  const state = await fixture(t);
  state.tag = [{ ref: `refs/tags/v${version}`, object: { type: 'commit', sha: 'b'.repeat(40) } }];
  await assert.rejects(state.execute({ publish: true }), /does not resolve/);
  assert.deepEqual(state.mutations, []);
  state.tag = [];
  state.reads = 0;
  state.beforeRecheck = () => { state.tag = [{ ref: `refs/tags/v${version}`, object: { type: 'commit', sha: commit } }]; };
  await assert.rejects(state.execute({ publish: true }), /Tag changed/);
  assert.deepEqual(state.mutations, []);
});

test('annotated tags are peeled and cyclic or noncommit targets fail closed', async t => {
  const state = await fixture(t);
  const options = { tag: state.values.tag, expectedCommit: commit };
  const annotation = 'b'.repeat(40);
  const ref = { ref: `refs/tags/v${version}`, object: { type: 'tag', sha: annotation } };
  assert.deepEqual(await resolveReleaseTag(options, async path => path.startsWith('git/matching-refs/')
    ? [[ref]] : { object: { type: 'commit', sha: commit } }), { commit, referenceSha: annotation });
  await assert.rejects(resolveReleaseTag(options, async path => path.startsWith('git/matching-refs/')
    ? [[ref]] : ref), /cyclic/);
  await assert.rejects(resolveReleaseTag(options, async path => path.startsWith('git/matching-refs/')
    ? [[ref]] : { object: { type: 'tree', sha: commit } }), /commit|resolve/);
});

test('an uncertain publication failure is never retried or rolled back', async t => {
  const state = await fixture(t);
  state.failPatch = true;
  await assert.rejects(state.execute({ publish: true }), error => /outcome may be unknown/.test(error.message) && error.publicationMayHaveOccurred === true);
  assert.equal(state.mutations.length, 1);
});

test('publication response drift is reported without overwriting assets or undoing publication', async t => {
  const state = await fixture(t);
  state.afterPatch = () => { state.release.assets[0].id = 999; };
  await assert.rejects(state.execute({ publish: true }), error => /Publication response is unexpected/.test(error.message) && error.publicationMayHaveOccurred === true);
  assert.equal(state.mutations.length, 1);
});

test('CLI rejects missing exact arguments; importing the module never invokes publication', () => {
  const script = fileURLToPath(new URL('./local-release.mjs', import.meta.url));
  for (const args of [[], ['--publish'], ['--tag', 'latest'], ['--password', 'DO-NOT-PRINT']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.ok(!`${result.stdout}${result.stderr}`.includes('DO-NOT-PRINT'));
  }
});

test('local release CLI executes through a symlinked checkout and is inert when imported without argv[1]', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gajae-local-release-entry-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const checkout = join(directory, 'checkout');
  await symlink(fileURLToPath(new URL('../../', import.meta.url)), checkout, 'junction');
  const result = spawnSync(process.execPath, [join(checkout, 'scripts/release/local-release.mjs')], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e',
    `process.argv.length = 1; await import(${JSON.stringify(new URL('./local-release.mjs', import.meta.url).href)});`], { encoding: 'utf8' });
  assert.equal(imported.status, 0);
  assert.equal(imported.stdout, '');
});

test('command transport never clobbers an existing file and redacts child errors', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gajae-release-command-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'existing');
  await writeFile(output, 'original');
  await assert.rejects(releaseCommand(process.execPath, ['-e', 'process.stdout.write("replacement")'], { output }), { code: 'EEXIST' });
  assert.equal(await readFile(output, 'utf8'), 'original');
  await assert.rejects(releaseCommand(process.execPath, ['-e', 'console.error("DO-NOT-PRINT");process.exit(1)']), error => !error.message.includes('DO-NOT-PRINT'));
  await assert.rejects(releaseCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 20 }), /timed out/);
});

test('command downloads enforce the byte limit while streaming, before writing oversized chunks', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gajae-release-command-limit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const exact = join(directory, 'exact');
  await releaseCommand(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(1024, 255))'], {
    output: exact, maxOutputBytes: 1024,
  });
  assert.deepEqual(await readFile(exact), Buffer.alloc(1024, 255));
  const oversized = join(directory, 'oversized');
  await assert.rejects(releaseCommand(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(1025))'], {
    output: oversized, maxOutputBytes: 1024,
  }), /file output limit/);
  assert.ok((await readFile(oversized)).length <= 1024);
});
