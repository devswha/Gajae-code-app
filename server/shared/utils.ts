import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { access, lstat, mkdir, readFile, readdir, readlink, realpath, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { DesktopWorkAdmission } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  ApiSuccessShape,
  AppErrorOptions,
  LLMProvider,
  NormalizedMessage,
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
  WorkspacePathValidationResult,
} from '@/shared/types.js';

type GjcRuntimeModelCatalogLoader = () => Promise<unknown>;
type NormalizedMessageInput = { kind: NormalizedMessage['kind']; provider: NormalizedMessage['provider']; id?: string | null; sessionId?: string | null; timestamp?: string | null } & Record<string, unknown>;
type ProviderSessionActiveModelChangeCacheEntry = ProviderSessionActiveModelChange & { updatedAt: string };
type ProviderSessionActiveModelChangeCacheFile = { version: number; entries: Record<string, ProviderSessionActiveModelChangeCacheEntry> };

let catalogReader: GjcRuntimeModelCatalogLoader | undefined;
const CACHE_FORMAT = 1;

export function registerGjcRuntimeModelCatalogLoader(loader: GjcRuntimeModelCatalogLoader): void {
  catalogReader = loader;
}

export function loadGjcRuntimeModelCatalog(): Promise<unknown> {
  return catalogReader
    ? catalogReader()
    : Promise.reject(new Error('GJC runtime model catalog is unavailable.'));
}

export function createApiSuccessResponse<TData>(data: TData): ApiSuccessShape<TData> {
  return { success: true, data };
}

export function asyncHandler(handler: (req: Request, res: Response, next: NextFunction) => unknown | Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    let release: (() => void) | undefined;
    try {
      const admission = req.app?.locals.desktopRestartAdmission as DesktopWorkAdmission | undefined;
      // Use the registered route, not a caller-controlled URL/query/body. Even
      // GET handlers can start native processes and must acquire before awaiting.
      release = admission?.enter('http:handler');
      const outcome = Promise.resolve(handler(req, res, next));
      // Response finish/close is not completion of the actual handler. In
      // particular, client disconnect must not let prepare overtake a write.
      void outcome.then(() => release?.(), (error) => { release?.(); next(error); });
    } catch (error) {
      release?.();
      if (error && typeof error === 'object' && 'code' in error && error.code === 'DESKTOP_RESTART_FENCED') {
        res.setHeader('Retry-After', '1');
        res.status(503).json({ error: 'Desktop restart is being prepared. Retry this request.', code: 'DESKTOP_RESTART_FENCED' });
      } else next(error);
    }
  };
}

export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(message: string, options: AppErrorOptions = {}) {
    const { code = 'INTERNAL_ERROR', statusCode = 500, details } = options;
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT || os.homedir();
const FORBIDDEN_WORKSPACE_PATHS = [
  '/', '/etc', '/bin', '/sbin', '/usr', '/dev', '/proc', '/sys', '/var', '/boot', '/root', '/lib', '/lib64', '/opt', '/tmp', '/run',
  'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData', 'C:\\System Volume Information', 'C:\\$Recycle.Bin',
];

function pathDialect(value: string): typeof path.posix {
  return process.platform === 'win32' || value.startsWith('\\\\') || /^[a-zA-Z]:([\\/]|$)/.test(value)
    ? path.win32
    : path.posix;
}

function removeExtendedPathPrefix(value: string): string {
  if (value.startsWith('\\\\?\\UNC\\')) return `\\\\${value.slice('\\\\?\\UNC\\'.length)}`;
  return value.startsWith('\\\\?\\') ? value.slice('\\\\?\\'.length) : value;
}

export function normalizeProjectPath(inputPath: string): string {
  if (typeof inputPath !== 'string') return '';
  const source = inputPath.trim();
  if (!source) return '';
  const unprefixed = removeExtendedPathPrefix(source);
  const implementation = pathDialect(unprefixed);
  const result = implementation.normalize(unprefixed);
  if (!result) return '';
  return result === implementation.parse(result).root ? result : result.replace(/[\\/]+$/, '');
}

function outsideRoot(candidate: string, root: string): boolean {
  return candidate !== root && !candidate.startsWith(`${root}${path.sep}`);
}

function protectedWorkspacePath(candidate: string): string | undefined {
  if (FORBIDDEN_WORKSPACE_PATHS.includes(candidate) || candidate === '/') {
    return 'Cannot use system-critical directories as workspace locations';
  }
  for (const protectedPath of FORBIDDEN_WORKSPACE_PATHS) {
    const canonicalProtectedPath = normalizeProjectPath(protectedPath);
    if (candidate !== canonicalProtectedPath && !candidate.startsWith(`${canonicalProtectedPath}${path.sep}`)) continue;
    if (canonicalProtectedPath === '/var' && (candidate.startsWith('/var/tmp') || candidate.startsWith('/var/folders'))) continue;
    return `Cannot create workspace in system directory: ${protectedPath}`;
  }
  return undefined;
}

async function resolveCandidatePath(absolutePath: string): Promise<string> {
  let output = normalizeProjectPath(absolutePath);
  try {
    await access(absolutePath);
    return normalizeProjectPath(await realpath(absolutePath));
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure.code !== 'ENOENT') throw failure;
    const parent = path.dirname(absolutePath);
    try {
      const actualParent = await realpath(parent);
      output = normalizeProjectPath(path.join(actualParent, path.basename(absolutePath)));
    } catch (parentError) {
      const parentFailure = parentError as NodeJS.ErrnoException;
      if (parentFailure.code !== 'ENOENT') throw parentFailure;
    }
    return output;
  }
}

async function symlinkLeavesWorkspace(absolutePath: string, workspaceRoot: string): Promise<boolean> {
  try {
    await access(absolutePath);
    if (!(await lstat(absolutePath)).isSymbolicLink()) return false;
    const target = await readlink(absolutePath);
    return outsideRoot(await realpath(path.resolve(path.dirname(absolutePath), target)), workspaceRoot);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure.code !== 'ENOENT') throw failure;
    return false;
  }
}

async function evaluateWorkspacePath(requestedPath: string): Promise<WorkspacePathValidationResult> {
  const requested = normalizeProjectPath(requestedPath);
  if (!requested) return { valid: false, error: 'Workspace path is required' };
  const absolute = path.resolve(requested);
  const protectedError = protectedWorkspacePath(normalizeProjectPath(absolute));
  if (protectedError) return { valid: false, error: protectedError };
  const resolvedPath = await resolveCandidatePath(absolute);
  const root = normalizeProjectPath(await realpath(WORKSPACES_ROOT));
  if (outsideRoot(resolvedPath, root)) {
    return { valid: false, error: `Workspace path must be within the allowed workspace root: ${WORKSPACES_ROOT}` };
  }
  if (await symlinkLeavesWorkspace(absolute, root)) {
    return { valid: false, error: 'Symlink target is outside the allowed workspace root' };
  }
  return { valid: true, resolvedPath };
}

export async function validateWorkspacePath(requestedPath: string): Promise<WorkspacePathValidationResult> {
  // Any filesystem surprise is a rejection, never a crash: the caller treats
  // this as a yes/no gate on user-supplied input.
  return evaluateWorkspacePath(requestedPath).catch((error: unknown) => (
    { valid: false, error: `Path validation failed: ${(error as Error).message}` }
  ));
}

export function generateMessageId(prefix = 'msg'): string {
  const unique = randomUUID();
  return [prefix, unique].join('_');
}

export function createNormalizedMessage(fields: NormalizedMessageInput): NormalizedMessage {
  return {
    ...fields,
    id: fields.id || generateMessageId(fields.kind),
    sessionId: fields.sessionId || '',
    timestamp: fields.timestamp || new Date().toISOString(),
    provider: fields.provider,
  };
}

export function createCompleteMessage(opts: { provider: NormalizedMessage['provider']; sessionId?: string | null; actualSessionId?: string | null; exitCode?: number | null; aborted?: boolean }): NormalizedMessage {
  const result = typeof opts.exitCode === 'number' ? opts.exitCode : 1;
  const cancelled = Boolean(opts.aborted);
  return createNormalizedMessage({
    kind: 'complete', provider: opts.provider, sessionId: opts.sessionId || null,
    actualSessionId: opts.actualSessionId || opts.sessionId || null, exitCode: result,
    success: result === 0 && !cancelled, aborted: cancelled,
  });
}

export function sliceTailPage<T>(items: T[], limit: number | null, offset: number): { page: T[]; hasMore: boolean } {
  const endingAt = Math.max(0, items.length - Math.max(0, offset));
  if (limit === null) return { page: items.slice(0, endingAt), hasMore: false };
  const beginningAt = Math.max(0, endingAt - Math.max(0, limit));
  return { page: items.slice(beginningAt, endingAt), hasMore: beginningAt > 0 };
}

export const readObjectRecord = (value: any): AnyRecord | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : null
);

export function buildDefaultProviderCurrentActiveModel(models: ProviderModelsDefinition): ProviderCurrentActiveModel {
  return { model: models.DEFAULT };
}

function getProviderSessionActiveModelChangesPath(): string {
  return path.join(os.homedir(), '.gajae-app', 'provider-session-active-model-changes.json');
}

export function getGjcLiveSessionRoot(): string {
  return process.env.GJC_LIVE_SESSION_DIR || path.join(os.homedir(), '.gajae-app', 'gjc-live-sessions');
}

const sessionModelKey = (provider: LLMProvider, sessionId: string): string => `${provider}:${sessionId}`;

function blankCache(): ProviderSessionActiveModelChangeCacheFile {
  return { version: CACHE_FORMAT, entries: {} };
}

function isStoredModelChange(value: unknown): value is ProviderSessionActiveModelChangeCacheEntry {
  const entry = readObjectRecord(value);
  return Boolean(entry && typeof entry.provider === 'string' && typeof entry.sessionId === 'string' && typeof entry.supported === 'boolean' && typeof entry.changed === 'boolean' && (typeof entry.model === 'string' || entry.model === null) && typeof entry.updatedAt === 'string');
}

async function loadModelChangeCache(filePath: string): Promise<ProviderSessionActiveModelChangeCacheFile> {
  try {
    const document = readObjectRecord(JSON.parse(await readFile(filePath, 'utf8')));
    if (!document || document.version !== CACHE_FORMAT || !readObjectRecord(document.entries)) return blankCache();
    return {
      version: CACHE_FORMAT,
      entries: Object.fromEntries(Object.entries(document.entries).filter((pair): pair is [string, ProviderSessionActiveModelChangeCacheEntry] => isStoredModelChange(pair[1]))),
    };
  } catch {
    return blankCache();
  }
}

async function saveModelChangeCache(filePath: string, document: ProviderSessionActiveModelChangeCacheFile): Promise<void> {
  const serialized = JSON.stringify(document, null, 2);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${serialized}\n`, 'utf8');
}

function unsupportedModelChange(provider: LLMProvider, sessionId: string): ProviderSessionActiveModelChange {
  return { provider, sessionId, supported: false, changed: false, model: null };
}

export async function readProviderSessionActiveModelChange(provider: LLMProvider, sessionId: string, options: { filePath?: string; supported?: boolean } = {}): Promise<ProviderSessionActiveModelChange> {
  const session = sessionId.trim();
  if (!session || !(options.supported ?? true)) return unsupportedModelChange(provider, session);
  const stored = (await loadModelChangeCache(options.filePath ?? getProviderSessionActiveModelChangesPath())).entries[sessionModelKey(provider, session)];
  if (!stored || !stored.changed || !stored.model?.trim()) return { provider, sessionId: session, supported: true, changed: false, model: null };
  return { provider, sessionId: session, supported: true, changed: true, model: stored.model.trim() };
}

export async function writeProviderSessionActiveModelChange(provider: LLMProvider, input: ProviderChangeActiveModelInput, options: { filePath?: string; supported?: boolean } = {}): Promise<ProviderSessionActiveModelChange> {
  const session = input.sessionId.trim();
  const model = input.model.trim();
  if (!(options.supported ?? true)) return unsupportedModelChange(provider, session);
  if (!session || !model) return { provider, sessionId: session, supported: true, changed: false, model: null };
  const filePath = options.filePath ?? getProviderSessionActiveModelChangesPath();
  const document = await loadModelChangeCache(filePath);
  document.entries[sessionModelKey(provider, session)] = { provider, sessionId: session, supported: true, changed: true, model, updatedAt: new Date().toISOString() };
  await saveModelChangeCache(filePath, document);
  return { provider, sessionId: session, supported: true, changed: true, model };
}

function payloadText(payload: unknown): string | null {
  if (typeof payload === 'string') return payload;
  if (Buffer.isBuffer(payload)) return payload.toString('utf8');
  if (payload instanceof ArrayBuffer) return Buffer.from(payload).toString('utf8');
  if (!Array.isArray(payload)) return null;
  const chunks = payload.map((entry) => {
    if (Buffer.isBuffer(entry)) return entry;
    if (entry instanceof ArrayBuffer) return Buffer.from(entry);
    return ArrayBuffer.isView(entry) ? Buffer.from(entry.buffer, entry.byteOffset, entry.byteLength) : null;
  }).filter((entry): entry is Buffer => entry !== null);
  return chunks.length ? Buffer.concat(chunks).toString('utf8') : null;
}

export function parseIncomingJsonObject(payload: unknown): AnyRecord | null {
  const text = payloadText(payload);
  if (typeof text !== 'string' || !text.trim().length) return null;
  try { return readObjectRecord(JSON.parse(text)); } catch { return null; }
}

export function normalizeSessionName(rawValue: string | undefined, fallback: string): string {
  const title = (rawValue ?? '').replace(/\s+/g, ' ').trim();
  return title ? title.slice(0, 120) : fallback;
}

export const SESSION_TITLE_MAX_LENGTH = 40;

/** A sentence must be at least this long to stand alone as the title; "Hi." does not. */
const SESSION_TITLE_MIN_SENTENCE = 12;
const SENTENCE_END = /[.!?。！？](?=\s|$)/g;
/** "e.g." / "i.e." / "U.S." - a dot closing a run of single letters is not a sentence end. */
const ABBREVIATION_BEFORE_DOT = /(?:^|\s)(?:\p{L}\.)*\p{L}$/u;
const TRAILING_PUNCTUATION = /[\s.!?…:;,。！？、，]+$/u;

function firstSentenceEnd(text: string): number | null {
  for (const match of text.matchAll(SENTENCE_END)) {
    if (match[0] === '.' && ABBREVIATION_BEFORE_DOT.test(text.slice(0, match.index))) continue;
    return match.index;
  }
  return null;
}
const LEADING_COMMAND = /^\/([\w:.-]+)(?:\s+|$)/;

function humanizeCommandName(command: string): string {
  return command.replace(/[-_:.]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function capitalize(text: string): string {
  return text ? text.charAt(0).toLocaleUpperCase() + text.slice(1) : text;
}

/**
 * Turns the first user message into a short sidebar title.
 *
 * The raw message tends to open with a slash command, `@file` mentions, or a
 * pasted code block, none of which say what the conversation is about, so they
 * go first. What remains is cut at the first sentence boundary when that leaves
 * something substantial, then to `maxLength` at a word boundary with an
 * ellipsis. A message that was nothing but a command is titled by the command.
 */
export function deriveSessionTitle(rawValue: string | undefined, fallback: string, maxLength = SESSION_TITLE_MAX_LENGTH): string {
  let text = (rawValue ?? '').replace(/\r\n?/g, '\n');
  const command = LEADING_COMMAND.exec(text.trimStart())?.[1] ?? null;

  text = text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`([^`\n]*)`/g, '$1')
    .trimStart()
    .replace(LEADING_COMMAND, '')
    .replace(/(^|[\s(])@[^\s)]+/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<\/?[a-zA-Z][^>\n]*>/g, ' ')
    .replace(/(\*{1,3}|_{1,3}|~{1,2})(\S(?:[^*_~\n]*\S)?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) {
    return command ? capitalize(humanizeCommandName(command)) || fallback : fallback;
  }

  const boundary = firstSentenceEnd(text);
  if (boundary !== null && boundary + 1 >= SESSION_TITLE_MIN_SENTENCE) {
    text = text.slice(0, boundary + 1);
  }
  text = text.replace(TRAILING_PUNCTUATION, '');

  if (text.length > maxLength) {
    const room = Math.max(1, maxLength - 1);
    let cut = text.slice(0, room);
    const lastGap = cut.lastIndexOf(' ');
    if (lastGap >= Math.ceil(room / 2)) cut = cut.slice(0, lastGap);
    text = `${cut.replace(TRAILING_PUNCTUATION, '')}…`;
  }

  return capitalize(text) || fallback;
}

function normalizeProviderTimestamp(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const epochMs = value < 1_000_000_000_000 ? value * 1000 : value;
    return new Date(epochMs).toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return normalizeProviderTimestamp(numeric);
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

export function getOpenCodeDatabasePath(): string {
  return path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

export async function findFilesRecursivelyCreatedAfter(rootDir: string, extension: string, lastScanAt: Date | null, fileList: string[] = []): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    // Discovery treats inaccessible provider storage as empty.
    return fileList;
  }
  for (const entry of entries) {
    const candidate = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      await findFilesRecursivelyCreatedAfter(candidate, extension, lastScanAt, fileList);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(extension)) continue;
    const created = lastScanAt ? await stat(candidate).catch(() => null) : null;
    if (!lastScanAt || (created && created.birthtime > lastScanAt)) fileList.push(candidate);
  }
  return fileList;
}

export async function readFileTimestamps(filePath: string): Promise<{ createdAt?: string; updatedAt?: string }> {
  const metadata = await stat(filePath).catch(() => null);
  if (!metadata) return {};
  return { createdAt: metadata.birthtime.toISOString(), updatedAt: metadata.mtime.toISOString() };
}

export async function extractFirstValidJsonlData<T>(filePath: string, extractor: (parsedJson: unknown) => T | null | undefined, signal?: AbortSignal): Promise<T | null> {
  try {
    const stream = fs.createReadStream(filePath, { signal });
    const rows = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const row of rows) {
      signal?.throwIfAborted();
      const source = row.trim();
      if (!source) continue;
      const extracted = extractor(JSON.parse(source));
      if (!extracted) continue;
      rows.close();
      stream.close();
      return extracted;
    }
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  return null;
}
