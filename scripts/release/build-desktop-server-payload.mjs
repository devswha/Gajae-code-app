#!/usr/bin/env node
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeDistributionExclusions, removeExcludedDistributionPackages, removeNonAsciiPaths } from './distribution-exclusions.mjs';
import { withOutOfTreeCopy } from './out-of-tree.mjs';
import { DESKTOP_NODE_VERSION, desktopPlatform } from './desktop-platforms.mjs';
import { pruneForeignPrebuilds } from './desktop-prebuilds.mjs';
import { smokeEnvironment } from './packaged-server-paths.mjs';

let desktop;
const NODE_VERSION = DESKTOP_NODE_VERSION;
const BUN_VERSION = '1.4.0';
const NATIVE_MODULES = ['better-sqlite3', 'node-pty'];
const RUNTIME_DEPENDENCIES = [
  '@gajae-code/coding-agent',
  '@puppeteer/browsers',
  '@octokit/rest',
  '@vscode/ripgrep',
  'better-sqlite3',
  'cors',
  'cross-spawn',
  'express',
  'gray-matter',
  'mime-types',
  'multer',
  'node-pty',
  'puppeteer-core',
  'shell-quote',
  'ws',
  'zod',
];
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');
const payloadDir = path.join(rootDir, 'src-tauri', 'resources', 'server-payload');
const sidecarDir = path.join(rootDir, 'src-tauri', 'binaries');
let sidecarPath;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`)));
  });
}

function capture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(`${command} ${args.join(' ')} exited with code ${code}: ${stderr}`)));
  });
}
async function stageSidecar(payloadNode) {
  await fs.mkdir(sidecarDir, { recursive: true });
  await fs.copyFile(payloadNode, sidecarPath);
  await fs.chmod(sidecarPath, 0o755);
  await codesign(sidecarPath);
  if ((await capture(sidecarPath, ['--version'])).trim() !== `v${NODE_VERSION}`) {
    throw new Error('Staged Tauri sidecar Node runtime version verification failed.');
  }
}


async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

async function sha256(filePath) {
  return crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

async function copy(relativePath, sourceRoot = rootDir, destination = payloadDir) {
  await fs.cp(path.join(sourceRoot, relativePath), path.join(destination, relativePath), { recursive: true });
}

export async function restrictRuntimeDependencies(directory = payloadDir) {
  const packagePath = path.join(directory, 'package.json');
  const lockPath = path.join(directory, 'package-lock.json');
  const packageJson = JSON.parse(await fs.readFile(packagePath, 'utf8'));
  const packageLock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  const dependencies = {};

  for (const dependency of RUNTIME_DEPENDENCIES) {
    const declaredVersion = packageJson.dependencies?.[dependency];
    const lockedVersion = packageLock.packages?.[`node_modules/${dependency}`]?.version;
    if (!declaredVersion && !lockedVersion) throw new Error(`Runtime dependency is missing from package-lock.json: ${dependency}`);
    dependencies[dependency] = declaredVersion || lockedVersion;
  }

  packageJson.dependencies = dependencies;
  delete packageJson.devDependencies;
  delete packageJson.optionalDependencies;
  // Keep exactly the reviewed install hooks; never stage dev/prepare hooks.
  packageJson.scripts = Object.fromEntries(['postinstall', 'apply:sdk-patch', 'check:sdk-patch'].map(name => {
    const command = packageJson.scripts?.[name];
    if (typeof command !== 'string' || !command) throw new Error(`Missing required SDK installation script: ${name}`);
    return [name, command];
  }));
  await fs.writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

export async function installDesktopPayloadDependencies(payloadNode, npmCli, npmEnvironment, directory = payloadDir, execute = run) {
  await restrictRuntimeDependencies(directory);
  await execute(payloadNode, [npmCli, 'install', '--package-lock-only', '--ignore-scripts', '--omit=dev'], { cwd: directory, env: npmEnvironment });
  await execute(payloadNode, [npmCli, 'ci', '--omit=dev'], { cwd: directory, env: npmEnvironment });
  // An ignored/failed postinstall must not silently produce an unpatched SDK.
  // Resolve the CLI from its stage cwd (as npm does), including /var ->
  // /private/var aliases on macOS; never invoke a checkout-relative fallback.
  await execute(payloadNode, ['scripts/apply-sdk-lifecycle-patch.mjs', '--check'], { cwd: directory, env: npmEnvironment });
  await execute(payloadNode, [npmCli, 'rebuild', '--omit=dev', '--build-from-source', ...NATIVE_MODULES], { cwd: directory, env: { ...npmEnvironment, npm_config_build_from_source: 'true' } });
  await execute(payloadNode, [path.join(directory, 'scripts', 'fix-node-pty.js')], { cwd: directory, env: npmEnvironment });
}

export async function finalizeDesktopPayloadMetadata(directory = payloadDir) {
  await fs.rm(path.join(directory, 'package-lock.json'), { force: true });
  await fs.rm(path.join(directory, 'scripts', 'fix-node-pty.js'), { force: true });
  const packagePath = path.join(directory, 'package.json');
  const packageJson = JSON.parse(await fs.readFile(packagePath, 'utf8'));
  // The immutable payload has no lockfile/reinstall entrypoint. Retain the
  // verifier and evidence, not postinstall hooks pointing at removed tools.
  packageJson.scripts = { 'check:sdk-patch': packageJson.scripts['check:sdk-patch'] };
  await fs.writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

async function pruneNonRuntimeMetadata(directory) {
  let removed = 0;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      removed += await pruneNonRuntimeMetadata(filePath);
    } else if (entry.isFile() && /(?:\.map|\.d\.(?:c|m)?ts)$/.test(entry.name)) {
      await fs.rm(filePath);
      removed += 1;
    }
  }
  return removed;
}

async function downloadPinnedNode() {
  const archiveName = desktop.nodeArchive;
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'gajae-node-download-'));
  try {
    const archive = path.join(temporary, archiveName);
    const response = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/${archiveName}`);
    if (!response.ok || !response.body) throw new Error(`Node download failed with HTTP ${response.status}.`);
    const chunks = [];
    for await (const chunk of response.body) chunks.push(chunk);
    await fs.writeFile(archive, Buffer.concat(chunks), { mode: 0o600 });
    if (await sha256(archive) !== desktop.nodeSha256) throw new Error('Pinned Node archive failed SHA-256 verification.');
    await run('tar', ['-xzf', archive, '-C', payloadDir]);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
  const extracted = path.join(payloadDir, `node-v${NODE_VERSION}-${desktop.nodePlatform}`);
  await fs.rename(extracted, path.join(payloadDir, 'node'));
}

async function required(relativePaths) {
  const missing = [];
  for (const relativePath of relativePaths) if (!(await exists(path.join(rootDir, relativePath)))) missing.push(relativePath);
  if (missing.length) throw new Error(`Missing payload inputs: ${missing.join(', ')}. Run npm run build first.`);
}

async function codesign(filePath) {
  if (process.platform !== 'darwin') return;
  await run('codesign', ['--force', '--sign', '-', '--timestamp=none', filePath]);
}

async function codesignNativeClosure(directory) {
  if (process.platform !== 'darwin') return;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (filePath.includes(`${path.sep}node_modules${path.sep}@gajae-code${path.sep}`)) continue;
      await codesignNativeClosure(filePath);
    } else if (entry.isFile() && (entry.name.endsWith('.node') || ['bun', 'gajae-core', 'node', 'spawn-helper'].includes(entry.name))) await codesign(filePath);
  }
}

async function verifyManifest() {
  const manifest = JSON.parse(await fs.readFile(path.join(payloadDir, 'server', 'gjc-runtime-manifest.json'), 'utf8'));
  const closure = manifest.platforms?.[desktop.key]?.files;
  if (!Array.isArray(closure) || closure.length === 0) throw new Error(`gjc-runtime-manifest is missing the ${desktop.key} native closure.`);
  for (const entry of closure) {
    const filePath = path.join(payloadDir, 'node_modules', entry.package, entry.path);
    if (!(await exists(filePath))) throw new Error(`Missing manifest native payload file: ${entry.package}/${entry.path}`);
    if (await sha256(filePath) !== entry.sha256) throw new Error(`Manifest hash mismatch: ${entry.package}/${entry.path}`);
    if (process.platform === 'darwin' && entry.path.endsWith('.node')) await run('codesign', ['--verify', '--strict', filePath]);
  }
}

async function smoke(payloadNode) {
  const smoke = `
    import { createRequire } from 'node:module';
    import { spawn, spawnSync } from 'node:child_process';
    import path from 'node:path';
    const require = createRequire(import.meta.url);
    const Database = require('better-sqlite3');
    const pty = require('node-pty');
    const database = new Database(':memory:');
    if (database.prepare('SELECT 22 AS value').get().value !== 22) throw new Error('better-sqlite3 smoke failed');
    database.close();
    await new Promise((resolve, reject) => {
      const terminal = pty.spawn(process.execPath, ['-e', 'process.exit(0)'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
      const timer = setTimeout(() => { terminal.kill(); reject(new Error('PTY timed out')); }, 5000);
      terminal.onExit(({ exitCode }) => { clearTimeout(timer); exitCode === 0 ? resolve() : reject(new Error('PTY exited ' + exitCode)); });
    });
    const bun = path.join(process.cwd(), 'dist-native', 'bun');
    if (spawnSync(bun, ['--version'], { encoding: 'utf8' }).stdout.trim() !== '${BUN_VERSION}') throw new Error('Bundled Bun version mismatch');
    const agentDir = process.env.GJC_WORKER_AGENT_DIR;
    await new Promise((resolve, reject) => {
      const worker = spawn(bun, [path.join(process.cwd(), 'dist-server/server/gjc-bun-worker.js')], { env: { ...process.env, GJC_WORKER_AGENT_DIR: agentDir }, stdio: ['pipe', 'pipe', 'pipe'] });
      let buffered = ''; let initialized = false; let shutdown = false; let stderr = '';
      const timer = setTimeout(() => { worker.kill(); reject(new Error('Bun worker timed out: ' + stderr + buffered)); }, 30000);
      const fail = (error) => { clearTimeout(timer); worker.kill(); reject(error); };
      worker.stdout.setEncoding('utf8'); worker.stderr.setEncoding('utf8');
      worker.stderr.on('data', chunk => { stderr += chunk; });
      worker.stdout.on('data', chunk => { buffered += chunk; const lines = buffered.split('\\n'); buffered = lines.pop(); try { for (const line of lines) { if (!line) continue; const frame = JSON.parse(line); if (frame.id === 'init') { if (frame.payload?.ok !== true) throw new Error('Bun worker rejected initialization: ' + JSON.stringify(frame.payload)); initialized = true; worker.stdin.write(JSON.stringify({ protocolVersion: 1, kind: 'request', id: 'shutdown', method: 'worker.shutdown', payload: {} }) + '\\n'); worker.stdin.end(); } else if (frame.id === 'shutdown' && frame.payload?.ok === true) shutdown = true; } } catch (error) { fail(error); } });
      worker.once('error', fail); worker.once('close', code => { clearTimeout(timer); code === 0 && initialized && shutdown && !stderr ? resolve() : reject(new Error('Bun worker handshake failed (exit ' + code + '): ' + stderr)); });
      setTimeout(() => worker.stdin.write(JSON.stringify({ protocolVersion: 1, kind: 'request', id: 'init', method: 'worker.initialize', payload: {} }) + '\\n'), 25);
    });
    const port = 39000 + Math.floor(Math.random() * 1000);
    const server = spawn(process.execPath, ['dist-server/server/index.js'], { env: { ...process.env, PATH: path.dirname(process.execPath) + ':/usr/bin:/bin', SERVER_PORT: String(port), HOST: '127.0.0.1', GJC_WORKER_AGENT_DIR: agentDir }, stdio: ['ignore', 'pipe', 'pipe'] });
    const stopped = new Promise(resolve => server.once('close', resolve));
    let output = ''; server.stdout.setEncoding('utf8'); server.stderr.setEncoding('utf8'); server.stdout.on('data', chunk => { output += chunk; }); server.stderr.on('data', chunk => { output += chunk; });
    try {
      let healthy = false;
      // Match the desktop supervisor's cold-start budget, including first-run
      // SQLite migrations on a busy build host. Fail early if the process exits.
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        if (server.exitCode !== null) throw new Error('Payload server exited before readiness: ' + output);
        try {
          const response = await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(2000) });
          const health = await response.json();
          if (response.ok && health.status === 'ok' && health.product === 'gajae-app' && health.protocolVersion === 1) { healthy = true; break; }
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!healthy) throw new Error('Payload health check failed: ' + output);
    } finally { server.kill('SIGTERM'); await stopped; }
  `;
  // The payload is smoked from a copy outside this checkout. In place, under
  // src-tauri/, Bun and Node would fall back on the repository's node_modules
  // for anything the payload lacks and the run would prove nothing about the
  // shipped tree - that is how the `elkjs` exclusion broke the worker in a
  // notarized DMG while every in-tree smoke passed.
  const buildOnlyNode = path.join(payloadDir, 'node');
  await withOutOfTreeCopy(payloadDir, `${desktop.label} server payload`, async (copyDir) => {
    console.log(`Smoking the payload from ${copyDir} (outside the repository tree).`);
    const smokeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gajae-payload-home-'));
    try {
      const env = smokeEnvironment({ command: payloadNode, cwd: copyDir }, smokeHome);
      for (const directory of [path.join(smokeHome, 'bin'), env.TMPDIR, env.GJC_WORKER_AGENT_DIR]) {
        await fs.mkdir(directory, { recursive: true });
      }
      await fs.symlink(payloadNode, path.join(smokeHome, 'bin', 'node'));
      await run(payloadNode, ['scripts/apply-sdk-lifecycle-patch.mjs', '--check'], { cwd: copyDir, env });
      await run(payloadNode, ['--input-type=module', '--eval', smoke], {
        cwd: copyDir,
        env,
      });
    } finally {
      await fs.rm(smokeHome, { recursive: true, force: true });
    }
  }, { filter: (source) => source !== buildOnlyNode && !source.startsWith(`${buildOnlyNode}${path.sep}`) });
}

export const DESKTOP_PAYLOAD_INPUTS = [
  'dist', 'dist-server', 'shared', 'public', 'server/gjc-runtime-manifest.json',
  'scripts/fix-node-pty.js', 'scripts/gajae-app-runtime.mjs', 'scripts/apply-sdk-lifecycle-patch.mjs',
  'patches/gjc-sdk-lifecycle/manifest.json',
  'package.json', 'package-lock.json', 'dist-native', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md',
];

export async function stageDesktopPayloadFiles(sourceRoot = rootDir, directory = payloadDir) {
  for (const input of DESKTOP_PAYLOAD_INPUTS) await copy(input, sourceRoot, directory);
  const readme = 'patches/gjc-sdk-lifecycle/README.md';
  if (await exists(path.join(sourceRoot, readme))) await copy(readme, sourceRoot, directory);
}

export async function buildDesktopServerPayload() {
  desktop = desktopPlatform();
  sidecarPath = path.join(sidecarDir, `gajae-app-server-${desktop.target}`);
  await required([...DESKTOP_PAYLOAD_INPUTS, 'dist-native/gajae-core', 'dist-native/bun']);
  await fs.rm(payloadDir, { recursive: true, force: true });
  await fs.mkdir(payloadDir, { recursive: true });
  try {
    // LICENSE and NOTICE ship with the payload for the same reason the server
    // tarball carries them: MIT requires the licence text and copyright notice to
    // travel with every copy, and NOTICE carries the origin attribution this
    // project keeps voluntarily. The desktop bundle used to omit both while the
    // tarball included them, so compliance depended on which artifact a user
    // happened to install.
    await stageDesktopPayloadFiles();
    await downloadPinnedNode();
    const payloadNode = path.join(payloadDir, 'node', 'bin', 'node');
    if ((await capture(payloadNode, ['--version'])).trim() !== `v${NODE_VERSION}`) throw new Error('Pinned Node runtime version verification failed.');
    const payloadNodeBin = path.dirname(payloadNode);
    const npmEnvironment = { ...process.env, PATH: `${payloadNodeBin}:/usr/bin:/bin`, npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' };
    const npmCli = path.join(payloadDir, 'node', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    await installDesktopPayloadDependencies(payloadNode, npmCli, npmEnvironment);
    await verifyManifest();
    // Distribution exclusions remain a separate policy from the hash-checked
    // SDK lifecycle patch. Excluded code is deleted (or replaced by a first-party
    // stub); the SDK patch does not change this policy or its license gate.
    console.log(describeDistributionExclusions(await removeExcludedDistributionPackages(fs, path, path.join(payloadDir, 'node_modules'))));
    if (process.platform === 'linux') {
      const foreignPrebuilds = await pruneForeignPrebuilds(path.join(payloadDir, 'node_modules'));
      console.log(`Removed ${foreignPrebuilds.length} incompatible native directories from the Linux payload.`);
    }
    const prunedMetadataFiles = await pruneNonRuntimeMetadata(path.join(payloadDir, 'node_modules'))
      + await pruneNonRuntimeMetadata(path.join(payloadDir, 'dist-server'));
    const nonAsciiRemoved = process.platform === 'darwin' ? await removeNonAsciiPaths(fs, path, payloadDir) : [];
    if (nonAsciiRemoved.length) console.log(`Removed non-ASCII bin links that would break the code signature on copy: ${nonAsciiRemoved.join(', ')}`);
    await codesignNativeClosure(payloadDir);
    await stageSidecar(payloadNode);
    await finalizeDesktopPayloadMetadata();
    await smoke(sidecarPath);
    await fs.rm(path.join(payloadDir, 'node'), { recursive: true, force: true });
    console.log(`Built and verified ${desktop.label} server payload at ${path.relative(rootDir, payloadDir)}; pruned ${prunedMetadataFiles} non-runtime metadata files.`);
  } catch (error) {
    await fs.rm(payloadDir, { recursive: true, force: true });
    await fs.rm(sidecarPath, { force: true });
    throw error;
  }
}

// Platform wrappers import this module as their executable implementation.
// Imports from tests expose staging helpers without downloading/building.
const entry = process.argv[1] ? await fs.realpath(process.argv[1]).catch(() => null) : null;
if (['build-desktop-server-payload.mjs', 'build-linux-server-payload.mjs', 'build-macos-server-payload.mjs']
  .some(name => entry === path.join(__dirname, name))) await buildDesktopServerPayload();
