import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { releaseCommand } from './local-release-command.mjs';
import { manualReleaseOptions, processManualRelease } from './manual-release.mjs';
import { assetNames } from './updater-artifacts.mjs';

const version = '2.0.0-beta.10';
const commit = 'a'.repeat(40);
const teamId = 'AB12345678';
const names = assetNames({ productVersion: version });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const runtimeManifest = Buffer.from('{\n  "schemaVersion": 1, "runtime": "pinned source fixture"\n}\n');
const buildInfo = { schemaVersion: 1, packageName: 'gajae-app', productVersion: version,
  desktopVersion: '0.2.4', debug: false, updateMode: 'disabled', runtimeManifestSha256: sha(runtimeManifest), payloadRuntimeManifestSha256: 'e'.repeat(64) };
const priorRelease = { id: 11, tag: 'v2.0.0-beta.9', productVersion: '2.0.0-beta.9',
  desktopVersion: '0.2.3', commit: 'b'.repeat(40), publishedAt: '2026-09-06T00:00:00Z' };

async function fixture(t, { serverVersion = version, serverPackage = 'gajae-app-server' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'gajae-manual-release-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: serverPackage, version: serverVersion }));
  const archive = join(directory, names.server.archive);
  await releaseCommand('tar', ['-czf', archive, '-C', directory, 'package.json']);
  const files = new Map([[names.macos.dmg, Buffer.from('signed DMG fixture')], [names.server.archive, await readFile(archive)]]);
  const values = { repo: 'devswha/gajae-code-app', tag: `v${version}`, commit,
    'draft-id': '123', 'team-id': teamId, asset: [...files].map(([name, body]) => `${name}=${sha(body)}`) };
  for (const [name, body] of [...files]) files.set(`${name}.sha256`, Buffer.from(`${sha(body)}  ${name}\n`));
  const state = { files, values, calls: [], writes: [], reads: 0, historyReads: 0, macChecked: 0,
    source: { name: 'gajae-app', version, desktopVersion: '0.2.4' }, tag: [],
    history: { priorPublished: [priorRelease], historyComplete: true },
    sourceManifest: runtimeManifest,
    release: { id: 123, tag_name: values.tag, target_commitish: commit, draft: true, published_at: null,
      prerelease: true, name: 'Manual beta.10', body: 'Reviewed manual/updater-disabled notes.',
      assets: [...files].map(([name, body], index) => ({ id: index + 1, name, label: '', size: body.length,
        state: 'uploaded', digest: `sha256:${sha(body)}`, updated_at: '2026-09-07T00:00:00Z' })) },
  };
  state.run = async (program, args, options = {}) => {
    state.calls.push({ program, args, options });
    if (program === 'tar') {
      if (state.tarResult) return state.tarResult(args);
      return releaseCommand(program, args, options);
    }
    assert.equal(program, 'gh', 'Tests never invoke signing, app installation or other programs.');
    assert.deepEqual(args.slice(0, 3), ['api', '--hostname', 'github.com']);
    const path = args[3].replace('repos/devswha/gajae-code-app/', '');
    const json = value => ({ stdout: JSON.stringify(value), stderr: '' });
    if (args.includes('--method')) {
      state.writes.push({ path, args });
      assert.equal(state.macChecked, 1);
      assert.equal(state.reads, 2);
      assert.equal(state.historyReads, 2);
      if (state.failPatch) throw new Error('simulated transport failure');
      state.release.draft = false;
      state.release.published_at = '2026-09-07T01:00:00Z';
      state.afterPatch?.();
      return json(state.release);
    }
    if (path === 'releases/123') {
      state.reads++;
      if (state.reads === 2) state.beforeRecheck?.();
      return json(state.release);
    }
    if (path === 'releases/123/assets') return json(state.assetPages ?? [state.release.assets]);
    if (path === `git/matching-refs/tags/v${version}`) return json([state.tag]);
    if (path.startsWith('git/tags/')) return json(state.annotation);
    if (path === `git/commits/${commit}`) return json({ sha: state.remoteCommit ?? commit });
    if (path === `contents/package.json?ref=${commit}`) return json(state.source);
    if (path === `contents/src-tauri/tauri.conf.json?ref=${commit}`) return json({ bundle: { macOS: { minimumSystemVersion: state.minimum ?? '13.0' } } });
    if (path === `contents/server/gjc-runtime-manifest.json?ref=${commit}`) {
      assert.equal(options.maxOutputBytes, 64 * 1024);
      await writeFile(options.output, state.sourceManifest, { flag: 'wx', mode: 0o600 });
      return { stdout: '', stderr: '' };
    }
    if (path.startsWith('releases/assets/')) {
      const asset = state.release.assets.find(item => item.id === Number(path.split('/').at(-1)));
      assert.ok(asset && Number.isSafeInteger(asset.id));
      assert.equal(options.maxOutputBytes, asset.size);
      assert.equal(options.timeout, 600_000);
      assert.equal((await stat(dirname(options.output))).mode & 0o777, 0o700);
      if (state.download) await state.download(asset, options.output);
      else await writeFile(options.output, state.files.get(asset.name), { flag: 'wx', mode: 0o600 });
      return { stdout: '', stderr: '' };
    }
    assert.fail(`Unexpected API call ${path}`);
  };
  state.collectHistory = async () => {
    state.historyReads++;
    if (state.historyReads === 2) state.beforeHistoryRecheck?.();
    return structuredClone(state.history);
  };
  state.verifyMac = async input => {
    state.macChecked++;
    state.macInput = input;
    assert.equal(input.manualDisabled, true);
    assert.equal(input.updaterArchivePath, undefined);
    assert.equal(input.teamId, teamId);
    assert.equal(input.version, version);
    assert.equal(input.desktopVersion, '0.2.4');
    assert.equal(input.minimumSystemVersion, '13.0');
    assert.equal(input.runtimeManifestSha256, sha(state.sourceManifest));
    assert.equal((await stat(input.dmg)).mode & 0o777, 0o400);
    if (state.macError) throw state.macError;
    if (state.duringMac) await state.duringMac(input);
    return state.macResult ?? { copiedApp: join(input.root, 'copy/Gajae Code App.app'), buildInfo, payloadRuntimeManifestSha256: 'e'.repeat(64) };
  };
  state.execute = overrides => processManualRelease(manualReleaseOptions({ ...state.values, ...overrides }), {
    run: state.run, verifyMac: state.verifyMac, collectHistory: state.collectHistory, platform: 'darwin', arch: 'arm64',
  });
  return state;
}

function addPayload(state, name) {
  const bytes = Buffer.from('independently accepted optional Linux payload');
  state.values.asset.push(`${name}=${sha(bytes)}`);
  for (const [filename, body] of [[name, bytes], [`${name}.sha256`, Buffer.from(`${sha(bytes)}  ${name}\n`)]]) {
    state.files.set(filename, body);
    state.release.assets.push({ id: state.release.assets.length + 1, name: filename, size: body.length,
      state: 'uploaded', digest: `sha256:${sha(body)}`, updated_at: '2026-09-07T00:00:00Z' });
  }
}

test('default manual lane verifies four assets, positive disabled evidence and fresh inputs without any write', async t => {
  const state = await fixture(t);
  const result = await state.execute();
  assert.equal(result.status, 'verified-draft');
  assert.equal(result.mode, 'manual-disabled');
  assert.deepEqual(result.buildInfo, buildInfo);
  assert.equal(result.desktopVersionFloor, '0.2.3');
  assert.equal(Object.keys(result.hashes).length, 4);
  assert.equal(state.reads, 2);
  assert.equal(state.historyReads, 2);
  assert.deepEqual(state.writes, []);
  assert.ok(!state.calls.some(call => call.args.some(arg => /updater|\.sig|\.app\.tar\.gz/.test(arg))));
  await assert.rejects(stat(state.macInput.root), { code: 'ENOENT' });
});

test('explicit publish issues exactly one numeric-ID PATCH draft=false after every gate and preserves notes/assets', async t => {
  const state = await fixture(t);
  const before = structuredClone(state.release);
  const result = await state.execute({ publish: true });
  assert.equal(result.status, 'published');
  assert.deepEqual(state.writes, [{ path: 'releases/123', args: ['api', '--hostname', 'github.com',
    'repos/devswha/gajae-code-app/releases/123', '--method', 'PATCH', '--field', 'draft=false'] }]);
  assert.deepEqual(state.release, { ...before, draft: false, published_at: '2026-09-07T01:00:00Z' });
});

test('CLI options reject updater material, unlisted payloads, unsafe IDs/refs, missing and duplicate pins', async t => {
  const state = await fixture(t);
  for (const change of [
    { repo: 'other/repo' }, { tag: 'latest' }, { tag: 'v02.0.0-beta.10' }, { tag: 'v2.0.0-rc.1' },
    { commit: 'main' }, { commit: 'a'.repeat(7) }, { commit: 'A'.repeat(40) },
    { 'draft-id': 0 }, { 'draft-id': '01' }, { 'draft-id': '-1' }, { 'draft-id': '9007199254740993' },
    { 'draft-id': '123?x=1' }, { 'team-id': undefined }, { publish: 'true' },
    { 'updater-public-key-file': '/not/allowed' }, { mode: 'local' }, { asset: [] },
    { asset: [state.values.asset[0]] }, { asset: [...state.values.asset, state.values.asset[0]] },
    ...[names.macos.archive, names.macos.archiveSignature, names.macos.manifest,
      names.macos.dmgChecksum, '../evil', `gajae-app-extra-${version}.zip`,
      names.optional.linuxDeb.toUpperCase()].map(name => ({ asset: [...state.values.asset, `${name}=${'a'.repeat(64)}`] })),
    { asset: [state.values.asset[0], `${names.server.archive}=${'A'.repeat(64)}`] },
    { asset: [state.values.asset[0], `${state.values.asset[1]}=`] },
  ]) assert.throws(() => manualReleaseOptions({ ...state.values, ...change }));
  assert.equal(manualReleaseOptions(state.values).publish, false);
});

test('exact deb/AppImage optional pairs are accepted only with their independent pins', async t => {
  const state = await fixture(t);
  for (const name of names.optionalPayloads) addPayload(state, name);
  assert.equal(Object.keys((await state.execute()).hashes).length, 8);
  state.values.asset.pop();
  await assert.rejects(state.execute({ publish: true }), /cardinality/);
  assert.deepEqual(state.writes, []);
});

test('invalid release metadata and extra or duplicate assets fail before any download', async t => {
  for (const change of [
    release => { release.id = '123'; }, release => { release.id = 456; }, release => { release.draft = false; },
    release => { release.draft = 'true'; }, release => { release.published_at = '2026-09-07T00:00:00Z'; },
    release => { release.tag_name = 'v2.0.0-beta.9'; }, release => { release.target_commitish = 'main'; },
    release => { release.prerelease = false; }, release => { release.assets.pop(); },
    release => { release.assets.push({ ...release.assets[0], id: 777, name: names.macos.manifest }); },
    release => { release.assets[0].name = names.macos.archive; },
    release => { release.assets[0].name = release.assets[1].name; },
    release => { release.assets[0].id = release.assets[1].id; },
    release => { release.assets[0].id = '1'; }, release => { release.assets[0].id = 0; },
    release => { release.assets[0].state = 'starter'; }, release => { delete release.assets[0].state; },
    release => { release.assets[0].size = 0; }, release => { release.assets[0].size = 250 * 1024 ** 2 + 1; },
    release => { release.assets[2].size = 1025; }, release => { release.assets[0].digest = 'bad'; },
    release => { release.assets[0].updated_at = 'yesterday'; }, release => { release.assets[0].label = '\u0000'; },
  ]) {
    const state = await fixture(t);
    change(state.release);
    await assert.rejects(state.execute({ publish: true }));
    assert.deepEqual(state.writes, []);
    assert.ok(!state.calls.some(call => call.options.output));
  }
});

test('separately paginated asset listing cannot conceal extra pages or malformed responses', async t => {
  for (const pages of [[], {}, [null], [[{ id: 500, name: names.macos.manifest }]]]) {
    const state = await fixture(t);
    state.assetPages = Array.isArray(pages) && pages[0]?.[0]?.id === 500 ? [state.release.assets, ...pages] : pages;
    await assert.rejects(state.execute({ publish: true }));
    assert.deepEqual(state.writes, []);
  }
});

test('both absent GitHub digests and matching digests still require actual independent byte hashes', async t => {
  const valid = await fixture(t);
  for (const asset of valid.release.assets) delete asset.digest;
  assert.equal((await valid.execute()).status, 'verified-draft');
  for (const changeDigest of [false, true]) {
    const state = await fixture(t);
    const replacement = Buffer.from('replacement DMG bytes');
    state.files.set(names.macos.dmg, replacement);
    Object.assign(state.release.assets[0], { size: replacement.length, digest: changeDigest ? `sha256:${sha(replacement)}` : null });
    await assert.rejects(state.execute({ publish: true }), /independent pin/);
    assert.deepEqual(state.writes, []);
  }
});

test('malformed checksum sidecars cannot redirect, append entries or disagree with independent pins', async t => {
  for (const checksum of ['wrong', `${'a'.repeat(64)}  ${names.macos.dmg}\n`,
    `${sha('signed DMG fixture')}  ../${names.macos.dmg}\n`,
    `${sha('signed DMG fixture')}  ${names.macos.dmg}\nextra\n`]) {
    const state = await fixture(t);
    const bytes = Buffer.from(checksum);
    state.files.set(names.macos.dmgChecksum, bytes);
    Object.assign(state.release.assets.find(asset => asset.name === names.macos.dmgChecksum), { size: bytes.length, digest: `sha256:${sha(bytes)}` });
    await assert.rejects(state.execute({ publish: true }), /Checksum sidecar/);
    assert.deepEqual(state.writes, []);
  }
});

test('source commit, package, server metadata and runtime-manifest mismatches block publication', async t => {
  for (const change of [
    state => { state.remoteCommit = 'b'.repeat(40); }, state => { state.source.name = 'other'; },
    state => { state.source.version = '2.0.0-beta.9'; }, state => { state.sourceManifest = Buffer.from('{}\n'); },
    state => { state.sourceManifest = Buffer.from('[]'); }, state => { state.sourceManifest = Buffer.from('bad JSON'); },
    state => { state.minimum = null; },
  ]) {
    const state = await fixture(t);
    change(state);
    // Null simulates missing config explicitly, without fixture's default.
    if (state.minimum === null) state.minimum = 13;
    await assert.rejects(state.execute({ publish: true }));
    assert.deepEqual(state.writes, []);
  }
  for (const options of [{ serverVersion: '2.0.0-beta.9' }, { serverPackage: 'gajae-app' }]) {
    const state = await fixture(t, options);
    await assert.rejects(state.execute({ publish: true }), /Server archive package/);
    assert.deepEqual(state.writes, []);
  }
  for (const listing of ['', 'package.json\n./package.json\n', 'elsewhere/package.json\n']) {
    const state = await fixture(t);
    state.tarResult = () => ({ stdout: listing, stderr: '' });
    await assert.rejects(state.execute({ publish: true }), /exactly one root/);
    assert.deepEqual(state.writes, []);
  }
});

test('signature failures and missing or non-disabled binary evidence never publish', async t => {
  for (const change of [
    state => { state.macError = new Error('Gatekeeper rejected app'); },
    state => { state.macResult = {}; },
    state => { state.macResult = { buildInfo: { ...buildInfo, debug: true } }; },
    state => { state.macResult = { buildInfo: { ...buildInfo, updateMode: 'enabled' } }; },
    state => { state.macResult = { buildInfo: { ...buildInfo, runtimeManifestSha256: 'd'.repeat(64) } }; },
  ]) {
    const state = await fixture(t);
    change(state);
    await assert.rejects(state.execute({ publish: true }));
    assert.deepEqual(state.writes, []);
  }
});

test('history must be complete and advancing; changes during verification refuse publication', async t => {
  for (const change of [
    state => { state.history.historyComplete = false; }, state => { state.source.desktopVersion = '0.2.3'; },
    state => { state.history.priorPublished[0] = { ...priorRelease, desktopVersion: '0.2.4' }; },
    state => { state.beforeHistoryRecheck = () => { state.history.historyComplete = false; }; },
    state => { state.beforeHistoryRecheck = () => { state.history.priorPublished[0] = { ...priorRelease, commit: 'c'.repeat(40) }; }; },
  ]) {
    const state = await fixture(t);
    change(state);
    await assert.rejects(state.execute({ publish: true }));
    assert.deepEqual(state.writes, []);
  }
});

test('fresh draft and tag checks reject all reviewed-input races', async t => {
  for (const change of [
    state => { state.release.assets[0].id = 999; }, state => { state.release.body = 'changed'; },
    state => { state.release.name = 'changed'; }, state => { state.release.prerelease = false; },
    state => { state.release.draft = false; }, state => { state.release.target_commitish = 'main'; },
    state => { state.release.assets[0].updated_at = '2026-09-07T01:00:00Z'; },
    state => { state.tag = [{ ref: `refs/tags/v${version}`, object: { type: 'commit', sha: commit } }]; },
  ]) {
    const state = await fixture(t);
    state.beforeRecheck = () => change(state);
    await assert.rejects(state.execute({ publish: true }));
    assert.equal(state.macChecked, 1);
    assert.deepEqual(state.writes, []);
  }
});

test('existing lightweight and annotated tags must resolve to the exact full commit', async t => {
  for (const annotated of [false, true]) {
    const state = await fixture(t);
    state.tag = [{ ref: `refs/tags/v${version}`, object: { type: annotated ? 'tag' : 'commit', sha: annotated ? 'b'.repeat(40) : commit } }];
    state.annotation = { object: { type: 'commit', sha: commit } };
    assert.equal((await state.execute()).status, 'verified-draft');
  }
  const wrong = await fixture(t);
  wrong.tag = [{ ref: `refs/tags/v${version}`, object: { type: 'commit', sha: 'b'.repeat(40) } }];
  await assert.rejects(wrong.execute({ publish: true }), /expected commit/);
  assert.deepEqual(wrong.writes, []);
});

test('download truncation, symlinks and post-verification byte changes fail closed', async t => {
  for (const download of [
    async (_, output) => writeFile(output, 'short', { flag: 'wx' }),
    async (_, output) => symlink('/dev/null', output),
  ]) {
    const state = await fixture(t);
    state.download = download;
    await assert.rejects(state.execute({ publish: true }));
    assert.deepEqual(state.writes, []);
  }
  const changed = await fixture(t);
  changed.duringMac = async input => {
    await chmod(input.dmg, 0o600);
    await writeFile(input.dmg, 'altered DMG bytes!');
  };
  await assert.rejects(changed.execute({ publish: true }), /size|snapshot changed/);
  assert.deepEqual(changed.writes, []);
});

test('failed detachment preserves its directory and never claims publication', async t => {
  const state = await fixture(t);
  state.macError = Object.assign(new Error('Could not confirm image detachment'), { preserveDirectory: true });
  await assert.rejects(state.execute({ publish: true }), error => error.preserveDirectory && !error.publicationMayHaveOccurred);
  assert.ok((await stat(state.macInput.root)).isDirectory());
  assert.deepEqual(state.writes, []);
  // This fixture has no real mount; only its synthetic retained directory is removed.
  await rm(state.macInput.root, { recursive: true, force: true });
});

test('transport or response uncertainty after PATCH never retries or rolls back, and marks the outcome unknown', async t => {
  for (const change of [
    state => { state.failPatch = true; },
    state => { state.afterPatch = () => { state.release.assets[0].id = 999; }; },
    state => { state.afterPatch = () => { state.release.draft = true; }; },
    state => { state.afterPatch = () => { state.release.published_at = null; }; },
    state => { state.afterPatch = () => { state.release.published_at = 'bad'; }; },
  ]) {
    const state = await fixture(t);
    change(state);
    await assert.rejects(state.execute({ publish: true }), error => error.publicationMayHaveOccurred === true);
    assert.equal(state.writes.length, 1);
    await assert.rejects(stat(state.macInput.root), { code: 'ENOENT' });
  }
});

test('CLI rejects missing/duplicate/unknown flags without leaking arguments; imports and symlink entry are safe', async t => {
  const script = fileURLToPath(new URL('./manual-release.mjs', import.meta.url));
  for (const args of [[], ['--publish'], ['--password', 'DO-NOT-PRINT'], ['--mode', 'ci'],
    ['--updater-public-key-file', 'DO-NOT-PRINT'], ['--repo', 'first', '--repo', 'second'], ['--publish', '--publish']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.ok(!`${result.stdout}${result.stderr}`.includes('DO-NOT-PRINT'));
  }
  const directory = await mkdtemp(join(tmpdir(), 'gajae-manual-entry-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const linked = join(directory, 'manual.mjs');
  await symlink(script, linked);
  const help = spawnSync(process.execPath, [linked, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e',
    `process.argv.length = 1; await import(${JSON.stringify(new URL('./manual-release.mjs', import.meta.url).href)});`], { encoding: 'utf8' });
  assert.equal(imported.status, 0);
  assert.equal(imported.stdout, '');
});

test('diagnostic command transport enforces the configured hard stdout cap and timeout', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gajae-manual-command-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'bounded.json');
  await assert.rejects(releaseCommand(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(4097))'],
    { output, timeout: 10_000, maxOutputBytes: 4096 }), /file output limit/);
  assert.ok((await stat(output)).size <= 4096);
  await assert.rejects(releaseCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
    { output: join(directory, 'timeout.json'), timeout: 20, maxOutputBytes: 4096 }), /timed out/);
  await assert.rejects(releaseCommand(process.execPath, ['-e', 'process.stdout.write("overwrite")'],
    { output, timeout: 10_000, maxOutputBytes: 4096 }), { code: 'EEXIST' });
  assert.equal((await stat(output)).mode & 0o777, 0o600);
});
