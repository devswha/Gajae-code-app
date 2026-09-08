import { isAbsolute, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import sdkPolicy from '../shared/sdkLifecyclePolicy.json' with { type: 'json' };

import manifest from './gjc-runtime-manifest.json' with { type: 'json' };

type RuntimeManifestFile = {
  package: string;
  path: string;
  sha256: string;
};

type RuntimeManifestPlatform = {
  files: RuntimeManifestFile[];
};

type RuntimeManifest = {
  schemaVersion: number;
  gjcSdk: string;
  bun: string;
  natives: string;
  platforms: Record<string, RuntimeManifestPlatform>;
  sdkLifecycle: {
    id: string;
    packages: Record<string, string>;
    files: RuntimeManifestFile[];
  };
};

const sdkLifecycleProofs = new WeakSet<object>();
declare const verifiedSdkPatchBrand: unique symbol;
/** Source-integrity evidence only, NOT complete SDK quiescence or installation authority. */
export type VerifiedSdkPatch = Readonly<{ id: string; [verifiedSdkPatchBrand]: true }>;
export function isVerifiedSdkPatch(value: unknown): value is VerifiedSdkPatch {
  return typeof value === 'object' && value !== null && sdkLifecycleProofs.has(value);
}

type BunRuntime = {
  version: string;
  resolveSync(specifier: string, from: string): string;
  file(path: string): { arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> };
};

type PackageMetadata = { name?: unknown; version?: unknown };

const RUNTIME_MANIFEST_FAILURE = 'GJC runtime manifest validation failed.';
const SHA256 = /^[a-f0-9]{64}$/;
const resolverFrom = fileURLToPath(new URL('.', import.meta.url));
const SDK_PACKAGES = new Set(['@gajae-code/coding-agent', '@gajae-code/agent-core', '@gajae-code/ai']);
const REQUIRED_SDK_PACKAGES = ['@gajae-code/coding-agent', '@gajae-code/agent-core'];

function validSdkLifecycle(value: unknown): value is RuntimeManifest['sdkLifecycle'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const patch = value as RuntimeManifest['sdkLifecycle'];
  if (Object.keys(patch).length !== 3 || typeof patch.id !== 'string' || !/^[a-z][a-z0-9-]{0,127}$/u.test(patch.id)
    || !patch.packages || typeof patch.packages !== 'object' || Array.isArray(patch.packages)
    || Object.keys(patch.packages).length < REQUIRED_SDK_PACKAGES.length || Object.keys(patch.packages).length > SDK_PACKAGES.size
    || REQUIRED_SDK_PACKAGES.some((name) => !Object.hasOwn(patch.packages, name))
    || Object.entries(patch.packages).some(([name, version]) => !SDK_PACKAGES.has(name) || typeof version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(version))
    || sdkPolicy.schemaVersion !== 1 || !Number.isSafeInteger(sdkPolicy.maxFiles) || sdkPolicy.maxFiles < 1 || sdkPolicy.maxFiles > 128
    || !Array.isArray(patch.files) || !patch.files.length || patch.files.length > sdkPolicy.maxFiles) return false;
  const seen = new Set<string>();
  for (const file of patch.files) {
    if (!file || typeof file !== 'object' || Object.keys(file).length !== 3
      || !Object.hasOwn(patch.packages, file.package) || typeof file.path !== 'string'
      || !/^src\/[A-Za-z0-9._/-]+\.ts$/u.test(file.path)
      || file.path.split('/').some((part) => !part || part === '.' || part === '..') || !SHA256.test(file.sha256)) return false;
    const key = `${file.package}/${file.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return Object.keys(patch.packages).every((name) => patch.files.some((file) => file.package === name));
}

function validFile(file: unknown): file is RuntimeManifestFile {
  return typeof file === 'object'
    && file !== null
    && typeof (file as RuntimeManifestFile).package === 'string'
    && typeof (file as RuntimeManifestFile).path === 'string'
    && (file as RuntimeManifestFile).path.startsWith('native/')
    && !(file as RuntimeManifestFile).path.includes('..')
    && SHA256.test((file as RuntimeManifestFile).sha256);
}

async function runtimeManifest(bun: BunRuntime): Promise<RuntimeManifest | null> {
  let value: unknown = manifest;
  const overrideAllowed = process.env.GJC_ALLOW_RUNTIME_MANIFEST_OVERRIDE;
  const overridePath = process.env.GJC_RUNTIME_MANIFEST_PATH;
  if (overrideAllowed === '1') {
    console.error('GJC runtime manifest override enabled.');
    if (!overridePath || !isAbsolute(overridePath)) return null;
    try {
      value = JSON.parse(await bun.file(overridePath).text());
    } catch {
      return null;
    }
  }
  return typeof value === 'object'
    && value !== null
    && (value as RuntimeManifest).schemaVersion === 2
    && typeof (value as RuntimeManifest).gjcSdk === 'string'
    && typeof (value as RuntimeManifest).bun === 'string'
    && typeof (value as RuntimeManifest).natives === 'string'
    && typeof (value as RuntimeManifest).platforms === 'object'
    && (value as RuntimeManifest).platforms !== null
    && Object.values((value as RuntimeManifest).platforms).every((platform) => Array.isArray(platform.files) && platform.files.every(validFile))
    && validSdkLifecycle((value as RuntimeManifest).sdkLifecycle)
    ? value as RuntimeManifest
    : null;
}

function bunRuntime(): BunRuntime | null {
  const candidate = (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun;
  return candidate
    && typeof candidate.version === 'string'
    && typeof candidate.resolveSync === 'function'
    && typeof candidate.file === 'function'
    ? candidate
    : null;
}

async function packageMetadata(bun: BunRuntime, packageRoot: string): Promise<PackageMetadata | null> {
  try {
    const metadata = JSON.parse(await bun.file(join(packageRoot, 'package.json')).text()) as PackageMetadata;
    return metadata && typeof metadata === 'object' ? metadata : null;
  } catch {
    return null;
  }
}

async function packageRoot(bun: BunRuntime, specifier: string, from = resolverFrom): Promise<string | null> {
  const resolved = bun.resolveSync(specifier, from);
  let directory = dirname(resolved);
  while (directory !== dirname(directory)) {
    const metadata = await packageMetadata(bun, directory);
    if (metadata?.name === specifier) return directory;
    directory = dirname(directory);
  }
  return null;
}

async function sha256Hex(bun: BunRuntime, path: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await bun.file(path).arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Verifies the pinned Bun runtime and installed GJC packages before starting a Bun worker.
 * This module remains importable in Node; only this function requires Bun globals.
 */
export async function verifyRuntimeManifest(): Promise<VerifiedSdkPatch | undefined> {
  try {
    const bun = bunRuntime();
    const expected = bun ? await runtimeManifest(bun) : null;
    const platform = `${process.platform}-${process.arch}`;
    if (!expected || !bun) throw new Error();
    if (bun.version !== expected.bun) throw new Error();

    const [sdkRoot, nativesRoot] = await Promise.all([
      packageRoot(bun, '@gajae-code/coding-agent'),
      packageRoot(bun, '@gajae-code/natives'),
    ]);
    if (!sdkRoot || !nativesRoot) throw new Error();

    const [sdk, natives] = await Promise.all([
      packageMetadata(bun, sdkRoot),
      packageMetadata(bun, nativesRoot),
    ]);
    if (sdk?.version !== expected.gjcSdk || natives?.version !== expected.natives) throw new Error();

    const closure = expected.platforms[platform];
    const platformRoot = join(dirname(nativesRoot), `natives-${platform}`);
    const platformPackage = await packageMetadata(bun, platformRoot);
    if (!closure || platformPackage?.name !== `@gajae-code/natives-${platform}`
      || platformPackage.version !== expected.natives || closure.files.length === 0) {
      throw new Error();
    }

    for (const file of closure.files) {
      const root = file.package === '@gajae-code/natives'
        ? nativesRoot
        : file.package === `@gajae-code/natives-${platform}`
        ? platformRoot
        : null;
      if (!root || await sha256Hex(bun, join(root, file.path)) !== file.sha256) throw new Error();
    }
    const sdkRoots = new Map<string, string>([['@gajae-code/coding-agent', sdkRoot]]);
    for (const [name, version] of Object.entries(expected.sdkLifecycle.packages)) {
      const root = sdkRoots.get(name) ?? await packageRoot(bun, name);
      if (!root || (await packageMetadata(bun, root))?.version !== version) throw new Error();
      sdkRoots.set(name, root);
    }
    // The application and the SDK/core must load the same patched instances.
    // A matching top-level copy cannot certify an unpatched nested dependency.
    for (const [consumer, dependencies] of [
      ['@gajae-code/coding-agent', ['@gajae-code/agent-core', '@gajae-code/ai']],
      ['@gajae-code/agent-core', ['@gajae-code/ai']],
    ] as const) {
      const consumerRoot = sdkRoots.get(consumer);
      if (!consumerRoot) throw new Error();
      for (const dependency of dependencies) {
        if (!sdkRoots.has(dependency)) continue;
        if (await packageRoot(bun, dependency, join(consumerRoot, 'src')) !== sdkRoots.get(dependency)) throw new Error();
      }
    }
    if (expected.sdkLifecycle.packages['@gajae-code/coding-agent'] !== expected.gjcSdk) throw new Error();
    for (const file of expected.sdkLifecycle.files) {
      const root = sdkRoots.get(file.package);
      if (!root || await sha256Hex(bun, join(root, file.path)) !== file.sha256) throw new Error();
    }
    // Test overrides may exercise native closure rejection, but cannot grant
    // production lifetime evidence for arbitrary alternate SDK implementations.
    if (process.env.GJC_ALLOW_RUNTIME_MANIFEST_OVERRIDE === '1') return undefined;
    const proof = Object.freeze({ id: expected.sdkLifecycle.id }) as VerifiedSdkPatch;
    sdkLifecycleProofs.add(proof);
    return proof;
  } catch {
    throw new Error(RUNTIME_MANIFEST_FAILURE);
  }
}
