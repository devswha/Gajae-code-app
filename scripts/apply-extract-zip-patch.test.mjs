import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

import { applyExtractZipPatch } from './apply-extract-zip-patch.mjs';
import { extractZipFixture, hash, helper, manifest, patchDirectory, zip } from './test-fixtures/extract-zip.mjs';

test('exact pre/post integrity, idempotence, permissions and non-mutating check', async t => {
  const f = await extractZipFixture(t);
  await assert.rejects(applyExtractZipPatch(f.root, { checkOnly: true }), /not been applied/);
  assert.equal(hash(await fs.readFile(f.filename)), manifest.beforeSha256);
  assert.deepEqual(await applyExtractZipPatch(f.root), { id: manifest.id, applied: 1, verified: 1 });
  assert.equal(hash(await fs.readFile(f.filename)), manifest.afterSha256);
  const before = await fs.stat(f.filename);
  assert.equal(before.mode & 0o777, 0o644);
  for (const checkOnly of [true, false]) assert.equal((await applyExtractZipPatch(f.root, { checkOnly })).applied, 0);
  assert.equal((await fs.stat(f.filename)).ino, before.ino);
  assert.deepEqual((await fs.readdir(f.packageRoot)).sort(), ['index.js', 'package.json']);
});

test('unknown source/version/metadata/manifest and nested/aliased installs refuse before writing', async t => {
  const changes = [
    async f => fs.writeFile(f.filename, f.original + '\n// local modification'),
    async f => {
      const filename = path.join(f.packageRoot, 'package.json');
      const pkg = JSON.parse(await fs.readFile(filename));
      pkg.version = '2.0.2'; await fs.writeFile(filename, JSON.stringify(pkg));
    },
    async f => {
      const filename = path.join(f.packageRoot, 'package.json');
      const pkg = JSON.parse(await fs.readFile(filename));
      pkg.main = 'unknown.js'; await fs.writeFile(filename, JSON.stringify(pkg));
    },
    async f => fs.writeFile(path.join(f.root, patchDirectory, 'manifest.json'), JSON.stringify({ ...manifest, afterSha256: hash(f.original) })),
    async f => fs.cp(f.packageRoot, path.join(f.root, 'node_modules/parent/node_modules/extract-zip'), { recursive: true }),
    async f => fs.cp(f.packageRoot, path.join(f.root, 'node_modules/alias'), { recursive: true }),
    async f => fs.cp(f.packageRoot, path.join(f.root, 'node_modules/@scope/parent/node_modules/extract-zip'), { recursive: true }),
  ];
  for (const change of changes) {
    const f = await extractZipFixture(t); await change(f);
    const before = await fs.readFile(f.filename);
    for (const checkOnly of [false, true]) await assert.rejects(applyExtractZipPatch(f.root, { checkOnly }));
    assert.deepEqual(await fs.readFile(f.filename), before);
  }
});

test('symlinked source/package and missing metadata fail closed', { skip: process.platform === 'win32' }, async t => {
  for (const relative of ['index.js', 'package.json']) {
    const f = await extractZipFixture(t);
    const filename = path.join(f.packageRoot, relative); const outside = path.join(f.root, 'outside');
    await fs.rename(filename, outside); await fs.symlink(outside, filename);
    await assert.rejects(applyExtractZipPatch(f.root), /regular file/);
  }
  const f = await extractZipFixture(t);
  await fs.rename(f.packageRoot, path.join(f.root, 'outside'));
  await fs.symlink(path.join(f.root, 'outside'), f.packageRoot);
  await assert.rejects(applyExtractZipPatch(f.root), /Linked dependency/);
});

test('copied CLI checks its own root, executes through aliases, and rejects unknown arguments', async t => {
  const f = await extractZipFixture(t);
  const alias = path.join(f.root, 'alias'); await fs.symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const run = args => spawnSync(process.execPath, [path.join(alias, helper), ...args], { encoding: 'utf8' });
  assert.notEqual(run(['--check']).status, 0);
  assert.equal(run([]).status, 0);
  assert.equal(run(['--check']).status, 0);
  assert.notEqual(run(['--unknown']).status, 0);
  await fs.writeFile(f.filename, 'tampered');
  assert.notEqual(run(['--check']).status, 0);
});

test('real archive symlink-leaf attack writes outside before patch and is rejected after patch', { skip: process.platform === 'win32' }, async t => {
  for (const patched of [false, true]) {
    const f = await extractZipFixture(t, { patched, runtime: true });
    const extract = createRequire(f.filename)(f.filename);
    const canary = path.join(f.root, 'canary'); await fs.writeFile(canary, 'ORIGINAL');
    const archive = path.join(f.root, 'attack.zip');
    await fs.writeFile(archive, zip([{ name: 'pwn', data: '../canary', mode: 0o120777 }, { name: 'pwn', data: 'OVERWRITTEN' }]));
    const task = extract(archive, { dir: path.join(f.root, 'dest') });
    if (patched) await assert.rejects(task, /Out of bound path .*processing file pwn/);
    else await task;
    assert.equal(await fs.readFile(canary, 'utf8'), patched ? 'ORIGINAL' : 'OVERWRITTEN');
    assert.equal((await fs.lstat(path.join(f.root, 'dest/pwn'))).isSymbolicLink(), true);
  }
});

test('real normal ZIP, duplicate regular file, directories and safe symlink remain compatible', { skip: process.platform === 'win32' }, async t => {
  const f = await extractZipFixture(t, { patched: true, runtime: true });
  const extract = createRequire(f.filename)(f.filename);
  const archive = path.join(f.root, 'safe.zip');
  await fs.writeFile(archive, zip([
    { name: 'bin/', mode: 0o40755 }, { name: 'bin/tool', data: 'first', mode: 0o100755 },
    { name: 'bin/tool', data: 'second', mode: 0o100755 }, { name: 'empty' },
    { name: 'shortcut', data: 'bin/tool', mode: 0o120777 },
  ]));
  const dest = path.join(f.root, 'dest'); await extract(archive, { dir: dest });
  assert.equal(await fs.readFile(path.join(dest, 'bin/tool'), 'utf8'), 'second');
  assert.equal(await fs.readFile(path.join(dest, 'shortcut'), 'utf8'), 'second');
  assert.equal(await fs.readlink(path.join(dest, 'shortcut')), 'bin/tool');
  assert.equal((await fs.stat(path.join(dest, 'empty'))).size, 0);
  assert.equal((await fs.stat(path.join(dest, 'bin/tool'))).mode & 0o111, 0o111);
});

test('real archives reject dangling/pre-existing leaves and preserve existing parent traversal protection', { skip: process.platform === 'win32' }, async t => {
  for (const scenario of ['dangling', 'pre-existing', 'parent']) {
    const f = await extractZipFixture(t, { patched: true, runtime: true });
    const extract = createRequire(f.filename)(f.filename);
    const dest = path.join(f.root, 'dest'); await fs.mkdir(dest);
    const entries = [];
    if (scenario === 'pre-existing') await fs.symlink('../outside', path.join(dest, 'pwn'));
    else entries.push({ name: 'pwn', data: scenario === 'parent' ? '..' : '../outside', mode: 0o120777 });
    entries.push({ name: scenario === 'parent' ? 'pwn/outside' : 'pwn', data: 'bad' });
    const archive = path.join(f.root, 'attack.zip'); await fs.writeFile(archive, zip(entries));
    await assert.rejects(extract(archive, { dir: dest }), /Out of bound path/);
    await assert.rejects(fs.stat(path.join(f.root, 'outside')), { code: 'ENOENT' });
  }
});
