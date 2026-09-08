import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applySdkLifecyclePatch } from './apply-sdk-lifecycle-patch.mjs';

const hash = (text) => createHash('sha256').update(text).digest('hex');
async function fixture(t, files = ['one.ts']) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gajae-sdk-patch-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pkg = '@gajae-code/coding-agent';
  const packageRoot = path.join(root, 'node_modules', pkg);
  await fs.mkdir(path.join(packageRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: pkg, version: '0.16.4' }));
  const manifest = { schemaVersion: 1, id: 'gjc-sdk-lifecycle-v1', packages: { [pkg]: '0.16.4' }, files: [] };
  for (const name of files) {
    const before = `export const ${name.split('.')[0]} = 'unjoined';\n`;
    const after = before.replace('unjoined', 'joined');
    await fs.writeFile(path.join(packageRoot, 'src', name), before, { mode: 0o644 });
    manifest.files.push({ package: pkg, path: `src/${name}`, beforeSha256: hash(before), afterSha256: hash(after), replacements: [{ before: "'unjoined'", after: "'joined'" }] });
  }
  return { root, packageRoot, manifest, source: (name = files[0]) => path.join(packageRoot, 'src', name) };
}

test('applier verifies every file, is idempotent, and preserves source permissions', async (t) => {
  const f = await fixture(t, ['one.ts', 'two.ts']);
  assert.deepEqual(await applySdkLifecyclePatch(f.root, f.manifest), { id: f.manifest.id, applied: 2, verified: 2 });
  assert.match(await fs.readFile(f.source(), 'utf8'), /'joined'/u);
  assert.equal((await fs.stat(f.source())).mode & 0o777, 0o644);
  assert.deepEqual(await applySdkLifecyclePatch(f.root, f.manifest), { id: f.manifest.id, applied: 0, verified: 2 });
  assert.deepEqual(await applySdkLifecyclePatch(f.root, f.manifest, { checkOnly: true }), { id: f.manifest.id, applied: 0, verified: 2 });
  assert.deepEqual((await fs.readdir(path.dirname(f.source()))).sort(), ['one.ts', 'two.ts']);
});

test('check-only refuses unapplied sources without writing', async (t) => {
  const f = await fixture(t);
  await assert.rejects(applySdkLifecyclePatch(f.root, f.manifest, { checkOnly: true }), /not been applied/u);
  assert.equal(hash(await fs.readFile(f.source())), f.manifest.files[0].beforeSha256);
});

test('all sources are validated before replacing any one file', async (t) => {
  const f = await fixture(t, ['one.ts', 'two.ts']);
  await fs.writeFile(f.source('two.ts'), 'user-owned local modification');
  await assert.rejects(applySdkLifecyclePatch(f.root, f.manifest), /source digest mismatch/u);
  assert.equal(hash(await fs.readFile(f.source('one.ts'))), f.manifest.files[0].beforeSha256);
  assert.equal(await fs.readFile(f.source('two.ts'), 'utf8'), 'user-owned local modification');
});

test('version drift never patches a newly installed SDK even if source bytes happen to match', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.packageRoot, 'package.json'), JSON.stringify({ name: '@gajae-code/coding-agent', version: '0.16.6' }));
  await assert.rejects(applySdkLifecyclePatch(f.root, f.manifest), /version mismatch/u);
  assert.equal(hash(await fs.readFile(f.source())), f.manifest.files[0].beforeSha256);
});

test('malformed, traversing, duplicate and incorrect-result manifests are rejected without mutation', async (t) => {
  const f = await fixture(t);
  for (const mutate of [
    (m) => { m.files[0].path = 'src/../../private.ts'; },
    (m) => { m.files[0].path = '/private.ts'; },
    (m) => { m.files[0].path = 'src/../private.ts'; },
    (m) => { m.files.push(structuredClone(m.files[0])); },
    (m) => { m.files[0].afterSha256 = '0'.repeat(64); },
    (m) => { m.files[0].replacements[0].before = 'not present'; },
    (m) => { m.files[0].replacements[0].before = ''; },
    (m) => { m.files[0].replacements[0].shell = 'no'; },
    (m) => { m.packages = { 'foreign-package': '0.16.4' }; },
  ]) {
    const manifest = structuredClone(f.manifest); mutate(manifest);
    await assert.rejects(applySdkLifecyclePatch(f.root, manifest));
    assert.equal(hash(await fs.readFile(f.source())), f.manifest.files[0].beforeSha256);
  }
});

test('symlinked targets and parent directories cannot redirect writes', { skip: process.platform === 'win32' }, async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside);
  const externalFile = path.join(outside, 'one.ts');
  const original = await fs.readFile(f.source()); await fs.writeFile(externalFile, original);
  await fs.unlink(f.source()); await fs.symlink(externalFile, f.source());
  await assert.rejects(applySdkLifecyclePatch(f.root, f.manifest), /regular file/u);
  assert.equal(hash(await fs.readFile(externalFile)), f.manifest.files[0].beforeSha256);
  await fs.unlink(f.source()); await fs.rmdir(path.dirname(f.source()));
  await fs.symlink(outside, path.join(f.packageRoot, 'src'));
  await assert.rejects(applySdkLifecyclePatch(f.root, f.manifest), /regular file/u);
  assert.equal(hash(await fs.readFile(externalFile)), f.manifest.files[0].beforeSha256);
});

test('a partially applied known inventory can finish without rewriting verified files', async (t) => {
  const f = await fixture(t, ['one.ts', 'two.ts']);
  const text = await fs.readFile(f.source('one.ts'), 'utf8');
  await fs.writeFile(f.source('one.ts'), text.replace('unjoined', 'joined'));
  const first = await fs.stat(f.source('one.ts'));
  assert.equal((await applySdkLifecyclePatch(f.root, f.manifest)).applied, 1);
  const after = await fs.stat(f.source('one.ts'));
  assert.equal(after.ino, first.ino);
  assert.equal(after.mtimeMs, first.mtimeMs);
  await applySdkLifecyclePatch(f.root, f.manifest, { checkOnly: true });
});
