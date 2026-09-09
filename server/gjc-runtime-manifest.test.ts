import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

import sdkPolicy from '../shared/sdkLifecyclePolicy.json' with { type: 'json' };

import { isVerifiedSdkPatch, verifyRuntimeManifest } from './gjc-runtime-manifest.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture(t: test.TestContext) {
  const platform = `${process.platform}-${process.arch}`;
  const root = path.resolve('/runtime-fixture/node_modules/@gajae-code');
  const files = new Map<string, string>();
  const metadata = (name: string, version = '0.16.4') => {
    files.set(path.join(root, name, 'package.json'), JSON.stringify({ name: `@gajae-code/${name}`, version }));
  };
  for (const name of ['coding-agent', 'agent-core', 'natives', `natives-${platform}`]) metadata(name);
  files.set(path.join(root, `natives-${platform}`, 'native/addon.node'), 'native fixture');
  files.set(path.join(root, 'coding-agent', 'src/session.ts'), 'patched session fixture');
  files.set(path.join(root, 'agent-core', 'src/ledger.ts'), 'patched ledger fixture');
  const manifest: Record<string, any> = {
    schemaVersion: 2, gjcSdk: '0.16.4', natives: '0.16.4', bun: '1.4.0',
    platforms: { [platform]: { files: [{ package: `@gajae-code/natives-${platform}`, path: 'native/addon.node', sha256: sha('native fixture') }] } },
    sdkLifecycle: { id: 'gjc-sdk-lifecycle-v1', packages: { '@gajae-code/coding-agent': '0.16.4', '@gajae-code/agent-core': '0.16.4' },
      files: [{ package: '@gajae-code/coding-agent', path: 'src/session.ts', sha256: sha('patched session fixture') },
        { package: '@gajae-code/agent-core', path: 'src/ledger.ts', sha256: sha('patched ledger fixture') }] },
  };
  const override = path.resolve('/runtime-fixture/manifest.json');
  const requested: string[] = [];
  const bun = {
    version: '1.4.0',
    resolveSync(name: string) { return path.join(root, name.slice('@gajae-code/'.length), 'index.ts'); },
    file(filename: string) {
      requested.push(filename);
      const content = () => {
        const value = filename === override ? JSON.stringify(manifest) : files.get(filename);
        if (value === undefined) throw new Error('missing fixture file');
        return value;
      };
      return { text: async () => content(), arrayBuffer: async () => Uint8Array.from(Buffer.from(content())).buffer };
    },
  };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Bun');
  const previousAllow = process.env.GJC_ALLOW_RUNTIME_MANIFEST_OVERRIDE;
  const previousPath = process.env.GJC_RUNTIME_MANIFEST_PATH;
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'Bun', descriptor);
    else delete (globalThis as unknown as Record<string, unknown>).Bun;
    if (previousAllow === undefined) delete process.env.GJC_ALLOW_RUNTIME_MANIFEST_OVERRIDE;
    else process.env.GJC_ALLOW_RUNTIME_MANIFEST_OVERRIDE = previousAllow;
    if (previousPath === undefined) delete process.env.GJC_RUNTIME_MANIFEST_PATH;
    else process.env.GJC_RUNTIME_MANIFEST_PATH = previousPath;
  });
  Object.defineProperty(globalThis, 'Bun', { configurable: true, value: bun });
  process.env.GJC_ALLOW_RUNTIME_MANIFEST_OVERRIDE = '1';
  process.env.GJC_RUNTIME_MANIFEST_PATH = override;
  return { files, manifest, root, requested, metadata, bun };
}

test('manifest v2 checks native and every SDK post-hash; test overrides cannot mint source-integrity receipts', async (t) => {
  const f = fixture(t);
  assert.equal(await verifyRuntimeManifest(), undefined);
  assert.ok(f.requested.includes(path.join(f.root, 'coding-agent', 'src/session.ts')));
  assert.ok(f.requested.includes(path.join(f.root, 'agent-core', 'src/ledger.ts')));
});

test('shared SDK file-count limit admits the full boundary and rejects an extra member', async (t) => {
  const f = fixture(t);
  while (f.manifest.sdkLifecycle.files.length < sdkPolicy.maxFiles) {
    const relative = `src/provider-${f.manifest.sdkLifecycle.files.length}.ts`;
    f.files.set(path.join(f.root, 'coding-agent', relative), 'patched provider');
    f.manifest.sdkLifecycle.files.push({ package: '@gajae-code/coding-agent', path: relative, sha256: sha('patched provider') });
  }
  await verifyRuntimeManifest();
  f.manifest.sdkLifecycle.files.push({ package: '@gajae-code/coding-agent', path: 'src/overflow.ts', sha256: sha('patched provider') });
  await assert.rejects(verifyRuntimeManifest(), { message: 'GJC runtime manifest validation failed.' });
});

for (const [name, mutate] of Object.entries({
  legacy: (f: ReturnType<typeof fixture>) => { f.manifest.schemaVersion = 1; },
  omitted: (f: ReturnType<typeof fixture>) => { delete f.manifest.sdkLifecycle; },
  empty: (f: ReturnType<typeof fixture>) => { f.manifest.sdkLifecycle.files = []; },
  partial: (f: ReturnType<typeof fixture>) => { f.manifest.sdkLifecycle.files.pop(); },
  duplicate: (f: ReturnType<typeof fixture>) => { f.manifest.sdkLifecycle.files.push(f.manifest.sdkLifecycle.files[0]); },
  traversal: (f: ReturnType<typeof fixture>) => { f.manifest.sdkLifecycle.files[0].path = 'src/../../secret.ts'; },
  mixed: (f: ReturnType<typeof fixture>) => { f.files.set(path.join(f.root, 'agent-core', 'src/ledger.ts'), 'pristine source'); },
  wrongVersion: (f: ReturnType<typeof fixture>) => { f.metadata('agent-core', '0.16.6'); },
  wrongDigest: (f: ReturnType<typeof fixture>) => { f.manifest.sdkLifecycle.files[0].sha256 = '0'.repeat(64); },
  nativeTamper: (f: ReturnType<typeof fixture>) => { f.manifest.platforms[`${process.platform}-${process.arch}`].files[0].sha256 = '0'.repeat(64); },
})) {
  test(`manifest rejects ${name} lifecycle/native evidence before SDK creation`, async (t) => {
    const f = fixture(t); mutate(f);
    await assert.rejects(verifyRuntimeManifest(), { message: 'GJC runtime manifest validation failed.' });
    assert.ok(!f.requested.some((filename) => filename.includes('secret')));
  });
}

test('a marker or serialized receipt cannot impersonate the trusted bootstrap result', () => {
  assert.equal(isVerifiedSdkPatch({ id: 'gjc-sdk-lifecycle-v1' }), false);
  assert.equal(isVerifiedSdkPatch(JSON.parse('{"id":"gjc-sdk-lifecycle-v1"}')), false);
  assert.equal(isVerifiedSdkPatch(null), false);
});

test('matching top-level hashes do not certify a different SDK-nested core instance', async (t) => {
  const f = fixture(t);
  const nested = path.join(f.root, 'coding-agent/node_modules/@gajae-code/agent-core');
  f.files.set(path.join(nested, 'package.json'), JSON.stringify({ name: '@gajae-code/agent-core', version: '0.16.4' }));
  const original = f.bun.resolveSync;
  f.bun.resolveSync = (name: string, from?: string) => name === '@gajae-code/agent-core' && from?.includes('coding-agent')
    ? path.join(nested, 'index.ts') : original(name);
  await assert.rejects(verifyRuntimeManifest(), { message: 'GJC runtime manifest validation failed.' });
});
