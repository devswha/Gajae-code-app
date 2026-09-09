export type BrowserTabState = {
  id: string;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
};

export type BrowserSessionState = {
  sessionId: string;
  activeTabId: string | null;
  tabs: BrowserTabState[];
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validates a complete metadata snapshot, optionally scoped to its observer. */
export function isBrowserSessionState(value: unknown, sessionId?: string): value is BrowserSessionState {
  if (!object(value)
    || typeof value.sessionId !== 'string' || value.sessionId.length === 0
    || (sessionId !== undefined && value.sessionId !== sessionId)
    || (value.activeTabId !== null && (typeof value.activeTabId !== 'string' || value.activeTabId.length === 0))
    || !Array.isArray(value.tabs)) return false;

  const tabIds = new Set<string>();
  for (const tab of value.tabs) {
    if (!object(tab)
      || typeof tab.id !== 'string' || tab.id.length === 0 || tabIds.has(tab.id)
      || typeof tab.title !== 'string'
      || typeof tab.url !== 'string'
      || typeof tab.loading !== 'boolean'
      || typeof tab.canGoBack !== 'boolean'
      || typeof tab.canGoForward !== 'boolean') return false;
    tabIds.add(tab.id);
  }
  return value.activeTabId === null || tabIds.has(value.activeTabId);
}
