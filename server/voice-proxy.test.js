import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

function deferred(t) {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  t.after(() => resolve());
  return { promise, resolve };
}

async function serve(t, backend, baseUrl = 'http://voice.fixture') {
  const previous = process.env.VOICE_API_BASE_URL;
  process.env.VOICE_API_BASE_URL = baseUrl;
  let router;
  try {
    router = (await import(`./voice-proxy.js?fixture=${randomUUID()}`)).default;
  } finally {
    if (previous === undefined) delete process.env.VOICE_API_BASE_URL;
    else process.env.VOICE_API_BASE_URL = previous;
  }
  const fetchClient = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', backend);
  const app = express();
  const requests = [];
  let active = 0;
  const waiters = [];
  app.locals.desktopRestartAdmission = { enter: () => {
    active++;
    return () => {
      active--;
      if (!active) waiters.splice(0).forEach((resolve) => resolve());
    };
  } };
  app.use(express.json());
  app.use((req, _res, next) => { requests.push(req); next(); });
  app.use(router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    origin, requests,
    active: () => active,
    idle: () => active ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve(),
    request: (path, options) => fetchClient(`${origin}${path}`, options),
  };
}

function audioForm(field = 'audio') {
  const form = new FormData();
  form.append(field, new Blob(['audio bytes'], { type: 'audio/webm' }), 'recording.webm');
  return form;
}
const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('transcription retains ownership after multipart parsing until the backend response body completes', { timeout: 10_000 }, async (t) => {
  const backendStarted = deferred(t);
  const release = deferred(t);
  const server = await serve(t, async (url, options) => {
    assert.equal(url, 'http://voice.fixture/audio/transcriptions');
    assert.equal(options.body.get('file').name, 'recording.webm');
    assert.equal(await options.body.get('file').text(), 'audio bytes');
    backendStarted.resolve();
    return new Response(new ReadableStream({
      async start(controller) {
        await release.promise;
        controller.enqueue(new TextEncoder().encode('{"text":"recognized"}'));
        controller.close();
      },
    }));
  });
  let answered = false;
  const pending = server.request('/transcribe', { method: 'POST', body: audioForm() }).then((response) => { answered = true; return response; });
  await backendStarted.promise;
  assert.equal(server.active(), 1);
  assert.equal(answered, false);
  release.resolve();
  const response = await pending;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: 'recognized' });
  await server.idle();
  assert.equal(server.active(), 0);
});

test('disconnect after transcription starts does not release its unfinished backend work', { timeout: 10_000 }, async (t) => {
  const backendStarted = deferred(t);
  const release = deferred(t);
  const server = await serve(t, async () => {
    backendStarted.resolve();
    await release.promise;
    return new Response('plain transcription');
  });
  const cancellation = new AbortController();
  const pending = server.request('/transcribe', { method: 'POST', body: audioForm(), signal: cancellation.signal }).catch(() => null);
  await backendStarted.promise;
  cancellation.abort();
  await pending;
  assert.equal(server.active(), 1);
  release.resolve();
  await server.idle();
});

test('aborted partial audio uploads settle storage without starting a backend request', { timeout: 10_000 }, async (t) => {
  let calls = 0;
  const server = await serve(t, async () => { calls++; throw new Error('must not call backend'); });
  const request = http.request(`${server.origin}/transcribe`, {
    method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=audio-upload' },
  });
  request.on('error', () => {});
  t.after(() => request.destroy());
  request.write('--audio-upload\r\nContent-Disposition: form-data; name="audio"; filename="recording.webm"\r\nContent-Type: audio/webm\r\n\r\npartial');
  while (!server.requests.length || !server.active()) await new Promise((resolve) => setImmediate(resolve));
  const aborted = once(server.requests[0], 'aborted');
  request.destroy();
  await aborted;
  await server.idle();
  assert.equal(calls, 0);
});

test('transcription keeps missing-file, invalid multipart and backend failure responses', async (t) => {
  let calls = 0;
  const server = await serve(t, async () => { calls++; return new Response('denied', { status: 401 }); });
  const missing = await server.request('/transcribe', json({}));
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { error: 'No audio uploaded' });
  const invalid = await server.request('/transcribe', { method: 'POST', body: audioForm('wrong-field') });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, 'Unexpected field');
  assert.equal(calls, 0);
  const denied = await server.request('/transcribe', { method: 'POST', body: audioForm() });
  assert.equal(denied.status, 502);
  assert.equal((await denied.json()).error, 'Voice backend rejected the request (check the API key).');
  await server.idle();
});

test('TTS keeps ownership while disconnect cancellation of the upstream stream is pending', { timeout: 10_000 }, async (t) => {
  const cancelling = deferred(t);
  const release = deferred(t);
  const server = await serve(t, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
    async cancel() { cancelling.resolve(); await release.promise; },
  }), { headers: { 'content-type': 'audio/wav' } }));
  const response = await server.request('/tts', json({ text: 'say it' }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/wav');
  const reader = response.body.getReader();
  assert.deepEqual((await reader.read()).value, new Uint8Array([1, 2, 3]));
  await reader.cancel();
  await cancelling.promise;
  assert.equal(server.active(), 1);
  release.resolve();
  await server.idle();
  assert.equal(server.active(), 0);
});

test('TTS streams exact bytes and releases after ordinary EOF', async (t) => {
  const bytes = new Uint8Array([0, 5, 12, 255]);
  const server = await serve(t, async (_url, options) => {
    assert.equal(JSON.parse(options.body).input, 'hello');
    return new Response(bytes, { headers: { 'content-type': 'audio/mpeg' } });
  });
  const response = await server.request('/tts', json({ text: 'hello' }));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  await server.idle();
  assert.equal(server.active(), 0);
});

test('voice validation stays unchanged when no backend is configured', async (t) => {
  const server = await serve(t, async () => { throw new Error('must not call backend'); }, '');
  const health = await server.request('/health');
  assert.deepEqual(await health.json(), { configured: false });
  for (const route of ['/transcribe', '/tts']) {
    const response = await server.request(route, json({ text: 'hello' }));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'No voice backend configured');
  }
  await server.idle();
});
