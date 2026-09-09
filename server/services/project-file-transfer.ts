import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';

import type { Response } from 'express';
import type { StorageEngine } from 'multer';

/** The handler owns both the source descriptor and the response through close. */
export async function streamProjectFile(source: Readable, response: Response): Promise<void> {
  const sourceClosed = new Promise<void>((resolve) => source.once('close', resolve));
  const stopSource = () => { source.destroy(); };
  const reportError = (error: Error) => {
    if (response.destroyed) return;
    if (!response.headersSent) response.status(500).json({ error: 'Error reading file' });
    else response.destroy(error);
  };
  source.on('error', reportError);
  response.once('close', stopSource);
  const responseDone = finished(response, { cleanup: true }).catch(stopSource);
  try {
    if (response.destroyed) stopSource();
    else source.pipe(response);
    await Promise.all([sourceClosed, responseDone]);
  } catch (error) {
    response.destroy(error instanceof Error ? error : new Error('File stream failed.'));
    throw error;
  } finally {
    stopSource();
    await Promise.all([sourceClosed, responseDone]);
    source.off('error', reportError);
    response.off('close', stopSource);
  }
}

/**
 * A request-private staging directory has one cleanup owner. Multer's parser
 * callback can precede a disk writer's close on abort; settle() joins the real
 * pipelines and any removal callbacks before that directory may be removed.
 */
export function createProjectUploadStorage(destination: string, createOutput = fs.createWriteStream): {
  storage: StorageEngine;
  settle(): Promise<void>;
} {
  const operations: Promise<void>[] = [];
  const writes = new Map<string, Promise<Partial<Express.Multer.File>>>();
  const created = new Set<string>();
  const storage: StorageEngine = {
    _handleFile(request, file, done) {
      const filename = `upload-${randomUUID()}`;
      const target = path.join(destination, filename);
      file.path = target;
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.once('aborted', abort);
      const write = Promise.resolve().then(async () => {
        if (request.aborted || file.stream.destroyed) throw new Error('Request aborted');
        const output = createOutput(target, { flags: 'wx', mode: 0o600 });
        output.once('open', () => created.add(target));
        await pipeline(file.stream, output, { signal: controller.signal });
        return { destination, filename, path: target, size: output.bytesWritten };
      }).finally(() => request.off('aborted', abort));
      writes.set(target, write);
      operations.push(write.then((info) => done(null, info), (error: Error) => done(error)));
    },
    _removeFile(_request, file, done) {
      const remove = async () => {
        await writes.get(file.path)?.catch(() => {});
        // A failed exclusive open never grants ownership of an existing file.
        if (created.has(file.path)) {
          await unlink(file.path).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
          created.delete(file.path);
        }
      };
      operations.push(remove().then(() => done(null), (error: Error) => done(error)));
    },
  };
  return {
    storage,
    async settle() {
      const failures: unknown[] = [];
      // A storage completion can schedule another removal callback.
      for (let settled = 0; settled < operations.length;) {
        const batch = operations.slice(settled);
        settled += batch.length;
        for (const result of await Promise.allSettled(batch)) {
          if (result.status === 'rejected') failures.push(result.reason);
        }
      }
      if (failures.length) throw new AggregateError(failures, 'Upload callback cleanup failed.');
    },
  };
}
