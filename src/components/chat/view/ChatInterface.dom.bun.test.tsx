import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';

import { AuthProvider } from '../../auth/context/AuthContext';
import { WebSocketProvider } from '../../../contexts/WebSocketContext';
import english from '../../../i18n/locales/en/chat.json';
import { cancelComposerFreeze, prepareComposerFreeze, resetComposerFreezeForTests } from '../../../shared/composerFreeze';
import { useSessionStore } from '../../../stores/useSessionStore';
import { browserComposerDraftRepository, composerRouteKey, type StoredComposerDraft } from '../utils/composerDraftStorage';

import ChatInterface from './ChatInterface';

const originalFetch = globalThis.fetch;
const originalSocket = globalThis.WebSocket;
const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
const originalRepository = { ...browserComposerDraftRepository };
const i18n = createInstance();
await i18n.init({ lng: 'en', resources: { en: { chat: english } } });
let client: QueryClient;
afterEach(() => {
  cleanup(); client?.clear(); resetComposerFreezeForTests(); localStorage.clear();
  globalThis.fetch = originalFetch; globalThis.WebSocket = originalSocket;
  Object.assign(browserComposerDraftRepository, originalRepository);
  if (originalIndexedDB) Object.defineProperty(globalThis, 'indexedDB', originalIndexedDB); else Reflect.deleteProperty(globalThis, 'indexedDB');
});

test('actual ChatInterface passes the hook freeze state through its composer surface to native buttons', async () => {
  resetComposerFreezeForTests(); localStorage.clear();
  // Repository seam only: this test verifies the actual parent/child tree, not
  // IndexedDB implementation or native installation authority.
  const records = new Map<string, StoredComposerDraft>();
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: {} });
  browserComposerDraftRepository.load = async (route) => records.get(composerRouteKey(route)) ?? null;
  browserComposerDraftRepository.save = async (draft, revision) => { records.set(composerRouteKey(draft), { ...draft, revision: revision + 1 }); return revision + 1; };
  class Socket {
    static OPEN = 1; readyState = 0; onopen = null; onclose = null; onmessage = null; onerror = null;
    close() { this.readyState = 3; }
    send() { assert.fail('no socket send should be accepted in this fixture'); }
  }
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  globalThis.fetch = async (url) => {
    const path = String(url);
    const body = path.endsWith('/api/auth/user') ? { user: { id: 'owner', username: 'owner' } }
      : path.endsWith('/permissions') ? { data: { projectId: 'project', mode: 'ask', allowAlways: [] } }
        : path.includes('/files') ? [] : {};
    return new Response(JSON.stringify(body));
  };
  localStorage.setItem('uiPreferences', JSON.stringify({ voiceEnabled: true }));
  localStorage.setItem('voiceConfig', JSON.stringify({ baseUrl: 'https://voice.fixture/v1' }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  function App() {
    return <ChatInterface selectedProject={{ projectId: 'project', fullPath: '/fixture', displayName: 'Project', origin: 'explicit' }}
      selectedSession={null} ws={null} sendMessage={() => false} sessionStore={useSessionStore()} />;
  }
  const view = render(<QueryClientProvider client={client}><I18nextProvider i18n={i18n}><AuthProvider><WebSocketProvider><App /></WebSocketProvider></AuthProvider></I18nextProvider></QueryClientProvider>);
  const textarea = await view.findByRole('textbox');
  fireEvent.change(textarea, { target: { value: 'keep actual parent draft' } });
  await waitFor(() => assert.equal(records.get(JSON.stringify(['project', null]))?.input, 'keep actual parent draft'));
  const send = view.getByRole('button', { name: english.input.send });
  assert.equal(send.hasAttribute('disabled'), false);
  await act(async () => {
    const receipt = await prepareComposerFreeze({ token: 'parent', epoch: 1, ttlMs: 2000 });
    assert.equal(receipt.installerAuthority, false);
  });
  assert.equal(send.hasAttribute('disabled'), true);
  assert.equal(view.getByRole('button', { name: english.input.attachImages }).hasAttribute('disabled'), true);
  assert.equal(view.getByRole('button', { name: english.voice.input }).hasAttribute('disabled'), true);
  act(() => { cancelComposerFreeze({ token: 'parent', epoch: 1 }); });
  assert.equal(send.hasAttribute('disabled'), false);
  assert.equal((textarea as HTMLTextAreaElement).value, 'keep actual parent draft');
});
