import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, test } from 'node:test';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';

import { version } from '../../../../../package.json';
import { DESKTOP_UPDATE_BRIDGE_EVENT, DESKTOP_UPDATE_BRIDGE_NAME, DESKTOP_UPDATE_PHASES, type DesktopUpdateCommand, type DesktopUpdateSnapshot } from '../../../../../shared/desktopUpdateProtocol';
import english from '../../../../i18n/locales/en/settings.json';
import korean from '../../../../i18n/locales/ko/settings.json';

import AboutTab from './AboutTab';

const futureWebVersion = `${Number(version.split('.')[0]) + 1}.0.0`;
const retiredWebVersion = `${Number(version.split('.')[0]) + 2}.0.0`;

const globals = window as unknown as Record<string, unknown>;
const originalInjection = Object.getOwnPropertyDescriptor(window, DESKTOP_UPDATE_BRIDGE_NAME);
const originalFetch = globalThis.fetch;
beforeEach(() => {
  // Even a native-presence regression must not contact real release services.
  globalThis.fetch = async () => new Response('[]');
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  if (originalInjection) Object.defineProperty(window, DESKTOP_UPDATE_BRIDGE_NAME, originalInjection);
  else delete globals[DESKTOP_UPDATE_BRIDGE_NAME];
});

function native(extra: Partial<DesktopUpdateSnapshot> = {}): DesktopUpdateSnapshot {
  const targeted = ['available', 'downloading', 'verifying', 'ready'].includes(extra.phase ?? 'idle');
  return { protocolVersion: 1, phase: 'idle', automatic: true, productVersion: '2.0.0-beta.10',
    desktopVersion: '0.2.4', targetProductVersion: targeted ? '2.0.0-beta.11' : null,
    targetDesktopVersion: targeted ? '0.2.5' : null, targetId: targeted ? 'a'.repeat(64) : null,
    discoveryIncomplete: false, reason: null, installationAvailable: false,
    downloadedBytes: null, totalBytes: null, notes: null, ...extra };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function mount(language = 'en') {
  const i18n = createInstance();
  await i18n.init({ lng: language, fallbackLng: 'en', resources: { en: { settings: english }, ko: { settings: korean } }, interpolation: { escapeValue: false } });
  const view = render(<I18nextProvider i18n={i18n}><AboutTab /></I18nextProvider>);
  await act(async () => {});
  return { ...view, i18n };
}
function inject(request: (command: DesktopUpdateCommand) => Promise<unknown>) {
  globals[DESKTOP_UPDATE_BRIDGE_NAME] = { protocolVersion: 1, request };
}
async function replace(snapshot: DesktopUpdateSnapshot) {
  inject(async () => snapshot);
  await act(async () => { window.dispatchEvent(new Event(DESKTOP_UPDATE_BRIDGE_EVENT)); });
}

test('ordinary web retains notification-only About with no desktop controls or credential inputs', async () => {
  delete globals[DESKTOP_UPDATE_BRIDGE_NAME];
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify([{ tag_name: `v${futureWebVersion}`, draft: false, prerelease: false }]));
  };
  await mount();
  await waitFor(() => assert.equal(calls, 1));
  assert.ok(screen.getByRole('link', { name: english.about.updateAvailable.replace('{{version}}', futureWebVersion) }));
  assert.equal(screen.queryByText(english.desktopUpdate.title), null);
  assert.equal(screen.queryByRole('checkbox'), null);
  assert.equal(screen.queryByRole('button'), null);
  assert.equal(document.querySelector('input[type="password"]'), null);
});

test('injected but rejected/unvalidated bridge exposes no settings or install authority and never fetches GitHub', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response('[]'); };
  inject(async () => { throw new Error('private capability must not be rendered'); });
  const view = await mount();
  assert.equal(calls, 0);
  assert.equal(screen.queryByRole('checkbox'), null);
  assert.equal(screen.queryByRole('button', { name: english.desktopUpdate.check }), null);
  assert.equal(screen.queryByRole('button', { name: english.desktopUpdate.restart }), null);
  assert.ok(screen.getByText(english.desktopUpdate.unconfirmed));
  assert.ok(screen.getByRole('button', { name: english.desktopUpdate.refresh }));
  assert.equal(view.container.textContent?.includes('private capability'), false);
  assert.ok(screen.getByText(english.desktopUpdate.unknownVersion));
});

test('late native injection aborts web discovery; retirement never resumes a web latest claim', async () => {
  delete globals[DESKTOP_UPDATE_BRIDGE_NAME];
  const waiting = deferred<Response>();
  let calls = 0;
  let signal: AbortSignal | null = null;
  globalThis.fetch = async (_url, init) => { calls += 1; signal = init?.signal as AbortSignal; return waiting.promise; };
  await mount();
  await replace(native({ productVersion: '3.0.0', desktopVersion: '0.9.0' }));
  assert.equal((signal as AbortSignal | null)?.aborted, true);
  await act(async () => { waiting.resolve(new Response(JSON.stringify([{ tag_name: `v${retiredWebVersion}`, draft: false, prerelease: false }]))); });
  assert.ok(screen.getByText('v3.0.0'));
  assert.equal(screen.queryByRole('link', { name: english.about.updateAvailable.replace('{{version}}', retiredWebVersion) }), null);
  delete globals[DESKTOP_UPDATE_BRIDGE_NAME];
  await act(async () => { window.dispatchEvent(new Event(DESKTOP_UPDATE_BRIDGE_EVENT)); });
  assert.equal(calls, 1);
  assert.ok(screen.getByText(english.desktopUpdate.lastConfirmed));
  assert.equal((screen.getByRole('checkbox') as HTMLInputElement).disabled, true);
  assert.ok(screen.getByText('v3.0.0'), 'retirement retains native version rather than the web bundle version');
});

test('all native phases have truthful localized live status; preparation never claims installation', async () => {
  inject(async () => native());
  await mount();
  for (const phase of DESKTOP_UPDATE_PHASES) {
    await replace(native({ phase, discoveryIncomplete: true, reason: `native reason: ${phase}`, targetProductVersion: '2.0.0-beta.11', targetDesktopVersion: '0.2.5' }));
    const status = screen.getByRole('status');
    assert.equal(status.getAttribute('aria-live'), 'polite');
    assert.ok(status.textContent?.includes(english.desktopUpdate.phases[phase]));
    assert.ok(status.textContent?.includes(`native reason: ${phase}`));
    assert.ok(status.textContent?.includes(english.desktopUpdate.incomplete));
    assert.ok(screen.getByText(english.desktopUpdate.preparationOnly));
    assert.equal(screen.queryByRole('button', { name: english.desktopUpdate.update }), null);
    assert.ok(screen.getByText('0.2.5'));
    if (phase === 'disabled') {
      assert.equal((screen.getByRole('checkbox') as HTMLInputElement).disabled, true);
      assert.equal((screen.getByRole('button', { name: english.desktopUpdate.check }) as HTMLButtonElement).disabled, true);
      assert.equal((screen.getByRole('button', { name: english.desktopUpdate.refresh }) as HTMLButtonElement).disabled, false);
    }
  }
  assert.equal((screen.getByRole('checkbox') as HTMLInputElement).disabled, true, 'recovery cannot change automatic settings');
});

test('known and unknown download sizes preserve null progress without inventing percentages', async () => {
  inject(async () => native({ phase: 'downloading' }));
  await mount();
  assert.equal(screen.getByRole('progressbar').getAttribute('value'), null);
  assert.ok(screen.getByText(english.desktopUpdate.unknownProgress));
  await replace(native({ phase: 'downloading', downloadedBytes: 50 }));
  assert.equal(screen.getByRole('progressbar').getAttribute('value'), null);
  assert.ok(screen.getByText('50 bytes downloaded; total size unknown.'));
  await replace(native({ phase: 'downloading', downloadedBytes: 50, totalBytes: 100 }));
  assert.equal(screen.getByRole('progressbar').getAttribute('value'), '50');
  assert.equal(screen.getByRole('progressbar').getAttribute('max'), '100');
  assert.ok(screen.getByText('50 / 100 bytes'));
  await replace(native({ phase: 'downloading', downloadedBytes: 0, totalBytes: 0 }));
  assert.equal(screen.getByRole('progressbar').getAttribute('value'), null, 'zero bytes do not imply completion');
});

test('auto opt-out waits for native confirmation and a rejected setting never appears saved', async () => {
  let waiting = deferred<unknown>();
  let confirmed = native();
  const commands: DesktopUpdateCommand[] = [];
  inject(async (command) => { commands.push(command); return command.action === 'status' ? confirmed : waiting.promise; });
  await mount();
  const checkbox = screen.getByRole('checkbox', { name: english.desktopUpdate.automatic }) as HTMLInputElement;
  assert.equal(checkbox.checked, true);
  fireEvent.click(checkbox);
  await act(async () => {});
  assert.equal(checkbox.checked, true);
  assert.equal(checkbox.disabled, true);
  assert.ok(screen.getByText(english.desktopUpdate.confirmingSetting));
  await act(async () => { waiting.reject(new Error('persistence failed')); });
  assert.equal(checkbox.checked, true);
  assert.ok(screen.getByText(english.desktopUpdate.lastConfirmed));
  assert.equal((screen.getByRole('button', { name: english.desktopUpdate.refresh }) as HTMLButtonElement).disabled, false);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: english.desktopUpdate.refresh })); });
  waiting = deferred<unknown>();
  fireEvent.click(checkbox);
  await act(async () => {});
  confirmed = native({ automatic: false });
  await act(async () => { waiting.resolve(confirmed); });
  assert.equal(checkbox.checked, false);
  assert.deepEqual(commands.filter((command) => command.action === 'setAutomatic'), [
    { action: 'setAutomatic', automatic: false }, { action: 'setAutomatic', automatic: false },
  ]);
});

test('manual checks work when automatic is off, errors retry checks and recovery only refreshes status', async () => {
  const commands: DesktopUpdateCommand[] = [];
  let snapshot = native({ automatic: false });
  inject(async (command) => { commands.push(command); return snapshot; });
  await mount();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: english.desktopUpdate.check })); });
  assert.deepEqual(commands.at(-1), { action: 'check' });
  snapshot = native({ phase: 'error', automatic: false, reason: 'Offline' });
  await act(async () => { window.dispatchEvent(new Event(DESKTOP_UPDATE_BRIDGE_EVENT)); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: english.desktopUpdate.retry })); });
  assert.deepEqual(commands.at(-1), { action: 'check' });
  snapshot = native({ phase: 'recovery', reason: 'Native recovery required' });
  await act(async () => { window.dispatchEvent(new Event(DESKTOP_UPDATE_BRIDGE_EVENT)); });
  assert.equal((screen.getByRole('button', { name: english.desktopUpdate.check }) as HTMLButtonElement).disabled, true);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: english.desktopUpdate.refresh })); });
  assert.deepEqual(commands.at(-1), { action: 'status' });
});

test('Update requires native installation support and a ready or available target, with OS approval guidance', async () => {
  const commands: DesktopUpdateCommand[] = [];
  let snapshot = native({ phase: 'ready' });
  inject(async (command) => { commands.push(command); return snapshot; });
  await mount();
  assert.equal(screen.queryByRole('button', { name: english.desktopUpdate.update }), null);
  snapshot = native({ phase: 'deferred', installationAvailable: true });
  await act(async () => { window.dispatchEvent(new Event(DESKTOP_UPDATE_BRIDGE_EVENT)); });
  assert.equal(screen.queryByRole('button', { name: english.desktopUpdate.update }), null);
  snapshot = native({ phase: 'ready', installationAvailable: true });
  await act(async () => { window.dispatchEvent(new Event(DESKTOP_UPDATE_BRIDGE_EVENT)); });
  const restart = screen.getByRole('button', { name: english.desktopUpdate.update });
  const descriptions = restart.getAttribute('aria-describedby')?.split(' ').map((id) => document.getElementById(id)?.textContent);
  assert.deepEqual(descriptions, [english.desktopUpdate.manualHelp, english.desktopUpdate.osPrompt]);
  assert.equal(document.querySelector('input:not([type="checkbox"])'), null);
  act(() => restart.focus());
  assert.equal(document.activeElement === restart, true);
  await act(async () => { fireEvent.click(restart); });
  assert.deepEqual(commands.at(-1), { action: 'restart', targetId: snapshot.targetId });
  assert.ok(screen.getByText(english.desktopUpdate.phases.ready), 'a successful request does not invent a restart phase');
});

test('About checks discover only, with explicit Update required to download and safely restart an available target', async () => {
  const commands: DesktopUpdateCommand[] = [];
  let snapshot = native({ automatic: false });
  inject(async (command) => {
    commands.push(command);
    if (command.action === 'check') snapshot = native({ phase: 'available', automatic: false, installationAvailable: true });
    if (command.action === 'download') snapshot = { ...snapshot, phase: 'ready' };
    if (command.action === 'restart') snapshot = { ...snapshot, phase: 'restarting' };
    return snapshot;
  });
  await mount();
  assert.ok(screen.getByRole('checkbox', { name: 'Check for updates automatically' }));
  assert.ok(screen.getByText(english.desktopUpdate.automaticHelp));
  assert.ok(screen.getByText(english.desktopUpdate.manualHelp));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: english.desktopUpdate.check })); });
  assert.deepEqual(commands, [{ action: 'status' }, { action: 'check' }]);
  assert.ok(screen.getByText(english.desktopUpdate.phases.available));
  assert.ok(screen.getByText('2.0.0-beta.11'));
  const button = screen.getByRole('button', { name: english.desktopUpdate.update });
  act(() => { fireEvent.click(button); fireEvent.click(button); });
  await act(async () => {});
  assert.deepEqual(commands.filter((command) => ['download', 'restart'].includes(command.action)), [
    { action: 'download', targetId: snapshot.targetId }, { action: 'restart', targetId: snapshot.targetId },
  ]);
});

test('About retains a disconnected target read-only and Refresh status reconnects without any mutation', async () => {
  const snapshot = native({ phase: 'available', installationAvailable: true });
  const commands: DesktopUpdateCommand[] = [];
  let online = true;
  inject(async (command) => {
    commands.push(command);
    if (!online) throw new Error('disconnected');
    return snapshot;
  });
  await mount();
  online = false;
  await act(async () => { window.dispatchEvent(new Event(DESKTOP_UPDATE_BRIDGE_EVENT)); });
  assert.ok(screen.getByText(english.desktopUpdate.lastConfirmed));
  assert.equal((screen.getByRole('button', { name: english.desktopUpdate.update }) as HTMLButtonElement).disabled, true);
  assert.equal((screen.getByRole('button', { name: english.desktopUpdate.check }) as HTMLButtonElement).disabled, true);
  assert.equal((screen.getByRole('checkbox') as HTMLInputElement).disabled, true);
  const refresh = screen.getByRole('button', { name: english.desktopUpdate.refresh });
  assert.equal((refresh as HTMLButtonElement).disabled, false);
  online = true;
  await act(async () => { fireEvent.click(refresh); });
  assert.equal(screen.queryByText(english.desktopUpdate.lastConfirmed), null);
  assert.equal((screen.getByRole('button', { name: english.desktopUpdate.update }) as HTMLButtonElement).disabled, false);
  assert.ok(commands.every((command) => command.action === 'status'));
});

test('native notes, versions and reasons remain plaintext, bounded and keyboard focusable', async () => {
  const text = '<img src=x onerror="alert(1)">\n[Install](javascript:alert(1))';
  inject(async () => native({ phase: 'deferred', notes: text, reason: text, targetProductVersion: '<b>not HTML</b>' }));
  const view = await mount();
  assert.equal(view.container.querySelector('img, script, b'), null);
  const notes = screen.getByRole('region', { name: english.desktopUpdate.notes });
  assert.equal(notes.textContent, text);
  assert.equal(notes.getAttribute('tabindex'), '0');
  assert.ok(notes.className.includes('max-h-48'));
  assert.ok(notes.className.includes('overflow-y-auto'));
  assert.equal(notes.querySelector('a'), null);
});

test('English and Korean expose translated controls, progress, reasons and OS prompt instructions', async () => {
  inject(async () => native({ phase: 'downloading', downloadedBytes: 50, totalBytes: null, reason: '작업 완료 대기 중' }));
  const view = await mount('ko');
  assert.ok(screen.getByRole('heading', { name: korean.desktopUpdate.title }));
  assert.ok(screen.getByRole('checkbox', { name: korean.desktopUpdate.automatic }));
  assert.ok(screen.getByText('50바이트 다운로드됨 · 전체 크기 알 수 없음'));
  assert.ok(screen.getByText('작업 완료 대기 중'));
  await replace(native({ phase: 'ready', installationAvailable: true }));
  assert.ok(screen.getByRole('button', { name: korean.desktopUpdate.update }));
  assert.ok(screen.getByText(korean.desktopUpdate.osPrompt));
  await act(async () => { await view.i18n.changeLanguage('en'); });
  assert.ok(screen.getByRole('button', { name: english.desktopUpdate.update }));
  assert.ok(screen.getByText(english.desktopUpdate.osPrompt));
});

test('known native reason codes are localized while unknown reasons remain literal', async () => {
  inject(async () => native({ phase: 'error' }));
  const view = await mount();
  const keys = {
    discovery_failed: 'discoveryFailed', cache_invalid: 'cacheInvalid',
    preparation_cancelled: 'preparationCancelled', preferences_not_persisted: 'preferencesNotPersisted',
  } as const;
  for (const [language, translations] of [['en', english], ['ko', korean]] as const) {
    await act(async () => { await view.i18n.changeLanguage(language); });
    for (const [reason, key] of Object.entries(keys)) {
      await replace(native({ phase: 'error', reason }));
      assert.ok(screen.getByText(translations.desktopUpdate.reasons[key]));
    }
    await replace(native({ phase: 'error', reason: 'future_native_reason' }));
    assert.ok(screen.getByText('future_native_reason'));
    await replace(native({ phase: 'error', reason: 'constructor' }));
    assert.ok(screen.getByText('constructor'));
  }
});

test('desktop update keys and interpolation placeholders have parity across all ten settings locales', () => {
  function leaves(value: unknown, path = ''): Record<string, string> {
    if (typeof value === 'string') return { [path]: value };
    assert.ok(value && typeof value === 'object');
    return Object.assign({}, ...Object.entries(value).map(([key, item]) => leaves(item, `${path}.${key}`)));
  }
  const expected = leaves({ desktopUpdate: english.desktopUpdate, about: english.about });
  for (const locale of ['en', 'ko', 'de', 'fr', 'it', 'ja', 'ru', 'tr', 'zh-CN', 'zh-TW']) {
    const file = new URL(`../../../../i18n/locales/${locale}/settings.json`, import.meta.url);
    const translated = JSON.parse(readFileSync(file, 'utf8'));
    const actual = leaves({ desktopUpdate: translated.desktopUpdate, about: translated.about });
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), locale);
    for (const [key, text] of Object.entries(actual)) {
      assert.ok(text.trim().length > 0, `${locale}${key}`);
      assert.deepEqual(text.match(/\{\{\w+\}\}/g)?.sort() ?? [], expected[key].match(/\{\{\w+\}\}/g)?.sort() ?? [], `${locale}${key}`);
    }
  }
});
