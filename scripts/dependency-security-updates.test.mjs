import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import matter from 'gray-matter';
import semver from 'semver';

const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const require = createRequire(import.meta.url);

test('locked multer and both js-yaml majors meet the security floors', () => {
  assert.ok(semver.satisfies(lock.packages['node_modules/multer'].version, '>=2.3.0 <3'));
  const yaml = Object.entries(lock.packages).filter(([name]) => name.endsWith('/js-yaml'));
  assert.deepEqual([...new Set(yaml.map(([, entry]) => semver.major(entry.version)))].sort(), [3, 4]);
  for (const [name, entry] of yaml) {
    assert.ok(semver.satisfies(entry.version, '>=3.15.2 <4 || >=4.3.2 <5'), name);
  }
});

test('every installed locked YAML parser charges empty merge sources against its work limit', () => {
  for (const name of Object.keys(lock.packages).filter(name => name.endsWith('/js-yaml'))) {
    const yaml = require(fileURLToPath(new URL(`../${name}`, import.meta.url)));
    assert.deepEqual(yaml.load('defaults: &defaults {enabled: true}\njob: {<<: *defaults}\n'), {
      defaults: { enabled: true }, job: { enabled: true },
    });
    assert.throws(() => yaml.load('job: {<<: [{}, {}, {}, {}]}\n', { maxTotalMergeKeys: 3 }), /maxTotalMergeKeys/, name);
  }
});

test('gray-matter retains YAML 3 frontmatter and merge compatibility', () => {
  const parsed = matter('---\ndefaults: &defaults\n  enabled: true\njob:\n  <<: *defaults\n  name: build\n---\nBody\n');
  assert.deepEqual(parsed.data.job, { enabled: true, name: 'build' });
  assert.equal(parsed.content, 'Body\n');
});
