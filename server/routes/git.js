import path from 'path';
import { promises as fs } from 'fs';

import express from 'express';
// cross-spawn: drop-in spawn with Windows .cmd/PATHEXT resolution.
import spawn from 'cross-spawn';

import { projectsDb } from '../modules/database/index.js';
import { asyncHandler } from '../shared/utils.js';

const router = express.Router();

function spawnAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      shell: false,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const error = new Error(`Command failed: ${command} ${args.join(' ')}`);
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

/**
 * Runs a command while retaining at most `stdoutLimit` characters. This is
 * deliberately separate from spawnAsync: other git routes still need their
 * complete command output, while diff patches must never be fully buffered.
 */
function spawnBounded(command, args, {
  stdoutLimit,
  allowedExitCodes = [0],
  timeoutMs = 15000,
  ...options
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, shell: false });
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let killedForLimit = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on('data', (data) => {
      if (truncated) return;
      const remaining = stdoutLimit - stdoutBytes;
      if (remaining > 0) {
        const retained = data.subarray(0, remaining);
        stdoutChunks.push(retained);
        stdoutBytes += retained.length;
      }
      if (data.length > remaining) {
        truncated = true;
        killedForLimit = true;
        child.kill();
      }
    });
    child.stderr.on('data', (data) => {
      const remaining = 8192 - stderrBytes;
      if (remaining <= 0) return;
      const retained = data.subarray(0, remaining);
      stderrChunks.push(retained);
      stderrBytes += retained.length;
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      const stdout = Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8');
      const stderr = Buffer.concat(stderrChunks, stderrBytes).toString('utf8');
      if (timedOut) {
        const error = new Error(`Command timed out: ${command} ${args.join(' ')}`);
        error.code = 'ETIMEDOUT';
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      if (killedForLimit) {
        resolve({ stdout, stderr, truncated: true });
        return;
      }
      if (allowedExitCodes.includes(code)) {
        resolve({ stdout, stderr, truncated: false });
        return;
      }
      const error = new Error(`Command failed: ${command} ${args.join(' ')}`);
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

function streamNullRecords(command, args, { cwd, onRecord, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false });
    const decoder = new TextDecoder();
    let pending = '';
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on('data', (data) => {
      const records = `${pending}${decoder.decode(data, { stream: true })}`.split('\0');
      pending = records.pop() ?? '';
      for (const record of records) {
        if (record) onRecord(record);
      }
    });
    child.stderr.on('data', (data) => {
      if (stderr.length < 8192) stderr += data.toString('utf8', 0, 8192 - stderr.length);
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      pending += decoder.decode();
      if (pending) onRecord(pending);
      if (timedOut) {
        reject(new Error(`Command timed out: ${command} ${args.join(' ')}`));
      } else if (code === 0) {
        resolve();
      } else {
        const error = new Error(`Command failed: ${command} ${args.join(' ')}`);
        error.code = code;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

// Input validation helpers (defense-in-depth)
function validateBranchName(branch) {
  if (!/^[a-zA-Z0-9._\/-]+$/.test(branch)) {
    throw new Error('Invalid branch name');
  }
  return branch;
}

function validateRemoteName(remote) {
  if (!/^[a-zA-Z0-9._-]+$/.test(remote)) {
    throw new Error('Invalid remote name');
  }
  return remote;
}

function validateProjectPath(projectPath) {
  if (!projectPath || projectPath.includes('\0')) {
    throw new Error('Invalid project path');
  }
  const resolved = path.resolve(projectPath);
  // Must be an absolute path after resolution
  if (!path.isAbsolute(resolved)) {
    throw new Error('Invalid project path: must be absolute');
  }
  // Block obviously dangerous paths
  if (resolved === '/' || resolved === path.sep) {
    throw new Error('Invalid project path: root directory not allowed');
  }
  return resolved;
}

/**
 * Resolve the absolute project directory for a given DB `projectId`.
 *
 * After the projectName → projectId migration, every git endpoint receives
 * the DB primary key (`project` query/body param). The legacy filesystem
 * resolver that walked Claude's JSONL history is no longer used here; the
 * path comes straight from the `projects` table and is then sanity-checked
 * by `validateProjectPath` before any `git` command runs against it.
 */
async function getActualProjectPath(projectId, sessionId) {
  if (sessionId !== undefined) {
    const { resolveSessionWorkspacePath } = await import('../services/session-worktree-paths.js');
    return validateProjectPath(await resolveSessionWorkspacePath(projectId, sessionId));
  }
  const projectPath = await projectsDb.getProjectPathById(projectId);
  if (!projectPath) {
    throw new Error(`Unable to resolve project path for "${projectId}"`);
  }
  return validateProjectPath(projectPath);
}

// Helper function to validate git repository
async function validateGitRepository(projectPath) {
  try {
    // Check if directory exists
    await fs.access(projectPath);
  } catch {
    throw new Error(`Project path not found: ${projectPath}`);
  }

  try {
    // Allow any directory that is inside a work tree (repo root or nested folder).
    const { stdout: insideWorkTreeOutput } = await spawnAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: projectPath });
    const isInsideWorkTree = insideWorkTreeOutput.trim() === 'true';
    if (!isInsideWorkTree) {
      throw new Error('Not inside a git work tree');
    }

    // Ensure git can resolve the repository root for this directory.
    await spawnAsync('git', ['rev-parse', '--show-toplevel'], { cwd: projectPath });
  } catch {
    throw new Error('Not a git repository. This directory does not contain a .git folder. Initialize a git repository with "git init" to use source control features.');
  }
}

async function getGitProjectContext(projectPath) {
  const resolvedProjectPath = await fs.realpath(projectPath);
  const { stdout } = await spawnAsync('git', ['rev-parse', '--show-toplevel'], { cwd: resolvedProjectPath });
  const repositoryRoot = path.resolve(stdout.trim());
  const relativePath = path.relative(repositoryRoot, resolvedProjectPath);
  if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error('Project path is outside its git work tree');
  }
  return {
    repositoryRoot,
    projectPath: resolvedProjectPath,
    projectPrefix: relativePath.split(path.sep).join('/'),
  };
}

function gitPathspec(projectPrefix) {
  return projectPrefix || '.';
}

export function projectRelativeGitPath(filePath, projectPrefix) {
  if (!projectPrefix) return filePath;
  if (filePath === projectPrefix) return '';
  const prefix = `${projectPrefix}/`;
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : null;
}

function projectRelativeStatusEntries(statusOutput, projectPrefix) {
  return parseGitStatusEntries(statusOutput).flatMap((entry) => {
    const relative = projectRelativeStatusEntry(entry, projectPrefix);
    return relative ? [relative] : [];
  });
}

/**
 * The runtime keeps each session's scratch (runtime state, workflow gates,
 * lock files) under `.gjc/_session-<id>/` inside the project. It is never
 * something to review or commit, and a project without a `.gitignore` for it
 * shows hundreds of those rows before its first real change. `.gjc/` itself
 * stays: skills and rules there are the user's.
 */
const RUNTIME_SESSION_SCRATCH = /^\.gjc\/_session-[^/]+\//;

function projectRelativeStatusEntry(entry, projectPrefix) {
  const filePath = projectRelativeGitPath(entry.path, projectPrefix);
  if (!filePath || RUNTIME_SESSION_SCRATCH.test(filePath)) return null;
  const oldPath = entry.oldPath ? projectRelativeGitPath(entry.oldPath, projectPrefix) : null;
  return { ...entry, path: filePath, oldPath };
}

async function readBoundedProjectStatusEntries(repositoryRoot, projectPrefix) {
  const trackedEntries = [];
  const untrackedEntries = [];
  let trackedCount = 0;
  let untrackedCount = 0;
  let renameRecord = null;

  const retain = (entry) => {
    const relative = projectRelativeStatusEntry(entry, projectPrefix);
    if (!relative) return;
    if (relative.status === 'untracked') {
      untrackedCount += 1;
      if (untrackedEntries.length < DIFF_FILE_LIMIT) untrackedEntries.push(relative);
    } else {
      trackedCount += 1;
      if (trackedEntries.length < DIFF_FILE_LIMIT) trackedEntries.push(relative);
    }
  };
  const parseRecord = (record, oldPath = null) => {
    const suffix = oldPath === null ? '\0' : `\0${oldPath}\0`;
    const [entry] = parseGitStatusEntries(`${record}${suffix}`);
    if (entry) retain(entry);
  };

  await streamNullRecords('git', [
    '--literal-pathspecs',
    'status', '--porcelain=v1', '-z', '--untracked-files=all',
    '--', gitPathspec(projectPrefix),
  ], {
    cwd: repositoryRoot,
    onRecord: (record) => {
      if (renameRecord !== null) {
        parseRecord(renameRecord, record);
        renameRecord = null;
        return;
      }
      if (record.length >= 2 && (record[0] === 'R' || record[0] === 'C' || record[1] === 'R' || record[1] === 'C')) {
        renameRecord = record;
        return;
      }
      parseRecord(record);
    },
  });
  if (renameRecord !== null) parseRecord(renameRecord);

  return {
    trackedEntries,
    untrackedEntries,
    totalFiles: trackedCount + untrackedCount,
  };
}

async function readSelectedNumstatFiles(repositoryRoot, projectPrefix, hasCommits, statusByPath) {
  const files = [];
  let renameRecords = null;
  const retain = (records) => {
    const [file] = parseGitNumstatOutput(`${records.join('\0')}\0`);
    if (!file) return;
    const filePath = projectRelativeGitPath(file.path, projectPrefix);
    if (!filePath || !statusByPath.has(filePath)) return;
    const oldPath = file.oldPath ? projectRelativeGitPath(file.oldPath, projectPrefix) : null;
    const status = statusByPath.get(filePath);
    files.push({
      ...file,
      path: filePath,
      oldPath: status.oldPath || oldPath,
      status: status.status,
      staged: status.staged,
    });
  };

  await streamNullRecords('git', [
    '-c', 'core.quotepath=false',
    '-c', 'diff.renames=true',
    '--literal-pathspecs',
    'diff', hasCommits ? 'HEAD' : EMPTY_TREE_HASH,
    '--no-color', '--numstat', '-z', '--', gitPathspec(projectPrefix),
  ], {
    cwd: repositoryRoot,
    onRecord: (record) => {
      if (renameRecords !== null) {
        renameRecords.push(record);
        if (renameRecords.length === 3) {
          retain(renameRecords);
          renameRecords = null;
        }
        return;
      }
      const fields = record.split('\t');
      if (fields.length >= 3 && fields.slice(2).join('\t') === '') {
        renameRecords = [record];
      } else {
        retain([record]);
      }
    },
  });

  return files;
}

function getGitErrorDetails(error) {
  return `${error?.message || ''} ${error?.stderr || ''} ${error?.stdout || ''}`;
}

function isMissingHeadRevisionError(error) {
  const errorDetails = getGitErrorDetails(error).toLowerCase();
  return errorDetails.includes('unknown revision')
    || errorDetails.includes('ambiguous argument')
    || errorDetails.includes('needed a single revision')
    || errorDetails.includes('bad revision');
}

async function getCurrentBranchName(projectPath) {
  try {
    // symbolic-ref works even when the repository has no commits.
    const { stdout } = await spawnAsync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: projectPath });
    const branchName = stdout.trim();
    if (branchName) {
      return branchName;
    }
  } catch (error) {
    // Fall back to rev-parse for detached HEAD and older git edge cases.
  }

  const { stdout } = await spawnAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectPath });
  return stdout.trim();
}

async function repositoryHasCommits(projectPath) {
  try {
    await spawnAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: projectPath });
    return true;
  } catch (error) {
    if (isMissingHeadRevisionError(error)) {
      return false;
    }
    throw error;
  }
}

// Get git status for a project
/**
 * Parses `git status --porcelain=v1 -z` output into the response shape the
 * workspace Status tab consumes. NUL-separated entries carry no path quoting,
 * so names with spaces/unicode survive intact (the plain porcelain output
 * quotes and escapes them, which broke the old line-based parser).
 *
 * `staged` lists paths with index-side changes so the summary always mirrors
 * the real git index (including files staged outside the app, e.g. via
 * VSCode or the terminal).
 *
 * Exported for tests.
 */
export function parseGitStatusEntries(statusOutput) {
  const entries = [];
  const statusEntries = statusOutput.split('\0');
  for (let entryIndex = 0; entryIndex < statusEntries.length; entryIndex++) {
    const entry = statusEntries[entryIndex];
    if (!entry || entry.length < 4) continue;

    // Porcelain v1: X = index (staged) status, Y = worktree (unstaged) status.
    const indexStatus = entry[0];
    const worktreeStatus = entry[1];
    const path = entry.slice(3);
    let oldPath = null;

    // Renames/copies carry the original path as the following NUL entry;
    // the UI tracks the post-rename path only.
    if (indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R' || worktreeStatus === 'C') {
      oldPath = statusEntries[++entryIndex] || null;
    }

    if (indexStatus === '?') {
      entries.push({ path, oldPath: null, status: 'untracked', staged: false });
      continue;
    }
    if (indexStatus === '!') {
      continue; // ignored files are never reported
    }

    const isConflict =
      indexStatus === 'U' || worktreeStatus === 'U' ||
      (indexStatus === 'A' && worktreeStatus === 'A') ||
      (indexStatus === 'D' && worktreeStatus === 'D');
    if (isConflict) {
      // Merge conflicts must be resolved in the worktree first; surface them
      // as modified and never as staged.
      entries.push({ path, oldPath, status: 'modified', staged: false });
      continue;
    }

    const status = indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R' || worktreeStatus === 'C'
      ? 'renamed'
      : indexStatus === 'D' || worktreeStatus === 'D'
        ? 'deleted'
        : indexStatus === 'A' || worktreeStatus === 'A'
          ? 'added'
          : 'modified';
    entries.push({ path, oldPath, status, staged: indexStatus !== ' ' });
  }

  return entries;
}

export function parseGitStatusOutput(statusOutput) {
  return summarizeGitStatusEntries(parseGitStatusEntries(statusOutput));
}

function summarizeGitStatusEntries(entries) {
  const modified = [];
  const added = [];
  const deleted = [];
  const untracked = [];
  const staged = [];

  for (const entry of entries) {
    if (entry.status === 'untracked') {
      untracked.push(entry.path);
      continue;
    }
    if (entry.staged) staged.push(entry.path);
    if (entry.status === 'deleted') {
      deleted.push(entry.path);
    } else if (entry.status === 'added') {
      added.push(entry.path);
    } else {
      modified.push(entry.path);
    }
  }

  return { modified, added, deleted, untracked, staged };
}

function statusFromNumstat(additions, deletions) {
  if (additions > 0 && deletions === 0) return 'added';
  if (additions === 0 && deletions > 0) return 'deleted';
  return 'modified';
}

/**
 * Parses NUL-delimited `git diff --numstat -z` output. Renames use an empty
 * path field followed by the old and new paths. NUL-delimited paths are
 * literal and may themselves contain strings such as ` => `.
 */
export function parseGitNumstatOutput(numstatOutput) {
  const files = [];
  const entries = numstatOutput.split('\0');
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry) continue;
    const fields = entry.split('\t');
    if (fields.length < 3) continue;

    const [additionsText, deletionsText, ...pathFields] = fields;
    let filePath = pathFields.join('\t');
    let oldPath = null;
    if (!filePath) {
      oldPath = entries[++index] || null;
      filePath = entries[++index] || '';
    }
    if (!filePath) continue;

    const binary = additionsText === '-' || deletionsText === '-';
    const additions = binary ? 0 : Number.parseInt(additionsText, 10);
    const deletions = binary ? 0 : Number.parseInt(deletionsText, 10);
    files.push({
      path: filePath,
      oldPath,
      status: oldPath ? 'renamed' : statusFromNumstat(additions, deletions),
      additions: Number.isNaN(additions) ? 0 : additions,
      deletions: Number.isNaN(deletions) ? 0 : deletions,
      binary,
    });
  }
  return files;
}

/** How many files one response lists, however many the tree holds. */
const DIFF_FILE_LIMIT = 1000;
const DIFF_PER_FILE_LIMIT = 50000;
const DIFF_TOTAL_LIMIT = 400000;
const DIFF_PATCH_FILE_LIMIT = 100;
const FILE_METADATA_CONCURRENCY = 8;
const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

async function mapWithConcurrency(values, limit, mapper) {
  const result = new Array(values.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      result[index] = await mapper(values[index], index);
    }
  }));
  return result;
}

export function isBinaryContent(buffer) {
  return buffer.includes(0);
}

export async function inspectUntrackedFile(projectPath, filePath) {
  const absolutePath = path.join(projectPath, filePath);
  try {
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      return { binary: false, symlinkTarget: await fs.readlink(absolutePath) };
    }
    if (!stat.isFile()) {
      return { previewUnsupported: true };
    }

    const file = await fs.open(absolutePath, 'r');
    try {
      const buffer = Buffer.alloc(8192);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      return { binary: isBinaryContent(buffer.subarray(0, bytesRead)) };
    } finally {
      await file.close();
    }
  } catch {
    return { previewUnsupported: true };
  }
}

function patchLineCounts(patch) {
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@ ')) {
      inHunk = true;
      continue;
    }
    if (!inHunk || line === '\\ No newline at end of file') continue;
    if (line.startsWith('+')) additions++;
    if (line.startsWith('-')) deletions++;
  }
  return { additions, deletions };
}

async function readFilePatch({ projectPath, file, hasCommits, stdoutLimit }) {
  if (typeof file.symlinkTarget === 'string') {
    const targetLines = file.symlinkTarget.split('\n');
    const patch = [
      `diff --git a/${file.path} b/${file.path}`,
      'new file mode 120000',
      '--- /dev/null',
      `+++ b/${file.path}`,
      `@@ -0,0 +1,${targetLines.length} @@`,
      ...targetLines.map((line) => `+${line}`),
      '\\ No newline at end of file',
      '',
    ].join('\n');
    return { stdout: patch.slice(0, stdoutLimit), stderr: '', truncated: patch.length > stdoutLimit };
  }
  const args = file.status === 'untracked'
    ? ['-c', 'core.quotepath=false', '--literal-pathspecs', 'diff', '--no-color', '--no-ext-diff', '--no-index', '--src-prefix=a/', '--dst-prefix=b/', '--', '/dev/null', file.path]
    : [
      '-c', 'core.quotepath=false',
      '--literal-pathspecs',
      'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/',
      hasCommits ? 'HEAD' : EMPTY_TREE_HASH,
      '--', file.path,
    ];
  const result = await spawnBounded('git', args, {
    cwd: projectPath,
    stdoutLimit,
    allowedExitCodes: file.status === 'untracked' ? [0, 1] : [0],
  });
  // --no-index returns 1 when files differ, but also for errors such as a
  // disappeared file. Only the former is an expected patch result.
  if (file.status === 'untracked' && result.stderr && !result.stdout && !result.truncated) {
    const error = new Error(`Unable to diff untracked file: ${file.path}`);
    error.stderr = result.stderr;
    throw error;
  }
  return result;
}

async function attachBoundedFilePatches(files, context, hasCommits) {
  let remaining = DIFF_TOTAL_LIMIT;
  const output = [];
  // This is intentionally sequential. It caps both child-process concurrency
  // and aggregate retained patch text, rather than merely limiting each child.
  for (const [index, file] of files.entries()) {
    if (file.binary) {
      output.push({ ...file, patch: null, tooLarge: false, patchOmitted: false });
      continue;
    }
    if (file.previewUnsupported) {
      output.push({ ...file, patch: null, tooLarge: false, patchOmitted: true });
      continue;
    }
    if (index >= DIFF_PATCH_FILE_LIMIT || remaining <= 0) {
      output.push({ ...file, patch: null, tooLarge: false, patchOmitted: true });
      continue;
    }
    const { stdout, truncated } = await readFilePatch({
      ...context,
      file,
      hasCommits,
      stdoutLimit: Math.min(DIFF_PER_FILE_LIMIT, remaining) + 1,
    });
    if (truncated || stdout.length > DIFF_PER_FILE_LIMIT || stdout.length > remaining) {
      output.push({ ...file, patch: null, tooLarge: true, patchOmitted: false });
      continue;
    }
    remaining -= stdout.length;
    const counts = file.status === 'untracked' || !hasCommits ? patchLineCounts(stdout) : {};
    output.push({ ...file, ...counts, patch: stdout || null, tooLarge: false, patchOmitted: false });
  }
  return output;
}

router.get('/status', asyncHandler(async (req, res) => {
  const { project } = req.query;

  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project, req.query.sessionId);

    // Validate git repository
    await validateGitRepository(projectPath);

    const { repositoryRoot, projectPrefix } = await getGitProjectContext(projectPath);
    const branch = await getCurrentBranchName(repositoryRoot);
    const hasCommits = await repositoryHasCommits(repositoryRoot);

    const { stdout: statusOutput } = await spawnAsync(
      'git',
      ['--literal-pathspecs', 'status', '--porcelain=v1', '-z', '--', gitPathspec(projectPrefix)],
      { cwd: repositoryRoot },
    );
    const { modified, added, deleted, untracked, staged } = summarizeGitStatusEntries(
      projectRelativeStatusEntries(statusOutput, projectPrefix),
    );

    res.json({
      branch,
      hasCommits,
      modified,
      added,
      deleted,
      untracked,
      staged
    });
  } catch (error) {
    console.error('Git status error:', error);
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, code: error.code });
    res.json({
      error: error.message.includes('not a git repository') || error.message.includes('Project directory is not a git repository')
        ? error.message
        : 'Git operation failed',
      details: error.message.includes('not a git repository') || error.message.includes('Project directory is not a git repository')
        ? error.message
        : `Failed to get git status: ${error.message}`
    });
  }
}));

export async function readProjectDiff(projectPath) {
  await validateGitRepository(projectPath);

  const { repositoryRoot, projectPath: projectBasePath, projectPrefix } = await getGitProjectContext(projectPath);
  const branch = await getCurrentBranchName(repositoryRoot);
  const hasCommits = await repositoryHasCommits(repositoryRoot);
  const { trackedEntries, untrackedEntries, totalFiles } =
    await readBoundedProjectStatusEntries(repositoryRoot, projectPrefix);
  const statusEntries = [...trackedEntries, ...untrackedEntries].slice(0, DIFF_FILE_LIMIT);
  const statusByPath = new Map(statusEntries.map((entry) => [entry.path, entry]));
  const numstatFiles = trackedEntries.length > 0
    ? await readSelectedNumstatFiles(repositoryRoot, projectPrefix, hasCommits, statusByPath)
    : [];

  const numstatByPath = new Map(numstatFiles.map((file) => [file.path, file]));
  const trackedFiles = statusEntries
    .filter((entry) => entry.status !== 'untracked')
    .map((entry) => numstatByPath.get(entry.path) || ({
      path: entry.path,
      oldPath: entry.oldPath,
      status: entry.status,
      staged: entry.staged,
      additions: 0,
      deletions: 0,
      binary: false,
    }));
  const selectedUntrackedEntries = statusEntries.filter((entry) => entry.status === 'untracked');
  const untrackedFiles = selectedUntrackedEntries.map((entry) => ({
    path: entry.path,
    oldPath: null,
    status: 'untracked',
    staged: false,
    additions: 0,
    deletions: 0,
    binary: false,
  }));

  const filesWithBinaryMetadata = await mapWithConcurrency(
    [...trackedFiles, ...untrackedFiles],
    FILE_METADATA_CONCURRENCY,
    async (file, index) => file.status === 'untracked' && index < DIFF_PATCH_FILE_LIMIT
      ? { ...file, ...await inspectUntrackedFile(projectBasePath, file.path) }
      : file,
  );
  const files = await attachBoundedFilePatches(filesWithBinaryMetadata, { projectPath: projectBasePath }, hasCommits);
  return { branch, hasCommits, files, totalFiles, truncated: totalFiles > files.length };
}

router.get('/diff', asyncHandler(async (req, res) => {
  const { project } = req.query;

  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project, req.query.sessionId);
    res.json(await readProjectDiff(projectPath));
  } catch (error) {
    console.error('Git diff error:', error);
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, code: error.code });
    res.json({
      error: error.message.includes('not a git repository') || error.message.includes('Project directory is not a git repository')
        ? error.message
        : 'Git operation failed',
      details: error.message.includes('not a git repository') || error.message.includes('Project directory is not a git repository')
        ? error.message
        : `Failed to get git diff: ${error.message}`,
    });
  }
}));

// Get list of branches
router.get('/branches', asyncHandler(async (req, res) => {
  const { project } = req.query;
  
  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    
    // Validate git repository
    await validateGitRepository(projectPath);
    
    // Get all branches
    const { stdout } = await spawnAsync('git', ['branch', '-a'], { cwd: projectPath });

    const rawLines = stdout
      .split('\n')
      .map(b => b.trim())
      .filter(b => b && !b.includes('->'));

    // Local branches (may start with '* ' for current)
    const localBranches = rawLines
      .filter(b => !b.startsWith('remotes/'))
      .map(b => (b.startsWith('* ') ? b.substring(2) : b));

    // Remote branches — strip 'remotes/<remote>/' prefix
    const remoteBranches = rawLines
      .filter(b => b.startsWith('remotes/'))
      .map(b => b.replace(/^remotes\/[^/]+\//, ''))
      .filter(name => !localBranches.includes(name)); // skip if already a local branch

    // Backward-compat flat list (local + unique remotes, deduplicated)
    const branches = [...localBranches, ...remoteBranches]
      .filter((b, i, arr) => arr.indexOf(b) === i);

    res.json({ branches, localBranches, remoteBranches });
  } catch (error) {
    console.error('Git branches error:', error);
    res.json({ error: error.message });
  }
}));

// Checkout branch
router.post('/checkout', asyncHandler(async (req, res) => {
  const { project, branch } = req.body;
  
  if (!project || !branch) {
    return res.status(400).json({ error: 'Project id and branch are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    
    // Checkout the branch
    validateBranchName(branch);
    const { stdout } = await spawnAsync('git', ['checkout', branch], { cwd: projectPath });
    
    res.json({ success: true, output: stdout });
  } catch (error) {
    console.error('Git checkout error:', error);
    res.status(500).json({ error: error.message });
  }
}));

// Fields are joined with the ASCII unit separator so pipes (or anything else
// typed into a commit subject) cannot break parsing.
const GIT_LOG_FIELD_SEPARATOR = '\u001f';
const GIT_LOG_PRETTY_FORMAT = '%H%x1f%P%x1f%D%x1f%an%x1f%ae%x1f%ad%x1f%s';

/**
 * Parses `git log --shortstat` output produced with GIT_LOG_PRETTY_FORMAT.
 *
 * Each commit is one format line (hash, parent hashes, ref decorations,
 * author, email, date, subject) optionally followed by its `--shortstat`
 * summary line ("N files changed, ..."). Parents and refs feed the commit
 * graph rendered by the History view; merge commits carry no shortstat line,
 * so their `stats` stays empty.
 *
 * Exported for tests.
 */
export function parseGitLogWithStats(stdout) {
  const commits = [];

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;

    if (line.includes(GIT_LOG_FIELD_SEPARATOR)) {
      const [hash, parents, refs, author, email, date, ...messageParts] = line.split(GIT_LOG_FIELD_SEPARATOR);
      commits.push({
        hash,
        parents: parents ? parents.split(' ').filter(Boolean) : [],
        // `%D` decorations, e.g. "HEAD -> main", "origin/main", "tag: v1.0".
        refs: refs ? refs.split(', ').filter(Boolean) : [],
        author,
        email,
        date,
        message: messageParts.join(GIT_LOG_FIELD_SEPARATOR),
        stats: ''
      });
      continue;
    }

    if (commits.length > 0 && /files? changed/.test(line)) {
      commits[commits.length - 1].stats = line.trim();
    }
  }

  return commits;
}

// Get recent commits (across all branches, in graph order)
router.get('/commits', asyncHandler(async (req, res) => {
  const { project, limit = 10 } = req.query;

  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);
    const parsedLimit = Number.parseInt(String(limit), 10);
    const safeLimit = Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, 100)
      : 10;

    // Branches/remotes/tags (not --all, which would drag in refs/stash) with
    // `--topo-order` guarantee children appear before their parents across
    // every branch, which the frontend lane-assignment relies on.
    // `--shortstat` replaces the previous per-commit `git show --stat` calls.
    const { stdout } = await spawnAsync(
      'git',
      [
        'log',
        '--branches',
        '--remotes',
        '--tags',
        '--topo-order',
        '--shortstat',
        `--pretty=format:${GIT_LOG_PRETTY_FORMAT}`,
        '--date=iso-strict',
        '-n', String(safeLimit)
      ],
      { cwd: projectPath },
    );

    res.json({ commits: parseGitLogWithStats(stdout) });
  } catch (error) {
    console.error('Git commits error:', error);
    res.json({ error: error.message });
  }
}));

// Fetch from remote (using smart remote detection)
router.post('/fetch', asyncHandler(async (req, res) => {
  const { project } = req.body;
  
  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);

    // Get current branch and its upstream remote
    const branch = await getCurrentBranchName(projectPath);

    let remoteName = 'origin'; // fallback
    try {
      const { stdout } = await spawnAsync('git', ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], { cwd: projectPath });
      remoteName = stdout.trim().split('/')[0]; // Extract remote name
    } catch (error) {
      // No upstream, try to fetch from origin anyway
      console.log('No upstream configured, using origin as fallback');
    }

    validateRemoteName(remoteName);
    const { stdout } = await spawnAsync('git', ['fetch', remoteName], { cwd: projectPath });

    res.json({ success: true, output: stdout || 'Fetch completed successfully', remoteName });
  } catch (error) {
    console.error('Git fetch error:', error);
    res.status(500).json({ 
      error: 'Fetch failed', 
      details: error.message.includes('Could not resolve hostname') 
        ? 'Unable to connect to remote repository. Check your internet connection.'
        : error.message.includes('fatal: \'origin\' does not appear to be a git repository')
        ? 'No remote repository configured. Add a remote with: git remote add origin <url>'
        : error.message
    });
  }
}));

// Pull from remote (fetch + merge using smart remote detection)
router.post('/pull', asyncHandler(async (req, res) => {
  const { project } = req.body;
  
  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);

    // Get current branch and its upstream remote
    const branch = await getCurrentBranchName(projectPath);

    let remoteName = 'origin'; // fallback
    let remoteBranch = branch; // fallback
    try {
      const { stdout } = await spawnAsync('git', ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], { cwd: projectPath });
      const tracking = stdout.trim();
      remoteName = tracking.split('/')[0]; // Extract remote name
      remoteBranch = tracking.split('/').slice(1).join('/'); // Extract branch name
    } catch (error) {
      // No upstream, use fallback
      console.log('No upstream configured, using origin/branch as fallback');
    }

    validateRemoteName(remoteName);
    validateBranchName(remoteBranch);
    const { stdout } = await spawnAsync('git', ['pull', remoteName, remoteBranch], { cwd: projectPath });

    res.json({
      success: true,
      output: stdout || 'Pull completed successfully',
      remoteName,
      remoteBranch
    });
  } catch (error) {
    console.error('Git pull error:', error);

    // Enhanced error handling for common pull scenarios
    let errorMessage = 'Pull failed';
    let details = error.message;
    
    if (error.message.includes('CONFLICT')) {
      errorMessage = 'Merge conflicts detected';
      details = 'Pull created merge conflicts. Please resolve conflicts manually in the editor, then commit the changes.';
    } else if (error.message.includes('Please commit your changes or stash them')) {
      errorMessage = 'Uncommitted changes detected';  
      details = 'Please commit or stash your local changes before pulling.';
    } else if (error.message.includes('Could not resolve hostname')) {
      errorMessage = 'Network error';
      details = 'Unable to connect to remote repository. Check your internet connection.';
    } else if (error.message.includes('fatal: \'origin\' does not appear to be a git repository')) {
      errorMessage = 'Remote not configured';
      details = 'No remote repository configured. Add a remote with: git remote add origin <url>';
    } else if (error.message.includes('diverged')) {
      errorMessage = 'Branches have diverged';
      details = 'Your local branch and remote branch have diverged. Consider fetching first to review changes.';
    }
    
    res.status(500).json({ 
      error: errorMessage, 
      details: details
    });
  }
}));

// Push commits to remote repository
router.post('/push', asyncHandler(async (req, res) => {
  const { project } = req.body;
  
  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);

    // Get current branch and its upstream remote
    const branch = await getCurrentBranchName(projectPath);

    let remoteName = 'origin'; // fallback
    let remoteBranch = branch; // fallback
    try {
      const { stdout } = await spawnAsync('git', ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], { cwd: projectPath });
      const tracking = stdout.trim();
      remoteName = tracking.split('/')[0]; // Extract remote name
      remoteBranch = tracking.split('/').slice(1).join('/'); // Extract branch name
    } catch (error) {
      // No upstream, use fallback
      console.log('No upstream configured, using origin/branch as fallback');
    }

    validateRemoteName(remoteName);
    validateBranchName(remoteBranch);
    const { stdout } = await spawnAsync('git', ['push', remoteName, remoteBranch], { cwd: projectPath });

    res.json({
      success: true,
      output: stdout || 'Push completed successfully',
      remoteName,
      remoteBranch
    });
  } catch (error) {
    console.error('Git push error:', error);
    
    // Enhanced error handling for common push scenarios
    let errorMessage = 'Push failed';
    let details = error.message;
    
    if (error.message.includes('rejected')) {
      errorMessage = 'Push rejected';
      details = 'The remote has newer commits. Pull first to merge changes before pushing.';
    } else if (error.message.includes('non-fast-forward')) {
      errorMessage = 'Non-fast-forward push';
      details = 'Your branch is behind the remote. Pull the latest changes first.';
    } else if (error.message.includes('Could not resolve hostname')) {
      errorMessage = 'Network error';
      details = 'Unable to connect to remote repository. Check your internet connection.';
    } else if (error.message.includes('fatal: \'origin\' does not appear to be a git repository')) {
      errorMessage = 'Remote not configured';
      details = 'No remote repository configured. Add a remote with: git remote add origin <url>';
    } else if (error.message.includes('Permission denied')) {
      errorMessage = 'Authentication failed';
      details = 'Permission denied. Check your credentials or SSH keys.';
    } else if (error.message.includes('no upstream branch')) {
      errorMessage = 'No upstream branch';
      details = 'No upstream branch configured. Use: git push --set-upstream origin <branch>';
    }
    
    res.status(500).json({ 
      error: errorMessage, 
      details: details
    });
  }
}));

export default router;
