import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { applyExtractZipPatch } from './apply-extract-zip-patch.mjs';
import { evaluateAuditReport, EXCEPTIONS } from './check-audit.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const today = '2026-09-09';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, { patched = true } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gajae-audit-guard-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'node_modules/extract-zip');
  const manifestDirectory = path.join(root, 'patches/extract-zip-symlink-leaf');
  await mkdir(directory, { recursive: true });
  await mkdir(manifestDirectory, { recursive: true });
  await copyFile(path.join(repository, 'patches/extract-zip-symlink-leaf/manifest.json'), path.join(manifestDirectory, 'manifest.json'));
  await copyFile(path.join(repository, 'node_modules/extract-zip/package.json'), path.join(directory, 'package.json'));
  const manifest = JSON.parse(await readFile(path.join(manifestDirectory, 'manifest.json'), 'utf8'));
  let source = await readFile(path.join(repository, 'node_modules/extract-zip/index.js'), 'utf8');
  if (digest(source) === manifest.afterSha256) source = source.replace(manifest.replacement.after, manifest.replacement.before);
  assert.equal(digest(source), manifest.beforeSha256);
  await writeFile(path.join(directory, 'index.js'), source);
  if (patched) await applyExtractZipPatch(root);
  return { root, directory, manifestDirectory };
}

function report() {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      'extract-zip': {
        name: 'extract-zip', severity: 'high', nodes: ['node_modules/extract-zip'],
        via: EXCEPTIONS.map(exception => ({ name: 'extract-zip', severity: 'high', title: 'fixture', url: `https://github.com/advisories/${exception.advisory}` })),
      },
      '@puppeteer/browsers': { name: '@puppeteer/browsers', severity: 'high', via: ['extract-zip'], nodes: ['node_modules/@puppeteer/browsers'] },
    },
    metadata: { vulnerabilities: { high: 2, total: 2 } },
  };
}

test('audit recognizes only exact installed backports with current reviews', async t => {
  const { root } = await fixture(t);
  const result = await evaluateAuditReport(report(), { installRoot: root, today });
  assert.deepEqual(result.errors, []);
  assert.equal(result.honored.length, 2);
});

test('unapplied and altered sources cannot turn an advisory into an exception', async t => {
  for (const scenario of ['unapplied', 'altered']) await t.test(scenario, async t => {
    const { root, directory } = await fixture(t, { patched: scenario !== 'unapplied' });
    if (scenario === 'altered') await writeFile(path.join(directory, 'index.js'), 'module.exports = () => {};\n');
    const result = await evaluateAuditReport(report(), { installRoot: root, today });
    assert.match(result.errors.join('\n'), /patch verification failed/);
    assert.equal(result.honored.length, 0);
    assert.match(result.errors.join('\n'), /GHSA-7PQW-9J4J-H8Q3/);
  });
});

test('changed canonical manifests and resolution metadata fail closed', async t => {
  for (const target of ['manifest', 'metadata']) await t.test(target, async t => {
    const { root, directory, manifestDirectory } = await fixture(t);
    const filename = target === 'manifest' ? path.join(manifestDirectory, 'manifest.json') : path.join(directory, 'package.json');
    await writeFile(filename, (await readFile(filename, 'utf8')) + '\n');
    const result = await evaluateAuditReport(report(), { installRoot: root, today });
    assert.match(result.errors.join('\n'), /patch verification failed/);
    assert.equal(result.honored.length, 0);
  });
});

test('unrecorded nested or aliased extract-zip copies are rejected', async t => {
  for (const slot of ['node_modules/other/node_modules/extract-zip', 'node_modules/zip-alias']) await t.test(slot, async t => {
    const { root, directory } = await fixture(t);
    const extra = path.join(root, slot);
    await mkdir(extra, { recursive: true });
    await copyFile(path.join(directory, 'package.json'), path.join(extra, 'package.json'));
    const result = await evaluateAuditReport(report(), { installRoot: root, today });
    assert.match(result.errors.join('\n'), /Nested or aliased/);
    assert.equal(result.honored.length, 0);
  });
});

test('linked dependency slots do not grant a canonical patch exception', { skip: process.platform === 'win32' }, async t => {
  const { root, directory } = await fixture(t);
  await symlink(directory, path.join(root, 'node_modules/zip-link'));
  const result = await evaluateAuditReport(report(), { installRoot: root, today });
  assert.match(result.errors.join('\n'), /Linked dependency/);
  assert.equal(result.honored.length, 0);
});

test('expired, future and stale advisory reviews remain blocking', async t => {
  const { root } = await fixture(t);
  for (const overrides of [{ reviewBy: '2026-09-08' }, { reviewedOn: '2026-09-10' }]) {
    const exceptions = EXCEPTIONS.map(exception => ({ ...exception, ...overrides }));
    const result = await evaluateAuditReport(report(), { installRoot: root, today, exceptions });
    assert.match(result.errors.join('\n'), /Missing, future or expired review/);
    assert.equal(result.honored.length, 0);
  }
  const stale = report();
  stale.vulnerabilities['extract-zip'].via.pop();
  const result = await evaluateAuditReport(stale, { installRoot: root, today });
  assert.match(result.errors.join('\n'), /no longer matches/);
});

test('unknown high severity and mismatched npm paths are not covered', async t => {
  const { root } = await fixture(t);
  const unknown = report();
  unknown.vulnerabilities.other = { name: 'other', severity: 'critical', nodes: ['node_modules/other'], via: [{ name: 'other', severity: 'critical', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc' }] };
  assert.match((await evaluateAuditReport(unknown, { installRoot: root, today })).errors.join('\n'), /GHSA-AAAA-BBBB-CCCC/);
  const nested = report();
  nested.vulnerabilities['extract-zip'].nodes.push('node_modules/other/node_modules/extract-zip');
  assert.match((await evaluateAuditReport(nested, { installRoot: root, today })).errors.join('\n'), /Unreviewed installed paths/);
});

test('network errors, incomplete reports and dangling dependency edges fail closed', async t => {
  const { root } = await fixture(t);
  for (const invalid of [{}, { error: { code: 'ECONNRESET' } }, { ...report(), vulnerabilities: [] }]) {
    assert.match((await evaluateAuditReport(invalid, { installRoot: root, today })).errors.join('\n'), /invalid or incomplete/);
  }
  const dangling = report();
  dangling.vulnerabilities['@puppeteer/browsers'].via = ['missing'];
  assert.match((await evaluateAuditReport(dangling, { installRoot: root, today })).errors.join('\n'), /Missing audit dependency evidence/);
});
