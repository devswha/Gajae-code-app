#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream as makeReadStream, readFileSync as readUtf8File } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SERVER_PACKAGE_NAME } from '../../shared/productIdentity.js';
import { isolatedQaEnvironment } from '../start-isolated-dev.mjs';

import { describeDistributionExclusions, removeExcludedDistributionPackages } from './distribution-exclusions.mjs';
import { withOutOfTreeCopy } from './out-of-tree.mjs';

const TARGET_NODE_MAJOR = 22;
const TARGET_NODE_VERSION = [22, 22, 2];
const TARGET_GLIBC_VERSION = [2, 35, 0];
const TARGET_PLATFORM = 'linux';
const TARGET_ARCH = 'x64';
const NATIVE_MODULES = ['better-sqlite3', 'node-pty'];
const BUN_VERSION = '1.4.0';
const GJC_SDK_PACKAGE = '@gajae-code/coding-agent';
const GJC_NATIVES_PACKAGE = '@gajae-code/natives';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');

/**
 * The runtime versions are pinned once, in the manifest `fill:runtime-manifest`
 * generates from the installed runtime and the server verifies at boot. A
 * literal here would silently go stale on the next SDK bump and break the
 * release lane instead of catching real drift.
 */
const runtimeManifest = JSON.parse(
  readUtf8File(path.join(rootDir, 'server', 'gjc-runtime-manifest.json'), 'utf8'),
);
const GJC_RUNTIME_VERSIONS = {
  [GJC_SDK_PACKAGE]: runtimeManifest.gjcSdk,
  [GJC_NATIVES_PACKAGE]: runtimeManifest.natives,
};
for (const [packageName, version] of Object.entries(GJC_RUNTIME_VERSIONS)) {
  if (!/^\d+\.\d+\.\d+/u.test(version || '')) {
    throw new Error(`server/gjc-runtime-manifest.json does not pin an exact ${packageName} version.`);
  }
}
const GJC_SDK_VERSION = GJC_RUNTIME_VERSIONS[GJC_SDK_PACKAGE];

function versionParts(input) {
  const matched = /^(\d+)\.(\d+)(?:\.(\d+))?/u.exec(input ?? '');
  if (!matched) return null;
  return matched.slice(1).map((part) => Number(part ?? 0));
}

function meetsMinimumVersion(candidate, floor) {
  for (let index = 0; index < floor.length; index += 1) {
    if (candidate[index] !== floor[index]) return candidate[index] > floor[index];
  }
  return true;
}

function assertTargetEnvironment() {
  if (process.platform !== TARGET_PLATFORM) {
    throw new Error(`Server bundles must be built on ${TARGET_PLATFORM}; received ${process.platform}.`);
  }
  if (process.arch !== TARGET_ARCH) {
    throw new Error(`Server bundles must be built for ${TARGET_ARCH}; received ${process.arch}.`);
  }

  const nodeVersion = versionParts(process.versions.node);
  if (
    !nodeVersion ||
    nodeVersion[0] !== TARGET_NODE_MAJOR ||
    !meetsMinimumVersion(nodeVersion, TARGET_NODE_VERSION)
  ) {
    throw new Error(
      `Server bundles require Node.js ${TARGET_NODE_VERSION.join('.')} or newer within the ${TARGET_NODE_MAJOR}.x line; received ${process.versions.node}.`,
    );
  }

  const glibcVersion = process.report?.getReport?.().header?.glibcVersionRuntime;
  const parsedGlibcVersion = versionParts(glibcVersion);
  if (
    !parsedGlibcVersion ||
    parsedGlibcVersion[0] !== TARGET_GLIBC_VERSION[0] ||
    parsedGlibcVersion[1] !== TARGET_GLIBC_VERSION[1]
  ) {
    throw new Error(
      `Server bundles must be built on glibc ${TARGET_GLIBC_VERSION.slice(0, 2).join('.')} exactly; received ${glibcVersion || 'unknown'}.`,
    );
  }
}

function sourceDateEpoch() {
  const value = process.env.SOURCE_DATE_EPOCH;
  if (value === undefined) return '0';
  if (!/^\d+$/.test(value)) {
    throw new Error('SOURCE_DATE_EPOCH must be a non-negative integer number of seconds.');
  }
  return value;
}

function execute(command, args, { collectOutput = false, ...launchOptions } = {}) {
  return new Promise((complete, fail) => {
    const subprocess = spawn(command, args, {
      stdio: collectOutput ? ['ignore', 'pipe', 'inherit'] : 'inherit',
      ...launchOptions
    });
    let output;
    if (collectOutput) {
      output = '';
      subprocess.stdout.setEncoding('utf8');
      subprocess.stdout.on('data', (chunk) => { output += chunk; });
    }
    subprocess.once('error', fail);
    subprocess.once('exit', (code) => {
      if (code === 0) {
        complete(output);
        return;
      }
      fail(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

async function isElfFile(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const magic = Buffer.alloc(4);
    const { bytesRead } = await handle.read(magic, 0, magic.length, 0);
    return bytesRead === 4 && magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  } finally {
    await handle.close();
  }
}

async function collectElfFiles(directory) {
  const files = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectElfFiles(entryPath));
    } else if (entry.isFile() && await isElfFile(entryPath)) {
      files.push(entryPath);
    }
  }
  return files;
}
async function collectGjcNativesElfFiles(stageDir) {
  const packageScope = path.join(stageDir, 'node_modules', '@gajae-code');
  const entries = await fs.readdir(packageScope, { withFileTypes: true });
  const elfFiles = [];
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith('natives-')) {
      elfFiles.push(...await collectElfFiles(path.join(packageScope, entry.name)));
    }
  }
  return elfFiles;
}

async function auditGlibcRequirements(stageDir) {
  const corePath = path.join(stageDir, 'dist-native', 'gajae-core');
  const bunPath = path.join(stageDir, 'dist-native', 'bun');
  const elfFiles = [];
  for (const moduleName of NATIVE_MODULES) {
    elfFiles.push(...await collectElfFiles(path.join(stageDir, 'node_modules', moduleName)));
  }
  elfFiles.push(...await collectGjcNativesElfFiles(stageDir));
  if (!(await isElfFile(corePath))) {
    throw new Error('dist-native/gajae-core is not a Linux ELF executable.');
  }
  if (!(await isElfFile(bunPath))) {
    throw new Error('dist-native/bun is not a Linux ELF executable.');
  }
  elfFiles.push(corePath, bunPath);
  for (const filePath of elfFiles) {
    const versionInfo = await execute('readelf', ['--version-info', '--wide', filePath], { collectOutput: true });
    for (const match of versionInfo.matchAll(/\bGLIBC_(\d+)\.(\d+)(?:\.(\d+))?\b/gu)) {
      const required = [Number(match[1]), Number(match[2]), Number(match[3] || 0)];
      if (!meetsMinimumVersion(TARGET_GLIBC_VERSION, required)) {
        throw new Error(
          `${path.relative(stageDir, filePath)} requires GLIBC_${required.join('.')}, newer than the supported ${TARGET_GLIBC_VERSION.slice(0, 2).join('.')} floor.`,
        );
      }
    }
  }
  console.log(`Audited glibc symbol requirements for ${elfFiles.length} produced native files.`);
}

async function canAccess(filePath) {
  return fs.access(filePath).then(
    () => true,
    () => false,
  );
}
function assertGjcSdkProductionDependency(packageJson) {
  if (packageJson.dependencies?.[GJC_SDK_PACKAGE] !== GJC_SDK_VERSION) {
    throw new Error(`${GJC_SDK_PACKAGE}@${GJC_SDK_VERSION} must be an exact production dependency.`);
  }
}

async function assertInstalledGjcSdkDependencies(stageDir) {
  for (const [packageName, expectedVersion] of Object.entries(GJC_RUNTIME_VERSIONS)) {
    let installedPackage;
    try {
      installedPackage = JSON.parse(await fs.readFile(
        path.join(stageDir, 'node_modules', packageName, 'package.json'),
        'utf8',
      ));
    } catch {
      throw new Error(`Production installation is missing ${packageName}@${expectedVersion}.`);
    }
    if (installedPackage.version !== expectedVersion) {
      throw new Error(`Production installation must resolve ${packageName}@${expectedVersion}.`);
    }
  }
}

async function assertBundledBun(directory) {
  const bunPath = path.join(directory, 'dist-native', 'bun');
  let version;
  try {
    version = (await execute(bunPath, ['--version'], { collectOutput: true })).trim();
  } catch {
    throw new Error(`dist-native/bun must be an executable Bun ${BUN_VERSION} binary.`);
  }
  if (version !== BUN_VERSION) {
    throw new Error(`dist-native/bun must report Bun ${BUN_VERSION}.`);
  }
}

async function validateRequiredInputs(relativePaths) {
  const missing = [];
  for (const relativePath of relativePaths) {
    if (!(await canAccess(path.join(rootDir, relativePath)))) {
      missing.push(relativePath);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Required server bundle inputs are missing: ${missing.join(', ')}`);
  }
}

async function stageRequiredInput(stageDir, relativePath, sourceRoot = rootDir) {
  await fs.cp(
    path.join(sourceRoot, relativePath),
    path.join(stageDir, relativePath),
    { recursive: true },
  );
}

/**
 * Source maps are a build-time debugging aid; shipping them only exposes the
 * original TypeScript layout to anyone who unpacks the bundle.
 */
async function pruneSourceMaps(directory) {
  let removed = 0;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      removed += await pruneSourceMaps(entryPath);
    } else if (entry.isFile() && entry.name.endsWith('.map')) {
      await fs.rm(entryPath);
      removed += 1;
    }
  }
  return removed;
}

export async function writeInstallPackageJson(stageDir, packageJson) {
  const installManifest = {
    ...packageJson,
    scripts: Object.fromEntries(['postinstall', 'apply:sdk-patch', 'check:sdk-patch', 'apply:extract-zip-patch', 'check:extract-zip-patch'].map(name => {
      const command = packageJson.scripts?.[name];
      if (typeof command !== 'string' || !command) throw new Error(`Missing required SDK installation script: ${name}`);
      return [name, command];
    })),
  };
  const manifestPath = path.join(stageDir, 'package.json');
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify(installManifest, null, 2)}\n`,
    'utf8',
  );
}

export async function writeRuntimePackageJson(stageDir, packageJson) {
  const runtimePackageJson = {
    name: SERVER_PACKAGE_NAME,
    version: packageJson.version,
    private: true,
    description: 'Gajae Code App server runtime',
    type: 'module',
    main: 'dist-server/server/index.js',
    bin: {
      'gajae-app': 'scripts/gajae-app-runtime.mjs',
    },
    engines: {
      node: '>=22.22.2 <23',
    },
    scripts: {
      start: 'node scripts/gajae-app-runtime.mjs start',
      'check:sdk-patch': packageJson.scripts['check:sdk-patch'],
      'check:extract-zip-patch': packageJson.scripts['check:extract-zip-patch'],
    },
    dependencies: packageJson.dependencies,
    license: packageJson.license,
  };
  await fs.writeFile(
    path.join(stageDir, 'package.json'),
    `${JSON.stringify(runtimePackageJson, null, 2)}\n`,
    'utf8',
  );
}


function calculateSha256(filePath) {
  return new Promise((complete, fail) => {
    const digest = createHash('sha256');
    const input = makeReadStream(filePath);
    input.on('data', (chunk) => digest.update(chunk));
    input.on('end', () => complete(digest.digest('hex')));
    input.on('error', fail);
  });
}

async function smokeNativeRuntime(stageDir) {
  const smokeSource = `
    import { constants } from 'node:fs';
    import { access, mkdir } from 'node:fs/promises';
    import { createRequire } from 'node:module';
    import { spawnSync, spawn } from 'node:child_process';

    import path from 'node:path';
    const require = createRequire(import.meta.url);
    const Database = require('better-sqlite3');
    const pty = require('node-pty');
    const { rgPath } = require('@vscode/ripgrep');

    const database = new Database(':memory:');
    const result = database.prepare('SELECT 22 AS value').get();
    database.close();
    if (result.value !== 22) throw new Error('better-sqlite3 query failed.');


    await access(rgPath, constants.X_OK);
    const ripgrep = spawnSync(rgPath, ['--version'], { encoding: 'utf8' });
    if (ripgrep.status !== 0) throw new Error('ripgrep failed to start.');

    const corePath = path.join(process.cwd(), 'dist-native', 'gajae-core');
    await access(corePath, constants.X_OK);
    const core = spawnSync(corePath, ['--version'], { encoding: 'utf8' });
    if (core.status !== 0 || !core.stdout.startsWith('gajae-core ')) {
      throw new Error('gajae-core failed to start.');
    }

    const bunPath = path.join(process.cwd(), 'dist-native', 'bun');
    await access(bunPath, constants.X_OK);
    const bun = spawnSync(bunPath, ['--version'], { encoding: 'utf8' });
    if (bun.status !== 0 || bun.stdout.trim() !== '${BUN_VERSION}') {
      throw new Error('Bun failed to start with the required version.');
    }
    const smokeAgentDir = path.join(process.cwd(), '.gjc-smoke-agent');
    await mkdir(smokeAgentDir, { recursive: true });
    await new Promise((resolve, reject) => {
      const worker = spawn(bunPath, [path.join(process.cwd(), 'dist-server', 'server', 'gjc-bun-worker.js')], {
        env: { ...process.env, GJC_WORKER_AGENT_DIR: smokeAgentDir },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let initialized = false;
      let shutdownResponses = 0;
      const timeout = setTimeout(() => {
        worker.kill();
        reject(new Error('staged Bun worker timed out: ' + stderr));
      }, 30_000);
      const fail = (error) => {
        clearTimeout(timeout);
        worker.kill();
        reject(error);
      };
      worker.stdout.setEncoding('utf8');
      worker.stderr.setEncoding('utf8');
      worker.stdout.on('data', (chunk) => {
        stdout += chunk;
        const lines = stdout.split('\\n');
        stdout = lines.pop();
        try {
          for (const line of lines) {
            if (!line) continue;
            const frame = JSON.parse(line);
            if (frame.kind === 'response' && frame.id === 'stage-init') {
              if (initialized || frame.payload?.ok !== true) {
                throw new Error('staged Bun worker rejected initialization.');
              }
              initialized = true;
              worker.stdin.write(JSON.stringify({
                protocolVersion: 1,
                kind: 'request',
                id: 'stage-shutdown',
                method: 'worker.shutdown',
                payload: {},
              }) + '\\n');
              worker.stdin.end();
            } else if (frame.kind === 'response' && frame.id === 'stage-shutdown') {
              if (frame.payload?.ok !== true || ++shutdownResponses !== 1) {
                throw new Error('staged Bun worker rejected shutdown.');
              }
            }
          }
        } catch (error) {
          fail(error);
        }
      });
      worker.stderr.on('data', (chunk) => { stderr += chunk; });
      worker.once('error', fail);
      worker.once('close', (code) => {
        clearTimeout(timeout);
        if (code === 0 && initialized && shutdownResponses === 1 && !stderr) resolve();
        else reject(new Error('staged Bun worker exited with code ' + code + ': ' + stderr));
      });
      worker.stdin.write(JSON.stringify({
        protocolVersion: 1,
        kind: 'request',
        id: 'stage-init',
        method: 'worker.initialize',
        payload: {},
      }) + '\\n');
    });

    await new Promise((resolve, reject) => {
      const terminal = pty.spawn(process.execPath, ['-e', 'process.exit(0)'], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: process.env,
      });
      const timeout = setTimeout(() => {
        terminal.kill();
        reject(new Error('node-pty child timed out.'));
      }, 5_000);
      terminal.onExit(({ exitCode }) => {
        clearTimeout(timeout);
        if (exitCode === 0) resolve();
        else reject(new Error(\`node-pty child exited with code \${exitCode}.\`));
      });
    });
  `;
  // Smoked from a copy outside the checkout: under release/server/ the stage
  // would resolve anything it lacks from the repository's node_modules, and a
  // package the build removed (see distribution-exclusions.mjs) would pass
  // here and fail on the user's machine. The copy also keeps the smoke's
  // `.gjc-smoke-agent` scratch directory out of the archive.
  await withOutOfTreeCopy(stageDir, 'server bundle stage', async (copyDir) => {
    console.log(`Smoking the staged runtime from ${copyDir} (outside the repository tree).`);
    const qaHome = path.join(copyDir, '.smoke-home');
    await fs.mkdir(qaHome, { recursive: true });
    const env = isolatedQaEnvironment({ parentEnv: process.env, qaHome, host: '127.0.0.1', serverPort: 3001, vitePort: 5173, remote: false });
    await execute(process.execPath, ['scripts/apply-sdk-lifecycle-patch.mjs', '--check'], { cwd: copyDir, env });
    await execute(process.execPath, ['scripts/apply-extract-zip-patch.mjs', '--check'], { cwd: copyDir, env });
    await execute(process.execPath, ['--input-type=module', '--eval', smokeSource], { cwd: copyDir, env });
  });
}

async function createDeterministicArchive(stageDir, archivePath, epoch) {
  const tarPath = archivePath.slice(0, -3);
  await fs.rm(tarPath, { force: true });
  await fs.rm(archivePath, { force: true });

  await execute('tar', [
    '--format=gnu',
    '--sort=name',
    `--mtime=@${epoch}`,
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    '--mode=ugo+rwX,go-w',
    '-cf',
    tarPath,
    '-C',
    stageDir,
    '.',
  ]);
  await execute('gzip', ['--no-name', '--force', tarPath]);
}

export const SERVER_BUNDLE_INPUTS = [
  'dist',
  'dist-server',
  'dist-native',
  'public',
  'shared',
  'package-lock.json',
  'scripts/fix-node-pty.js',
  'scripts/gajae-app-runtime.mjs',
  'scripts/apply-sdk-lifecycle-patch.mjs',
  'patches/gjc-sdk-lifecycle/manifest.json',
  'scripts/apply-extract-zip-patch.mjs',
  'patches/extract-zip-symlink-leaf/manifest.json',
  'packaging/systemd/gajae-app.service',
  'docs/SELF-HOST.md',
  'docs/INSTALL.md',
  'docker/gjc/Dockerfile',
  'docker/shared/install-gajae-app.sh',
  'docker/shared/start-gajae-app.sh',
  'LICENSE',
  'NOTICE',
  // License notices come from the locked production tree, rather than an
  // approximation of it. Keeping the generated record beside the shipped
  // modules makes the bundle independently auditable.
  'THIRD-PARTY-NOTICES.md',
];

function bundleLocations(version) {
  const bundleName = `gajae-app-server-${version}-linux-x64-node22.tar.gz`;
  const bundleRoot = path.join(rootDir, 'release', 'server');
  const archivePath = path.join(bundleRoot, bundleName);
  return {
    bundleName,
    bundleRoot,
    archivePath,
    checksumPath: `${archivePath}.sha256`,
    stageDir: path.join(bundleRoot, `.stage-${version}`),
  };
}

function npmEnvironment(additions = {}) {
  return {
    ...process.env,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    ...additions,
  };
}

async function prepareBundleStage(locations) {
  await validateRequiredInputs(SERVER_BUNDLE_INPUTS);
  await fs.mkdir(locations.bundleRoot, { recursive: true });
  await fs.rm(locations.stageDir, { recursive: true, force: true });
  await fs.rm(locations.archivePath, { force: true });
  await fs.rm(locations.checksumPath, { force: true });
  await fs.mkdir(locations.stageDir, { recursive: true });
}

export async function stageBundleFiles(stageDir, packageJson, sourceRoot = rootDir) {
  for (const relativePath of SERVER_BUNDLE_INPUTS) {
    await stageRequiredInput(stageDir, relativePath, sourceRoot);
  }
  for (const readme of ['patches/gjc-sdk-lifecycle/README.md', 'patches/extract-zip-symlink-leaf/README.md']) {
    if (await canAccess(path.join(sourceRoot, readme))) await stageRequiredInput(stageDir, readme, sourceRoot);
  }
  const prunedSourceMaps = await pruneSourceMaps(path.join(stageDir, 'dist-server'));
  console.log(`Pruned ${prunedSourceMaps} source map files from dist-server.`);
  await writeInstallPackageJson(stageDir, packageJson);
}

export async function installStageDependencies(stageDir, { run = execute, verifyVersions = assertInstalledGjcSdkDependencies } = {}) {
  console.log('Installing production server dependencies into bundle stage...');
  await run('npm', ['ci', '--omit=dev'], {
    cwd: stageDir,
    env: npmEnvironment(),
  });
  await run(process.execPath, ['scripts/apply-sdk-lifecycle-patch.mjs', '--check'], { cwd: stageDir, env: npmEnvironment() });
  await run(process.execPath, ['scripts/apply-extract-zip-patch.mjs', '--check'], { cwd: stageDir, env: npmEnvironment() });
  await verifyVersions(stageDir);
}

async function excludeDistributionPackages(stageDir) {
  // This applies the shared distribution policy after npm has resolved the
  // complete production tree. The desktop payload follows the same policy.
  const exclusions = await removeExcludedDistributionPackages(
    fs,
    path,
    path.join(stageDir, 'node_modules'),
  );
  console.log(describeDistributionExclusions(exclusions));
}

async function rebuildStageNatives(stageDir) {
  console.log(`Rebuilding ${NATIVE_MODULES.join(', ')} from source for Node.js ${TARGET_NODE_MAJOR}...`);
  await execute('npm', ['rebuild', '--omit=dev', '--build-from-source', ...NATIVE_MODULES], {
    cwd: stageDir,
    env: npmEnvironment({ npm_config_build_from_source: 'true' }),
  });
  await execute(process.execPath, ['scripts/fix-node-pty.js'], { cwd: stageDir });
  await auditGlibcRequirements(stageDir);
  await smokeNativeRuntime(stageDir);
}

async function finalizeStageMetadata(stageDir, packageJson) {
  // The staging manifest only exists to drive npm; the archive exposes the
  // constrained runtime entrypoint instead.
  await fs.rm(path.join(stageDir, 'package-lock.json'), { force: true });
  await fs.rm(path.join(stageDir, 'scripts', 'fix-node-pty.js'), { force: true });
  await fs.chmod(path.join(stageDir, 'scripts', 'gajae-app-runtime.mjs'), 0o755);
  await fs.chmod(path.join(stageDir, 'dist-native', 'bun'), 0o755);
  await writeRuntimePackageJson(stageDir, packageJson);
}

async function writeBundleArchive(locations) {
  await createDeterministicArchive(locations.stageDir, locations.archivePath, sourceDateEpoch());
  const digest = await calculateSha256(locations.archivePath);
  await fs.writeFile(locations.checksumPath, `${digest}  ${locations.bundleName}\n`, 'utf8');
}

async function reportBundleOutput(locations) {
  const size = (await fs.stat(locations.archivePath)).size / 1024 / 1024;
  console.log(`Wrote ${path.relative(rootDir, locations.archivePath)} (${size.toFixed(1)} MB)`);
  console.log(`Wrote ${path.relative(rootDir, locations.checksumPath)}`);
}

async function removePartialBundle(locations) {
  await fs.rm(locations.archivePath, { force: true });
  await fs.rm(locations.checksumPath, { force: true });
}

async function loadBundlePackageJson() {
  const packageJson = JSON.parse(
    await fs.readFile(path.join(rootDir, 'package.json'), 'utf8'),
  );
  assertGjcSdkProductionDependency(packageJson);
  await assertBundledBun(rootDir);
  return packageJson;
}

async function assembleBundle(stageDir, packageJson, locations) {
  await stageBundleFiles(stageDir, packageJson);
  await installStageDependencies(stageDir);
  await excludeDistributionPackages(stageDir);
  await rebuildStageNatives(stageDir);
  await finalizeStageMetadata(stageDir, packageJson);
  await writeBundleArchive(locations);
}


async function buildServerBundle() {
  assertTargetEnvironment();
  const packageJson = await loadBundlePackageJson();
  const locations = bundleLocations(packageJson.version);
  await prepareBundleStage(locations);

  try {
    await assembleBundle(locations.stageDir, packageJson, locations);
  } catch (error) {
    await removePartialBundle(locations);
    throw error;
  } finally {
    await fs.rm(locations.stageDir, { recursive: true, force: true });
  }

  await reportBundleOutput(locations);
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) await buildServerBundle();
