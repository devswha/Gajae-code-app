import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/*
 * The engine's file set has to be a fact, not a memory.
 *
 * `server/gjc-*` is about to become the contents of a different repository, and
 * a file that lands in that namespace without a decision behind it either moves
 * when it should not or stays when it should not. Both failures are silent, and
 * both are found long afterwards.
 *
 * `gjc-engine-manifest.json` is the single declaration: eslint reads it to
 * enforce the import boundary, and the extraction will read it to know what to
 * move. This test keeps it honest in both directions.
 */

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'server', 'gjc-engine-manifest.json'), 'utf8'));

const declared = new Map<string, string>();
for (const [group, entries] of Object.entries(manifest)) {
  if (group.startsWith('$')) continue;
  if (Array.isArray(entries)) {
    for (const file of entries) declared.set(file, group);
  } else if (entries && typeof entries === 'object') {
    for (const file of Object.keys(entries)) declared.set(file, group);
  }
}

function inventoryEngineFiles(repositoryRoot: string): string[] {
  // Verify authored files before git add, but keep ignored build/runtime output
  // out and retain the same server/gjc-* namespace as the extraction manifest.
  const files = execFileSync('git', [
    'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'server/gjc-*',
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  return [...new Set(files.split('\0').filter(Boolean))].sort();
}

const inventory = inventoryEngineFiles(REPOSITORY_ROOT);

test('every file in the engine namespace has a recorded side', () => {
  const undeclared = inventory.filter((file) => !declared.has(file));
  assert.deepEqual(
    undeclared,
    [],
    'these files sit in server/gjc-* with no entry in gjc-engine-manifest.json. '
    + 'Adding one is a decision about whether the file ships closed with the engine '
    + 'or stays with the application; make it deliberately.',
  );
});

test('the manifest describes no file that does not exist', () => {
  const inventorySet = new Set(inventory);
  const missing = [...declared.keys()].filter((file) => !inventorySet.has(file));
  assert.deepEqual(
    missing,
    [],
    'the manifest lists files that are not in server/gjc-*. A declaration guarding '
    + 'nothing reads like a decision long after it stopped being one.',
  );
});

test('the application side of the manifest states why each file stays', () => {
  for (const [file, reason] of Object.entries(manifest.application)) {
    assert.equal(typeof reason, 'string', `${file} needs a reason, not a placeholder`);
    assert.ok(
      (reason as string).length > 40,
      `${file} needs a reason someone can act on, not a label`,
    );
  }
});

test('nothing declared as engine imports the application', () => {
  // The eslint boundary rule covers this for source files. Repeating it here
  // over the manifest catches the case eslint cannot see: a file added to the
  // engine list that was never in the engine element, and test files, which are
  // outside the element entirely but still move with the engine.
  const appImport = /from\s+'(?:\.\.\/src\/|\.\/modules\/|@\/modules\/|\.\/services\/|@\/services\/)/u;
  const engineFiles = [
    ...(manifest.engine as string[]),
    ...(manifest.engineTests as string[]),
  ];

  for (const file of engineFiles) {
    const source = readFileSync(join(REPOSITORY_ROOT, file), 'utf8');
    const offending = source
      .split('\n')
      .filter((line) => appImport.test(line))
      .map((line) => line.trim());
    assert.deepEqual(
      offending,
      [],
      `${relative(REPOSITORY_ROOT, file)} is declared as engine but imports the application. `
      + 'The engine cannot take that import with it.',
    );
  }
});

test('engine inventory includes untracked nonignored files without widening its namespace', (t) => {
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'gjc-engine-inventory-'));
  t.after(() => rmSync(repositoryRoot, { recursive: true, force: true }));
  const git = (args: string[]) => execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' });
  git(['init', '-q']);
  // Keep the fixture independent of the developer's global ignore patterns.
  git(['config', 'core.excludesFile', '']);

  const trackedFiles = [
    'server/gjc-tracked.ts',
    'server/gjc-tracked.log',
    'server/gjc-existing/tracked.ts',
  ];
  const untrackedFiles = [
    'server/gjc-bun-oauth-controller.bun.test.ts',
    'server/gjc-new.ts',
    'server/gjc-existing/new.ts',
    'server/gjc-new-directory/nested.ts',
    'server/gjc-space name.ts',
    'server/gjc-한글.ts',
  ];
  const excludedFiles = [
    'server/gjc-ignored.log',
    'server/gjc-existing/ignored.log',
    'server/gjc-ignored-directory/generated.ts',
    'server/gjc-local-only.ts',
    'server/other.ts',
    'server/gjclient.ts',
    'server/modules/providers/gjc-app.ts',
    'src/gjc-ui.ts',
    'scripts/gjc-helper.ts',
    'other/server/gjc-lookalike.ts',
  ];
  for (const file of [...trackedFiles, ...untrackedFiles, ...excludedFiles]) {
    const path = join(repositoryRoot, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '// inventory fixture\n');
  }
  git(['add', '--', ...trackedFiles]);
  // Existing tracked files must remain visible even when a later ignore rule
  // matches them; only untracked files are subject to standard Git exclusions.
  writeFileSync(join(repositoryRoot, '.gitignore'), '*.log\n/server/gjc-ignored-directory/\n');
  writeFileSync(join(repositoryRoot, '.git/info/exclude'), '/server/gjc-local-only.ts\n');

  const beforeStaging = inventoryEngineFiles(repositoryRoot);
  assert.deepEqual(beforeStaging, [...trackedFiles, ...untrackedFiles].sort());
  const recordedFiles = new Set(trackedFiles);
  assert.deepEqual(
    beforeStaging.filter((file) => !recordedFiles.has(file)),
    [...untrackedFiles].sort(),
    'new engine files must require a classification before git add',
  );

  git(['add', '--', ...untrackedFiles]);
  assert.deepEqual(inventoryEngineFiles(repositoryRoot), beforeStaging, 'staging must not change the inventory');
});
