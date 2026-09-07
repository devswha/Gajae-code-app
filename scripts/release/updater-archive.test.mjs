import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { Header } from 'tar';

import { PRODUCT_NAME } from '../../shared/productIdentity.js';

import {
  cleanupUpdaterExtraction,
  compareAppInventories,
  createUpdaterArchive,
  extractUpdaterArchive,
  inspectUpdaterArchive,
  inventoryApp,
} from './updater-archive.mjs';

const appRoot = `${PRODUCT_NAME}.app`;
const execFile = promisify(execFileCallback);
let rawArchiveId = 0;

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gajae-updater-archive-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function makeRawArchive(root, entries, name) {
  const archiveName = name ?? `fixture-${++rawArchiveId}.app.tar.gz`;
  const archivePath = join(root, archiveName);
  const output = createWriteStream(archivePath, { flags: 'wx', mode: 0o600 });
  const gzip = createGzip({ level: 9 });
  gzip.pipe(output);
  for (const item of entries) {
    const body = Buffer.isBuffer(item.body) ? item.body : Buffer.from(item.body ?? '');
    const type = item.type ?? 'File';
    const header = new Header({
      path: item.path,
      type,
      mode: item.mode ?? (type === 'Directory' ? 0o755 : type === 'SymbolicLink' ? 0o777 : 0o644),
      size: type === 'File' || type === 'ExtendedHeader' || type === 'GlobalExtendedHeader' ? body.length : 0,
      linkpath: item.linkpath,
    });
    const block = Buffer.alloc(512);
    header.encode(block);
    assert.equal(new Header(block).cksumValid, true, `Fixture header checksum must be valid for ${item.path}.`);
    gzip.write(block);
    if (body.length > 0) gzip.write(body);
    const padding = (512 - (body.length % 512)) % 512;
    if (padding > 0) gzip.write(Buffer.alloc(padding));
  }
  gzip.end(Buffer.alloc(1024));
  await finished(output);
  return archivePath;
}

async function makeApp(root, { fileBody = 'payload', mode = 0o640, linkTarget = 'A' } = {}) {
  const app = join(root, appRoot);
  await mkdir(join(app, 'Contents/Resources/resources/server-payload'), { recursive: true, mode: 0o755 });
  await mkdir(join(app, 'Versions/A'), { recursive: true, mode: 0o755 });
  await writeFile(join(app, 'Contents/Resources/resources/server-payload/package.json'), fileBody, { mode });
  await writeFile(join(app, 'Versions/A/Framework'), 'framework bytes', { mode: 0o600 });
  await writeFile(join(app, 'Versions/A/Foo'), 'framework target', { mode: 0o644 });
  await symlink(linkTarget, join(app, 'Versions/Current'));
  await symlink('Current/Foo', join(app, 'Versions/Framework'));
  await symlink('../Versions/Current/Foo', join(app, 'Contents/Framework'));
  return app;
}

function rootDirectory() {
  return { path: appRoot, type: 'Directory', mode: 0o755 };
}

function rootFile(path, body = 'x') {
  return { path: `${appRoot}/${path}`, type: 'File', body };
}

function frameworkFixtureEntries() {
  const base = `${appRoot}/Contents/Frameworks/Example.framework`;
  return [
    rootDirectory(),
    { path: `${appRoot}/Contents`, type: 'Directory', mode: 0o755 },
    { path: `${appRoot}/Contents/Frameworks`, type: 'Directory', mode: 0o755 },
    { path: base, type: 'Directory', mode: 0o755 },
    { path: `${base}/Versions`, type: 'Directory', mode: 0o755 },
    { path: `${base}/Versions/A`, type: 'Directory', mode: 0o755 },
    rootFile('Contents/Frameworks/Example.framework/Versions/A/Foo', 'framework target'),
    { path: `${base}/Versions/Current`, type: 'SymbolicLink', linkpath: 'A', mode: 0o777 },
    { path: `${base}/Foo`, type: 'SymbolicLink', linkpath: 'Versions/Current/Foo', mode: 0o777 },
    { path: `${base}/Resources`, type: 'Directory', mode: 0o755 },
    { path: `${base}/Resources/Foo`, type: 'SymbolicLink', linkpath: '../Versions/Current/Foo', mode: 0o777 },
  ];
}

test('inventory and archive round-trip preserve bytes, modes, symlinks and unusual names', async t => {
  const sourceRoot = await fixture(t);
  const app = await makeApp(sourceRoot, { fileBody: 'newline\nname', mode: 0o640 });
  await writeFile(join(app, 'Contents', 'name with\nnewline'), 'unusual', { mode: 0o600 });
  await symlink('Current', join(app, 'Versions/Previous'));
  const before = await inventoryApp(app);
  const archivePath = join(sourceRoot, 'round-trip.app.tar.gz');
  const created = await createUpdaterArchive({ appPath: app, archivePath });
  const inspected = await inspectUpdaterArchive({ archivePath });
  assert.equal(created.sha256, (await import('node:crypto')).createHash('sha256').update(await readFile(archivePath)).digest('hex'));
  compareAppInventories(before, inspected.inventory);
  const extractionParent = await fixture(t);
  const extracted = await extractUpdaterArchive({ archivePath, root: extractionParent });
  compareAppInventories(before, extracted.inventory);
  assert.equal((await readFile(join(app, 'Contents/Resources/resources/server-payload/package.json'), 'utf8')), 'newline\nname');
  await cleanupUpdaterExtraction(extracted);
});

test('zero-length files finalize their hash once and survive the full archive roundtrip', async t => {
  const root = await fixture(t);
  const app = await makeApp(root, { fileBody: '' });
  await writeFile(join(app, 'empty'), '');
  const before = await inventoryApp(app);
  const archivePath = join(root, 'empty-members.app.tar.gz');
  await createUpdaterArchive({ appPath: app, archivePath });
  const inspected = await inspectUpdaterArchive({ archivePath });
  compareAppInventories(before, inspected.inventory);
  const empty = inspected.inventory.entries.find(entry => entry.path === `${appRoot}/empty`);
  assert.equal(empty.size, 0);
  assert.equal(empty.sha256, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  const extracted = await extractUpdaterArchive({ archivePath, root: await fixture(t) });
  compareAppInventories(before, extracted.inventory);
  await cleanupUpdaterExtraction(extracted);
});

test('framework-style links resolve through map symlinks and dot-dot components', async t => {
  const root = await fixture(t);
  const archivePath = await makeRawArchive(root, frameworkFixtureEntries());
  const inspected = await inspectUpdaterArchive({ archivePath });
  assert.ok(inspected.inventory.entries.some(entry => (
    entry.type === 'symlink' && entry.target === 'Versions/Current/Foo'
  )));
  const extractionParent = await fixture(t);
  const extracted = await extractUpdaterArchive({ archivePath, root: extractionParent });
  compareAppInventories(inspected.inventory, extracted.inventory);
  await cleanupUpdaterExtraction(extracted);
});

test('inventory is independent of timestamps and rejects hard-linked files', async t => {
  const root = await fixture(t);
  const app = await makeApp(root);
  const first = await inventoryApp(app);
  await writeFile(join(app, 'Contents/Resources/resources/server-payload/package.json'), 'payload', { mode: 0o640 });
  const second = await inventoryApp(app);
  compareAppInventories(first, second);

  await link(join(app, 'Contents/Resources/resources/server-payload/package.json'), join(app, 'Contents/hard-link'));
  await assert.rejects(() => inventoryApp(app), /hard-linked/);
});

test('traversal, absolute paths and noncanonical roots are rejected from actual tar streams', async t => {
  const root = await fixture(t);
  for (const badPath of [
    '../outside',
    `${appRoot}/../outside`,
    '/tmp/outside',
    `${appRoot}//file`,
    `${appRoot}/./file`,
    `${appRoot}/file//`,
    `Other.app/file`,
  ]) {
    const invalidEntry = badPath.endsWith('/')
      ? { path: badPath, type: 'Directory', mode: 0o755 }
      : { path: badPath, type: 'File', body: 'x', mode: 0o644 };
    const archive = await makeRawArchive(root, [rootDirectory(), invalidEntry]);
    await assert.rejects(() => inspectUpdaterArchive({ archivePath: archive }), /root|canonical|dot|relative|separator|member/);
  }
});

test('duplicate, case-alias and multiple-root entries are rejected', async t => {
  const root = await fixture(t);
  const cases = [
    [rootDirectory(), rootFile('same'), rootFile('same')],
    [rootDirectory(), rootFile('same'), rootFile('SAME')],
    [rootDirectory(), rootFile('file'), { path: 'Other.app', type: 'Directory', mode: 0o755 }],
  ];
  for (const entries of cases) {
    const archive = await makeRawArchive(root, entries);
    await assert.rejects(() => inspectUpdaterArchive({ archivePath: archive }), /duplicate|alias|root|member/);
  }
});

test('full-map symlink ancestor checks catch links before or after their children', async t => {
  const root = await fixture(t);
  for (const entries of [
    [rootDirectory(), { path: `${appRoot}/Contents`, type: 'SymbolicLink', linkpath: '.' }, rootFile('Contents/escaped')],
    [rootDirectory(), rootFile('Contents/escaped'), { path: `${appRoot}/Contents`, type: 'SymbolicLink', linkpath: '.' }],
  ]) {
    const archive = await makeRawArchive(root, entries);
    await assert.rejects(() => inspectUpdaterArchive({ archivePath: archive }), /ancestor|symbolic|directory/);
  }

  const escaping = await makeRawArchive(root, [
    rootDirectory(),
    { path: `${appRoot}/link`, type: 'SymbolicLink', linkpath: '../../outside' },
  ]);
  await assert.rejects(() => inspectUpdaterArchive({ archivePath: escaping }), /escapes|relative|root/);

  const cycle = await makeRawArchive(root, [
    rootDirectory(),
    { path: `${appRoot}/one`, type: 'SymbolicLink', linkpath: 'two' },
    { path: `${appRoot}/two`, type: 'SymbolicLink', linkpath: 'one' },
  ]);
  await assert.rejects(() => inspectUpdaterArchive({ archivePath: cycle }), /cycle|symbolic/);
});

test('special files, hard links and AppleDouble are rejected while unsafe PAX paths fail closed', async t => {
  const root = await fixture(t);
  for (const type of ['Link', 'CharacterDevice', 'BlockDevice', 'FIFO']) {
    const archive = await makeRawArchive(root, [rootDirectory(), { path: `${appRoot}/bad`, type, linkpath: type === 'Link' ? 'target' : undefined }]);
    await assert.rejects(() => inspectUpdaterArchive({ archivePath: archive }), /unsupported|ignored|special|entry/);
  }
  const appleDouble = await makeRawArchive(root, [rootDirectory(), rootFile('._metadata')]);
  await assert.rejects(() => inspectUpdaterArchive({ archivePath: appleDouble }), /AppleDouble|canonical/);
  const pax = await makeRawArchive(root, [
    { path: 'PaxHeaders.0', type: 'ExtendedHeader', body: '16 path=ignored\n' },
    rootDirectory(),
  ]);
  await assert.rejects(() => inspectUpdaterArchive({ archivePath: pax }), /root|member|canonical/);
});

test('compressed and absolute decompressed stream caps are enforced independently', async t => {
  const root = await fixture(t);
  const archive = await makeRawArchive(root, [rootDirectory(), rootFile('large', 'x'.repeat(16 * 1024))]);
  await assert.rejects(() => inspectUpdaterArchive({ archivePath: archive, maxExpandedBytes: 1024 }), /expanded|Decompressed/);
  await assert.rejects(() => inspectUpdaterArchive({ archivePath: archive, maxArchiveBytes: 16 }), /compressed|Compressed/);
  const entryLimited = await makeRawArchive(root, [rootDirectory(), rootFile('one', 'x')]);
  await assert.rejects(() => inspectUpdaterArchive({ archivePath: entryLimited, maxEntries: 1 }), /entries/);
});

test('entry and metadata limits abort parsing at the boundary', async t => {
  const root = await fixture(t);
  const manyEntries = await makeRawArchive(root, [
    rootDirectory(),
    rootFile('one'),
    rootFile('two'),
    rootFile('three'),
  ]);
  await assert.rejects(() => inspectUpdaterArchive({ archivePath: manyEntries, maxEntries: 2 }), /entries/);
  const metadata = await makeRawArchive(root, [
    rootDirectory(),
    { path: 'PaxHeaders.0', type: 'ExtendedHeader', body: '10 path=x\n' },
  ]);
  await assert.rejects(() => inspectUpdaterArchive({ archivePath: metadata, maxEntries: 1 }), /entries/);
  const oversizedMetadata = await makeRawArchive(root, [
    rootDirectory(),
    { path: 'PaxHeaders.1', type: 'ExtendedHeader', body: 'x'.repeat(128) },
  ]);
  await assert.rejects(() => inspectUpdaterArchive({ archivePath: oversizedMetadata, maxMetadataBytes: 32 }), /metadata/);
});

test('a FIFO archive path is rejected without waiting for a writer', async t => {
  const root = await fixture(t);
  const fifo = join(root, 'archive.app.tar.gz');
  await execFile('mkfifo', [fifo]);
  const moduleUrl = new URL('./updater-archive.mjs', import.meta.url).href;
  const script = `import(${JSON.stringify(moduleUrl)}).then(({ inspectUpdaterArchive }) => inspectUpdaterArchive({ archivePath: ${JSON.stringify(fifo)} })).catch(error => { console.error(error.message); process.exitCode = 1; });`;
  await assert.rejects(
    execFile(process.execPath, ['--input-type=module', '--eval', script], { timeout: 2000, maxBuffer: 16 * 1024 }),
    error => error.killed !== true && /regular file|nonempty|FIFO/.test(error.stderr ?? ''),
  );
});

test('inventory comparison catches byte, mode and link-target mismatches', async t => {
  const firstRoot = await fixture(t);
  const secondRoot = await fixture(t);
  const first = await makeApp(firstRoot, { fileBody: 'one' });
  const second = await makeApp(secondRoot, { fileBody: 'two' });
  const firstInventory = await inventoryApp(first);
  let secondInventory = await inventoryApp(second);
  assert.throws(() => compareAppInventories(firstInventory, secondInventory), /bytes/);
  const secondPayload = join(second, 'Contents/Resources/resources/server-payload/package.json');
  await writeFile(secondPayload, 'one');
  await chmod(secondPayload, 0o600);
  secondInventory = await inventoryApp(second);
  assert.throws(() => compareAppInventories(firstInventory, secondInventory), /mode/);
  await chmod(secondPayload, 0o640);
  await rm(join(second, 'Versions/Current'));
  await symlink('A/.', join(second, 'Versions/Current'));
  secondInventory = await inventoryApp(second);
  assert.throws(() => compareAppInventories(firstInventory, secondInventory), /target/);
});

test('maintained tar PAX metadata preserves long member names and exact inventory', async t => {
  const root = await fixture(t);
  const app = await makeApp(root);
  const longName = 'n'.repeat(101);
  await writeFile(join(app, longName), 'long');
  const before = await inventoryApp(app);
  const archivePath = join(root, 'long.app.tar.gz');
  await createUpdaterArchive({ appPath: app, archivePath });
  const inspected = await inspectUpdaterArchive({ archivePath });
  compareAppInventories(before, inspected.inventory);
  assert.ok(inspected.inventory.entries.some(entry => entry.path.endsWith(`/${longName}`)));
});

test('maintained tar PAX/prefix encoding accepts a 300-byte bundled path', async t => {
  const root = await fixture(t);
  const app = await makeApp(root);
  const segments = ['a', 'b', 'c', 'd'].map(value => value.repeat(70));
  const nested = join(app, ...segments);
  await mkdir(nested, { recursive: true, mode: 0o755 });
  await writeFile(join(nested, 'runtime'), 'deep path');
  const archivePath = join(root, 'deep.app.tar.gz');
  const before = await inventoryApp(app);
  await createUpdaterArchive({ appPath: app, archivePath });
  const inspected = await inspectUpdaterArchive({ archivePath });
  compareAppInventories(before, inspected.inventory);
  assert.ok(inspected.inventory.entries.some(entry => entry.path.endsWith('/runtime')));
  const extracted = await extractUpdaterArchive({ archivePath, root: await fixture(t) });
  compareAppInventories(before, extracted.inventory);
  await cleanupUpdaterExtraction(extracted);
});

test('extraction requires a fresh private parent and cleans failed output', async t => {
  const root = await fixture(t);
  const app = await makeApp(root);
  const archive = join(root, 'safe.app.tar.gz');
  await createUpdaterArchive({ appPath: app, archivePath: archive });
  const notPrivate = await fixture(t);
  await chmod(notPrivate, 0o755);
  await assert.rejects(() => extractUpdaterArchive({ archivePath: archive, root: notPrivate }), /private|owner-only/);
  await assert.rejects(() => extractUpdaterArchive({ archivePath: archive, root, destination: join(root, 'nested', 'not-fresh') }), /fresh child|ENOENT|directory/);
});
