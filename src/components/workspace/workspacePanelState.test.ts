import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_WORKSPACE_PANEL_STATE,
  DEFAULT_WORKSPACE_PANEL_WIDTH,
  MIN_WORKSPACE_PANEL_WIDTH,
  WORKSPACE_PANEL_STORAGE_KEY,
  clampWorkspacePanelWidth,
  normalizeWorkspaceTab,
  readWorkspacePanelState,
  workspaceTabForKey,
  writeWorkspacePanelState,
  type WorkspaceStorage,
} from './workspacePanelState';

function createStorage(seed: Record<string, string> = {}): WorkspaceStorage & { entries: Map<string, string> } {
  const entries = new Map(Object.entries(seed));
  return {
    entries,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
  };
}

test('a width narrower than the minimum is raised instead of collapsing the panel', () => {
  assert.equal(clampWorkspacePanelWidth(40), MIN_WORKSPACE_PANEL_WIDTH);
});

test('a container width caps the panel so the chat keeps a fifth of the row', () => {
  assert.equal(clampWorkspacePanelWidth(5000, 1000), 800);
});

test('a container too narrow to honor the ratio still yields the minimum width', () => {
  assert.equal(clampWorkspacePanelWidth(500, 200), MIN_WORKSPACE_PANEL_WIDTH);
});

test('a non-finite width falls back to the default rather than styling NaN', () => {
  assert.equal(clampWorkspacePanelWidth(Number.NaN), DEFAULT_WORKSPACE_PANEL_WIDTH);
});

test('only the declared tabs are accepted', () => {
  assert.equal(normalizeWorkspaceTab('status'), 'status');
  assert.equal(normalizeWorkspaceTab('changes'), 'changes');
  assert.equal(normalizeWorkspaceTab('browser'), 'browser');
  assert.equal(normalizeWorkspaceTab('shell'), null);
  assert.equal(normalizeWorkspaceTab(undefined), null);
});

test('a tab retired with its panel degrades to the default instead of sticking', () => {
  assert.equal(normalizeWorkspaceTab('files'), null);
  assert.equal(normalizeWorkspaceTab('editor'), null);
  assert.equal(normalizeWorkspaceTab('tasks'), null);
});

test('tablist keys move across tabs and wrap in both directions', () => {
  assert.equal(workspaceTabForKey('status', 'ArrowRight'), 'changes');
  assert.equal(workspaceTabForKey('changes', 'ArrowRight'), 'browser');
  assert.equal(workspaceTabForKey('browser', 'ArrowRight'), 'status');
  assert.equal(workspaceTabForKey('status', 'ArrowLeft'), 'browser');
  assert.equal(workspaceTabForKey('browser', 'ArrowLeft'), 'changes');
  assert.equal(workspaceTabForKey('browser', 'Home'), 'status');
  assert.equal(workspaceTabForKey('status', 'End'), 'browser');
});

test('keys that are not tablist navigation are left to the browser', () => {
  assert.equal(workspaceTabForKey('status', 'Tab'), null);
  assert.equal(workspaceTabForKey('status', 'a'), null);
});

test('no storage at all yields the closed default instead of throwing', () => {
  assert.deepEqual(readWorkspacePanelState(null), DEFAULT_WORKSPACE_PANEL_STATE);
});

test('a persisted state is restored with its width clamped', () => {
  const storage = createStorage({
    [WORKSPACE_PANEL_STORAGE_KEY]: JSON.stringify({ open: true, tab: 'browser', width: 12 }),
  });

  assert.deepEqual(readWorkspacePanelState(storage), {
    open: true,
    tab: 'browser',
    width: MIN_WORKSPACE_PANEL_WIDTH,
  });
});

test('a state persisted against a retired tab reopens on the default tab', () => {
  const storage = createStorage({
    [WORKSPACE_PANEL_STORAGE_KEY]: JSON.stringify({ open: true, tab: 'editor', width: 420 }),
  });

  assert.deepEqual(readWorkspacePanelState(storage), {
    open: true,
    tab: DEFAULT_WORKSPACE_PANEL_STATE.tab,
    width: 420,
  });
});

test('the retired Tasks tab moves out of the rail without losing the saved width', () => {
  const storage = createStorage({
    [WORKSPACE_PANEL_STORAGE_KEY]: JSON.stringify({ open: true, tab: 'tasks', width: 420 }),
  });
  const state = readWorkspacePanelState(storage);
  assert.deepEqual(state, { open: false, tab: 'status', width: 420 });
  writeWorkspacePanelState(storage, state);
  assert.deepEqual(readWorkspacePanelState(storage), state);
});

test('a corrupt or foreign payload degrades to the default instead of rendering garbage', () => {
  assert.deepEqual(readWorkspacePanelState(createStorage({ [WORKSPACE_PANEL_STORAGE_KEY]: 'not json' })), DEFAULT_WORKSPACE_PANEL_STATE);
  assert.deepEqual(readWorkspacePanelState(createStorage({ [WORKSPACE_PANEL_STORAGE_KEY]: '"a string"' })), DEFAULT_WORKSPACE_PANEL_STATE);
  assert.deepEqual(
    readWorkspacePanelState(createStorage({ [WORKSPACE_PANEL_STORAGE_KEY]: JSON.stringify({ open: 'yes', tab: 'git' }) })),
    DEFAULT_WORKSPACE_PANEL_STATE,
  );
});

test('an install that had the old files panel open keeps a panel open on first load', () => {
  const state = readWorkspacePanelState(createStorage({ 'files-panel-open': 'true' }));

  assert.deepEqual(state, { ...DEFAULT_WORKSPACE_PANEL_STATE, open: true });
});

test('an install that had the old files panel closed stays closed', () => {
  assert.deepEqual(
    readWorkspacePanelState(createStorage({ 'files-panel-open': 'false' })),
    DEFAULT_WORKSPACE_PANEL_STATE,
  );
});

test('writing state persists the clamped value and retires the legacy key', () => {
  const storage = createStorage({ 'files-panel-open': 'true' });

  writeWorkspacePanelState(storage, { open: true, tab: 'browser', width: 10_000 });

  assert.equal(storage.entries.has('files-panel-open'), false);
  assert.deepEqual(JSON.parse(storage.entries.get(WORKSPACE_PANEL_STORAGE_KEY) ?? '{}'), {
    open: true,
    tab: 'browser',
    width: 1600,
  });
});

test('a storage that throws never propagates out of read or write', () => {
  const hostile: WorkspaceStorage = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
    removeItem: () => {
      throw new Error('blocked');
    },
  };

  assert.deepEqual(readWorkspacePanelState(hostile), DEFAULT_WORKSPACE_PANEL_STATE);
  assert.doesNotThrow(() => writeWorkspacePanelState(hostile, DEFAULT_WORKSPACE_PANEL_STATE));
});
