import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import test from 'node:test';

import express, { type Request } from 'express';

import { asyncHandler, getHttpActivityGeneration, snapshotHttpActivity } from '../shared/utils.js';

import { createProjectUploadStorage, streamProjectFile } from './project-file-transfer.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function request(): Request {
  return Object.assign(new EventEmitter(), { aborted: false }) as unknown as Request;
}
function file(stream: Readable): Express.Multer.File {
  return { stream, originalname: 'fixture.txt', mimetype: 'text/plain' } as Express.Multer.File;
}

test('project upload reports success only after an exclusive private file is closed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gajae-upload-owner-'));
  try {
    const owned = createProjectUploadStorage(root);
    const input = file(Readable.from(['fixture']));
    let closed = false;
    const info = await new Promise<Partial<Express.Multer.File>>((resolve, reject) => {
      owned.storage._handleFile(request(), input, (error, value) => {
        closed = input.stream.closed;
        if (error) reject(error); else resolve(value!);
      });
    });
    await owned.settle();
    assert.equal(closed, true);
    assert.equal(await readFile(info.path!, 'utf8'), 'fixture');
    assert.equal((await stat(info.path!)).mode & 0o777, 0o600);
    assert.equal(info.size, 7);
    await new Promise<void>((resolve, reject) => owned.storage._removeFile(request(), { ...input, ...info }, (error) => error ? reject(error) : resolve()));
    await owned.settle();
    await assert.rejects(stat(info.path!), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('aborted upload retains ownership through a delayed writer close and late removal', async () => {
  const writeStarted = deferred();
  const closing = deferred();
  const releaseClose = deferred();
  const output = new Writable({
    write(_chunk, _encoding, done) { writeStarted.resolve(); done(); },
    destroy(error, done) { closing.resolve(); void releaseClose.promise.then(() => done(error)); },
  });
  const owned = createProjectUploadStorage('/unused-private-staging', (() => output) as unknown as typeof fs.createWriteStream);
  const req = request();
  const input = file(new PassThrough());
  let callbackCount = 0;
  let removed = false;
  owned.storage._handleFile(req, input, (error) => {
    callbackCount++;
    assert.ok(error);
    owned.storage._removeFile(req, input, () => { removed = true; });
  });
  input.stream.push('partial');
  await writeStarted.promise;
  Object.assign(req, { aborted: true }); req.emit('aborted');
  await closing.promise;
  let settled = false;
  const settledPromise = owned.settle().then(() => { settled = true; });
  await tick();
  assert.equal(settled, false);
  assert.equal(callbackCount, 0);
  assert.equal(output.closed, false);
  releaseClose.resolve();
  await settledPromise;
  assert.equal(output.closed, true);
  assert.equal(callbackCount, 1);
  assert.equal(removed, true);
  assert.equal(req.listenerCount('aborted'), 0);
});

test('a pre-aborted upload never starts a disk write', async () => {
  const req = request(); Object.assign(req, { aborted: true });
  let writes = 0;
  const owned = createProjectUploadStorage('/unused-private-staging', (() => { writes++; throw new Error('unexpected open'); }) as typeof fs.createWriteStream);
  const result = new Promise<Error | null | undefined>((resolve) => owned.storage._handleFile(req, file(Readable.from(['x'])), resolve));
  await owned.settle();
  assert.equal((await result)?.message, 'Request aborted');
  assert.equal(writes, 0);
  assert.equal(req.listenerCount('aborted'), 0);
});

test('response completion does not hide a still-closing project source from the HTTP owner', async (t) => {
  const closing = deferred();
  const releaseClose = deferred();
  const initial = snapshotHttpActivity();
  const source = new Readable({
    read() { this.push('fixture'); this.push(null); },
    destroy(error, done) { closing.resolve(); void releaseClose.promise.then(() => done(error)); },
  });
  const app = express();
  app.get('/file', asyncHandler(async (_req, res) => { await streamProjectFile(source, res); }));
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    releaseClose.resolve();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${address.port}/file`);
  assert.equal(await response.text(), 'fixture');
  await closing.promise;
  assert.equal(snapshotHttpActivity().running, initial.running + 1);
  const beforeClose = getHttpActivityGeneration();
  releaseClose.resolve(); await once(source, 'close'); await tick();
  assert.equal(snapshotHttpActivity().running, initial.running);
  assert.notEqual(getHttpActivityGeneration(), beforeClose);
});
