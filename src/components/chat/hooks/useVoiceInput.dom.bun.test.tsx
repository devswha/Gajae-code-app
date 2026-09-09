import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

import { cancelComposerFreeze, prepareComposerFreeze, resetComposerFreezeForTests } from '../../../shared/composerFreeze';
import { boundedComposerDraft, composerRouteKey, type ComposerDraftRepository, type StoredComposerDraft } from '../utils/composerDraftStorage';

import { useChatComposerState } from './useChatComposerState';
import { useVoiceInput } from './useVoiceInput';

const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const audio = () => new Blob([new Uint8Array(1024)], { type: 'audio/webm' });
class Recorder {
  static instances: Recorder[] = [];
  static startFailure = false;
  static isTypeSupported() { return true; }
  state = 'inactive'; mimeType = 'audio/webm'; stops = 0; stopFailure = false;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void | Promise<void>) | null = null;
  onerror: (() => void) | null = null;
  constructor() { Recorder.instances.push(this); }
  start() { if (Recorder.startFailure) throw new Error('start failed'); this.state = 'recording'; }
  stop() { this.stops += 1; if (this.stopFailure) throw new Error('stop failed'); this.state = 'inactive'; }
  async complete(data = audio()) { this.state = 'inactive'; this.ondataavailable?.({ data }); await this.onstop?.(); }
}
function microphone() {
  const track = { stops: 0, stop() { this.stops += 1; } };
  return { track, stream: { getTracks: () => [track] } as unknown as MediaStream };
}
const originalRecorder = Object.getOwnPropertyDescriptor(globalThis, 'MediaRecorder');
const originalMedia = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
const originalFetch = globalThis.fetch;
let epoch = 0;
let device = microphone();
let acquire: () => Promise<MediaStream>;
beforeEach(() => {
  resetComposerFreezeForTests(); localStorage.clear(); epoch = 0;
  Recorder.instances = []; Recorder.startFailure = false; device = microphone();
  acquire = async () => device.stream;
  Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: Recorder });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => acquire() } });
  globalThis.fetch = async () => new Response('{"text":"spoken text"}');
});
afterEach(() => {
  cleanup(); resetComposerFreezeForTests(); localStorage.clear(); globalThis.fetch = originalFetch;
  if (originalRecorder) Object.defineProperty(globalThis, 'MediaRecorder', originalRecorder); else Reflect.deleteProperty(globalThis, 'MediaRecorder');
  if (originalMedia) Object.defineProperty(navigator, 'mediaDevices', originalMedia); else Reflect.deleteProperty(navigator, 'mediaDevices');
});
const request = () => ({ token: `voice-${++epoch}`, epoch, ttlMs: 2000 });
async function busy() { await act(async () => { await assert.rejects(prepareComposerFreeze(request()), (error) => (error as { reason?: string }).reason === 'busy'); }); }
async function idle() {
  await act(async () => { const receipt = await prepareComposerFreeze(request()); assert.equal(receipt.installerAuthority, false); cancelComposerFreeze(receipt); });
}
const voice = (onTranscript: (text: string, send?: boolean) => void | Promise<void> = () => {}, onError?: (message: string) => void) => renderHook(() => useVoiceInput(onTranscript, onError, 'A'));
async function start(view: ReturnType<typeof voice>) { act(() => view.result.current.toggle()); await waitFor(() => assert.equal(view.result.current.state, 'recording')); return Recorder.instances.at(-1)!; }

test('new voice admission is blocked synchronously, while pending permission owns its actual lifetime', async () => {
  const permission = deferred<MediaStream>(); let calls = 0;
  acquire = () => { calls += 1; return permission.promise; };
  const view = voice(); const captured = view.result.current.toggle;
  const receipt = await prepareComposerFreeze(request());
  act(() => captured()); assert.equal(calls, 0);
  cancelComposerFreeze(receipt);
  act(() => { captured(); captured(); });
  assert.equal(calls, 1); assert.equal(view.result.current.state, 'starting'); await busy();
  view.unmount(); await busy();
  await act(async () => permission.resolve(device.stream));
  assert.equal(device.track.stops, 1); assert.equal(Recorder.instances.length, 0); await idle();
});

test('recording, final data, HTTP body, and transcript delivery stay admitted until each actually settles', async () => {
  const body = deferred<{ text: string }>(); const delivered = deferred<void>(); let delivering = false;
  const received: Array<[string, boolean | undefined]> = []; let url = '';
  globalThis.fetch = async (input) => { url = String(input); return { ok: true, json: () => body.promise } as Response; };
  const view = voice(async (text, send) => { received.push([text, send]); delivering = true; await delivered.promise; });
  const recorder = await start(view); await busy();
  assert.equal(recorder.stops, 0, 'freeze never stops an accepted recording');
  act(() => view.result.current.stop({ send: true }));
  assert.equal(view.result.current.state, 'stopping'); await busy();
  let completion!: Promise<void>;
  act(() => { completion = recorder.complete(); });
  await waitFor(() => assert.equal(url, '/api/voice/transcribe')); await busy();
  await act(async () => body.resolve({ text: 'final voice' }));
  await waitFor(() => assert.equal(delivering, true)); await busy();
  await act(async () => { delivered.resolve(); await completion; });
  assert.deepEqual(received, [['final voice', true]]);
  assert.equal(view.result.current.state, 'idle'); assert.equal(device.track.stops, 1); await idle();
});

test('unmount flushes the last recorded audio and retains an external transcription through settlement', async () => {
  localStorage.setItem('voiceConfig', JSON.stringify({ baseUrl: 'https://voice.fixture/v1' }));
  const response = deferred<Response>(); const received: Array<[string, boolean | undefined]> = []; let requested = '';
  globalThis.fetch = async (url) => { requested = String(url); return response.promise; };
  const view = voice((text, send) => { received.push([text, send]); });
  const recorder = await start(view); view.unmount();
  assert.equal(recorder.stops, 1); assert.equal(device.track.stops, 1); await busy();
  const completing = recorder.complete();
  await waitFor(() => assert.equal(requested, 'https://voice.fixture/v1/audio/transcriptions')); await busy();
  response.resolve(new Response('{"text":"keep after departure"}')); await completing;
  assert.deepEqual(received, [['keep after departure', false]]); await idle();
});

test('failed stop requests and recorder errors do not fabricate terminal settlement', async () => {
  const errors: string[] = []; const view = voice(() => {}, (message) => { errors.push(message); });
  const recorder = await start(view); recorder.stopFailure = true;
  act(() => view.result.current.stop()); await busy();
  assert.equal(view.result.current.state, 'recording'); assert.match(errors[0], /could not stop/);
  recorder.stopFailure = false;
  act(() => recorder.onerror?.()); await busy();
  await act(async () => recorder.complete()); await idle();
});

for (const failure of ['permission', 'start', 'short', 'network-abort', 'body', 'empty', 'delivery'] as const) {
  test(`${failure} failure releases the actual voice owner without leaving a permanent busy placeholder`, async () => {
    const errors: string[] = [];
    if (failure === 'permission') acquire = async () => { throw new DOMException('denied', 'NotAllowedError'); };
    if (failure === 'start') Recorder.startFailure = true;
    if (failure === 'network-abort') globalThis.fetch = async () => { throw new DOMException('network settled aborted', 'AbortError'); };
    if (failure === 'body') globalThis.fetch = async () => new Response('not JSON');
    if (failure === 'empty') globalThis.fetch = async () => new Response('{"text":""}');
    const view = voice(() => { if (failure === 'delivery') throw new Error('delivery failed'); }, (message) => { errors.push(message); });
    act(() => view.result.current.toggle());
    if (failure !== 'permission' && failure !== 'start') {
      await waitFor(() => assert.equal(view.result.current.state, 'recording'));
      act(() => view.result.current.stop());
      await act(async () => Recorder.instances.at(-1)!.complete(failure === 'short' ? new Blob(['short']) : audio()));
    }
    await waitFor(() => assert.equal(view.result.current.state, 'idle'));
    assert.equal(errors.length, 1); await idle();
  });
}

test('late voice output belongs to the original composer route, including an empty owner unmounted before delivery', async () => {
  const records = new Map<string, StoredComposerDraft>();
  const repository: ComposerDraftRepository = {
    async load(route) { return records.get(composerRouteKey(route)) ?? null; },
    async save(value, revision) { records.set(composerRouteKey(value), { ...boundedComposerDraft(value).draft, revision: revision + 1 }); return revision + 1; },
  };
  const body = deferred<Response>(); let requested = false; const sends: unknown[] = [];
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/voice/transcribe')) { requested = true; return body.promise; }
    return new Response('[]');
  };
  const view = renderHook(({ route }: { route: string }) => {
    const c = useChatComposerState({ draftRepository: repository,
      selectedProject: { projectId: route, fullPath: '/fixture', displayName: route, origin: 'explicit' }, selectedSession: null,
      currentSessionId: null, gjcModel: 'fixture', isLoading: false, canAbortSession: false, tokenBudget: null,
      sendMessage: (message) => { sends.push(message); }, addMessage() {}, scrollToBottom() {}, setIsUserScrolledUp() {}, setPendingPermissionRequests() {},
    });
    return { c, v: useVoiceInput(c.handleVoiceTranscript, undefined, route) };
  }, { initialProps: { route: 'A' } });
  await waitFor(() => assert.equal(view.result.current.c.draftPersistence.phase, 'saved'));
  act(() => view.result.current.v.toggle());
  await waitFor(() => assert.equal(view.result.current.v.state, 'recording'));
  const recorder = Recorder.instances[0];
  act(() => view.result.current.v.stop({ send: true }));
  let completing!: Promise<void>; act(() => { completing = recorder.complete(); });
  await waitFor(() => assert.equal(requested, true));
  view.rerender({ route: 'B' });
  act(() => view.result.current.c.setInput('B draft stays B'));
  await waitFor(() => assert.equal(view.result.current.c.draftPersistence.phase, 'saved'));
  view.unmount(); await busy();
  await act(async () => { body.resolve(new Response('{"text":"voice for A"}')); await completing; });
  await waitFor(() => assert.equal(records.get(JSON.stringify(['A', null]))?.input, 'voice for A'));
  assert.equal(records.get(JSON.stringify(['B', null]))?.input, 'B draft stays B');
  assert.deepEqual(sends, []); await idle();
});
