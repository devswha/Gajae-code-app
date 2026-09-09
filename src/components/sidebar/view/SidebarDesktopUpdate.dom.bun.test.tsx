import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createInstance, type TFunction } from 'i18next';
import { useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';

import { DESKTOP_UPDATE_BRIDGE_EVENT, DESKTOP_UPDATE_BRIDGE_NAME, type DesktopUpdateCommand, type DesktopUpdateSnapshot } from '../../../../shared/desktopUpdateProtocol';
import { useDesktopUpdate } from '../../../hooks/useDesktopUpdate';
import english from '../../../i18n/locales/en/settings.json';
import sidebarEnglish from '../../../i18n/locales/en/sidebar.json';
import korean from '../../../i18n/locales/ko/settings.json';
import sidebarKorean from '../../../i18n/locales/ko/sidebar.json';
import DesktopUpdatePanel from '../../settings/view/tabs/DesktopUpdatePanel';

import SidebarCollapsed from './SidebarCollapsed';
import SidebarDesktopUpdate from './SidebarDesktopUpdate';
import SidebarFooter from './SidebarFooter';

const globals = window as unknown as Record<string, unknown>;
const originalInjection = Object.getOwnPropertyDescriptor(window, DESKTOP_UPDATE_BRIDGE_NAME);
const originalFetch = globalThis.fetch;
const originalSetTimeout = window.setTimeout;
const originalClearTimeout = window.clearTimeout;
let nextTarget = 100;

afterEach(() => {
  cleanup();
  if (originalInjection) Object.defineProperty(window, DESKTOP_UPDATE_BRIDGE_NAME, originalInjection);
  else delete globals[DESKTOP_UPDATE_BRIDGE_NAME];
  globalThis.fetch = originalFetch;
  window.setTimeout = originalSetTimeout;
  window.clearTimeout = originalClearTimeout;
});

function native(extra: Partial<DesktopUpdateSnapshot> = {}): DesktopUpdateSnapshot {
  return { protocolVersion: 1, phase: 'available', automatic: true, productVersion: '2.0.0-beta.10',
    desktopVersion: '0.2.4', targetProductVersion: '2.0.0-beta.11', targetDesktopVersion: '0.2.5',
    targetId: (++nextTarget).toString(16).padStart(64, '0'), discoveryIncomplete: false, reason: null,
    installationAvailable: true, downloadedBytes: null, totalBytes: null, notes: null, ...extra };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function inject(request: (command: DesktopUpdateCommand) => Promise<unknown>) {
  globals[DESKTOP_UPDATE_BRIDGE_NAME] = { protocolVersion: 1, request };
}
async function replace(snapshot: DesktopUpdateSnapshot) {
  inject(async () => snapshot);
  await act(async () => { window.dispatchEvent(new Event(DESKTOP_UPDATE_BRIDGE_EVENT)); });
}
const flush = async () => { await act(async () => {}); };
const writes = (commands: DesktopUpdateCommand[]) => commands.filter((command) => command.action !== 'status');
const noop = () => {};

function Footer({ t }: { t: TFunction }) {
  return <SidebarFooter currentVersion="2.0.0-beta.10" onOpenArchive={noop} onRefresh={noop}
    isRefreshing={false} onShowSettings={noop} t={t} />;
}
function SharedPanel() {
  return <DesktopUpdatePanel update={useDesktopUpdate()} />;
}
function Modes({ t }: { t: TFunction }) {
  useDesktopUpdate();
  const [collapsed, setCollapsed] = useState(false);
  return <>
    <button type="button" onClick={() => setCollapsed(true)}>Collapse test sidebar</button>
    {collapsed ? <SidebarCollapsed t={t} onExpand={() => setCollapsed(false)} onShowSettings={noop} /> : <Footer t={t} />}
  </>;
}
async function mount(kind: 'footer' | 'collapsed' | 'notice' | 'shared' | 'modes' = 'footer', language = 'en', onExpand = noop) {
  const i18n = createInstance();
  await i18n.init({ lng: language, fallbackLng: 'en', interpolation: { escapeValue: false },
    resources: { en: { settings: english, sidebar: sidebarEnglish }, ko: { settings: korean, sidebar: sidebarKorean } } });
  const t = i18n.getFixedT(language, 'sidebar');
  const content = kind === 'collapsed' ? <SidebarCollapsed onExpand={onExpand} onShowSettings={noop} t={t} />
    : kind === 'notice' ? <SidebarDesktopUpdate />
      : kind === 'modes' ? <Modes t={t} />
        : kind === 'shared' ? <><Footer t={t} /><SharedPanel /></> : <Footer t={t} />;
  const view = render(<I18nextProvider i18n={i18n}>{content}</I18nextProvider>);
  await flush();
  return { ...view, i18n, t };
}

test('ordinary web and static Footer render are safe without a bridge, fetch, or updater UI', async () => {
  delete globals[DESKTOP_UPDATE_BRIDGE_NAME];
  let fetches = 0;
  globalThis.fetch = async () => { fetches += 1; throw new Error('unexpected network request'); };
  const view = await mount();
  assert.equal(view.container.querySelector('[data-sidebar-update]'), null);
  assert.ok(screen.getByRole('button', { name: sidebarEnglish.actions.settings }));
  assert.equal(fetches, 0);
  const html = renderToStaticMarkup(<Footer t={view.t} />);
  assert.ok(html.includes(sidebarEnglish.actions.settings));
  assert.equal(html.includes('data-sidebar-update'), false);
});

test('presence, unvalidated responses, disabled, idle, and missing targets do not introduce a notice', async () => {
  inject(async () => { throw new Error('private bridge capability'); });
  const view = await mount();
  assert.equal(view.container.querySelector('[data-sidebar-update]'), null);
  for (const snapshot of [native({ phase: 'disabled' }), native({ phase: 'idle' }), native({ phase: 'error', targetId: null })]) {
    await replace(snapshot);
    assert.equal(view.container.querySelector('[data-sidebar-update]'), null);
  }
  assert.equal(view.container.textContent?.includes('private bridge capability'), false);
});

test('available card is directly above Settings, polite, non-modal, and never steals focus or updates on render', async () => {
  const snapshot = native();
  const commands: DesktopUpdateCommand[] = [];
  const waiting = deferred<unknown>();
  inject(async (command) => { commands.push(command); return waiting.promise; });
  const view = await mount();
  const settings = screen.getByRole('button', { name: sidebarEnglish.actions.settings });
  act(() => settings.focus());
  await act(async () => { waiting.resolve(snapshot); });
  const card = view.container.querySelector('[data-sidebar-update="expanded"]');
  assert.equal(settings.previousElementSibling, card);
  assert.equal(document.activeElement, settings);
  assert.equal(screen.getByRole('status').getAttribute('aria-live'), 'polite');
  assert.ok(screen.getByText('Version 2.0.0-beta.11'));
  assert.ok(screen.getByText(english.desktopUpdate.phases.available));
  assert.equal(screen.queryByRole('dialog'), null);
  assert.equal(card?.querySelector('a, input'), null);
  assert.equal(card?.textContent?.includes(snapshot.targetId!), false, 'opaque target IDs are not displayed');
  assert.deepEqual(writes(commands), []);
});

test('Update explicitly downloads then requests one target-bound restart; duplicate cross-mount clicks coalesce', async () => {
  let snapshot = native();
  const commands: DesktopUpdateCommand[] = [];
  const waiting = deferred<unknown>();
  inject(async (command) => {
    commands.push(command);
    if (command.action === 'download') return waiting.promise;
    if (command.action === 'restart') return { ...snapshot, phase: 'restarting' };
    return snapshot;
  });
  await mount('shared');
  assert.deepEqual(commands, [{ action: 'status' }], 'two mounts share one discovery-free connection');
  const buttons = screen.getAllByRole('button', { name: english.desktopUpdate.update });
  act(() => { fireEvent.click(buttons[0]); fireEvent.click(buttons[1]); fireEvent.click(buttons[0]); });
  await flush();
  assert.deepEqual(writes(commands), [{ action: 'download', targetId: snapshot.targetId }]);
  assert.ok(screen.getAllByRole('button', { name: english.desktopUpdate.updating }).every((button) => (button as HTMLButtonElement).disabled));
  snapshot = { ...snapshot, phase: 'ready' };
  await act(async () => { waiting.resolve(snapshot); });
  assert.deepEqual(writes(commands), [
    { action: 'download', targetId: snapshot.targetId }, { action: 'restart', targetId: snapshot.targetId },
  ]);
  assert.equal(screen.queryByRole('button', { name: english.desktopUpdate.update }), null);
});

test('ready target uses Update to request restart only after a click', async () => {
  const snapshot = native({ phase: 'ready' });
  const commands: DesktopUpdateCommand[] = [];
  inject(async (command) => { commands.push(command); return command.action === 'restart' ? { ...snapshot, phase: 'restarting' } : snapshot; });
  await mount();
  assert.deepEqual(writes(commands), []);
  const button = screen.getByRole('button', { name: english.desktopUpdate.update });
  act(() => button.focus());
  assert.equal(document.activeElement, button);
  await act(async () => { fireEvent.click(button); });
  assert.deepEqual(writes(commands), [{ action: 'restart', targetId: snapshot.targetId }]);
});

test('dismissal survives sidebar mode swaps in memory but a different target is shown', async () => {
  const snapshot = native();
  inject(async () => snapshot);
  const beforeStorage = { ...localStorage };
  const view = await mount('modes');
  fireEvent.click(screen.getByRole('button', { name: english.desktopUpdate.dismiss }));
  assert.equal(view.container.querySelector('[data-sidebar-update]'), null);
  fireEvent.click(screen.getByRole('button', { name: 'Collapse test sidebar' }));
  assert.equal(view.container.querySelector('[data-sidebar-update]'), null);
  await replace(native({ targetProductVersion: '2.0.0-beta.12' }));
  const details = screen.getByRole('button', { name: /Show desktop update details: Version 2.0.0-beta.12/ });
  fireEvent.click(details);
  assert.ok(screen.getByRole('button', { name: english.desktopUpdate.update }));
  assert.ok(screen.getByText('Version 2.0.0-beta.12'));
  assert.deepEqual({ ...localStorage }, beforeStorage);
});

test('collapsed rail has a keyboard-focusable details icon immediately above bottom Settings; opening only expands', async () => {
  const commands: DesktopUpdateCommand[] = [];
  let expansions = 0;
  inject(async (command) => { commands.push(command); return native(); });
  const view = await mount('collapsed', 'ko', () => { expansions += 1; });
  const details = screen.getByRole('button', { name: /데스크톱 업데이트 정보 보기/ });
  const settings = screen.getByRole('button', { name: sidebarKorean.actions.settings });
  assert.equal(settings.previousElementSibling, details.parentElement);
  assert.ok(view.container.querySelector('.mt-auto')?.contains(settings), 'utility group is pinned to the bottom');
  act(() => details.focus());
  assert.equal(document.activeElement, details);
  assert.equal(details.getAttribute('title'), details.getAttribute('aria-label'));
  assert.ok(screen.getByRole('status').textContent?.includes(korean.desktopUpdate.phases.available));
  fireEvent.click(details);
  assert.equal(expansions, 1);
  assert.deepEqual(writes(commands), []);
});

test('Sidebar keeps a native client owner before the expanded/collapsed branch', () => {
  const source = readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8');
  assert.match(source, /function Sidebar\([^]*?useDesktopUpdate\(\);[^]*?controller\.isSidebarCollapsed/);
});

test('downloads preserve indeterminate unknown progress and verification does not invent a percentage', async () => {
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
  await replace(native({ phase: 'downloading', downloadedBytes: 0, totalBytes: 0 }));
  assert.equal(screen.getByRole('progressbar').getAttribute('value'), null);
  await replace(native({ phase: 'verifying', downloadedBytes: 100, totalBytes: 100 }));
  assert.equal(screen.getByRole('progressbar', { name: english.desktopUpdate.phases.verifying }).getAttribute('value'), null);
  assert.equal(screen.queryByRole('button', { name: english.desktopUpdate.update }), null);
});

test('unsupported installation has no Update action; disconnected snapshots lock mutations but allow read-only refresh', async () => {
  inject(async () => native({ installationAvailable: false }));
  const view = await mount();
  assert.ok(screen.getByText(english.desktopUpdate.preparationOnly));
  assert.equal(screen.queryByRole('button', { name: english.desktopUpdate.update }), null);
  await replace(native());
  delete globals[DESKTOP_UPDATE_BRIDGE_NAME];
  await act(async () => { window.dispatchEvent(new Event(DESKTOP_UPDATE_BRIDGE_EVENT)); });
  const card = view.container.querySelector('[data-sidebar-update="expanded"]')!;
  assert.ok(within(card as HTMLElement).getByText(english.desktopUpdate.lastConfirmed));
  assert.equal((screen.getByRole('button', { name: english.desktopUpdate.update }) as HTMLButtonElement).disabled, true);
  const refresh = screen.getByRole('button', { name: english.desktopUpdate.refresh });
  assert.equal((refresh as HTMLButtonElement).disabled, false);
  const commands: DesktopUpdateCommand[] = [];
  inject(async (command) => { commands.push(command); return native(); });
  await act(async () => { fireEvent.click(refresh); });
  assert.deepEqual(commands, [{ action: 'status' }]);
  assert.equal(screen.queryByText(english.desktopUpdate.lastConfirmed), null);
  assert.equal((screen.getByRole('button', { name: english.desktopUpdate.update }) as HTMLButtonElement).disabled, false);
});

test('error and deferred retry checks only; recovery is read-only status refresh', async () => {
  const commands: DesktopUpdateCommand[] = [];
  let snapshot = native({ phase: 'error', reason: 'discovery_failed' });
  inject(async (command) => { commands.push(command); return snapshot; });
  await mount('notice');
  assert.ok(screen.getByText(english.desktopUpdate.reasons.discoveryFailed));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: english.desktopUpdate.retry })); });
  assert.deepEqual(writes(commands), [{ action: 'check' }]);
  snapshot = { ...snapshot, phase: 'deferred' };
  await act(async () => { window.dispatchEvent(new Event(DESKTOP_UPDATE_BRIDGE_EVENT)); });
  assert.ok(screen.getByText(english.desktopUpdate.deferredHelp));
  snapshot = { ...snapshot, phase: 'recovery' };
  await act(async () => { window.dispatchEvent(new Event(DESKTOP_UPDATE_BRIDGE_EVENT)); });
  assert.ok(screen.getByText(english.desktopUpdate.recoveryHelp));
  assert.equal(screen.queryByRole('button', { name: english.desktopUpdate.update }), null);
  assert.equal(screen.queryByRole('button', { name: english.desktopUpdate.retry }), null);
  const before = commands.length;
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: english.desktopUpdate.refresh })); });
  assert.deepEqual(commands.slice(before), [{ action: 'status' }]);
});

test('timed-out native operations lock Update but permit status refresh without replaying a write', async () => {
  const timeouts = new Map<number, () => void>();
  let timerId = 50_000;
  window.setTimeout = ((...args: Parameters<typeof window.setTimeout>) => {
    if (args[1] !== 10_000) return originalSetTimeout.apply(window, args);
    timeouts.set(++timerId, args[0] as () => void);
    return timerId;
  }) as typeof window.setTimeout;
  window.clearTimeout = (timer) => {
    if (typeof timer === 'number' && timeouts.delete(timer)) return;
    originalClearTimeout.call(window, timer);
  };
  const snapshot = native();
  const waiting = deferred<unknown>();
  const commands: DesktopUpdateCommand[] = [];
  inject(async (command) => { commands.push(command); return command.action === 'download' ? waiting.promise : snapshot; });
  await mount('notice');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: english.desktopUpdate.update })); });
  assert.equal((screen.getByRole('button', { name: english.desktopUpdate.updating }) as HTMLButtonElement).disabled, true);
  await act(async () => { for (const callback of [...timeouts.values()]) callback(); });
  assert.ok(screen.getByText(english.desktopUpdate.awaitingOperation));
  assert.equal((screen.getByRole('button', { name: english.desktopUpdate.update }) as HTMLButtonElement).disabled, true);
  const refresh = screen.getByRole('button', { name: english.desktopUpdate.refresh });
  assert.equal((refresh as HTMLButtonElement).disabled, false);
  await act(async () => { fireEvent.click(refresh); });
  assert.ok(screen.getByText(english.desktopUpdate.awaitingOperation));
  assert.equal((screen.getByRole('button', { name: english.desktopUpdate.update }) as HTMLButtonElement).disabled, true);
  assert.deepEqual(writes(commands), [{ action: 'download', targetId: snapshot.targetId }]);
  await act(async () => { waiting.resolve({ ...snapshot, phase: 'ready' }); });
  assert.equal(screen.queryByText(english.desktopUpdate.awaitingOperation), null);
  assert.equal(commands.some((command) => command.action === 'restart'), false, 'a timed-out click never resumes installation');
});

test('busy, changed, and failed updates show translated actionable hints and never auto-retry', async () => {
  const cases = [
    ['updater_busy', 'busy'], ['updater_target_changed', 'changed'], ['updater_install_failed', 'failed'],
  ] as const;
  for (const [language, translations] of [['en', english], ['ko', korean]] as const) {
    for (const [reason, error] of cases) {
      const snapshot = native({ phase: 'ready' });
      const commands: DesktopUpdateCommand[] = [];
      inject(async (command) => { commands.push(command); return command.action === 'restart' ? { ...snapshot, reason } : snapshot; });
      const view = await mount('notice', language);
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: translations.desktopUpdate.update })); });
      const hint = screen.getByText(translations.desktopUpdate.updateErrors[error]);
      assert.ok(screen.getByRole('status').contains(hint));
      assert.equal((screen.getByRole('button', { name: translations.desktopUpdate.update }) as HTMLButtonElement).disabled, false);
      await flush();
      assert.deepEqual(writes(commands), [{ action: 'restart', targetId: snapshot.targetId }]);
      view.unmount();
    }
  }
});

test('owner preserves an accepted download across collapsed/expanded swaps without replaying it', async () => {
  let snapshot = native();
  const commands: DesktopUpdateCommand[] = [];
  const waiting = deferred<unknown>();
  inject(async (command) => {
    commands.push(command);
    if (command.action === 'download') return waiting.promise;
    return command.action === 'restart' ? { ...snapshot, phase: 'restarting' } : snapshot;
  });
  await mount('modes');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: english.desktopUpdate.update })); });
  fireEvent.click(screen.getByRole('button', { name: 'Collapse test sidebar' }));
  fireEvent.click(screen.getByRole('button', { name: /Show desktop update details/ }));
  assert.equal((screen.getByRole('button', { name: english.desktopUpdate.updating }) as HTMLButtonElement).disabled, true);
  assert.equal(commands.filter((command) => command.action === 'status').length, 1);
  snapshot = { ...snapshot, phase: 'ready' };
  await act(async () => { waiting.resolve(snapshot); });
  assert.deepEqual(writes(commands), [
    { action: 'download', targetId: snapshot.targetId }, { action: 'restart', targetId: snapshot.targetId },
  ]);
});
