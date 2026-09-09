#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import crypto from 'node:crypto';
import { access, lstat, mkdir, readdir, readFile, realpath, rm, stat, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import path from 'node:path';

import { SERVER_PACKAGE_NAME } from '../../shared/productIdentity.js';

import { assertOutOfTree } from './out-of-tree.mjs';
import { APPIMAGE_ENV_MARKER, appImageLaunchTarget, createSmokeDataDirectory, packagedTargets, parseSmokeOptions as parseDesktopSmokeOptions, smokeEnvironment, smokeLocation } from './packaged-server-paths.mjs';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export function parseSmokeOptions(args) {
  if (!args.includes('--server-archive-root')) return parseDesktopSmokeOptions(args);
  const usage = 'Usage: --server-archive-root <extracted-dir> [--data-survival] [--from-copy]; archive checks require a disposable fixture project.';
  if (args.some(arg => ['--linux-root', '--tauri-app', '--project-dir', '--appimage-env'].includes(arg))) throw new Error(usage);
  try {
    // Reuse the portable copy/cleanup and argument validation used by Linux
    // desktop packages. An archive has a different target and authentication.
    return { ...parseDesktopSmokeOptions(args.map(arg => arg === '--server-archive-root' ? '--linux-root' : arg)), serverArchive: true };
  } catch (error) { throw new Error(usage, { cause: error }); }
}

export function assertServerArchiveHost({ platform = process.platform, arch = process.arch, node = process.versions.node, glibc = process.report.getReport().header.glibcVersionRuntime } = {}) {
  const [major, minor, patch] = node.split('.').map(Number);
  if (platform !== 'linux' || arch !== 'x64' || major !== 22 || !(minor > 22 || (minor === 22 && patch >= 2))) {
    throw new Error('Server archive smoke requires Linux x64 and Node 22.22.2+ within Node 22.');
  }
  const [libcMajor, libcMinor] = (glibc ?? '').split('.').map(Number);
  if (libcMajor !== 2 || !(libcMinor >= 35)) throw new Error('Server archive smoke requires glibc 2.35 or newer.');
}

export async function serverArchiveTarget(root) {
  root = await realpath(root);
  await assertOutOfTree(root, 'server archive smoke');
  const checkContained = async filename => {
    const relative = path.relative(root, await realpath(filename));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Server archive path escapes extracted root: ${filename}`);
  };
  const checkLinks = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) await checkContained(filename);
      else if (entry.isDirectory()) await checkLinks(filename);
    }
  };
  await checkLinks(root);
  try {
    await lstat(path.join(root, '.env'));
    throw new Error('Server archive smoke refuses a payload containing .env; it could load live credentials.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const required = ['package.json', 'scripts/gajae-app-runtime.mjs', 'dist/index.html', 'dist-server/server/index.js', 'dist-server/server/cli.js', 'dist-server/server/gjc-bun-worker.js', 'dist-server/server/gjc-runtime-manifest.json', 'dist-native/bun', 'dist-native/gajae-core'];
  for (const relative of required) {
    const filename = path.join(root, relative);
    await checkContained(filename);
    if (!(await stat(filename)).isFile()) throw new Error(`Server archive requires a regular file: ${filename}`);
  }
  for (const relative of ['dist-native/bun', 'dist-native/gajae-core']) await access(path.join(root, relative), constants.X_OK);
  const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (metadata.name !== SERVER_PACKAGE_NAME || typeof metadata.version !== 'string' || !metadata.version) throw new Error('Expected canonical gajae-app-server archive metadata.');
  return {
    label: 'Linux server archive', serverArchive: true, cwd: root, command: process.execPath,
    bun: path.join(root, 'dist-native/bun'), args: [path.join(root, 'scripts/gajae-app-runtime.mjs'), 'start'],
    expectedVersion: metadata.version,
  };
}

function request(url, { headers, method = 'GET', body, redirect = 'manual' } = {}) {
  // Force a fresh connection per request: the packaged server may close
  // keep-alive after a response, and undici socket reuse would then fail
  // with UND_ERR_SOCKET ("other side closed") on the next request.
  return fetch(url, { headers: { ...headers, connection: 'close' }, method, body, redirect, signal: AbortSignal.timeout(5_000) });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.once('listening', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close(error => error ? reject(error) : resolve(port));
    });
    server.listen(0, '127.0.0.1');
  });
}

async function waitForHealth(baseUrl, output, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null || output.error) {
      throw new Error(`Packaged server exited before becoming healthy (${child.exitCode ?? child.signalCode ?? output.error.message}):\n${output.value}`);
    }
    try {
      const response = await request(`${baseUrl}/health`);
      const health = await response.json();
      if (response.ok && health.status === 'ok' && health.product === 'gajae-app' && health.protocolVersion === 1 && typeof health.version === 'string' && health.version) return health;
    } catch {
      // The sidecar has not bound its loopback port yet.
    }
    await delay(100);
  }
  throw new Error(`Packaged server did not become healthy:\n${output.value}`);
}

async function prepareSmoke(target, dataDirectory, suppliedProjectDir) {
  const env = smokeEnvironment(target, dataDirectory);
  for (const directory of [path.join(dataDirectory, 'bin'), env.TMPDIR, env.GJC_WORKER_AGENT_DIR]) await mkdir(directory, { recursive: true });
  // Scripts invoking `node` through PATH must use the shipped sidecar too.
  await symlink(target.command, path.join(dataDirectory, 'bin', 'node'));
  const projectDir = suppliedProjectDir || path.join(dataDirectory, 'project');
  if (!suppliedProjectDir) {
    await mkdir(projectDir);
    for (const args of [
      ['init', '--quiet', '--initial-branch=main'],
      ['-c', 'user.name=Packaged Smoke', '-c', 'user.email=packaged-smoke@localhost', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'Packaged smoke fixture'],
    ]) {
      await new Promise((resolve, reject) => {
        const child = spawn('git', args, { cwd: projectDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('error', reject);
        child.once('close', code => code === 0 ? resolve() : reject(new Error(`Packaged smoke project setup failed (${code}): ${stderr}`)));
      });
    }
  }
  return { target: { ...target, env }, projectDir };
}

export function launch(target, dataDirectory, projectDir) {
  const portPromise = freePort();
  return portPromise.then(port => {
    const baseUrl = `http://127.0.0.1:${port}`;
    const apiKey = `smoke-key-${crypto.randomUUID()}`;
    const nonce = `smoke-nonce-${crypto.randomUUID()}`;
    const output = { value: '' };
    const child = spawn(target.launchCommand ?? target.command, target.launchArgs ?? target.args, {
      cwd: target.cwd,
      env: {
        ...target.env,
        DATABASE_PATH: path.join(dataDirectory, 'auth.db'),
        GJC_WORKER_AGENT_DIR: path.join(dataDirectory, 'agent'),
        ...(target.serverArchive ? { API_KEY: apiKey } : { GJC_DESKTOP: '1', GJC_DESKTOP_API_KEY: apiKey, GJC_DESKTOP_BOOTSTRAP_NONCE: nonce }),
        HOME: dataDirectory, WORKSPACES_ROOT: projectDir, HOST: '127.0.0.1', NODE_ENV: 'production', SERVER_PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { output.value += chunk; });
    child.stderr.on('data', chunk => { output.value += chunk; });
    child.once('error', error => { output.error = error; output.value += `\n${error.message}`; });
    return { child, baseUrl, nonce, apiKey, output, appImageEnv: target.appImageEnv, serverArchive: target.serverArchive, expectedVersion: target.expectedVersion };
  });
}

async function nativeClosureSmoke(target) {
  await extractZipPatchSmoke(target);
  const source = `
    import { createRequire } from 'node:module';
    import { createHash } from 'node:crypto';
    import { spawnSync } from 'node:child_process';
    import { readFileSync } from 'node:fs';
    import path from 'node:path';
    const require = createRequire(import.meta.url);
    const Database = require('better-sqlite3');
    const pty = require('node-pty');
    const lightningcss = require('lightningcss');
    const database = new Database(':memory:');
    if (database.prepare('SELECT 1 AS value').get().value !== 1) throw new Error('better-sqlite3 native smoke failed');
    database.close();
    lightningcss.transform({ filename: 'smoke.css', code: Buffer.from('a { color: red; }') });
    const manifest = JSON.parse(readFileSync(path.join(process.cwd(), ${JSON.stringify(target.serverArchive ? 'dist-server/server/gjc-runtime-manifest.json' : 'server/gjc-runtime-manifest.json')}), 'utf8'));
    const platform = process.platform + '-' + process.arch;
    const closure = manifest.platforms[platform]?.files ?? [];
    if (!closure.length) throw new Error('Gajae native manifest is missing for ' + platform);
    for (const entry of closure) {
      const filename = path.join(process.cwd(), 'node_modules', entry.package, entry.path);
      if (createHash('sha256').update(readFileSync(filename)).digest('hex') !== entry.sha256) {
        throw new Error('Packaged native hash mismatch: ' + entry.package + '/' + entry.path);
      }
    }
    const natives = manifest.platforms[platform]?.files.filter(entry => entry.path.endsWith('.node')) ?? [];
    const nativeEntry = natives.find(entry => entry.path.includes('-baseline.node')) ?? natives[0];
    if (!nativeEntry) throw new Error('Gajae native manifest entry is missing for ' + platform);
    const nativeBindings = require(path.join(process.cwd(), 'node_modules', nativeEntry.package, nativeEntry.path));
    const sentinel = '__piNativesV' + manifest.natives.replace(/[^A-Za-z0-9]/g, '_');
    if (typeof nativeBindings[sentinel] !== 'function') throw new Error('Gajae native version sentinel is missing');
    const bun = spawnSync(path.join(process.cwd(), 'dist-native', 'bun'), ['--version'], { encoding: 'utf8', timeout: 10000 });
    if (bun.error || bun.status !== 0 || bun.stdout.trim() !== manifest.bun) throw new Error('Bundled Bun version mismatch: ' + (bun.error?.message ?? bun.stderr ?? bun.stdout));
    if (${Boolean(target.serverArchive)}) {
      if (manifest.bun !== '1.4.0') throw new Error('Server archive must pin Bun 1.4.0');
      const core = spawnSync(path.join(process.cwd(), 'dist-native', 'gajae-core'), ['--version'], { encoding: 'utf8', timeout: 10000 });
      if (core.error || core.status !== 0 || !core.stdout.startsWith('gajae-core ')) throw new Error('Bundled Rust core failed to execute');
      const { rgPath } = require('@vscode/ripgrep');
      const rg = spawnSync(rgPath, ['--version'], { encoding: 'utf8', timeout: 10000 });
      if (rg.error || rg.status !== 0 || !rg.stdout.startsWith('ripgrep ')) throw new Error('Bundled ripgrep failed to execute');
    }
    await new Promise((resolve, reject) => {
      const terminal = pty.spawn(process.execPath, ['-e', 'process.exit(0)'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
      const timer = setTimeout(() => { terminal.kill(); reject(new Error('node-pty native smoke timed out')); }, 5000);
      terminal.onExit(({ exitCode }) => { clearTimeout(timer); exitCode === 0 ? resolve() : reject(new Error('node-pty native smoke exited ' + exitCode)); });
    });
  `;
  await new Promise((resolve, reject) => {
    const child = spawn(target.command, ['--input-type=module', '--eval', source], {
      cwd: target.cwd,
      env: target.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0
      ? resolve()
      : reject(new Error(`Packaged native closure smoke failed (${code}): ${stderr || stdout}`)));
  });
  if (target.serverArchive) await workerInitializationSmoke(target);
}

// Execute the verifier shipped in the extracted payload, not a checkout
// import. This check precedes native/module loading in every packaged smoke.
export async function extractZipPatchSmoke(target) {
  await assertOutOfTree(target.cwd, 'extract-zip packaged patch smoke');
  await new Promise((resolve, reject) => {
    const child = spawn(target.command, ['scripts/apply-extract-zip-patch.mjs', '--check'], {
      cwd: target.cwd, env: target.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Packaged extract-zip patch check timed out.')); }, 30_000);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('Packaged extract-zip patch check failed (' + code + '): ' + output));
    });
  });
}

export async function workerInitializationSmoke(target, { timeoutMs = 45_000 } = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(target.bun, [path.join(target.cwd, 'dist-server/server/gjc-bun-worker.js')], {
      cwd: target.cwd, env: target.env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let pending = ''; let diagnostic = ''; let failure; let phase = 'initialize';
    const fail = error => { failure ??= error; child.kill('SIGKILL'); };
    const timer = setTimeout(() => fail(new Error('Bun worker initialization/shutdown timed out.')), timeoutMs);
    const send = method => child.stdin.write(`${JSON.stringify({ protocolVersion: 1, kind: 'request', id: `archive-${method}`, method: `worker.${method}`, payload: {} })}\n`);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { diagnostic += chunk; });
    child.once('error', fail);
    child.stdin.on('error', fail);
    child.stdout.on('data', chunk => {
      pending += chunk;
      const lines = pending.split('\n'); pending = lines.pop();
      try {
        for (const line of lines.filter(Boolean)) {
          const frame = JSON.parse(line);
          if (frame.protocolVersion !== 1 || frame.kind !== 'response' || frame.id !== `archive-${phase}` || frame.payload?.ok !== true) throw new Error(`Bun worker rejected ${phase}: ${line}`);
          if (phase === 'initialize') { phase = 'shutdown'; send('shutdown'); child.stdin.end(); }
          else if (phase === 'shutdown') phase = 'closed';
          else throw new Error('Unexpected extra Bun worker response.');
        }
      } catch (error) { fail(error); }
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (failure || code !== 0 || signal || phase !== 'closed' || pending.trim()) reject(new Error(`Packaged Bun worker handshake failed: ${failure?.message ?? `phase=${phase}, exit=${code}, signal=${signal}`}\n${diagnostic}`));
      else resolve();
    });
    send('initialize');
  });
  console.log('Packaged Bun worker initialize/shutdown handshake passed.');
}

export async function bootstrap(instance) {
  const health = await waitForHealth(instance.baseUrl, instance.output, instance.child);
  if (instance.serverArchive) {
    if (health.version !== instance.expectedVersion) throw new Error('Running server version does not match archive metadata.');
    const headers = { 'x-api-key': instance.apiKey, origin: instance.baseUrl };
    for (const invalid of [{}, { 'x-api-key': 'invalid-smoke-key' }]) {
      const denied = await request(`${instance.baseUrl}/api/auth/user`, { headers: invalid });
      if (denied.status !== 401) throw new Error('Server archive accepted a missing or invalid API key.');
    }
    const owner = await json(await request(`${instance.baseUrl}/api/auth/user`, { headers }), 'Server archive owner authentication');
    if (!owner.user?.id || owner.shell?.desktop !== false) throw new Error('Server archive did not boot with normal server authentication.');
    const page = await request(`${instance.baseUrl}/`, { headers });
    const html = await page.text();
    const asset = html.match(/<script\b[^>]*\bsrc="(\/assets\/[^"?#]+\.js)"/);
    if (!page.ok || !page.headers.get('content-type')?.includes('text/html') || !asset) throw new Error('Server archive did not serve the built frontend.');
    const script = await request(`${instance.baseUrl}${asset[1]}`, { headers });
    if (!script.ok || !script.headers.get('content-type')?.includes('javascript') || !(await script.text()).trim()) throw new Error('Server archive frontend asset is missing.');
    return { health, headers };
  }
  if (instance.appImageEnv) {
    if (!instance.output.value.split('\n').includes(APPIMAGE_ENV_MARKER)) throw new Error('AppImage smoke did not execute the instrumented GUI launcher through AppRun.');
    console.log(APPIMAGE_ENV_MARKER);
  }
  for (const suffix of ['', '?nonce=invalid-smoke-nonce']) {
    const denied = await request(`${instance.baseUrl}/desktop/bootstrap${suffix}`);
    if (denied.status !== 401 || denied.headers.has('set-cookie')) throw new Error('Invalid bootstrap nonce was accepted or set a cookie.');
  }
  const attempts = await Promise.all([0, 1].map(() => request(`${instance.baseUrl}/desktop/bootstrap?nonce=${encodeURIComponent(instance.nonce)}`)));
  const bootstrap = attempts.find(response => response.status === 303);
  const rejected = attempts.find(response => response.status === 401);
  if (!bootstrap || !rejected || rejected.headers.has('set-cookie')) throw new Error('Concurrent bootstrap must accept the nonce exactly once.');
  const cookie = bootstrap.headers.get('set-cookie');
  if (bootstrap.status !== 303 || bootstrap.headers.get('location') !== '/' || !cookie?.includes('HttpOnly') || !cookie.includes('SameSite=Lax') || !cookie.includes('Path=/') || !cookie.includes('gajae_desktop_api_key=')) throw new Error('Desktop bootstrap did not produce the required scoped HttpOnly cookie and root redirect.');
  const replay = await request(`${instance.baseUrl}/desktop/bootstrap?nonce=${encodeURIComponent(instance.nonce)}`);
  if (replay.status !== 401 || replay.headers.has('set-cookie')) throw new Error(`Bootstrap nonce replay status was ${replay.status}, expected 401 without a cookie.`);
  return { health, headers: { cookie: cookie.split(';', 1)[0], origin: instance.baseUrl } };
}

export async function stop(instance, { timeoutMs = 15_000 } = {}) {
  if (!instance.child.pid) return;
  if (instance.stopped) return;
  const { child } = instance;
  try {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Packaged server exited before shutdown (${child.exitCode ?? child.signalCode}).`);
    const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    let timer;
    try {
      child.kill('SIGTERM');
      const result = await Promise.race([closed, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Packaged server did not exit after SIGTERM.')), timeoutMs);
      })]);
      if (result.code !== 0 || result.signal !== null) throw new Error(`Packaged server shutdown failed (code=${result.code}, signal=${result.signal}).`);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await closed;
      }
    }
  } catch (error) {
    throw new Error(`${error.message}\n${instance.output.value}`, { cause: error });
  } finally {
    instance.stopped = true;
  }
}

async function json(response, context) {
  const value = await response.json();
  if (!response.ok) throw new Error(`${context} failed (${response.status}): ${JSON.stringify(value)}`);
  return value;
}

async function sqliteSnapshot(target, database) {
  if (!existsSync(database)) throw new Error(`Expected durable SQLite database is missing: ${database}`);
  const source = `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); const Database = require('better-sqlite3'); const db = new Database(process.argv[1], { readonly: true }); const schema = db.prepare("SELECT name, type, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name").all(); const userVersion = db.pragma('user_version', { simple: true }); console.log(JSON.stringify({ userVersion, schema })); db.close();`;
  const output = await new Promise((resolve, reject) => {
    const child = spawn(target.command, ['--input-type=module', '--eval', source, database], {
      cwd: target.cwd, env: target.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(`SQLite schema inspection failed (${code}): ${stderr}`)));
  });
  return JSON.parse(output.trim());
}
async function createV6JobsFixture(target, database) {
  const source = `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); const Database = require('better-sqlite3'); const db = new Database(process.argv[1]); db.pragma('foreign_keys = ON'); db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP); INSERT INTO schema_migrations(version) VALUES(5),(6); CREATE TABLE jobs (id TEXT PRIMARY KEY NOT NULL, provider TEXT NOT NULL, state TEXT NOT NULL, lease_owner TEXT NULL, lease_generation INTEGER NOT NULL DEFAULT 0, next_lease_generation INTEGER NOT NULL DEFAULT 1, worktree_id TEXT NULL, branch TEXT NULL, base_commit TEXT NULL, repository_root TEXT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, prompt TEXT NULL); CREATE TABLE runs (run_id TEXT PRIMARY KEY NOT NULL, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, app_session_id TEXT NULL, provider_session_id TEXT NULL, state TEXT NOT NULL DEFAULT 'queued', outcome TEXT NULL, dispatched_at TEXT NULL); CREATE TABLE job_events (job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, sequence INTEGER NOT NULL, event_id TEXT NOT NULL, payload TEXT NOT NULL, run_id TEXT NULL REFERENCES runs(run_id), UNIQUE(job_id,sequence), UNIQUE(job_id,event_id)); CREATE INDEX job_events_job_sequence ON job_events(job_id,sequence); CREATE TABLE session_job_bindings (provider TEXT NOT NULL, app_session_id TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES jobs(id), provider_session_id TEXT NULL, bound_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, released_at TEXT NULL, UNIQUE(job_id)); CREATE UNIQUE INDEX active_session_job_bindings ON session_job_bindings(provider,app_session_id) WHERE released_at IS NULL;"); db.prepare("INSERT INTO jobs(id,provider,state,lease_owner,lease_generation,next_lease_generation,created_at,prompt) VALUES(?, 'gjc', 'succeeded', NULL, 0, 1, '2026-01-01T00:00:00.000Z', 'preserved packaged v6 job')").run(process.argv[2]); db.prepare("INSERT INTO runs(run_id,job_id,app_session_id,state,outcome,dispatched_at) VALUES('packaged-v6-run', ?, 'packaged-v6-session', 'succeeded', 'succeeded', '2026-01-01T00:00:01.000Z')").run(process.argv[2]); db.prepare("INSERT INTO job_events(job_id,sequence,event_id,payload,run_id) VALUES(?, 1, 'packaged-v6-event', '{\\"type\\":\\"completed\\"}', 'packaged-v6-run')").run(process.argv[2]); db.close();`;
  await new Promise((resolve, reject) => {
    const child = spawn(target.command, ['--input-type=module', '--eval', source, database, 'packaged-v6-preserved-job'], {
      cwd: target.cwd, env: target.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`v6 jobs fixture creation failed (${code}): ${stderr}`)));
  });
}

async function v7MigrationSnapshot(target, database) {
  const source = `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); const Database = require('better-sqlite3'); const db = new Database(process.argv[1], { readonly: true }); const migrationVersion = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version; const archivedAt = db.prepare('SELECT archived_at AS archivedAt FROM jobs WHERE id=?').get(process.argv[2])?.archivedAt; console.log(JSON.stringify({ migrationVersion, archivedAt })); db.close();`;
  const output = await new Promise((resolve, reject) => {
    const child = spawn(target.command, ['--input-type=module', '--eval', source, database, 'packaged-v6-preserved-job'], {
      cwd: target.cwd, env: target.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(`v7 migration inspection failed (${code}): ${stderr}`)));
  });
  return JSON.parse(output.trim());
}

// Resolve ws from the payload, so checkout dependencies cannot mask a broken
// package. Sockets use only the disposable boot credential for this target.
async function packagedProtocolChecks() {
  const { default: assert } = await import('node:assert/strict');
  const { once } = await import('node:events');
  const { createRequire } = await import('node:module');
  const { test } = await import('node:test');
  const { WebSocket } = createRequire(`${process.cwd()}/package.json`)('ws');
  const base = process.env.GAJAE_SMOKE_URL;
  const serverArchive = process.env.GAJAE_SMOKE_SERVER_ARCHIVE === '1';
  const project = process.env.GAJAE_SMOKE_PROJECT;
  const headers = JSON.parse(process.env.GAJAE_SMOKE_HEADERS);
  const cookie = headers.cookie;
  const sockets = new Set();
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const get = (pathname, requestHeaders = headers) => fetch(`${base}${pathname}`, { headers: { ...requestHeaders, connection: 'close' }, signal: AbortSignal.timeout(5_000) });
  async function connect(pathname, requestHeaders = headers) {
    const socket = new WebSocket(`${base.replace('http:', 'ws:')}${pathname}`, { headers: requestHeaders, handshakeTimeout: 3_000 });
    sockets.add(socket);
    const frames = [];
    socket.on('message', raw => frames.push(JSON.parse(String(raw))));
    socket.on('error', () => {});
    await once(socket, 'open');
    return {
      socket, frames,
      send: frame => socket.send(JSON.stringify(frame)),
      async wait(predicate, label) {
        const deadline = Date.now() + 4_000;
        while (Date.now() < deadline) {
          const found = frames.find(predicate);
          if (found) return found;
          await pause(20);
        }
        throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(frames)}`);
      },
      async output(marker) {
        const deadline = Date.now() + 4_000;
        while (Date.now() < deadline) {
          const output = frames.filter(frame => frame.type === 'output').map(frame => frame.data).join('');
          if (output.includes(marker)) return output;
          await pause(20);
        }
        throw new Error(`Terminal did not emit ${marker}: ${JSON.stringify(frames)}`);
      },
      async close() {
        if (socket.readyState === WebSocket.CLOSED) return;
        const closed = once(socket, 'close');
        socket.terminate();
        await closed;
      },
    };
  }
  await test('packaged HTTP, WebSocket and terminal integration', { timeout: 45_000 }, async t => {
    t.after(() => { for (const socket of sockets) socket.terminate(); });
    await t.test('HTTP rejects invalid credentials and preserves authenticated access', async () => {
      const invalidHeaders = serverArchive
        ? [{}, { 'x-api-key': 'invalid-smoke-key' }]
        : [{}, { cookie: 'gajae_desktop_api_key=invalid' }, { cookie, origin: 'http://localhost:1' }];
      for (const invalid of invalidHeaders) assert.equal((await get('/api/gjc/jobs', invalid)).status, 401);
      if (serverArchive) {
        assert.equal((await get('/api/gjc/jobs', { ...headers, origin: 'https://archive-smoke.invalid' })).status, 403);
        assert.equal((await get('/api/gjc/jobs', { 'x-api-key': headers['x-api-key'] })).status, 200);
      } else {
        assert.equal((await get('/api/gjc/jobs', { cookie })).status, 200);
      }
      assert.equal((await get('/api/gjc/jobs')).status, 200);
    });
    if (process.platform === 'linux' && !serverArchive) {
      await t.test('Linux desktop exposes Workspace Browser without enabling native computer automation', async () => {
        const response = await get('/api/automation/status');
        assert.equal(response.status, 200);
        const status = await response.json();
        assert.equal(status.supported, true);
        assert.equal(status.computerSupported, false);
        assert.equal(status.platform, 'linux');
      });
    }
    if (process.env.GAJAE_SMOKE_APPIMAGE_ENV === '1') {
      for (const [name, command, expected] of [
        ['Python', '/usr/bin/python3 -c \'import encodings, sys; assert sys.executable == "/usr/bin/python3"; print("GAJAE_SYSTEM_PYTHON_READY")\'', /GAJAE_SYSTEM_PYTHON_READY/],
        ['gio', '/usr/bin/gio version', /(?:^|\n)\d+\.\d+(?:\.\d+)?\r?\n/],
      ]) {
        await t.test(`AppRun server terminal can execute system ${name}`, async () => {
          const terminal = await connect('/shell');
          try {
            terminal.send({ type: 'init', projectPath: project, sessionId: `appimage-system-${name}`, isPlainShell: true, initialCommand: command });
            const output = await terminal.output('Process exited with code 0');
            assert.match(output, expected);
          } finally { await terminal.close(); }
        });
      }
    }
    for (const pathname of ['/ws', '/shell']) {
      await t.test(`${pathname} rejects invalid credentials and foreign origin`, async () => {
        const invalidHeaders = serverArchive
          ? [{ origin: base }, { origin: base, 'x-api-key': 'invalid-smoke-key' }, { ...headers, origin: 'https://archive-smoke.invalid' }]
          : [{ origin: base }, { origin: base, cookie: 'gajae_desktop_api_key=invalid' }, { cookie }, { cookie, origin: 'http://localhost:1' }];
        for (const invalid of invalidHeaders) {
          await assert.rejects(connect(pathname, invalid), /Unexpected server response: 401/);
        }
      });
    }
    await t.test('job subscriptions stay socket-local and recover from malformed input', async () => {
      const first = await connect('/ws');
      const second = await connect('/ws');
      first.send({ protocolVersion: 1, type: 'gjc.job.subscribe', jobId: 'bad/id', after: 0 });
      await first.wait(frame => frame.kind === 'gjc_job_error' && frame.code === 'invalid_request', 'invalid request');
      first.send({ protocolVersion: 1, type: 'gjc.job.subscribe', jobId: 'packaged-v6-preserved-job', after: 0 });
      const subscribed = await first.wait(frame => frame.kind === 'gjc_job_subscribed', 'healthy subscription');
      first.send({ protocolVersion: 1, type: 'gjc.job.replay', jobId: 'packaged-v6-preserved-job', subscriptionId: subscribed.subscriptionId, after: 0, byteBudget: 4096 });
      const replay = await first.wait(frame => frame.kind === 'gjc_job_replay_chunk', 'durable replay');
      assert.equal(replay.events.length, 1);
      assert.equal(replay.events[0].sequence, 1);
      await pause(100);
      assert.equal(second.frames.some(frame => frame.kind?.startsWith('gjc_job_')), false);
      second.send({ protocolVersion: 1, type: 'gjc.job.subscribe', jobId: 'packaged-v6-preserved-job', after: 1 });
      await second.wait(frame => frame.kind === 'gjc_job_subscribed', 'independent subscription');
      await first.close(); await second.close();
    });
    await t.test('terminal validates input, spawns, resizes, reconnects and reports command failure', async () => {
      let terminal = await connect('/shell');
      const init = { type: 'init', projectPath: project, sessionId: 'packaged-shell', isPlainShell: true, initialCommand: 'exec bash --noprofile --norc', cols: 80, rows: 24 };
      terminal.send({ ...init, projectPath: `${project}/missing` });
      await terminal.wait(frame => frame.type === 'error' && frame.message === 'Invalid project path', 'invalid cwd');
      terminal.send({ ...init, sessionId: 'bad/session' });
      await terminal.wait(frame => frame.type === 'error' && frame.message === 'Invalid session ID', 'invalid session');
      terminal.socket.send('{');
      await terminal.output('Invalid websocket payload');
      terminal.send(init);
      await terminal.output('Starting terminal in:');
      terminal.send({ type: 'input', data: "printf '__HOME:%s__\\n' \"$HOME\"\n" });
      await terminal.output(`__HOME:${process.env.HOME}__`);
      terminal.send({ type: 'resize', cols: 97, rows: 31 });
      terminal.send({ type: 'input', data: "printf '__SIZE:%s__\\n' \"$(stty size)\"\n" });
      await terminal.output('__SIZE:31 97__');
      const other = await connect('/shell');
      other.send({ ...init, sessionId: 'packaged-shell-other', initialCommand: "printf '__%s__\\n' OTHER_TERMINAL; exit 7" });
      await other.output('__OTHER_TERMINAL__');
      await other.output('Process exited with code 7');
      assert.equal(terminal.frames.some(frame => frame.data?.includes('__OTHER_TERMINAL__')), false);
      await other.close();
      await terminal.close();
      terminal = await connect('/shell');
      terminal.send(init);
      await terminal.output('Reconnected to existing session');
      terminal.send({ type: 'input', data: "printf '__%s__\\n' RECONNECTED; exit 0\n" });
      await terminal.output('__RECONNECTED__');
      await terminal.output('Process exited with code 0');
      await terminal.close();
    });
    await t.test('closing a replaced terminal socket preserves the current connection', async () => {
      const init = { type: 'init', projectPath: project, sessionId: 'packaged-shell-overlap', isPlainShell: true, initialCommand: 'exec bash --noprofile --norc' };
      const previous = await connect('/shell');
      previous.send(init);
      await previous.output('Starting terminal in:');
      const current = await connect('/shell');
      try {
        current.send(init);
        await current.output('Reconnected to existing session');
        current.send({ type: 'input', data: "printf '__%s__\\n' BEFORE_REPLACE\n" });
        await current.output('__BEFORE_REPLACE__');
        current.send({ type: 'resize', cols: 97, rows: 31 });
        current.send({ type: 'input', data: "printf '__OWNED_SIZE:%s__\\n' \"$(stty size)\"\n" });
        await current.output('__OWNED_SIZE:31 97__');
        previous.send({ type: 'resize', cols: 1, rows: 1 });
        previous.send({ type: 'input', data: 'exit 7\n' });
        previous.send({ ...init, forceRestart: true });
        await pause(100);
        await previous.close();
        // Allow the server to process the old connection's close handler.
        await pause(100);
        current.send({ type: 'input', data: "printf '__%s__\\n' AFTER_REPLACE\n" });
        await current.output('__AFTER_REPLACE__');
        current.send({ type: 'input', data: "printf '__RETAINED_SIZE:%s__\\n' \"$(stty size)\"\n" });
        await current.output('__RETAINED_SIZE:31 97__');
      } finally {
        current.send({ type: 'input', data: 'exit 0\n' });
        await current.close();
        await previous.close();
      }
    });
  });
}

async function protocolSmoke(target, instance, headers, projectDir) {
  const source = `(${packagedProtocolChecks.toString()})()`;
  await new Promise((resolve, reject) => {
    const child = spawn(target.command, ['--input-type=module', '--eval', source], {
      cwd: target.cwd,
      env: { ...target.env, GAJAE_SMOKE_URL: instance.baseUrl, GAJAE_SMOKE_HEADERS: JSON.stringify(headers), GAJAE_SMOKE_SERVER_ARCHIVE: target.serverArchive ? '1' : '0', GAJAE_SMOKE_PROJECT: projectDir, GAJAE_SMOKE_APPIMAGE_ENV: target.appImageEnv ? '1' : '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 55_000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      console.log(output.trim());
      if (code === 0) resolve();
      else reject(new Error(`Packaged protocol checks failed (${code}).\n${instance.output.value}`));
    });
  });
}

function isCompleteUniqueReplay(replay) {
  return replay?.nextCursor === null && Array.isArray(replay.events) && replay.events.length > 0
    && replay.events.every((event, index) => event?.sequence === index + 1 && typeof event.eventId === 'string' && event.eventId.length > 0)
    && new Set(replay.events.map(event => event.eventId)).size === replay.events.length;
}

export function verifyAbortedReplay(replay, runId) {
  const terminalId = `run-terminal:${runId}`;
  const terminals = Array.isArray(replay?.events) ? replay.events.filter(event => event?.eventId === terminalId || event?.payload?.kind === 'job_terminal') : [];
  const terminal = terminals[0];
  // Native JobEvent exposes eventId/sequence/payload; the orchestrator puts
  // the run identity in JobTerminalPayload, not on the outer replay event.
  if (typeof runId !== 'string' || !runId || !isCompleteUniqueReplay(replay) || terminals.length !== 1
      || terminal.eventId !== terminalId || terminal.payload?.schemaVersion !== 1
      || terminal.payload.runId !== runId || terminal.payload.kind !== 'job_terminal'
      || terminal.payload.outcome !== 'aborted' || terminal.payload.jobState !== 'aborted') {
    throw new Error(`Aborted GJC event replay was not gap-free and durable: ${JSON.stringify(replay)}`);
  }
}

export function verifyInterruptedReplay(replay, runId) {
  const terminalId = `shutdown-interrupted:${runId}`;
  const interruptions = Array.isArray(replay?.events) ? replay.events.filter(event => event?.eventId === terminalId || event?.payload?.type === 'interrupted') : [];
  const interruption = interruptions[0];
  // Shutdown reconciliation is authored by the native authority. Unlike an
  // orchestrator terminal payload, its run identity is only in eventId.
  if (typeof runId !== 'string' || !runId || !isCompleteUniqueReplay(replay) || interruptions.length !== 1
      || interruption.eventId !== terminalId || interruption.payload?.type !== 'interrupted'
      || interruption.payload.reason !== 'shutdown') {
    throw new Error(`Restarted GJC event replay was not gap-free, unique, and shutdown-preserved: ${JSON.stringify(replay)}`);
  }
}

async function smoke(packagedTarget, suppliedProjectDir) {
  const temporaryDirectory = await createSmokeDataDirectory();
  const jobsDatabase = path.join(temporaryDirectory, 'jobs.sqlite3');
  let instance;
  try {
    const { target, projectDir } = await prepareSmoke(packagedTarget, temporaryDirectory, suppliedProjectDir);
    await nativeClosureSmoke(target);
    await createV6JobsFixture(target, jobsDatabase);
    instance = await launch(target, temporaryDirectory, projectDir);
    const { health, headers } = await bootstrap(instance);
    await protocolSmoke(target, instance, headers, projectDir);
    const denied = await request(`${instance.baseUrl}/api/gjc/jobs`);
    if (denied.status !== 401) throw new Error(`Unauthenticated API status was ${denied.status}, expected 401.`);
    const jobs = await request(`${instance.baseUrl}/api/gjc/jobs`, { headers });
    const listedJobs = await json(jobs, 'Authenticated GJC job list');
    const preservedJob = Array.isArray(listedJobs.items) ? listedJobs.items.find(item => item?.jobId === 'packaged-v6-preserved-job') : null;
    if (!preservedJob || preservedJob.state !== 'succeeded' || preservedJob.lastSequence !== 1 || listedJobs.nextCursor !== null || Object.hasOwn(preservedJob, 'archivedAt')) throw new Error(`v6 GJC job list was not preserved after migration: ${JSON.stringify(listedJobs)}`);
    const create = await request(`${instance.baseUrl}/api/gjc/jobs`, { headers: { ...headers, 'content-type': 'application/json' }, method: 'POST', body: JSON.stringify({ appSessionId: `smoke-${crypto.randomUUID()}`, projectPath: projectDir, message: 'packaged server smoke' }) });
    const job = await json(create, 'GJC job creation');
    if (create.status !== 202 || typeof job.jobId !== 'string' || typeof job.runId !== 'string' || !job.runId) throw new Error(`GJC job creation returned an invalid response: ${JSON.stringify(job)}`);
    const abort = await request(`${instance.baseUrl}/api/gjc/jobs/${encodeURIComponent(job.jobId)}/abort`, { headers, method: 'POST' });
    if (abort.status !== 202) throw new Error(`GJC job abort failed (${abort.status}).`);
    if (target.serverArchive) {
      const result = await json(abort, 'GJC job abort');
      if (result.aborted !== true) throw new Error('Archive GJC job abort was not confirmed.');
      const replay = await json(await request(`${instance.baseUrl}/api/gjc/jobs/${encodeURIComponent(job.jobId)}/events?cursor=0`, { headers }), 'Aborted GJC event replay');
      verifyAbortedReplay(replay, job.runId);
    }
    await stop(instance);
    const migration = await v7MigrationSnapshot(target, jobsDatabase);
    if (migration.migrationVersion !== 7 || migration.archivedAt !== null) throw new Error(`v6 jobs.sqlite3 did not migrate to v7 with archived_at NULL: ${JSON.stringify(migration)}`);
    console.log(`${target.label} packaged server smoke passed: ${JSON.stringify(health)}`);
  } finally {
    try { if (instance) await stop(instance); }
    finally { await rm(temporaryDirectory, { recursive: true, force: true }); }
  }
}

async function dataSurvivalSmoke(packagedTarget, suppliedProjectDir) {
  const dataDirectory = await createSmokeDataDirectory();
  const authDatabase = path.join(dataDirectory, 'auth.db');
  const jobsDatabase = path.join(dataDirectory, 'jobs.sqlite3');
  const customName = `data-survival-${crypto.randomUUID()}`;
  let first;
  let second;
  try {
    const { target, projectDir } = await prepareSmoke(packagedTarget, dataDirectory, suppliedProjectDir);
    await nativeClosureSmoke(target);
    first = await launch(target, dataDirectory, projectDir);
    const firstSession = await bootstrap(first);
    const firstNonce = first.nonce;
    const project = await request(`${first.baseUrl}/api/projects/create-project`, { headers: { ...firstSession.headers, 'content-type': 'application/json' }, method: 'POST', body: JSON.stringify({ path: projectDir, customName }) });
    if (!(await json(project, 'Durable project creation')).success) throw new Error('Durable project creation did not report success.');
    const created = await request(`${first.baseUrl}/api/gjc/jobs`, { headers: { ...firstSession.headers, 'content-type': 'application/json' }, method: 'POST', body: JSON.stringify({ appSessionId: `data-survival-${crypto.randomUUID()}`, projectPath: projectDir, message: 'data survival shutdown fence' }) });
    const job = await json(created, 'Durable GJC job creation');
    if (created.status !== 202 || typeof job.jobId !== 'string' || typeof job.appSessionId !== 'string' || typeof job.runId !== 'string' || !job.runId) throw new Error(`Durable GJC job creation returned an invalid response: ${JSON.stringify(job)}`);
    await stop(first); first = undefined;

    const schemaAfterFirstBoot = { auth: await sqliteSnapshot(target, authDatabase), jobs: await sqliteSnapshot(target, jobsDatabase) };
    second = await launch(target, dataDirectory, projectDir);
    const secondSession = await bootstrap(second);
    const staleCredential = await request(`${second.baseUrl}/api/gjc/jobs`, { headers: { ...firstSession.headers, origin: second.baseUrl } });
    if (staleCredential.status !== 401) throw new Error('The replaced smoke credential from the previous boot was accepted.');
    if (!target.serverArchive) {
      const staleNonce = await request(`${second.baseUrl}/desktop/bootstrap?nonce=${encodeURIComponent(firstNonce)}`);
      if (staleNonce.status !== 401 || staleNonce.headers.has('set-cookie')) throw new Error('Desktop nonce from the previous boot was accepted.');
    }
    const list = await json(await request(`${second.baseUrl}/api/gjc/jobs`, { headers: secondSession.headers }), 'Restarted GJC job list');
    if (!Array.isArray(list.items) || !list.items.some(item => item?.jobId === job.jobId && item.state === 'interrupted')) throw new Error(`Restarted GJC job was not preserved as interrupted: ${JSON.stringify(list)}`);
    const replayBeforeResume = await json(await request(`${second.baseUrl}/api/gjc/jobs/${encodeURIComponent(job.jobId)}/events?cursor=0`, { headers: secondSession.headers }), 'Restarted GJC event replay');
    verifyInterruptedReplay(replayBeforeResume, job.runId);
    const sequences = replayBeforeResume.events.map(event => event.sequence);
    const resumed = await request(`${second.baseUrl}/api/gjc/jobs/${encodeURIComponent(job.jobId)}/resume`, { headers: { ...secondSession.headers, 'content-type': 'application/json' }, method: 'POST', body: JSON.stringify({ appSessionId: job.appSessionId, message: 'data survival resume admission' }) });
    const resumedJob = await json(resumed, 'Interrupted GJC job resume');
    if (resumed.status !== 202 || typeof resumedJob.runId !== 'string') throw new Error(`Interrupted GJC job resume returned an invalid response: ${JSON.stringify(resumedJob)}`);
    const abortResumed = await request(`${second.baseUrl}/api/gjc/jobs/${encodeURIComponent(job.jobId)}/abort`, { headers: secondSession.headers, method: 'POST' });
    if (abortResumed.status !== 202) throw new Error(`Resumed GJC job cleanup abort failed (${abortResumed.status}).`);
    await stop(second); second = undefined;

    const schemaAfterSecondBoot = { auth: await sqliteSnapshot(target, authDatabase), jobs: await sqliteSnapshot(target, jobsDatabase) };
    if (JSON.stringify(schemaAfterFirstBoot) !== JSON.stringify(schemaAfterSecondBoot)) throw new Error('SQLite schema changed across restart; migration was not idempotent.');
    const authRows = await new Promise((resolve, reject) => {
      const source = `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); const Database = require('better-sqlite3'); const db = new Database(process.argv[1], { readonly: true }); console.log(JSON.stringify(db.prepare('SELECT custom_project_name FROM projects WHERE custom_project_name = ?').all(process.argv[2]))); db.close();`;
      const child = spawn(target.command, ['--input-type=module', '--eval', source, authDatabase, customName], { cwd: target.cwd, env: target.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = ''; child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; }); child.once('error', reject); child.once('close', code => code === 0 ? resolve(JSON.parse(stdout.trim())) : reject(new Error(`Durable auth row inspection failed (${code}): ${stderr}`)));
    });
    if (!Array.isArray(authRows) || authRows.length !== 1) throw new Error('Durable auth.db project row did not survive restart.');
    console.log(`${target.label} packaged data-survival smoke passed: job=${job.jobId}, events=${sequences.length}, schemas=idempotent`);
  } finally {
    try {
      try { if (first) await stop(first); }
      finally { if (second) await stop(second); }
    } finally { await rm(dataDirectory, { recursive: true, force: true }); }
  }
}

export async function runPackagedSmoke(args = process.argv.slice(2)) {
  const options = parseSmokeOptions(args);
  if (options.serverArchive) assertServerArchiveHost();
  const location = await smokeLocation(options.app, options);
  try {
    let target = options.serverArchive ? await serverArchiveTarget(location.app) : await packagedTargets(location.app, options);
    if (options.appImageEnv) target = await appImageLaunchTarget(location, target);
    await (options.dataSurvival ? dataSurvivalSmoke(target, options.projectDir) : smoke(target, options.projectDir));
  } finally {
    await location.cleanup();
  }
}

if (process.argv[1] && await realpath(fileURLToPath(import.meta.url)) === await realpath(process.argv[1])) await runPackagedSmoke();
