/**
 * Persisted state for the right-hand Workspace panel.
 *
 * The panel replaced two independent right-hand surfaces (the files panel and
 * the editor sidebar), each with its own width and its own open flag. Keeping
 * the rules here — and out of React — means the width clamp, the tab
 * normalization and the storage migration are all directly testable, and the
 * panel component only has to render what these functions return.
 */

export const WORKSPACE_TABS = ['status', 'changes', 'browser'] as const;

export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

export type WorkspacePanelState = {
  open: boolean;
  tab: WorkspaceTab;
  width: number;
};

export type WorkspaceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const WORKSPACE_PANEL_STORAGE_KEY = 'workspace-panel';

// Written by the files panel this component replaced. Read once so an existing
// install keeps its panel open, then dropped on the next write.
const LEGACY_FILES_PANEL_OPEN_KEY = 'files-panel-open';

export const MIN_WORKSPACE_PANEL_WIDTH = 280;
export const DEFAULT_WORKSPACE_PANEL_WIDTH = 384;
export const WORKSPACE_PANEL_KEYBOARD_RESIZE_STEP = 24;

// A panel wider than this leaves the chat unusable, which is the one thing the
// panel must never do; the ratio applies whenever a container width is known.
const MAX_CONTAINER_RATIO = 0.8;
const ABSOLUTE_MAX_WORKSPACE_PANEL_WIDTH = 1600;

export const DEFAULT_WORKSPACE_PANEL_STATE: WorkspacePanelState = {
  open: false,
  // Status answers "what is this session doing" without any further clicks,
  // which is what a panel opened out of curiosity is usually being asked.
  tab: 'status',
  width: DEFAULT_WORKSPACE_PANEL_WIDTH,
};

export function clampWorkspacePanelWidth(width: number, containerWidth?: number): number {
  if (!Number.isFinite(width)) {
    return DEFAULT_WORKSPACE_PANEL_WIDTH;
  }

  const ceiling = typeof containerWidth === 'number' && containerWidth > 0
    ? Math.max(MIN_WORKSPACE_PANEL_WIDTH, Math.floor(containerWidth * MAX_CONTAINER_RATIO))
    : ABSOLUTE_MAX_WORKSPACE_PANEL_WIDTH;

  return Math.round(Math.min(Math.max(width, MIN_WORKSPACE_PANEL_WIDTH), ceiling));
}

export function normalizeWorkspaceTab(value: unknown): WorkspaceTab | null {
  return WORKSPACE_TABS.find((tab) => tab === value) ?? null;
}

/**
 * Returns the tab a tablist keypress should move to, or null when the key is
 * not a tablist navigation key. Arrow keys wrap, matching the ARIA tabs
 * pattern, so the strip stays usable without a pointer.
 */
export function workspaceTabForKey(current: WorkspaceTab, key: string): WorkspaceTab | null {
  const index = WORKSPACE_TABS.indexOf(current);
  if (index === -1) {
    return null;
  }

  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return WORKSPACE_TABS[(index + 1) % WORKSPACE_TABS.length] ?? null;
    case 'ArrowLeft':
    case 'ArrowUp':
      return WORKSPACE_TABS[(index - 1 + WORKSPACE_TABS.length) % WORKSPACE_TABS.length] ?? null;
    case 'Home':
      return WORKSPACE_TABS[0] ?? null;
    case 'End':
      return WORKSPACE_TABS[WORKSPACE_TABS.length - 1] ?? null;
    default:
      return null;
  }
}

export function readWorkspacePanelState(storage: WorkspaceStorage | null): WorkspacePanelState {
  if (!storage) {
    return DEFAULT_WORKSPACE_PANEL_STATE;
  }

  let raw: string | null = null;
  try {
    raw = storage.getItem(WORKSPACE_PANEL_STORAGE_KEY);
  } catch {
    return DEFAULT_WORKSPACE_PANEL_STATE;
  }

  if (raw === null) {
    return migrateLegacyState(storage);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_WORKSPACE_PANEL_STATE;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return DEFAULT_WORKSPACE_PANEL_STATE;
  }

  const record = parsed as Record<string, unknown>;
  const width = typeof record.width === 'number' ? record.width : DEFAULT_WORKSPACE_PANEL_WIDTH;

  return {
    // Tasks moved into the chat; do not open an unrelated rail on upgrade.
    open: record.tab !== 'tasks' && record.open === true,
    tab: normalizeWorkspaceTab(record.tab) ?? DEFAULT_WORKSPACE_PANEL_STATE.tab,
    width: clampWorkspacePanelWidth(width),
  };
}

function migrateLegacyState(storage: WorkspaceStorage): WorkspacePanelState {
  try {
    const legacyOpen = storage.getItem(LEGACY_FILES_PANEL_OPEN_KEY) === 'true';
    return legacyOpen
      ? { ...DEFAULT_WORKSPACE_PANEL_STATE, open: true }
      : DEFAULT_WORKSPACE_PANEL_STATE;
  } catch {
    return DEFAULT_WORKSPACE_PANEL_STATE;
  }
}

export function writeWorkspacePanelState(storage: WorkspaceStorage | null, state: WorkspacePanelState): void {
  if (!storage) {
    return;
  }

  try {
    storage.setItem(WORKSPACE_PANEL_STORAGE_KEY, JSON.stringify({
      open: state.open,
      tab: state.tab,
      width: clampWorkspacePanelWidth(state.width),
    }));
    storage.removeItem(LEGACY_FILES_PANEL_OPEN_KEY);
  } catch {
    // A full or blocked storage must not take the panel down with it.
  }
}
