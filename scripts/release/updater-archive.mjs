import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import {
  chmod,
  lchmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
} from 'node:fs/promises';
import { basename, dirname, posix, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createGunzip } from 'node:zlib';

import { create as createTar, extract as extractTar, Parser } from 'tar';

import { PRODUCT_NAME } from '../../shared/productIdentity.js';

import { UPDATER_ASSET_LIMITS } from './updater-artifacts.mjs';

const APP_ROOT = `${PRODUCT_NAME}.app`;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;
const ARCHIVE_FILE_TYPE = 'file';
const DIRECTORY_FILE_TYPE = 'directory';
const SYMLINK_FILE_TYPE = 'symlink';

/**
 * Limits specific to the single macOS updater archive contract. The two byte
 * limits are inherited from the shared release contract; the structural limits
 * prevent a small archive from creating an unreasonable metadata tree.
 */
export const UPDATER_ARCHIVE_LIMITS = Object.freeze({
  maxArchiveBytes: UPDATER_ASSET_LIMITS.maxArchiveBytes,
  maxExpandedBytes: UPDATER_ASSET_LIMITS.maxExpandedBytes,
  maxEntries: 100_000,
  maxDepth: 128,
  maxSymlinkDereferences: 64,
  maxMetadataBytes: UPDATER_ASSET_LIMITS.maxManifestBytes,
  maxPathBytes: 4096,
  maxSymlinkTargetBytes: 4096,
});

function demand(condition, message) {
  if (!condition) throw new Error(message);
}

function asLimits(options = {}) {
  const requested = options.limits ?? options;
  const number = (name, fallback, maximum, { integer = true } = {}) => {
    const value = requested[name] ?? fallback;
    demand(typeof value === 'number' && Number.isFinite(value) && value > 0
      && (!integer || Number.isSafeInteger(value)) && value <= maximum,
    `${name} must be a positive value no greater than the contract limit.`);
    return value;
  };
  return Object.freeze({
    maxArchiveBytes: number('maxArchiveBytes', UPDATER_ARCHIVE_LIMITS.maxArchiveBytes, UPDATER_ARCHIVE_LIMITS.maxArchiveBytes),
    maxExpandedBytes: number('maxExpandedBytes', UPDATER_ARCHIVE_LIMITS.maxExpandedBytes, UPDATER_ARCHIVE_LIMITS.maxExpandedBytes),
    maxEntries: number('maxEntries', UPDATER_ARCHIVE_LIMITS.maxEntries, UPDATER_ARCHIVE_LIMITS.maxEntries),
    maxDepth: number('maxDepth', UPDATER_ARCHIVE_LIMITS.maxDepth, UPDATER_ARCHIVE_LIMITS.maxDepth),
    maxSymlinkDereferences: number('maxSymlinkDereferences', UPDATER_ARCHIVE_LIMITS.maxSymlinkDereferences, UPDATER_ARCHIVE_LIMITS.maxSymlinkDereferences),
    maxMetadataBytes: number('maxMetadataBytes', UPDATER_ARCHIVE_LIMITS.maxMetadataBytes, UPDATER_ARCHIVE_LIMITS.maxMetadataBytes),
    maxPathBytes: number('maxPathBytes', UPDATER_ARCHIVE_LIMITS.maxPathBytes, UPDATER_ARCHIVE_LIMITS.maxPathBytes),
    maxSymlinkTargetBytes: number('maxSymlinkTargetBytes', UPDATER_ARCHIVE_LIMITS.maxSymlinkTargetBytes, UPDATER_ARCHIVE_LIMITS.maxSymlinkTargetBytes),
  });
}

function canonicalAlias(value) {
  return value.normalize('NFC').toLowerCase();
}

function safePathText(value, label, maxBytes) {
  demand(typeof value === 'string' && value.length > 0, `${label} must be a nonempty string.`);
  demand(!value.includes('\u0000'), `${label} contains a NUL byte.`);
  demand(Buffer.byteLength(value, 'utf8') <= maxBytes, `${label} exceeds its path length limit.`);
  // The archive is a macOS/POSIX contract. Backslashes are rejected rather
  // than becoming platform-dependent separators when a fixture is inspected
  // on another host.
  demand(!value.includes('\\'), `${label} contains a non-canonical backslash.`);
  return value;
}

function canonicalMemberPath(value, { directory = false, limits = UPDATER_ARCHIVE_LIMITS } = {}) {
  safePathText(value, 'Archive member path', limits.maxPathBytes);
  const hasTrailingSlash = value.endsWith('/');
  if (directory) {
    demand(!value.endsWith('//'), 'Directory member path has repeated trailing separators.');
  } else {
    demand(!hasTrailingSlash, 'Non-directory member path must not end with a separator.');
  }
  const stripped = hasTrailingSlash ? value.slice(0, -1) : value;
  demand(stripped.length > 0 && !stripped.startsWith('/') && !stripped.includes('//'),
    'Archive member path must be relative and canonical.');
  const parts = stripped.split('/');
  demand(parts.every(part => part.length > 0 && part !== '.' && part !== '..'),
    'Archive member path contains an empty, dot or dot-dot component.');
  demand(parts[0] === APP_ROOT, `Archive member must be rooted at ${APP_ROOT}.`);
  demand(parts.length <= limits.maxDepth, 'Archive member path is too deep.');
  for (const part of parts) {
    demand(!part.startsWith('._'), 'AppleDouble metadata is not part of the updater archive.');
  }
  return stripped;
}

function canonicalLinkTarget(value, limits) {
  safePathText(value, 'Symbolic-link target', limits.maxSymlinkTargetBytes);
  demand(!value.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(value),
    'Symbolic-link target must be relative to the app.');
  demand(!value.includes('//'), 'Symbolic-link target has repeated separators.');
  return value;
}

function resolveLinkTarget(memberPath, target) {
  const resolved = posix.normalize(posix.join(posix.dirname(memberPath), target));
  demand(resolved === APP_ROOT || resolved.startsWith(`${APP_ROOT}/`),
    `Symbolic link ${memberPath} escapes the app root.`);
  return resolved;
}

/**
 * Resolve a link target against the complete member map. Unlike a lexical
 * `join()/normalize()` check, this walks each path component and expands
 * internal symlinks before consuming the following component. That permits
 * framework layouts such as `Versions/Current/Foo` where `Current -> A` and
 * only `Versions/A/Foo` is an archive member.
 */
function resolveMappedLinkTarget(memberPath, target, byPath, limits, label) {
  const components = String(target).split('/');
  const stack = posix.dirname(memberPath).split('/');
  demand(stack[0] === APP_ROOT, `${label} symbolic link ${memberPath} has no canonical app parent.`);
  const seenLinks = new Set();
  let dereferences = 0;
  while (components.length > 0) {
    const component = components.shift();
    if (component === '' || component === '.') continue;
    if (component === '..') {
      demand(stack.length > 1, `${label} symbolic link ${memberPath} escapes the app root.`);
      stack.pop();
      continue;
    }
    demand(component !== '/', !component.includes('/'), `${label} symbolic link ${memberPath} has a non-canonical component.`);
    stack.push(component);
    demand(stack.length <= limits.maxDepth, `${label} symbolic link ${memberPath} targets an excessively deep path.`);
    const currentPath = stack.join('/');
    const current = byPath.get(currentPath);
    demand(current, `${label} symbolic link ${memberPath} targets a missing member: ${currentPath}.`);
    if (current.type !== SYMLINK_FILE_TYPE) continue;
    demand(++dereferences <= limits.maxSymlinkDereferences,
      `${label} symbolic link ${memberPath} exceeds the symlink dereference limit.`);
    demand(!seenLinks.has(currentPath), `${label} symbolic links contain a cycle at ${currentPath}.`);
    seenLinks.add(currentPath);
    stack.pop();
    components.unshift(...current.target.split('/'));
  }
  const resolved = stack.join('/');
  const final = byPath.get(resolved);
  demand(final, `${label} symbolic link ${memberPath} targets a missing member: ${resolved}.`);
  return resolved;
}

function relativeDepth(memberPath) {
  return memberPath.split('/').length;
}

function fileMode(stat) {
  return stat.mode & 0o7777;
}

function entryMode(entry, label) {
  demand(Number.isSafeInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o7777,
    `${label} has an invalid mode.`);
  return entry.mode;
}

function freezeRecord(record) {
  return Object.freeze(record);
}

function sortRecords(entries) {
  return [...entries].sort((left, right) => (
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  ));
}

function recordsFrom(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.entries)) return value.entries;
  if (value && value.inventory && Array.isArray(value.inventory.entries)) return value.inventory.entries;
  throw new Error('An app inventory entries array is required.');
}

function inventoryRoot(value) {
  if (Array.isArray(value)) return APP_ROOT;
  if (value?.inventory && !Array.isArray(value.entries)) return value.inventory.root;
  return value?.root;
}

/**
 * Validate the complete member map. This is intentionally run only after all
 * entries have been read, so a symlink that appears before a child entry still
 * blocks that child (and a link appearing later blocks earlier-looking paths).
 */
function validateMemberMap(entries, limits, label = 'Archive') {
  demand(Array.isArray(entries) && entries.length > 0, `${label} must contain at least one member.`);
  demand(entries.length <= limits.maxEntries, `${label} contains too many entries.`);
  const byPath = new Map();
  const byAlias = new Map();
  let fileBytes = 0;
  for (const entry of entries) {
    demand(entry && typeof entry === 'object', `${label} entries must be objects.`);
    const path = canonicalMemberPath(entry.path, {
      directory: entry.type === DIRECTORY_FILE_TYPE,
      limits,
    });
    demand(relativeDepth(path) <= limits.maxDepth, `${label} member path is too deep.`);
    demand(!byPath.has(path), `${label} contains a duplicate member: ${path}`);
    const alias = canonicalAlias(path);
    demand(!byAlias.has(alias), `${label} contains a case or Unicode alias: ${path}`);
    byPath.set(path, entry);
    byAlias.set(alias, path);
    if (entry.type === ARCHIVE_FILE_TYPE) {
      demand(Number.isSafeInteger(entry.size) && entry.size >= 0, `${label} file ${path} has an invalid size.`);
      demand(entry.size <= limits.maxExpandedBytes, `${label} file ${path} exceeds the expanded byte limit.`);
      demand(typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256),
        `${label} file ${path} has no canonical SHA-256.`);
      fileBytes += entry.size;
      demand(fileBytes <= limits.maxExpandedBytes, `${label} files exceed the expanded byte limit.`);
    } else if (entry.type === DIRECTORY_FILE_TYPE) {
      demand(entry.size === undefined || entry.size === 0, `${label} directory ${path} has file data.`);
    } else if (entry.type === SYMLINK_FILE_TYPE) {
      demand(entry.size === undefined || entry.size === 0, `${label} symbolic link ${path} has file data.`);
      canonicalLinkTarget(entry.target, limits);
    } else {
      throw new Error(`${label} contains an unsupported member type at ${path}.`);
    }
    entryMode(entry, `${label} member ${path}`);
  }

  const root = byPath.get(APP_ROOT);
  demand(root?.type === DIRECTORY_FILE_TYPE, `${label} must contain exactly one ${APP_ROOT} directory root.`);

  for (const entry of entries) {
    if (entry.path === APP_ROOT) continue;
    let parent = posix.dirname(entry.path);
    while (parent && parent !== '.') {
      const parentEntry = byPath.get(parent);
      demand(parentEntry, `${label} member ${entry.path} has no explicit parent directory: ${parent}.`);
      demand(parentEntry.type === DIRECTORY_FILE_TYPE,
        `${label} member ${entry.path} is beneath a non-directory ancestor ${parent}.`);
      parent = parent === APP_ROOT ? '' : posix.dirname(parent);
    }
  }

  for (const entry of entries) {
    if (entry.type !== SYMLINK_FILE_TYPE) continue;
    // Validate the target lexically first (absolute/dot-dot escape checks),
    // then resolve it through every map symlink component. Only member
    // *targets* may traverse a link; the archive's own member-parent check
    // above still forbids writing beneath any symlink ancestor.
    resolveLinkTarget(entry.path, entry.target);
    resolveMappedLinkTarget(entry.path, entry.target, byPath, limits, label);
  }

  return Object.freeze({
    entries: Object.freeze(sortRecords(entries).map(entry => freezeRecord({ ...entry }))),
    totalFileBytes: fileBytes,
  });
}

async function assertRegularArchive(archivePath, maxBytes) {
  demand(typeof archivePath === 'string' && archivePath.length > 0, 'Updater archive path is required.');
  // O_NONBLOCK is ignored for regular files but prevents a path swapped to a
  // FIFO from blocking before fstat can reject it.
  const fd = await open(resolve(archivePath), constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const stat = await fd.stat();
    demand(stat.isFile() && stat.size > 0, 'Updater archive must be a nonempty regular file.');
    demand(stat.size <= maxBytes, 'Updater archive exceeds the compressed byte limit.');
    return { fd, size: stat.size };
  } catch (error) {
    await fd.close().catch(() => {});
    throw error;
  }
}

class ByteLimitTransform extends Transform {
  #limit;
  #label;
  bytes = 0;

  constructor(limit, label, hash = false) {
    super();
    this.#limit = limit;
    this.#label = label;
    this.hash = hash ? createHash('sha256') : null;
  }

  _transform(chunk, encoding, callback) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.bytes += data.length;
    if (this.bytes > this.#limit) {
      callback(new Error(`${this.#label} exceeded ${this.#limit} bytes.`));
      return;
    }
    this.hash?.update(data);
    callback(null, data);
  }

  digest() {
    return this.hash?.digest('hex');
  }
}

function parserRecord(entry, limits) {
  const type = entry.type === 'File' ? ARCHIVE_FILE_TYPE
    : entry.type === 'Directory' ? DIRECTORY_FILE_TYPE
      : entry.type === 'SymbolicLink' ? SYMLINK_FILE_TYPE
        : undefined;
  demand(type, `Archive contains unsupported entry type ${entry.type}.`);
  const path = canonicalMemberPath(entry.path, { directory: type === DIRECTORY_FILE_TYPE, limits });
  const mode = entryMode(entry, `Archive member ${path}`);
  if (type === ARCHIVE_FILE_TYPE) {
    demand(Number.isSafeInteger(entry.size) && entry.size >= 0, `Archive file ${path} has an invalid size.`);
    return { path, type, mode, size: entry.size };
  }
  if (type === SYMLINK_FILE_TYPE) {
    demand(entry.size === 0, `Archive symbolic link ${path} has file data.`);
    return { path, type, mode, target: canonicalLinkTarget(entry.linkpath, limits) };
  }
  demand(entry.size === 0, `Archive directory ${path} has file data.`);
  return { path, type, mode };
}

async function parseArchive(archivePath, limits) {
  const archive = await assertRegularArchive(archivePath, limits.maxArchiveBytes);
  const records = [];
  let failure;
  let stopped = false;
  let count = 0;
  let declaredFileBytes = 0;
  const stop = error => {
    if (stopped) return;
    stopped = true;
    failure = error instanceof Error ? error : new Error(String(error));
    parser.abort(failure);
  };
  const parser = new Parser({
    strict: true,
    preservePaths: true,
    maxMetaEntrySize: limits.maxMetadataBytes,
    onReadEntry(entry) {
      if (stopped) return;
      count += 1;
      if (count > limits.maxEntries) {
        stop(new Error('Archive contains too many entries.'));
        return;
      }
      let record;
      try {
        record = parserRecord(entry, limits);
        if (record.type === ARCHIVE_FILE_TYPE) {
          declaredFileBytes += record.size;
          if (declaredFileBytes > limits.maxExpandedBytes) {
            stop(new Error('Archive files exceed the expanded byte limit.'));
            return;
          }
          const hash = createHash('sha256');
          let bytes = 0;
          entry.on('data', chunk => {
            if (stopped) return;
            bytes += chunk.length;
            hash.update(chunk);
            if (bytes > limits.maxExpandedBytes) {
              stop(new Error('Archive file exceeded the expanded byte limit.'));
            }
          });
          entry.on('end', () => {
            if (stopped) return;
            if (bytes !== record.size) {
              stop(new Error(`Archive file ${record.path} ended at ${bytes} bytes; expected ${record.size}.`));
            } else if (!record.sha256) {
              record.sha256 = hash.digest('hex');
            }
          });

        }
      } catch (error) {
        stop(error);
        return;
      }
      if (stopped) return;
      if (record) records.push(record);
      entry.on('error', error => stop(error));
      // Parser entries start paused. Resuming here is required for the parser
      // to reach the next header and for file bytes to be hashed.
      entry.resume();
    },
  });
  parser.on('meta', value => {
    if (stopped) return;
    count += 1;
    if (count > limits.maxEntries) {
      stop(new Error('Archive contains too many entries.'));
      return;
    }
    const size = Buffer.byteLength(String(value ?? ''), 'utf8');
    if (size > limits.maxMetadataBytes) {
      stop(new Error('Archive metadata exceeds its size limit.'));
    }
    // PAX/GNU metadata is bounded here and its effective path, mode, size and
    // link target are validated on the following ReadEntry. The selected
    // updater accepts maintained tar PAX path metadata (including paths over
    // the classic ustar 255-byte limit), so metadata itself is not rejected.
  });
  parser.on('ignoredEntry', entry => {
    if (stopped) return;
    count += 1;
    if (count > limits.maxEntries) {
      stop(new Error('Archive contains too many entries.'));
    } else if (entry?.meta && entry.size > limits.maxMetadataBytes) {
      stop(new Error('Archive metadata exceeds its size limit.'));
    } else {
      stop(new Error(`Archive contains an unsupported or ignored entry: ${entry?.path ?? '<unknown>'}.`));
    }
  });

  const compressed = new ByteLimitTransform(limits.maxArchiveBytes, 'Compressed archive');
  const decompressed = new ByteLimitTransform(limits.maxExpandedBytes, 'Decompressed archive');
  const gunzip = createGunzip();
  try {
    await pipeline(archive.fd.createReadStream({ autoClose: false }), compressed, gunzip, decompressed, parser);
    const finalStat = await archive.fd.stat();
    demand(finalStat.size === archive.size, 'Updater archive changed while it was being inspected.');
  } catch (error) {
    failure ??= error;
  } finally {
    await archive.fd.close().catch(() => {});
  }
  if (failure) throw failure;
  const normalized = validateMemberMap(records, limits, 'Updater archive');
  return Object.freeze({
    archivePath: resolve(archivePath),
    compressedBytes: compressed.bytes,
    expandedBytes: decompressed.bytes,
    inventory: Object.freeze({
      root: APP_ROOT,
      entries: normalized.entries,
      totalFileBytes: normalized.totalFileBytes,
    }),
  });
}

async function assertSafeDirectoryPath(directory, label) {
  const absolute = resolve(directory);
  const stat = await lstat(absolute);
  demand(stat.isDirectory() && !stat.isSymbolicLink(), `${label} must be a directory, not a symlink.`);
  const actual = await realpath(absolute);
  demand(actual === absolute, `${label} must not traverse a symbolic-link directory.`);
  if (typeof process.getuid === 'function') demand(stat.uid === process.getuid(), `${label} must be owned by the current user.`);
  demand((stat.mode & 0o077) === 0, `${label} must be owner-only private.`);
  return absolute;
}

async function createOutput(archivePath) {
  const absolute = resolve(archivePath);
  const parent = dirname(absolute);
  const parentStat = await lstat(parent);
  demand(parentStat.isDirectory() && !parentStat.isSymbolicLink(), 'Updater archive destination parent must be a real directory.');
  demand(await realpath(parent) === parent, 'Updater archive destination parent must not traverse a symlink.');
  const fd = await open(absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
  return { fd, archivePath: absolute };
}

async function hashFile(filePath, expected, limits, total) {
  // Keep the bounded-read operation nonblocking even if an app member is
  // replaced with a FIFO between lstat and open.
  const fd = await open(filePath, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const start = await fd.stat();
    demand(start.isFile() && start.size === expected.size, `App file ${expected.path} changed while it was being read.`);
    let bytes = 0;
    const hash = createHash('sha256');
    for await (const chunk of fd.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      total.value += chunk.length;
      demand(bytes <= limits.maxExpandedBytes && total.value <= limits.maxExpandedBytes,
        'App files exceed the expanded byte limit.');
      hash.update(chunk);
    }
    demand(bytes === start.size, `App file ${expected.path} ended at an unexpected size.`);
    const end = await fd.stat();
    demand(end.isFile() && end.size === start.size, `App file ${expected.path} changed while it was being read.`);
    return { size: bytes, sha256: hash.digest('hex') };
  } finally {
    await fd.close().catch(() => {});
  }
}

/**
 * Build a deterministic inventory of a final `.app` directory. File hashes and
 * byte lengths stand in for file contents; timestamps, owners and inode data
 * are deliberately absent. Symlinks are read without following them.
 */
export async function inventoryApp(appPath, options = {}) {
  const limits = asLimits(options);
  demand(typeof appPath === 'string' && appPath.length > 0, 'App path is required.');
  const absoluteRoot = resolve(appPath);
  demand(basename(absoluteRoot) === APP_ROOT, `App path must end in ${APP_ROOT}.`);
  const rootStat = await lstat(absoluteRoot);
  demand(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'App root must be a real directory.');
  const entries = [];
  const total = { value: 0 };

  async function visit(absolute, memberPath) {
    demand(entries.length < limits.maxEntries, 'App contains too many entries.');
    const stat = await lstat(absolute);
    if (stat.isDirectory()) {
      entries.push({ path: memberPath, type: DIRECTORY_FILE_TYPE, mode: fileMode(stat) });
      const names = await readdir(absolute);
      names.sort();
      for (const name of names) {
        demand(name !== '' && name !== '.' && name !== '..' && !name.includes('\u0000'),
          'App contains an invalid member name.');
        const childPath = `${memberPath}/${name}`;
        canonicalMemberPath(childPath, { directory: false, limits });
        await visit(resolve(absolute, name), childPath);
      }
      return;
    }
    if (stat.isSymbolicLink()) {
      const target = canonicalLinkTarget(await readlink(absolute), limits);
      entries.push({ path: memberPath, type: SYMLINK_FILE_TYPE, mode: fileMode(stat), target });
      return;
    }
    demand(stat.isFile(), `App contains a special file at ${memberPath}.`);
    demand(stat.nlink === undefined || stat.nlink <= 1, `App contains a hard-linked file at ${memberPath}.`);
    demand(stat.size <= limits.maxExpandedBytes, `App file ${memberPath} exceeds the expanded byte limit.`);
    const expected = { path: memberPath, size: stat.size };
    const content = await hashFile(absolute, expected, limits, total);
    entries.push({ path: memberPath, type: ARCHIVE_FILE_TYPE, mode: fileMode(stat), ...content });
  }

  await visit(absoluteRoot, APP_ROOT);
  const normalized = validateMemberMap(entries, limits, 'App inventory');
  return Object.freeze({
    root: APP_ROOT,
    entries: normalized.entries,
    totalFileBytes: normalized.totalFileBytes,
  });
}

/**
 * Compare two complete inventories. A successful comparison returns `true`; a
 * mismatch identifies the first path/field and never falls back to comparing
 * only a checksum or the runtime manifest.
 */
export function compareAppInventories(expected, actual) {
  demand(inventoryRoot(expected) === APP_ROOT && inventoryRoot(actual) === APP_ROOT,
    `App inventories must use the canonical ${APP_ROOT} root.`);
  const left = sortRecords(recordsFrom(expected));
  const right = sortRecords(recordsFrom(actual));
  demand(left.length === right.length, `App inventories differ in entry count (${left.length} !== ${right.length}).`);
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    demand(a.path === b.path, `App inventories differ at member ${a.path ?? b.path}.`);
    demand(a.type === b.type, `App member ${a.path} type differs.`);
    demand(a.mode === b.mode, `App member ${a.path} mode differs.`);
    if (a.type === ARCHIVE_FILE_TYPE) {
      demand(a.size === b.size && a.sha256 === b.sha256, `App member ${a.path} bytes differ.`);
    } else if (a.type === SYMLINK_FILE_TYPE) {
      demand(a.target === b.target, `App member ${a.path} symbolic-link target differs.`);
    }
  }
  return true;
}

/**
 * Safely inspect a `.app.tar.gz` using tar's maintained parser and an explicit
 * gzip stream. `expandedBytes` counts the entire decompressed tar stream, not
 * merely the sum of declared file sizes, so headers/padding cannot bypass the
 * absolute one-gigabyte cap.
 */
export async function inspectUpdaterArchive({ archivePath, ...options } = {}) {
  const limits = asLimits(options);
  return parseArchive(archivePath, limits);
}

/**
 * Create a deterministic single-root archive from an already-final app. The
 * source is never signed, stapled, or otherwise mutated. Existing output is
 * refused, and the generated bytes are inspected again before being returned.
 */
export async function createUpdaterArchive({ appPath, archivePath, ...options } = {}) {
  const limits = asLimits(options);
  demand(typeof appPath === 'string' && typeof archivePath === 'string', 'App and archive paths are required.');
  const sourceInventory = await inventoryApp(appPath, limits);
  const sourceRoot = resolve(appPath);
  const destinationPath = resolve(archivePath);
  demand(destinationPath !== sourceRoot && !destinationPath.startsWith(`${sourceRoot}/`),
    'Updater archive output must not be inside the source app.');
  const output = await createOutput(archivePath);
  let outputClosed = false;
  try {
    const sourceByPath = new Map(sourceInventory.entries.map(entry => [entry.path, entry]));
    const paths = sourceInventory.entries.map(entry => entry.path);
    const pack = createTar({
      cwd: dirname(sourceRoot),
      gzip: { portable: true, level: 6 },
      noMtime: true,
      // `portable:true` intentionally changes modes to a 0644/0755-style
      // default. The archive contract preserves the final app's modes, so
      // metadata is removed in the callback below without changing the mode
      // field. Maintained tar PAX path metadata remains enabled for long
      // bundled paths.
      portable: false,
      follow: false,
      noDirRecurse: true,
      jobs: 1,
      strict: true,
      preservePaths: false,
      filter: (path) => !basename(path).startsWith('._'),
      onWriteEntry: entry => {
        const stat = Object.assign(Object.create(Object.getPrototypeOf(entry.stat)), entry.stat, {
          mode: entry.stat.mode,
          size: entry.stat.size,
          uid: undefined,
          gid: undefined,
          uname: undefined,
          gname: undefined,
          atime: undefined,
          ctime: undefined,
          dev: undefined,
          ino: undefined,
          nlink: undefined,
        });
        entry.stat = stat;
        entry.noMtime = true;
        const expected = sourceByPath.get(entry.path.replace(/\/$/, ''));
        demand(expected, `Unexpected source member while packing: ${entry.path}.`);
        demand(entry.type === (expected.type === ARCHIVE_FILE_TYPE ? 'File'
          : expected.type === DIRECTORY_FILE_TYPE ? 'Directory' : 'SymbolicLink'),
        `Source member ${entry.path} changed type while packing.`);
      },
    }, paths);
    const limited = new ByteLimitTransform(limits.maxArchiveBytes, 'Compressed archive', true);
    // Keep descriptor ownership here. A FileHandle-owned stream retains a
    // reference after finish when autoClose:false, deadlocking handle.close().
    const stream = createWriteStream(output.archivePath, { fd: output.fd.fd, autoClose: false });
    try {
      await pipeline(pack, limited, stream);
      await output.fd.sync();
    } finally {
      await output.fd.close().catch(() => {});
      outputClosed = true;
    }
    const inspected = await inspectUpdaterArchive({ archivePath: output.archivePath, ...limits });
    const finalSourceInventory = await inventoryApp(appPath, limits);
    compareAppInventories(sourceInventory, finalSourceInventory);
    compareAppInventories(finalSourceInventory, inspected.inventory);
    return Object.freeze({
      archivePath: output.archivePath,
      sha256: limited.digest(),
      size: limited.bytes,
      compressedBytes: inspected.compressedBytes,
      expandedBytes: inspected.expandedBytes,
      inventory: finalSourceInventory,
    });
  } catch (error) {
    if (!outputClosed) await output.fd.close().catch(() => {});
    await rm(output.archivePath, { force: true }).catch(() => {});
    throw error;
  }
}

async function applyAndVerifyModes(appPath, expectedEntries, actualEntries) {
  const expectedByPath = new Map(expectedEntries.map(entry => [entry.path, entry]));
  // Verify and set children before parents, so even an archive containing a
  // non-searchable directory can be checked while its parent remains usable.
  const paths = [...actualEntries].sort((left, right) => right.path.split('/').length - left.path.split('/').length);
  for (const actual of paths) {
    const expected = expectedByPath.get(actual.path);
    demand(expected, `Extracted app contains an unexpected member ${actual.path}.`);
    const fullPath = resolve(appPath, relative(APP_ROOT, actual.path));
    if (actual.type === SYMLINK_FILE_TYPE) {
      const stat = await lstat(fullPath);
      demand(stat.isSymbolicLink() && fileMode(stat) === expected.mode,
        `Extracted symbolic link ${actual.path} mode differs.`);
      continue;
    }
    await chmod(fullPath, expected.mode);
    const stat = await lstat(fullPath);
    demand((stat.isDirectory() ? DIRECTORY_FILE_TYPE : stat.isFile() ? ARCHIVE_FILE_TYPE : undefined) === expected.type
      && fileMode(stat) === expected.mode,
    `Extracted member ${actual.path} mode or type differs.`);
  }
}

async function assertRealLinkParent(appRoot, linkPath) {
  const root = await realpath(appRoot);
  const parent = dirname(linkPath);
  const parentRelative = relative(root, parent);
  demand(parentRelative === '' || (!parentRelative.startsWith('..') && !parentRelative.startsWith('/')),
    'Symbolic-link parent escaped the extracted app root.');
  let current = root;
  for (const component of parentRelative.split(/[\\/]/u).filter(Boolean)) {
    current = resolve(current, component);
    const stat = await lstat(current);
    demand(stat.isDirectory() && !stat.isSymbolicLink(),
      `Symbolic-link parent contains a non-directory or symbolic link: ${current}.`);
    demand(await realpath(current) === current,
      `Symbolic-link parent traverses a symbolic-link directory: ${current}.`);
  }
}

async function createValidatedSymlinks(appRoot, entries, limits) {
  for (const entry of entries.filter(item => item.type === SYMLINK_FILE_TYPE).sort((a, b) => (
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  ))) {
    const linkPath = resolve(appRoot, relative(APP_ROOT, entry.path));
    await assertRealLinkParent(appRoot, linkPath);
    try {
      await lstat(linkPath);
      throw new Error(`Extraction would overwrite an existing member at ${entry.path}.`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await symlink(canonicalLinkTarget(entry.target, limits), linkPath);
    const created = await lstat(linkPath);
    demand(created.isSymbolicLink(), `Extracted symbolic link ${entry.path} was not created as a link.`);
    const createdMode = fileMode(created);
    if (createdMode !== entry.mode) {
      demand(typeof lchmod === 'function',
        `Cannot restore symbolic-link mode for ${entry.path}: lchmod is unavailable.`);
      try {
        await lchmod(linkPath, entry.mode);
      } catch (error) {
        throw new Error(`Cannot restore symbolic-link mode for ${entry.path}.`, { cause: error });
      }
      const restored = await lstat(linkPath);
      demand(restored.isSymbolicLink() && fileMode(restored) === entry.mode,
        `Symbolic-link mode restoration did not settle for ${entry.path}.`);
    }
  }
}

/**
 * Extract a previously inspected archive into a fresh owner-only directory.
 * The caller owns the returned directory and should remove it after release
 * verification. On any failure the generated directory is removed before the
 * error is rethrown.
 */
export async function extractUpdaterArchive({ archivePath, root, destination, ...options } = {}) {
  const limits = asLimits(options);
  demand(typeof root === 'string' && root.length > 0, 'A private extraction parent is required.');
  const parent = await assertSafeDirectoryPath(root, 'Extraction parent');
  const inspected = await parseArchive(archivePath, limits);
  const extractionRoot = destination === undefined
    ? await mkdtemp(`${parent}/.updater-extract-`)
    : resolve(destination);
  let created = false;
  try {
    if (destination !== undefined) {
      demand(dirname(extractionRoot) === parent,
        'A requested extraction directory must be a fresh child of the private extraction parent.');
      await mkdir(extractionRoot, { mode: 0o700 });
    }
    created = true;
    await chmod(extractionRoot, 0o700);
    await assertSafeDirectoryPath(extractionRoot, 'Extraction directory');
    const expectedByPath = new Map(inspected.inventory.entries.map(entry => [entry.path, entry]));
    const unpack = extractTar({
      // tar's synchronous unpacker completes filesystem writes before each
      // parser write returns. This prevents an extraction error from racing
      // cleanup of the private directory.
      sync: true,
      cwd: extractionRoot,
      strict: true,
      preservePaths: false,
      noMtime: true,
      preserveOwner: false,
      chmod: true,
      processUmask: 0,
      keep: true,
      unlink: false,
      maxDepth: limits.maxDepth,
      maxMetaEntrySize: limits.maxMetadataBytes,
      filter: (path, entry) => {
        const canonical = canonicalMemberPath(path, { directory: entry.type === 'Directory', limits });
        const expected = expectedByPath.get(canonical);
        demand(expected, `Archive changed while extracting at ${canonical}.`);
        demand((entry.type === 'File' ? ARCHIVE_FILE_TYPE : entry.type === 'Directory' ? DIRECTORY_FILE_TYPE
          : entry.type === 'SymbolicLink' ? SYMLINK_FILE_TYPE : undefined) === expected.type,
        `Archive member ${canonical} type changed while extracting.`);
        demand(entry.mode === expected.mode, `Archive member ${canonical} mode changed while extracting.`);
        if (expected.type === SYMLINK_FILE_TYPE) {
          demand(canonicalLinkTarget(entry.linkpath, limits) === expected.target,
            `Archive symbolic-link target changed while extracting at ${canonical}.`);
        }
        if (expected.type === ARCHIVE_FILE_TYPE) demand(entry.size === expected.size,
          `Archive member ${canonical} size changed while extracting.`);
        // tar's async symlink path check cannot understand valid links through
        // another internal link (eg Framework/Foo -> Versions/Current/Foo).
        // All links were validated from the complete map above; create them
        // only after tar has synchronously extracted regular entries.
        return expected.type !== SYMLINK_FILE_TYPE;
      },
    });
    const archive = await assertRegularArchive(archivePath, limits.maxArchiveBytes);
    try {
      await pipeline(
        archive.fd.createReadStream({ autoClose: false }),
        new ByteLimitTransform(limits.maxArchiveBytes, 'Compressed archive'),
        createGunzip(),
        new ByteLimitTransform(limits.maxExpandedBytes, 'Decompressed archive'),
        unpack,
      );
      const finalStat = await archive.fd.stat();
      demand(finalStat.size === archive.size, 'Updater archive changed while it was being extracted.');
    } finally {
      await archive.fd.close().catch(() => {});
    }
    const extractedApp = resolve(extractionRoot, APP_ROOT);
    await createValidatedSymlinks(extractedApp, inspected.inventory.entries, limits);
    const extractedInventory = await inventoryApp(extractedApp, limits);
    const expectedShape = inspected.inventory.entries.map(entry => ({ ...entry }));
    const actualShape = extractedInventory.entries.map(entry => ({ ...entry }));
    for (const entry of actualShape) delete entry.mode;
    for (const entry of expectedShape) delete entry.mode;
    compareAppInventories(expectedShape, actualShape);
    for (const entry of inspected.inventory.entries) {
      if (entry.type !== SYMLINK_FILE_TYPE) continue;
      const full = resolve(extractedApp, relative(APP_ROOT, entry.path));
      const resolvedTarget = await realpath(full);
      const escaped = relative(extractedApp, resolvedTarget);
      demand(escaped === '' || (!escaped.startsWith('..') && !escaped.startsWith('/')),
        `Extracted symbolic link ${entry.path} resolves outside the app root.`);
    }
    await applyAndVerifyModes(extractedApp, inspected.inventory.entries, extractedInventory.entries);
    const finalEntries = extractedInventory.entries.map(entry => ({
      ...entry,
      mode: expectedByPath.get(entry.path).mode,
    }));
    compareAppInventories(inspected.inventory.entries, finalEntries);
    return Object.freeze({
      directory: extractionRoot,
      extractionRoot,
      appPath: extractedApp,
      inventory: Object.freeze({ root: APP_ROOT, entries: Object.freeze(finalEntries), totalFileBytes: inspected.inventory.totalFileBytes }),
      archive: inspected,
    });
  } catch (error) {
    if (created) {
      try {
        await rm(extractionRoot, { recursive: true, force: true });
      } catch (cleanupError) {
        throw Object.assign(new Error(`Extraction failed and its temporary directory could not be removed: ${extractionRoot}`, { cause: error }), {
          preserveDirectory: true,
          cleanupError,
        });
      }
    }
    throw error;
  }
}

/** Remove a directory returned by extractUpdaterArchive. */
export async function cleanupUpdaterExtraction(extraction) {
  const directory = extraction?.directory ?? extraction?.extractionRoot;
  demand(typeof directory === 'string' && basename(directory).startsWith('.updater-extract-'),
    'A directory returned by extractUpdaterArchive is required.');
  await rm(directory, { recursive: true, force: true });
}

export { APP_ROOT as UPDATER_APP_ROOT };
