import { randomUUID } from 'node:crypto';
import fs, { constants, promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { finished, pipeline } from 'node:stream/promises';

import express from 'express';
import mime from 'mime-types';
import multer from 'multer';

import {
  buildStoredImageRecords, ensureImageAssetsDir,
  isAllowedImageMimeType, resolveImageAssetFile,
} from '@/modules/assets/services/image-assets.service.js';
import { asyncHandler } from '@/shared/utils.js';

const assetsRouter = express.Router();

function generatedFilename(mimeType: string): string {
  // The original extension is untrusted: an allowed image MIME with an HTML
  // filename must never become an executable document on the app's origin.
  return `${randomUUID()}.${mime.extension(mimeType)}`;
}

async function receiveImages(request: express.Request, response: express.Response): Promise<void> {
  const operations: Promise<unknown>[] = [];
  const writes = new Map<string, Promise<Partial<Express.Multer.File>>>();
  const created = new Set<string>();
  const remove = async (filename: string): Promise<void> => {
    // Multer can request removal while an aborted write is still closing.
    await writes.get(filename)?.catch(() => {});
    // A failed exclusive open (including an existing symlink) never grants
    // ownership of that pathname. Only remove files this request created.
    if (!created.has(filename)) return;
    await fsPromises.unlink(filename).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    created.delete(filename);
  };
  const upload = multer({
    // Use Multer's storage extension point so the handler owns the actual file
    // pipeline. diskStorage calls back on finish (before descriptor close), and
    // Multer's request-abort path can call next before pending storage callbacks.
    storage: {
      _handleFile: (_request, file, done) => {
        const write: Promise<Partial<Express.Multer.File>> = Promise.resolve().then(async () => {
          const destination = await ensureImageAssetsDir();
          if (request.aborted || file.stream.destroyed) throw new Error('Request aborted');
          const filename = generatedFilename(file.mimetype);
          const target = path.join(destination, filename);
          file.path = target;
          writes.set(target, write);
          const output = fs.createWriteStream(target, { flags: 'wx', mode: 0o600 });
          output.once('open', () => created.add(target));
          await pipeline(file.stream, output);
          return { destination, filename, path: target, size: output.bytesWritten };
        });
        operations.push(write.then((info) => done(null, info), (error: Error) => done(error)));
      },
      _removeFile: (_request, file, done) => {
        operations.push(remove(file.path).then(() => {
          delete (file as Partial<Express.Multer.File>).destination;
          delete (file as Partial<Express.Multer.File>).filename;
          delete (file as Partial<Express.Multer.File>).path;
          done(null);
        }, (error: Error) => done(error)));
      },
    },
    fileFilter: (_request, file, done) => {
      if (!isAllowedImageMimeType(file.mimetype)) {
        return done(new Error('Invalid file type. Only JPEG, PNG, GIF, WebP, and SVG are allowed.'));
      }
      done(null, true);
    },
    limits: { files: 5, fileSize: 5 * 1024 * 1024 },
  });
  const failure = await new Promise<unknown>((resolve) => upload.array('images', 5)(request, response, resolve)).catch((error: unknown) => error);
  const storageFailures: unknown[] = [];
  // Storage completion can schedule removal. Include operations added while a
  // previous batch is settling; do not use the response finish/close as a lease.
  for (let settled = 0; settled < operations.length;) {
    const batch = operations.slice(settled);
    settled += batch.length;
    const results = await Promise.allSettled(batch);
    for (const result of results) if (result.status === 'rejected') storageFailures.push(result.reason);
  }
  if (failure || request.aborted || storageFailures.length) {
    // Abort may bypass Multer's pending-file list. All writers are closed now;
    // remove late/partially written files before returning the upload failure.
    const cleanup = await Promise.allSettled([...created].map((filename) => remove(filename)));
    for (const result of cleanup) {
      if (result.status === 'rejected') console.error('Failed to clean up image upload:', result.reason);
    }
    throw failure || storageFailures[0] || new Error('Request aborted');
  }
}

assetsRouter.post('/images', asyncHandler(async (request, response) => {
  try {
    await receiveImages(request, response);
  } catch (failure) {
    const error = failure instanceof Error ? failure.message : 'Upload failed';
    response.status(400).json({ error });
    return;
  }

  const files = Array.isArray(request.files) ? request.files : [];
  if (!files.length) {
    response.status(400).json({ error: 'No image files provided' });
    return;
  }
  response.json({ images: buildStoredImageRecords(files) });
}));

assetsRouter.get('/images/:filename', asyncHandler(async (request, response) => {
  const filename = resolveImageAssetFile(request.params.filename);
  if (filename === null) {
    response.status(400).json({ error: 'Invalid asset filename' });
    return;
  }

  let asset;
  try {
    // Reject non-files before opening (including FIFOs), then verify the opened
    // descriptor. O_NOFOLLOW also closes a final-component symlink swap race.
    if (!(await fsPromises.lstat(filename)).isFile()) {
      response.status(404).json({ error: 'Asset not found' });
      return;
    }
    asset = await fsPromises.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    if (!(await asset.stat()).isFile()) {
      await asset.close();
      response.status(404).json({ error: 'Asset not found' });
      return;
    }
  } catch {
    await asset?.close().catch(() => {});
    response.status(404).json({ error: 'Asset not found' });
    return;
  }

  try {
    const detectedType = mime.lookup(filename);
    const contentType = detectedType && isAllowedImageMimeType(detectedType) ? detectedType : 'application/octet-stream';
    response.setHeader('Content-Type', contentType);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (contentType === 'image/svg+xml' || contentType === 'application/octet-stream') {
      response.setHeader('Content-Disposition', 'attachment');
    }

    const assetStream = asset.createReadStream();
    const sourceClosed = new Promise<void>((resolve) => assetStream.once('close', resolve));
    const stopSource = () => { assetStream.destroy(); };
    const reportError = (failure: Error) => {
      console.error('Error streaming image asset:', failure);
      if (response.destroyed) return;
      if (!response.headersSent) response.status(500).json({ error: 'Error reading asset' });
      else response.destroy();
    };
    assetStream.on('error', reportError);
    response.once('close', stopSource);
    const responseDone = finished(response, { cleanup: true }).catch(stopSource);
    try {
      if (response.destroyed) stopSource();
      else assetStream.pipe(response);
      await Promise.all([sourceClosed, responseDone]);
    } catch (error) {
      response.destroy(error instanceof Error ? error : new Error('Error reading asset'));
      throw error;
    } finally {
      stopSource();
      await Promise.all([sourceClosed, responseDone]);
      response.off('close', stopSource);
      assetStream.off('error', reportError);
    }
  } finally {
    // Source close, not response finish, establishes descriptor cleanup.
    await asset.close();
  }
}));

export default assetsRouter;
