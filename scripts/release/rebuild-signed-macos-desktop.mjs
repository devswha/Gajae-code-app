import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { desktopTargetDirectory } from './desktop-platforms.mjs';

const capture = promisify(execFile);
const MAX_MANIFEST_BYTES = 64 * 1024;
const TARGET = 'aarch64-apple-darwin';

async function appFile(appPath, path) {
  const app = await realpath(appPath);
  const parent = await realpath(dirname(path));
  if (!parent.startsWith(`${app}${sep}`)) throw new Error('Finalization file must remain inside the passed app.');
  const stat = await lstat(path);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('Finalization requires a singly linked regular app file, not a symlink or hard link.');
}

/** Validate both app-local manifests before signing/restamping can write them. */
export async function readAppRuntimeManifests(appPath) {
  const payload = join(appPath, 'Contents/Resources/resources/server-payload');
  const paths = ['server', 'dist-server/server'].map(location => join(payload, location, 'gjc-runtime-manifest.json'));
  const bytes = [];
  for (const path of paths) {
    await appFile(appPath, path);
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const start = await fd.stat();
      if (!start.isFile() || start.nlink !== 1 || start.size === 0 || start.size > MAX_MANIFEST_BYTES) {
        throw new Error('App runtime manifests must be nonempty regular files bounded to 64 KiB.');
      }
      // A bounded buffer plus an extra byte detects growth without buffering it.
      const buffer = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const result = await fd.read(buffer, size, buffer.length - size, size);
        if (result.bytesRead === 0) break;
        size += result.bytesRead;
      }
      const end = await fd.stat();
      if (size !== start.size || end.size !== start.size || end.mtimeMs !== start.mtimeMs || end.ctimeMs !== start.ctimeMs) {
        throw new Error('App runtime manifest changed while reading.');
      }
      bytes.push(buffer.subarray(0, size));
    } finally { await fd.close(); }
  }
  return { paths, bytes };
}

async function run(command, args, options) {
  try { await capture(command, args, { ...options, maxBuffer: 16 * 1024 * 1024 }); }
  catch { throw new Error('Signed-manifest desktop rebuild failed; no app executable was copied.'); }
}

/** Rebuild only the shell; never rebuild, sign or restamp the nested payload. */
export async function rebuildSignedMacosDesktop({ rootDir, appPath, inheritedEnv = process.env }, {
  execute = run, resolveTargetDirectory = desktopTargetDirectory,
} = {}) {
  rootDir = resolve(rootDir);
  appPath = await realpath(appPath);
  const { bytes } = await readAppRuntimeManifests(appPath);
  if (!bytes[0].equals(bytes[1])) throw new Error('Both restamped runtime manifests must be byte-identical.');
  const payloadRuntimeManifestSha256 = createHash('sha256').update(bytes[0]).digest('hex');
  const env = { ...inheritedEnv, GJC_SIGNED_RUNTIME_MANIFEST_SHA256: payloadRuntimeManifestSha256 };
  const targetDir = await resolveTargetDirectory(rootDir, env);
  if (typeof targetDir !== 'string' || !isAbsolute(targetDir)) throw new Error('Cargo target directory must be absolute.');
  const desktop = join(appPath, 'Contents/MacOS/gajae-app-desktop');
  await appFile(appPath, desktop);
  await execute('cargo', ['build', '--manifest-path', join(rootDir, 'src-tauri/Cargo.toml'),
    '--locked', '--release', '--target', TARGET, '--features', 'tauri/custom-protocol'], {
    cwd: join(rootDir, 'src-tauri'), env,
  });
  const rebuiltDesktop = join(targetDir, TARGET, 'release/gajae-app-desktop');
  const stat = await lstat(rebuiltDesktop);
  if (!stat.isFile() || stat.size === 0 || (stat.mode & 0o111) === 0) {
    throw new Error('Rebuilt desktop must be a nonempty regular executable.');
  }
  await execute('lipo', [rebuiltDesktop, '-verify_arch', 'arm64'], { cwd: join(rootDir, 'src-tauri'), env });
  // Never use an old path/manifest snapshot to bind newly copied executable bytes.
  const after = await readAppRuntimeManifests(appPath);
  if (!after.bytes.every((value, index) => value.equals(bytes[index]))) {
    throw new Error('Restamped runtime manifests changed during desktop rebuild.');
  }
  await appFile(appPath, desktop);
  await copyFile(rebuiltDesktop, desktop);
  return { desktop, rebuiltDesktop, payloadRuntimeManifestSha256 };
}
