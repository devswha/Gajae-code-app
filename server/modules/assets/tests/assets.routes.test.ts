import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import fileSystem, { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable, type Writable } from 'node:stream';
import test, { type TestContext } from 'node:test';

import express from 'express';

import assetsRouter from '../assets.routes.js';

async function serve(t: TestContext) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'gajae-assets-http-'));
  t.mock.method(os, 'homedir', () => home);
  const assets = path.join(home, '.gajae-app', 'assets');
  await mkdir(assets, { recursive: true });
  const app = express();
  const requests: express.Request[] = [];
  let active = 0;
  const idle: Array<() => void> = [];
  app.locals.desktopRestartAdmission = { enter: () => {
    active++;
    return () => {
      active--;
      if (!active) idle.splice(0).forEach((resolve) => resolve());
    };
  } };
  app.use((request, _response, next) => { requests.push(request); next(); });
  app.use('/assets', assetsRouter);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  });
  return {
    home,
    assets,
    origin: `http://127.0.0.1:${address.port}/assets`,
    requests,
    active: () => active,
    idle: () => active ? new Promise<void>((resolve) => idle.push(resolve)) : Promise.resolve(),
    request: (url: string, options?: RequestInit) => fetch(`http://127.0.0.1:${address.port}/assets${url}`, options),
  };
}

test('an image MIME cannot turn an HTML filename into an active same-origin document', async (t) => {
  const server = await serve(t);
  const form = new FormData();
  form.append('images', new Blob(['<script>globalThis.compromised = true</script>'], { type: 'image/png' }), 'attack.html');
  const uploaded = await server.request('/images', { method: 'POST', body: form });
  assert.equal(uploaded.status, 200);
  const { images } = await uploaded.json() as { images: Array<{ path: string; name: string }> };
  assert.equal(images[0].name, 'attack.html');
  const downloaded = await server.request(`/images/${path.basename(images[0].path)}`);
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get('content-type'), 'image/png');
  assert.equal(downloaded.headers.get('x-content-type-options'), 'nosniff');
  await downloaded.arrayBuffer();
});

function deferred(t: TestContext) {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  t.after(resolve);
  return { promise, resolve };
}

function delayDestroy(stream: Readable | Writable, entered: ReturnType<typeof deferred>, release: ReturnType<typeof deferred>): void {
  const original = stream._destroy.bind(stream);
  stream._destroy = (error, callback) => {
    entered.resolve();
    void release.promise.then(() => original(error, callback));
  };
}

function unfinishedUpload(server: Awaited<ReturnType<typeof serve>>) {
  const request = http.request(`${server.origin}/images`, {
    method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=owned-upload' },
  });
  request.on('error', () => {});
  request.write('--owned-upload\r\nContent-Disposition: form-data; name="images"; filename="partial.png"\r\nContent-Type: image/png\r\n\r\npartial bytes');
  return request;
}

test('image upload waits for the writer close callback, not merely writable finish', { timeout: 10_000 }, async (t) => {
  const closing = deferred(t);
  const release = deferred(t);
  const server = await serve(t);
  const create = fs.createWriteStream;
  t.mock.method(fs, 'createWriteStream', (...args: Parameters<typeof fs.createWriteStream>) => {
    const stream = create(...args);
    delayDestroy(stream, closing, release);
    return stream;
  });
  const form = new FormData();
  form.append('images', new Blob(['image'], { type: 'image/png' }), 'image.png');
  let answered = false;
  const response = server.request('/images', { method: 'POST', body: form }).then((value) => { answered = true; return value; });
  await closing.promise;
  assert.equal(server.active(), 1);
  assert.equal(answered, false);
  release.resolve();
  assert.equal((await response).status, 200);
  await server.idle();
  assert.equal(server.active(), 0);
});

for (const kind of ['file', 'symlink'] as const) {
  test(`failed exclusive image open never overwrites or removes a colliding ${kind}`, async (t) => {
    const server = await serve(t);
    const outside = path.join(server.home, 'existing.txt');
    await writeFile(outside, 'keep outside');
    const create = fs.createWriteStream;
    let target = '';
    t.mock.method(fs, 'createWriteStream', (...args: Parameters<typeof fs.createWriteStream>) => {
      target = String(args[0]);
      if (kind === 'symlink') fs.symlinkSync(outside, target);
      else fs.writeFileSync(target, 'keep existing', { flag: 'wx' });
      return create(...args);
    });
    const form = new FormData();
    form.append('images', new Blob(['must not overwrite'], { type: 'image/png' }), 'collision.png');
    const response = await server.request('/images', { method: 'POST', body: form });
    assert.equal(response.status, 400);
    assert.match((await response.json() as { error: string }).error, /EEXIST/u);
    await server.idle();
    assert.equal((await lstat(target)).isSymbolicLink(), kind === 'symlink');
    assert.equal(await readFile(target, 'utf8'), kind === 'symlink' ? 'keep outside' : 'keep existing');
    assert.equal(await readFile(outside, 'utf8'), 'keep outside');
  });
}

test('aborted image uploads retain ownership through delayed writer close and remove partial files', { timeout: 10_000 }, async (t) => {
  const opened = deferred(t);
  const closing = deferred(t);
  const release = deferred(t);
  const server = await serve(t);
  const create = fs.createWriteStream;
  t.mock.method(fs, 'createWriteStream', (...args: Parameters<typeof fs.createWriteStream>) => {
    const stream = create(...args);
    stream.once('open', opened.resolve);
    delayDestroy(stream, closing, release);
    return stream;
  });
  const request = unfinishedUpload(server);
  t.after(() => request.destroy());
  await opened.promise;
  request.destroy();
  await closing.promise;
  assert.equal(server.active(), 1);
  assert.equal((await readdir(server.assets)).length, 1);
  release.resolve();
  await server.idle();
  assert.deepEqual(await readdir(server.assets), []);
});

test('aborted uploads wait for pending directory preparation and never start a late file write', { timeout: 10_000 }, async (t) => {
  const preparing = deferred(t);
  const release = deferred(t);
  const server = await serve(t);
  const mkdir = fileSystem.mkdir;
  t.mock.method(fileSystem, 'mkdir', async (...args: Parameters<typeof fileSystem.mkdir>) => {
    if (String(args[0]) === server.assets) { preparing.resolve(); await release.promise; }
    return mkdir(...args);
  });
  const request = unfinishedUpload(server);
  t.after(() => request.destroy());
  await preparing.promise;
  const aborted = once(server.requests[0], 'aborted');
  request.destroy();
  await aborted;
  assert.equal(server.active(), 1);
  release.resolve();
  await server.idle();
  assert.deepEqual(await readdir(server.assets), []);
});

test('image size-limit failure waits for removal and preserves the upload error contract', { timeout: 10_000 }, async (t) => {
  const removing = deferred(t);
  const release = deferred(t);
  const server = await serve(t);
  const unlink = fileSystem.unlink;
  t.mock.method(fileSystem, 'unlink', async (filename: Parameters<typeof fileSystem.unlink>[0]) => {
    removing.resolve();
    await release.promise;
    return unlink(filename);
  });
  const form = new FormData();
  form.append('images', new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: 'image/png' }), 'large.png');
  const pending = server.request('/images', { method: 'POST', body: form });
  await removing.promise;
  assert.equal(server.active(), 1);
  release.resolve();
  const response = await pending;
  assert.equal(response.status, 400);
  assert.equal((await response.json() as { error: string }).error, 'File too large');
  await server.idle();
  assert.deepEqual(await readdir(server.assets), []);
});

test('image GET retains ownership after the response body ends until file descriptor cleanup', { timeout: 10_000 }, async (t) => {
  const closing = deferred(t);
  const release = deferred(t);
  const server = await serve(t);
  await writeFile(path.join(server.assets, 'stream.png'), 'stream bytes');
  const open = fileSystem.open;
  t.mock.method(fileSystem, 'open', async (...args: Parameters<typeof fileSystem.open>) => {
    const handle = await open(...args);
    const create = handle.createReadStream.bind(handle);
    t.mock.method(handle, 'createReadStream', (...options: Parameters<typeof create>) => {
      const stream = create(...options);
      delayDestroy(stream, closing, release);
      return stream;
    });
    return handle;
  });
  const response = await server.request('/images/stream.png');
  assert.equal(await response.text(), 'stream bytes');
  await closing.promise;
  assert.equal(server.active(), 1);
  release.resolve();
  await server.idle();
  assert.equal(server.active(), 0);
});

test('image GET disconnect waits for source destruction before closing the owned file handle', { timeout: 10_000 }, async (t) => {
  const closing = deferred(t);
  const release = deferred(t);
  const server = await serve(t);
  await writeFile(path.join(server.assets, 'disconnect.png'), 'fixture');
  const open = fileSystem.open;
  let handleClosed = false;
  t.mock.method(fileSystem, 'open', async (...args: Parameters<typeof fileSystem.open>) => {
    const handle = await open(...args);
    const close = handle.close.bind(handle);
    t.mock.method(handle, 'close', async () => { await close(); handleClosed = true; });
    t.mock.method(handle, 'createReadStream', () => {
      const source = new Readable({ read() {} });
      source.push('partial');
      delayDestroy(source, closing, release);
      return source as ReturnType<typeof handle.createReadStream>;
    });
    return handle;
  });
  const response = await server.request('/images/disconnect.png');
  const reader = response.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'partial');
  await reader.cancel();
  await closing.promise;
  assert.equal(server.active(), 1);
  assert.equal(handleClosed, false);
  release.resolve();
  await server.idle();
  assert.equal(handleClosed, true);
});

test('image read failure preserves its 500 response and closes the file handle', async (t) => {
  const server = await serve(t);
  await writeFile(path.join(server.assets, 'failed.png'), 'fixture');
  const open = fileSystem.open;
  let handleClosed = false;
  t.mock.method(fileSystem, 'open', async (...args: Parameters<typeof fileSystem.open>) => {
    const handle = await open(...args);
    const close = handle.close.bind(handle);
    t.mock.method(handle, 'close', async () => { await close(); handleClosed = true; });
    t.mock.method(handle, 'createReadStream', () => new Readable({
      read() { this.destroy(new Error('fixture read failure')); },
    }) as ReturnType<typeof handle.createReadStream>);
    return handle;
  });
  const response = await server.request('/images/failed.png');
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Error reading asset' });
  await server.idle();
  assert.equal(handleClosed, true);
});

test('legacy non-image assets and SVGs are downloaded without an active document type', async (t) => {
  const server = await serve(t);
  for (const filename of ['legacy.html', 'legacy.xml', 'legacy.svg']) {
    await writeFile(path.join(server.assets, filename), '<script>active content</script>');
    const response = await server.request(`/images/${filename}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-disposition'), 'attachment', filename);
    assert.equal(response.headers.get('content-type'), filename.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream');
    await response.arrayBuffer();
  }
});

test('asset reads reject symlinks, directories, and encoded traversal without exposing outside files', async (t) => {
  const server = await serve(t);
  const secret = path.join(server.home, 'private.txt');
  await writeFile(secret, 'fixture-private-content');
  await symlink(secret, path.join(server.assets, 'linked.png'));
  await mkdir(path.join(server.assets, 'directory.png'));
  for (const filename of ['linked.png', 'directory.png', '%2e%2e%2fprivate.txt', '%00.png']) {
    const response = await server.request(`/images/${filename}`);
    assert.ok(response.status >= 400 && response.status < 500, `${filename}: ${response.status}`);
    assert.equal((await response.text()).includes('fixture-private-content'), false);
  }
});

test('ordinary uploaded PNGs remain retrievable with their exact bytes', async (t) => {
  const server = await serve(t);
  const bytes = Buffer.from('89504e470d0a1a0a', 'hex');
  const form = new FormData();
  form.append('images', new Blob([bytes], { type: 'image/png' }), 'picture.png');
  const uploaded = await server.request('/images', { method: 'POST', body: form });
  assert.equal(uploaded.status, 200);
  const { images } = await uploaded.json() as { images: Array<{ path: string }> };
  const downloaded = await server.request(`/images/${path.basename(images[0].path)}`);
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
});
