import fsSync from 'node:fs';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import { assignTranscriptTurns, type TranscriptTurnRecord } from '@/modules/providers/list/gjc/gjc-transcript-turns.js';
import { readGjcTranscriptMessage } from '@/modules/providers/list/gjc/gjc-transcript-message.js';
import { AppError, createNormalizedMessage, generateMessageId, readObjectRecord } from '@/shared/utils.js';

const PROVIDER = 'gjc';

const MAX_JSONL_LINE_BYTES = 32 * 1024 * 1024;
const MAX_BUFFERED_HISTORY_RECORDS = 5_000;
const MAX_BUFFERED_HISTORY_BYTES = 64 * 1024 * 1024;
const HISTORY_READ_ATTEMPTS = 3;
const HISTORY_INDEX_CACHE_CAPACITY = 16;
type HistoryRow = { ordinal: number; time: number; kind: NormalizedMessage['kind']; toolId?: string };
type HistoryIndexCacheEntry = {
  size: number;
  mtimeMs: number;
  turns: ReturnType<typeof assignTranscriptTurns>;
  chronological: HistoryRow[];
  visible: HistoryRow[];
};

/**
 * Streams newline-delimited UTF-8 text while discarding a line as soon as it
 * exceeds the cap. `readline` buffers an entire line before yielding it, which
 * would allow a malformed multi-gigabyte JSONL record to exhaust server memory.
 */
async function* readBoundedJsonlLines(sessionFilePath: string): AsyncGenerator<string> {
  const fileStream = fsSync.createReadStream(sessionFilePath);
  let lineChunks: Buffer[] = [];
  let lineByteLength = 0;
  let discardingLine = false;

  for await (const chunk of fileStream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;

    while (start < buffer.length) {
      const newlineIndex = buffer.indexOf(0x0A, start);
      const end = newlineIndex === -1 ? buffer.length : newlineIndex;
      const segmentByteLength = end - start;

      if (!discardingLine) {
        if (lineByteLength + segmentByteLength > MAX_JSONL_LINE_BYTES) {
          lineChunks = [];
          lineByteLength = 0;
          discardingLine = true;
        } else if (segmentByteLength > 0) {
          lineChunks.push(buffer.subarray(start, end));
          lineByteLength += segmentByteLength;
        }
      }

      if (newlineIndex === -1) {
        break;
      }

      if (!discardingLine) {
        const line = Buffer.concat(lineChunks, lineByteLength).toString('utf8');
        yield line.endsWith('\r') ? line.slice(0, -1) : line;
      }

      lineChunks = [];
      lineByteLength = 0;
      discardingLine = false;
      start = newlineIndex + 1;
    }
  }

  if (!discardingLine && lineByteLength > 0) {
    const line = Buffer.concat(lineChunks, lineByteLength).toString('utf8');
    yield line.endsWith('\r') ? line.slice(0, -1) : line;
  }
}
/**
 * Reads the text body of a gjc content part (`text` or `thinking`).
 */
function extractGjcPartText(part: AnyRecord): string {
  if (typeof part.text === 'string') {
    return part.text;
  }
  if (typeof part.thinking === 'string') {
    return part.thinking;
  }
  return '';
}

/**
 * Reads the transcript once for lineage alone.
 *
 * Turn assignment needs the whole chain before any record can be placed, which
 * the streaming pass below cannot provide. This pass keeps four small fields per
 * record and nothing else, so the content still streams.
 *
 * **Every** record is collected, not only the messages: lineage runs through
 * compaction and other control entries, and filtering them out severs it.
 */
async function readTranscriptLineage(sessionFilePath: string): Promise<TranscriptTurnRecord[]> {
  const records: TranscriptTurnRecord[] = [];
  for await (const line of readBoundedJsonlLines(sessionFilePath)) {
    if (!line.trim()) continue;
    let entry: AnyRecord | null;
    try {
      entry = readObjectRecord(JSON.parse(line));
    } catch {
      continue;
    }
    if (!entry || typeof entry.id !== 'string') continue;
    const message = readGjcTranscriptMessage(entry);
    const role = typeof message?.role === 'string' ? message.role : undefined;
    records.push({
      id: entry.id,
      parentId: typeof entry.parentId === 'string' ? entry.parentId : undefined,
      role: role === 'user' || role === 'assistant' || role === 'toolResult' ? role : undefined,
      stopReason: typeof message?.stopReason === 'string' ? message.stopReason : undefined,
    });
  }
  return records;
}

/**
 * Streams a gjc JSONL transcript and flattens messages (including visible user
 * skill requests) into the compact shape consumed by `normalizeHistoryEntry`.
 *
 * Only displayable user, assistant, and tool-result messages are processed;
 * header and control events are ignored. Each `message.content[]` part becomes
 * its own intermediate record with a unique id so multi-part turns never collide.
 */
async function streamGjcSessionMessages(
  sessionFilePath: string,
  turns: ReturnType<typeof assignTranscriptTurns>,
  onMessage: (message: AnyRecord) => void,
): Promise<void> {
  try {

    for await (const line of readBoundedJsonlLines(sessionFilePath)) {
      if (!line.trim()) {
        continue;
      }

      try {
        const entry = readObjectRecord(JSON.parse(line));
        if (!entry) {
          continue;
        }

        const message = readGjcTranscriptMessage(entry);
        if (!message || message.display === false) {
          continue;
        }

        const role = typeof message.role === 'string' ? message.role : '';
        if (role !== 'user' && role !== 'assistant' && role !== 'toolResult') {
          continue;
        }

        const timestamp = entry.timestamp;
        const entryId = typeof entry.id === 'string'
          ? entry.id
          : (typeof entry.timestamp === 'string' ? entry.timestamp : generateMessageId(PROVIDER));

        // One transcript record becomes several intermediate records - a text
        // part, a tool call, a result - and every one of them belongs to the
        // same turn. Stamping them here keeps that from being restated at each
        // emit site, where one omission would silently drop a card's contents.
        const turn = typeof entry.id === 'string' ? turns.get(entry.id) : undefined;
        const emit = (record: AnyRecord): void => {
          onMessage(turn ? { ...record, turnId: turn.turnId, turnStatus: turn.status } : record);
        };

        const content = Array.isArray(message.content)
          ? message.content
          : (typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : []);

        // gjc records a tool RESULT as a top-level message with role 'toolResult'
        // whose content is plain text parts. Emit one tool_result here (paired to
        // its tool_use by toolCallId downstream) so the UI folds it into the tool
        // block instead of dumping the raw output as chat text.
        if (role === 'toolResult') {
          const output = content
            .map((rawPart) => {
              if (!rawPart || typeof rawPart !== 'object') {
                return '';
              }
              const text = (rawPart as AnyRecord).text;
              return typeof text === 'string' ? text : '';
            })
            .join('');
          // The runtime persists its typed per-tool `details` alongside the
          // text parts. Carrying it here is what keeps a reloaded transcript
          // identical to the live turn: a card that renders richly while the
          // turn streams and then degrades on refresh is worse than one that
          // is consistently plain.
          const details = message.details;
          emit({
            uuid: `${entryId}:toolresult`,
            type: 'tool_result',
            timestamp,
            toolCallId: message.toolCallId ?? message.callId,
            output,
            isError: Boolean(message.isError),
            ...(details && typeof details === 'object' && !Array.isArray(details)
              && Object.keys(details as AnyRecord).length > 0
              ? { details }
              : {}),
          });
          continue;
        }

        let partIndex = 0;
        for (const rawPart of content) {
          if (!rawPart || typeof rawPart !== 'object') {
            continue;
          }

          const part = rawPart as AnyRecord;
          const partId = `${entryId}:${partIndex}`;
          partIndex += 1;

          switch (part.type) {
            case 'text': {
              const text = typeof part.text === 'string' ? part.text : '';
              if (!text.trim()) {
                break;
              }
              emit({
                uuid: `${partId}:text`,
                timestamp,
                message: {
                  role,
                  content: text,
                },
              });
              break;
            }
            case 'thinking': {
              const text = extractGjcPartText(part);
              if (!text.trim()) {
                break;
              }
              emit({
                uuid: `${partId}:thinking`,
                type: 'thinking',
                timestamp,
                message: {
                  role: 'assistant',
                  content: text,
                },
              });
              break;
            }
            case 'toolCall': {
              emit({
                uuid: `${partId}:toolcall`,
                type: 'tool_use',
                timestamp,
                toolName: part.toolName ?? part.name ?? 'Unknown',
                toolInput: part.toolInput ?? part.input ?? part.arguments,
                toolCallId: part.toolCallId ?? part.id ?? part.callId,
              });
              break;
            }
            case 'toolResult': {
              emit({
                uuid: `${partId}:toolresult`,
                type: 'tool_result',
                timestamp,
                toolCallId: part.toolCallId ?? part.id ?? part.callId,
                output: part.output ?? part.content ?? part.result ?? '',
                isError: Boolean(part.isError),
              });
              break;
            }
            default:
              break;
          }
        }
      } catch (error) {
        if (error instanceof AppError) throw error;
        // Skip malformed lines, not explicit page safety failures.
      }
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    console.error('Error reading gjc session messages:', error);
    throw error;
  }
}

export class GjcSessionsProvider implements IProviderSessions {
  /**
   * Bounded LRU of the lineage+descriptor index for one transcript revision,
   * keyed by session file path. Descriptor rows are tiny ({ordinal,time,kind,
   * toolId}) and payloads are never cached, so the capacity is the memory
   * bound. The instance lives on the singleton provider, so the cache survives
   * page requests but not server restarts.
   */
  private readonly historyIndexCache = new Map<string, HistoryIndexCacheEntry>();

  private readHistoryIndexCache(sessionFilePath: string, size: number, mtimeMs: number): HistoryIndexCacheEntry | undefined {
    const entry = this.historyIndexCache.get(sessionFilePath);
    if (!entry) return undefined;
    if (entry.size !== size || entry.mtimeMs !== mtimeMs) {
      this.historyIndexCache.delete(sessionFilePath);
      return undefined;
    }
    // Refresh recency on hit.
    this.historyIndexCache.delete(sessionFilePath);
    this.historyIndexCache.set(sessionFilePath, entry);
    return entry;
  }

  private writeHistoryIndexCache(sessionFilePath: string, entry: HistoryIndexCacheEntry): void {
    this.historyIndexCache.delete(sessionFilePath);
    this.historyIndexCache.set(sessionFilePath, entry);
    while (this.historyIndexCache.size > HISTORY_INDEX_CACHE_CAPACITY) {
      const oldest = this.historyIndexCache.keys().next().value;
      if (oldest === undefined) break;
      this.historyIndexCache.delete(oldest);
    }
  }
  /**
   * Normalizes one flattened gjc content-part record into the shared envelope.
   */
  /**
   * Stamps the turn onto everything one flattened record produced.
   *
   * Done once around the normalizer rather than at each of its five returns:
   * one omission there would leave a message out of its turn, and a
   * changed-files card silently short of what the turn actually changed.
   */
  private normalizeHistoryEntry(raw: AnyRecord, sessionId: string | null): NormalizedMessage[] {
    const messages = this.normalizeHistoryEntryContent(raw, sessionId);
    const turnId = typeof raw.turnId === 'string' ? raw.turnId : undefined;
    if (!turnId) return messages;
    const turnStatus = raw.turnStatus as NormalizedMessage['turnStatus'];
    return messages.map((message) => ({ ...message, turnId, turnStatus }));
  }

  private normalizeHistoryEntryContent(raw: AnyRecord, sessionId: string | null): NormalizedMessage[] {
    const ts = raw.timestamp || new Date().toISOString();
    const baseId = raw.uuid || generateMessageId(PROVIDER);

    if (raw.type === 'thinking') {
      const thinkingContent = typeof raw.message?.content === 'string'
        ? raw.message.content
        : '';
      if (!thinkingContent.trim()) {
        return [];
      }
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'thinking',
        content: thinkingContent,
      })];
    }

    if (raw.message?.role === 'user') {
      const content = typeof raw.message.content === 'string' ? raw.message.content : '';
      if (!content.trim()) {
        return [];
      }
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'text',
        role: 'user',
        content,
      })];
    }

    if (raw.message?.role === 'assistant') {
      const content = typeof raw.message.content === 'string' ? raw.message.content : '';
      if (!content.trim()) {
        return [];
      }
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'text',
        role: 'assistant',
        content,
      })];
    }

    if (raw.type === 'tool_use' || raw.toolName) {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName: raw.toolName || 'Unknown',
        toolInput: raw.toolInput,
        toolId: raw.toolCallId || baseId,
      })];
    }

    if (raw.type === 'tool_result') {
      const rawOutput = raw.output;
      const content = typeof rawOutput === 'string'
        ? rawOutput
        : rawOutput == null ? '' : JSON.stringify(rawOutput);
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_result',
        toolId: raw.toolCallId || '',
        content,
        isError: Boolean(raw.isError),
        // Same slot the live path fills, so both produce one shape.
        ...(raw.details === undefined ? {} : { toolUseResult: raw.details }),
      })];
    }

    return [];
  }

  /**
   * Normalizes a persisted gjc history record. gjc has no live SDK event path
   * in the read-only integration, so history and (future) live events share the
   * same content-part normalization.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      return [];
    }

    return this.normalizeHistoryEntry(raw, sessionId);
  }

  /**
   * Loads gjc JSONL history and folds tool results into their tool calls.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    const normalizedOffset = Math.max(0, offset);
    const normalizedLimit = limit === null ? null : Math.max(0, limit);
    const sessionFilePath = sessionsDb.getSessionById(sessionId)?.jsonl_path;
    const empty = { messages: [], total: 0, hasMore: false, offset: normalizedOffset, limit: normalizedLimit };
    if (!sessionFilePath) return empty;
    // A live writer appends between the index and payload passes often enough
    // that one changed revision is routine, not a client-visible failure.
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.readHistoryPage(sessionFilePath, sessionId, normalizedLimit, normalizedOffset);
      } catch (error) {
        if (error instanceof AppError && error.code === 'HISTORY_CHANGED' && attempt < HISTORY_READ_ATTEMPTS) continue;
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return empty;
        throw error;
      }
    }
  }

  private async readHistoryPage(
    sessionFilePath: string,
    sessionId: string,
    normalizedLimit: number | null,
    normalizedOffset: number,
  ): Promise<FetchHistoryResult> {
    const revision = await fsSync.promises.stat(sessionFilePath);
    const cached = this.readHistoryIndexCache(sessionFilePath, revision.size, revision.mtimeMs);
    let turns: HistoryIndexCacheEntry['turns'];
    let chronological: HistoryRow[];
    let visible: HistoryRow[];
    if (cached) {
      // Same revision: the cached size/mtimeMs exactly equal the fresh stat, so
      // the post-read comparison below still guards the revision the index was
      // computed from.
      ({ turns, chronological, visible } = cached);
    } else {
      turns = assignTranscriptTurns(await readTranscriptLineage(sessionFilePath));
      // Index only small descriptors. Tool-result rows must not consume visible
      // pagination offsets or evict older messages from a payload ring.
      const index: HistoryRow[] = [];
      await streamGjcSessionMessages(sessionFilePath, turns, raw => {
        for (const message of this.normalizeHistoryEntry(raw, sessionId)) {
          const time = Date.parse(message.timestamp);
          index.push({ ordinal: index.length, time: Number.isFinite(time) ? time : 0, kind: message.kind, toolId: message.toolId });
        }
      });
      chronological = index.sort((a, b) => a.time - b.time || a.ordinal - b.ordinal);
      visible = chronological.filter(row => row.kind !== 'tool_result');
      this.writeHistoryIndexCache(sessionFilePath, { size: revision.size, mtimeMs: revision.mtimeMs, turns, chronological, visible });
    }
    const end = Math.max(0, visible.length - normalizedOffset);
    if (normalizedLimit === null && end > MAX_BUFFERED_HISTORY_RECORDS) {
      throw new AppError('History is too large to load at once; use paginated history.', { code: 'HISTORY_PAGE_TOO_LARGE', statusCode: 413 });
    }
    const start = Math.max(0, end - Math.min(normalizedLimit ?? MAX_BUFFERED_HISTORY_RECORDS, MAX_BUFFERED_HISTORY_RECORDS));
    const selected = visible.slice(start, end);
    const wanted = new Set(selected.map(row => row.ordinal));
    const resultsByTool = new Map<string, number>();
    const selectedTools = new Set(selected.filter(row => row.kind === 'tool_use' && row.toolId).map(row => row.toolId!));
    for (const row of chronological) {
      if (row.kind === 'tool_result' && row.toolId && selectedTools.has(row.toolId)) resultsByTool.set(row.toolId, row.ordinal);
    }
    for (const ordinal of resultsByTool.values()) wanted.add(ordinal);

    // A second streaming pass retains only the page and its attached results,
    // independent of how far back the user has paged. No growing payload cache.
    const payloads = new Map<number, NormalizedMessage>();
    let ordinal = 0;
    let bytes = 0;
    if (wanted.size) await streamGjcSessionMessages(sessionFilePath, turns, raw => {
      for (const message of this.normalizeHistoryEntry(raw, sessionId)) {
        const position = ordinal++;
        if (!wanted.has(position)) continue;
        bytes += Buffer.byteLength(JSON.stringify(message), 'utf8');
        if (bytes > MAX_BUFFERED_HISTORY_BYTES) {
          throw new AppError('History page exceeds the payload limit; request fewer messages.', { code: 'HISTORY_PAGE_TOO_LARGE', statusCode: 413 });
        }
        payloads.set(position, message);
      }
    });
    const after = await fsSync.promises.stat(sessionFilePath);
    if (after.size !== revision.size || after.mtimeMs !== revision.mtimeMs) {
      throw new AppError('Transcript changed while reading history; retry the request.', { code: 'HISTORY_CHANGED', statusCode: 409 });
    }
    const messages = selected.map(row => {
      const message = payloads.get(row.ordinal)!;
      const resultOrdinal = row.toolId ? resultsByTool.get(row.toolId) : undefined;
      const result = resultOrdinal === undefined ? undefined : payloads.get(resultOrdinal);
      if (message.kind === 'tool_use' && result) {
        message.toolResult = {
          content: result.content,
          isError: result.isError,
          ...(result.toolUseResult === undefined ? {} : { toolUseResult: result.toolUseResult }),
        };
      }
      return message;
    });
    return {
      messages,
      total: visible.length,
      hasMore: start > 0,
      offset: normalizedOffset,
      limit: normalizedLimit,
      tokenUsage: null,
    };
  }
}
