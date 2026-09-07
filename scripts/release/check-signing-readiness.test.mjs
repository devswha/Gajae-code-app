import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  REQUIRED_SIGNING_SECRETS, checkCiSigning, checkGitHubSigning, checkLocalSigning,
  parseDeveloperIdentities,
} from './check-signing-readiness.mjs';

const script = fileURLToPath(new URL('./check-signing-readiness.mjs', import.meta.url));
const marker = 'sensitive-fixture-value-never-print';
const identity = 'Developer ID Application: Fixture (AB12345678)';
const fingerprint = 'A'.repeat(40);
const identities = `  1) ${fingerprint} "${identity}"\n     1 valid identities found\n`;
const localOptions = { keychain: '/explicit/login.keychain-db', profile: 'known-profile', identity };
const localDependencies = { platform: 'darwin', arch: 'arm64', exists: () => true };
const workflow = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');

function workflowStep(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `Missing workflow step: ${name}`);
  const end = workflow.indexOf('\n      - name:', start + 1);
  return workflow.slice(start, end === -1 ? undefined : end);
}

function stepShell(name) {
  const step = workflowStep(name);
  const run = step.match(/ {8}run: \|\n((?: {10}.*\n|\n)+)/);
  assert.ok(run, `Missing shell body: ${name}`);
  return run[1].replace(/^ {10}/gm, '');
}

test('CI blocks all 31 incomplete signing configurations, including all-absent credentials', () => {
  for (let mask = 0; mask < 32; mask++) {
    const env = Object.fromEntries(REQUIRED_SIGNING_SECRETS.filter((_, i) => mask & (1 << i)).map(name => [name, marker]));
    const result = checkCiSigning(env);
    assert.equal(result.status, mask === 31 ? 'ready' : 'blocked', `mask ${mask}`);
    assert.equal(result.checks.filter(entry => entry.status === 'pass').length, Object.keys(env).length);
    assert.ok(!JSON.stringify(result).includes(marker));
  }
});

test('CI treats empty and whitespace-only values as missing', () => {
  const env = Object.fromEntries(REQUIRED_SIGNING_SECRETS.map(name => [name, marker]));
  for (const name of REQUIRED_SIGNING_SECRETS) {
    for (const value of ['', ' \n\t', undefined]) {
      assert.equal(checkCiSigning({ ...env, [name]: value }).status, 'blocked');
    }
  }
});

test('CLI exits nonzero for incomplete configuration without exposing values', () => {
  const env = { ...process.env };
  for (const name of REQUIRED_SIGNING_SECRETS) delete env[name];
  env.APPLE_ID = marker;
  const result = spawnSync(process.execPath, [script, '--mode', 'ci'], { env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).status, 'blocked');
  assert.ok(!`${result.stdout}${result.stderr}`.includes(marker));
  for (const args of [['--password', marker], ['--mode', marker], ['--mode', 'ci', '--profile', marker]]) {
    const invalid = spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8' });
    assert.equal(invalid.status, 2);
    assert.ok(!`${invalid.stdout}${invalid.stderr}`.includes(marker));
  }
});

test('CLI invoked through a symlinked checkout still checks credentials and fails closed', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gajae-signing-entry-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const checkout = join(directory, 'checkout');
  await symlink(fileURLToPath(new URL('../../', import.meta.url)), checkout, 'junction');
  const env = { ...process.env };
  for (const name of REQUIRED_SIGNING_SECRETS) delete env[name];
  const result = spawnSync(process.execPath, [join(checkout, 'scripts/release/check-signing-readiness.mjs'), '--mode', 'ci'], { env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'blocked');
  assert.deepEqual(report.checks.filter(entry => entry.status === 'fail').map(entry => entry.name), REQUIRED_SIGNING_SECRETS);
});

test('module imports stay inert when argv has no entry path or names a nonexistent file', () => {
  const moduleUrl = new URL('./check-signing-readiness.mjs', import.meta.url).href;
  for (const setup of ['process.argv.length = 1;', 'process.argv[1] = "/nonexistent-gajae-entry-path";']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `${setup} await import(${JSON.stringify(moduleUrl)});`], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
});

test('GitHub reads only names/timestamps, accepts repository secrets, and gives environment precedence', async () => {
  const calls = [];
  const result = await checkGitHubSigning({ repo: 'owner/repo' }, { run: async (command, args) => {
    calls.push({ command, args });
    return JSON.stringify((args.includes('--env') ? [REQUIRED_SIGNING_SECRETS[0]] : REQUIRED_SIGNING_SECRETS)
      .map(name => ({ name, updatedAt: args.includes('--env') ? '2026-09-05T01:00:00Z' : '2026-09-04T01:00:00Z', value: marker })));
  } });
  assert.deepEqual(calls, [
    { command: 'gh', args: ['secret', 'list', '--repo', 'owner/repo', '--json', 'name,updatedAt', '--env', 'release'] },
    { command: 'gh', args: ['secret', 'list', '--repo', 'owner/repo', '--json', 'name,updatedAt'] },
  ]);
  assert.equal(result.status, 'ready');
  const certificate = result.checks.find(entry => entry.name === 'APPLE_CERTIFICATE_P12');
  assert.equal(certificate.source, 'environment');
  assert.equal(certificate.updatedAt, '2026-09-05T01:00:00Z');
  assert.equal(result.checks.find(entry => entry.name === 'APPLE_ID').source, 'repository');
  assert.ok(!JSON.stringify(result).includes(marker));
});

test('empty GitHub scopes report every missing requirement', async () => {
  const result = await checkGitHubSigning({ repo: 'owner/repo' }, { run: async () => '[]' });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.checks.filter(entry => entry.status === 'fail').map(entry => entry.name), REQUIRED_SIGNING_SECRETS);
});

test('unreadable or malformed GitHub metadata never masquerades as a ready configuration', async () => {
  for (const response of ['not json', '{}', '[null]', '[{"name":"APPLE_ID"}]']) {
    const result = await checkGitHubSigning({ repo: 'owner/repo' }, { run: async () => response });
    assert.equal(result.status, 'blocked');
    assert.equal(result.checks[0].status, 'fail');
  }
  const result = await checkGitHubSigning({ repo: 'owner/repo' }, { run: async (_, args) => {
    if (args.includes('--env')) throw new Error(marker);
    return JSON.stringify(REQUIRED_SIGNING_SECRETS.map(name => ({ name, updatedAt: '2026-09-05T00:00:00Z' })));
  } });
  assert.equal(result.status, 'blocked', 'Unknown environment overrides prevent claiming readiness.');
  assert.ok(!JSON.stringify(result).includes(marker));
});

test('identity parser rejects unrelated signing certificates and invalid identities', () => {
  assert.deepEqual(parseDeveloperIdentities(identities), [{ fingerprint, name: identity, teamId: 'AB12345678' }]);
  assert.deepEqual(parseDeveloperIdentities(`1) ${fingerprint} "Apple Development: Fixture (AB12345678)"\n`), []);
  assert.deepEqual(parseDeveloperIdentities(`1) ${fingerprint} "${identity}" (CSSMERR_TP_CERT_EXPIRED)\n`), []);
});

test('local readiness uses only the explicit keychain and named profile, with no credential export or submission', async () => {
  const calls = [];
  const result = await checkLocalSigning(localOptions, { ...localDependencies, run: async (command, args) => {
    calls.push({ command, args });
    return command === 'security' ? identities : JSON.stringify({ history: [{ name: marker, id: marker }] });
  } });
  assert.equal(result.status, 'ready');
  assert.deepEqual(calls, [
    { command: 'security', args: ['find-identity', '-v', '-p', 'codesigning', localOptions.keychain] },
    { command: 'xcrun', args: ['notarytool', 'history', '--keychain-profile', 'known-profile', '--output-format', 'json', '--no-progress'] },
  ]);
  assert.ok(!JSON.stringify(result).includes(marker));
});

test('local mode fails before running commands without explicit supported inputs', async () => {
  const run = async () => { assert.fail('Must not query keychains with invalid inputs.'); };
  for (const override of [{ keychain: undefined }, { keychain: 'relative' }, { 'notary-keychain': 'relative' }, { profile: '' }, { profile: '-other' }, { identity: '-' }, { identity: undefined }]) {
    assert.equal((await checkLocalSigning({ ...localOptions, ...override }, { ...localDependencies, run })).status, 'blocked');
  }
  for (const override of [{ platform: 'linux' }, { arch: 'x64' }, { exists: () => false }]) {
    assert.equal((await checkLocalSigning(localOptions, { ...localDependencies, ...override, run })).status, 'blocked');
  }
});

test('notary profiles can use an explicit keychain different from the signing identity', async () => {
  const result = await checkLocalSigning({ ...localOptions, 'notary-keychain': '/explicit/notary.keychain-db' }, {
    ...localDependencies, run: async (command, args) => {
      if (command === 'security') {
        assert.equal(args.at(-1), localOptions.keychain);
        return identities;
      }
      assert.deepEqual(args.slice(-2), ['--keychain', '/explicit/notary.keychain-db']);
      return '{"history":[]}';
    },
  });
  assert.equal(result.status, 'ready');
});

test('local mode requires an exact unambiguous identity; SHA-1 selection is supported', async () => {
  for (const output of ['', identities + identities, identities.replace('Fixture', 'Different Fixture')]) {
    const result = await checkLocalSigning(localOptions, { ...localDependencies,
      run: async command => command === 'security' ? output : '{"history":[]}',
    });
    assert.equal(result.status, 'blocked');
  }
  const result = await checkLocalSigning({ ...localOptions, identity: fingerprint.toLowerCase() }, { ...localDependencies,
    run: async command => command === 'security' ? identities : '{"history":[]}',
  });
  assert.equal(result.status, 'ready');
});

test('failed authentication, command timeout, and unexpected notarization responses block readiness without raw output', async () => {
  for (const output of ['bad json', '{}', '{"history":null}']) {
    const result = await checkLocalSigning(localOptions, { ...localDependencies,
      run: async command => command === 'security' ? identities : output,
    });
    assert.equal(result.status, 'blocked');
  }
  const result = await checkLocalSigning(localOptions, { ...localDependencies, run: async () => {
    throw Object.assign(new Error(marker), { stdout: marker, stderr: marker, code: 'ETIMEDOUT' });
  } });
  assert.equal(result.status, 'blocked');
  assert.ok(!JSON.stringify(result).includes(marker));
});

test('workflow requires all signing inputs before expensive macOS work and cannot fall back to ad-hoc', () => {
  const desktop = workflow.slice(workflow.indexOf('  desktop-macos:'), workflow.indexOf('  ubuntu-24-compatibility:'));
  assert.match(desktop, /environment: release/);
  assert.doesNotMatch(desktop.slice(0, desktop.indexOf('\n    steps:')), /TAURI_SIGNING_PRIVATE_KEY/);
  for (const name of ['Require release signing credentials', 'Build canonical macOS updater assets']) {
    for (const secret of ['TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD']) {
      assert.ok(workflowStep(name).includes(`${secret}: ` + '${{ secrets.' + secret + ' }}'));
    }
  }
  assert.deepEqual([...desktop.matchAll(/\$\{\{ secrets\.(APPLE_[A-Z0-9_]+) }}/g)].map(match => match[1]), REQUIRED_SIGNING_SECRETS);
  assert.match(workflowStep('Require release signing credentials'), /node scripts\/release\/check-signing-readiness\.mjs --mode ci/);
  const preflight = desktop.indexOf('- name: Require release signing credentials');
  assert.ok(preflight < desktop.indexOf('- name: Set up Rust'));
  assert.ok(preflight < desktop.indexOf('- name: Install dependencies'));
  assert.ok(preflight < desktop.indexOf('- name: Build and verify embedded macOS server payload'));
  assert.doesNotMatch(desktop, /signed=false/);
  const importStep = workflowStep('Import the Developer ID certificate into a throwaway keychain');
  assert.ok(importStep.indexOf('GAJAE_SIGNING_KEYCHAIN=') < importStep.indexOf('security import'));
  assert.match(workflowStep('Remove the signing keychain'), /if: always\(\)/);
});

test('the actual publication guard rejects missing/false/malformed signing output and accepts only true', () => {
  const body = stepShell('Require signed desktop before publication');
  assert.match(workflowStep('Require signed desktop before publication'), /DESKTOP_SIGNED: \$\{\{ needs\.desktop-macos\.outputs\.signed }}/);
  const publishStart = workflow.lastIndexOf('\n  publish:');
  assert.notEqual(publishStart, -1);
  const publish = workflow.slice(publishStart);
  const guardIndex = publish.indexOf('- name: Require signed desktop before publication');
  const serverDownloadIndex = publish.indexOf('- name: Download canonical server release assets');
  assert.ok(guardIndex >= 0 && serverDownloadIndex >= 0 && guardIndex < serverDownloadIndex);
  for (const signed of ['', 'false', 'TRUE', ' true ', 'true\n', 'true']) {
    const result = spawnSync('bash', ['-c', body], { env: { ...process.env, DESKTOP_SIGNED: signed }, encoding: 'utf8' });
    assert.equal(result.status, signed === 'true' ? 0 : 1, JSON.stringify(signed));
  }
});
