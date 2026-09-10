import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';

import type { ServerEvent } from '../contexts/WebSocketContext';
import type { Project } from '../types/app';
import { resetAppShellStore, useAppShellStore } from '../stores/useAppShellStore';

import { useProjectsState } from './useProjectsState';

const project = (sessions: Project['sessions'] = []): Project => ({
  projectId: 'project-1',
  path: '/workspace/project',
  fullPath: '/workspace/project',
  displayName: 'Project one',
  origin: 'explicit',
  isStarred: false,
  sessions,
  sessionMeta: { hasMore: false, total: sessions.length },
});

type HookState = ReturnType<typeof useProjectsState>;

const navigations: string[] = [];

type Harness = {
  getState: () => HookState;
  emit: (event: ServerEvent) => void;
  loadingStates: boolean[];
};

const renderHarness = (): Harness => {
  let state: HookState | null = null;
  let listener: ((event: ServerEvent) => void) | null = null;
  const loadingStates: boolean[] = [];
  const queryClient = new QueryClient({
    defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } },
  });

  const HarnessComponent = () => {
    const hookState = useProjectsState({
      sessionId: null,
      navigate: ((path: string) => { navigations.push(path); }) as never,
      subscribe: (nextListener) => {
        listener = nextListener;
        return () => {
          listener = null;
        };
      },
      isMobile: false,
      activeSessions: new Map(),
    });
    state = hookState;
    if (loadingStates.at(-1) !== hookState.isLoadingProjects) {
      loadingStates.push(hookState.isLoadingProjects);
    }

    return createElement('output', { 'data-testid': 'projects-state' }, JSON.stringify({
      projectNames: hookState.projects.map((item) => item.displayName),
      isLoadingProjects: hookState.isLoadingProjects,
      sessionIds: hookState.projects.flatMap((item) => item.sessions?.map((session) => session.id) ?? []),
    }));
  };

  render(createElement(QueryClientProvider, { client: queryClient }, createElement(HarnessComponent)));

  return {
    getState: () => {
      assert.ok(state, 'hook state is available after rendering');
      return state;
    },
    emit: (event) => {
      assert.ok(listener, 'websocket listener is registered');
      listener(event);
    },
    loadingStates,
  };
};

const installFetch = (responses: Array<{ status?: number; body: unknown }>) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const response = responses[calls++];
    assert.ok(response, 'unexpected network request');
    return new Response(JSON.stringify(response.body), { status: response.status ?? 200 });
  };
  return {
    calls: () => calls,
    urls: () => urls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
};

afterEach(() => {
  cleanup();
  // The lone project selects itself and is remembered; do not hand that to the next suite.
  localStorage.clear();
  resetAppShellStore();
});

test('mount fetches projects once and exposes initial loading state', async () => {
  const fetch = installFetch([{ body: [project()] }]);
  try {
    const harness = renderHarness();

    await waitFor(() => assert.deepEqual(harness.getState().projects.map((item) => item.displayName), ['Project one']));

    assert.equal(fetch.calls(), 1);
    assert.equal(new URL(fetch.urls()[0], window.location.origin).pathname, '/api/projects');
    assert.deepEqual(harness.loadingStates, [true, false]);
  } finally {
    fetch.restore();
  }
});

test('silent refresh does not return to initial loading state', async () => {
  const fetch = installFetch([{ body: [project()] }, { body: [project()] }]);
  try {
    const harness = renderHarness();
    await waitFor(() => assert.equal(harness.getState().isLoadingProjects, false));

    await act(async () => {
      await harness.getState().refreshProjectsSilently();
    });

    assert.equal(fetch.calls(), 2);
    assert.deepEqual(harness.loadingStates, [true, false]);
  } finally {
    fetch.restore();
  }
});

test('session upserts write directly to the project cache', async () => {
  const fetch = installFetch([{ body: [project()] }]);
  try {
    const harness = renderHarness();
    await waitFor(() => assert.equal(harness.getState().projects.length, 1));

    act(() => {
      harness.emit({
        kind: 'session_upserted',
        sessionId: 'session-ws',
        provider: 'gjc',
        session: { id: 'session-ws', summary: 'From websocket' },
        project: {
          projectId: 'project-1',
          path: '/workspace/project',
          fullPath: '/workspace/project',
          displayName: 'Project one',
          isStarred: false,
        },
        timestamp: new Date().toISOString(),
      } as ServerEvent);
    });

    await waitFor(() => assert.deepEqual(harness.getState().projects[0]?.sessions?.map((session) => session.id), ['session-ws']));
    assert.equal(fetch.calls(), 1);
  } finally {
    fetch.restore();
  }
});

test('archived project upserts leave the active cache alone while new projects are inserted', async () => {
  const fetch = installFetch([{ body: [project()] }]);
  try {
    const harness = renderHarness();
    await waitFor(() => assert.equal(harness.getState().projects.length, 1));

    act(() => harness.emit({
      kind: 'session_upserted',
      sessionId: 'archived-session',
      provider: 'gjc',
      session: { id: 'archived-session', summary: 'Archived update' },
      project: {
        projectId: 'project-archived',
        path: '/workspace/archived',
        fullPath: '/workspace/archived',
        displayName: 'Archived project',
        isStarred: false,
        isArchived: true,
      },
      timestamp: new Date().toISOString(),
    } as ServerEvent));
    assert.deepEqual(harness.getState().projects.map((item) => item.projectId), ['project-1']);

    act(() => harness.emit({
      kind: 'session_upserted',
      sessionId: 'new-session',
      provider: 'gjc',
      session: { id: 'new-session', summary: 'New project update' },
      project: {
        projectId: 'project-new',
        path: '/workspace/new',
        fullPath: '/workspace/new',
        displayName: 'New project',
        isStarred: false,
        isArchived: false,
      },
      timestamp: new Date().toISOString(),
    } as ServerEvent));
    await waitFor(() => assert.deepEqual(harness.getState().projects.map((item) => item.projectId), ['project-1', 'project-new']));
    assert.deepEqual(harness.getState().projects[1]?.sessions?.map((session) => session.id), ['new-session']);
  } finally {
    fetch.restore();
  }
});

test('an archived upsert removes a stale cached row without dropping the selected project', async () => {
  const fetch = installFetch([{ body: [project()] }]);
  try {
    const harness = renderHarness();
    await waitFor(() => assert.equal(harness.getState().projects.length, 1));
    await waitFor(() => assert.equal(harness.getState().selectedProject?.projectId, 'project-1'));

    act(() => harness.emit({
      kind: 'session_upserted',
      sessionId: 'archived-session',
      provider: 'gjc',
      session: { id: 'archived-session', summary: 'Archived update' },
      project: {
        projectId: 'project-1',
        path: '/workspace/project',
        fullPath: '/workspace/project',
        displayName: 'Project one',
        isStarred: false,
        isArchived: true,
      },
      timestamp: new Date().toISOString(),
    } as ServerEvent));

    await waitFor(() => assert.equal(harness.getState().projects.length, 0));
    assert.equal(harness.getState().selectedProject?.projectId, 'project-1');
    assert.equal(harness.getState().selectedProject?.isArchived, true);
    assert.equal(harness.getState().selectedProject?.sessions?.[0]?.id, 'archived-session');

    const archivedProject = harness.getState().selectedProject;
    assert.ok(archivedProject);
    act(() => {
      harness.getState().registerOptimisticSession({
        sessionId: 'archived-optimistic',
        provider: 'gjc',
        project: archivedProject,
        summary: 'Archived optimistic update',
      });
    });
    assert.equal(harness.getState().projects.length, 0);
    assert.equal(harness.getState().selectedProject?.isArchived, true);
    assert.equal(harness.getState().selectedSession?.id, 'archived-optimistic');
  } finally {
    fetch.restore();
  }
});

test('an upsert carrying an origin promotes the cached project so the sidebar can show it', async () => {
  // The indexer had only discovered the repo ('auto', hidden); a workspace
  // descend registered it as explicit on the server and the session landed.
  const fetch = installFetch([{ body: [{ ...project(), origin: 'auto' }] }]);
  try {
    const harness = renderHarness();
    await waitFor(() => assert.equal(harness.getState().projects.length, 1));

    act(() => {
      harness.emit({
        kind: 'session_upserted',
        sessionId: 'session-descended',
        provider: 'gjc',
        session: { id: 'session-descended', summary: 'fix the build' },
        project: {
          projectId: 'project-1',
          path: '/workspace/project',
          fullPath: '/workspace/project',
          displayName: 'Project one',
          isStarred: false,
          origin: 'explicit',
        },
        timestamp: new Date().toISOString(),
      } as ServerEvent);
    });

    await waitFor(() => assert.equal(harness.getState().projects[0]?.origin, 'explicit'));
    assert.deepEqual(harness.getState().projects[0]?.sessions?.map((session) => session.id), ['session-descended']);
    assert.equal(fetch.calls(), 1);
  } finally {
    fetch.restore();
  }
});

test('upsert origin only promotes cached projects to explicit', async () => {
  const fetch = installFetch([{ body: [{ ...project(), origin: 'explicit' }] }]);
  try {
    const harness = renderHarness();
    await waitFor(() => assert.equal(harness.getState().projects.length, 1));
    act(() => harness.emit({
      kind: 'session_upserted', sessionId: 'auto-event', provider: 'gjc', session: { id: 'auto-event' },
      project: { ...project(), origin: 'auto' }, timestamp: new Date().toISOString(),
    } as ServerEvent));
    await waitFor(() => assert.equal(harness.getState().projects[0]?.origin, 'explicit'));
    act(() => harness.emit({
      kind: 'session_upserted', sessionId: 'explicit-event', provider: 'gjc', session: { id: 'explicit-event' },
      project: { ...project(), origin: 'explicit' }, timestamp: new Date().toISOString(),
    } as ServerEvent));
    assert.equal(harness.getState().projects[0]?.origin, 'explicit');
  } finally {
    fetch.restore();
  }
});

test('an upsert for the viewed session renames it where the header reads it, not only in the sidebar', async () => {
  const fetch = installFetch([{ body: [project()] }]);
  try {
    const harness = renderHarness();
    await waitFor(() => assert.equal(harness.getState().projects.length, 1));

    act(() => {
      harness.getState().registerOptimisticSession({ sessionId: 'session-live', provider: 'gjc', project: project(), summary: 'why does boot hang on the second launch?' });
    });
    await waitFor(() => assert.equal(harness.getState().selectedSession?.id, 'session-live'));

    // The provider-id mapping broadcast carries no title yet; the optimistic one stays.
    act(() => {
      harness.emit({
        kind: 'session_upserted',
        sessionId: 'session-live',
        providerSessionId: 'provider-live',
        provider: 'gjc',
        session: { id: 'session-live', summary: '', messageCount: 0, lastActivity: new Date().toISOString() },
        project: { projectId: 'project-1', path: '/workspace/project', fullPath: '/workspace/project', displayName: 'Project one', isStarred: false },
        timestamp: new Date().toISOString(),
      } as ServerEvent);
    });
    assert.equal(harness.getState().selectedSession?.summary, 'why does boot hang on the second launch?');

    act(() => {
      harness.emit({
        kind: 'session_upserted',
        sessionId: 'session-live',
        provider: 'gjc',
        session: { id: 'session-live', summary: 'Fix the boot race', messageCount: 0, lastActivity: new Date().toISOString() },
        project: { projectId: 'project-1', path: '/workspace/project', fullPath: '/workspace/project', displayName: 'Project one', isStarred: false },
        timestamp: new Date().toISOString(),
      } as ServerEvent);
    });

    await waitFor(() => assert.equal(harness.getState().selectedSession?.summary, 'Fix the boot race'));
    assert.equal(harness.getState().projects[0]?.sessions?.find((session) => session.id === 'session-live')?.summary, 'Fix the boot race');
  } finally {
    fetch.restore();
  }
});

test('deleting a session removes its row and the row stays removed', async () => {
  const sessions = [
    { id: 'session-a', summary: 'Keep me', __provider: 'gjc' as const },
    { id: 'session-b', summary: 'Delete me', __provider: 'gjc' as const },
  ];
  const fetch = installFetch([{ body: [project(sessions)] }]);
  try {
    const harness = renderHarness();
    await waitFor(() => assert.deepEqual(harness.getState().projects[0]?.sessions?.map((session) => session.id), ['session-a', 'session-b']));

    act(() => { harness.getState().handleSessionDelete('session-b'); });

    // Not just on the next tick: the cache merge used to bring the row back.
    await waitFor(() => assert.deepEqual(harness.getState().projects[0]?.sessions?.map((session) => session.id), ['session-a']));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(harness.getState().projects[0]?.sessions?.map((session) => session.id), ['session-a']);
    assert.equal(harness.getState().projects[0]?.sessionMeta?.total, 1);
  } finally {
    fetch.restore();
  }
});

test('a confirmed handoff follows the new session when it is indexed; other upserts do not navigate', async () => {
  const sessions = [{ id: 'session-old', summary: 'Before the handoff', __provider: 'gjc' as const }];
  const fetch = installFetch([{ body: [project(sessions)] }]);
  try {
    const harness = renderHarness();
    await waitFor(() => assert.deepEqual(harness.getState().projects[0]?.sessions?.length, 1));

    // An upsert for the old session while pending: not the handoff's.
    useAppShellStore.getState().setPendingHandoff({ fromSessionId: 'session-old', projectId: 'project-1', at: Date.now() });
    act(() => harness.emit({
      kind: 'session_upserted', sessionId: 'session-old', provider: 'gjc',
      session: { summary: 'Before the handoff', updatedAt: '2026-01-01T00:01:00Z' },
      project: { projectId: 'project-1' },
    } as never));
    assert.deepEqual(navigations, []);

    // The handoff's new session arrives: follow it, once.
    act(() => harness.emit({
      kind: 'session_upserted', sessionId: 'session-new', provider: 'gjc',
      session: { summary: 'Untitled gjc Session', updatedAt: '2026-01-01T00:02:00Z' },
      project: { projectId: 'project-1' },
    } as never));
    assert.deepEqual(navigations, ['/session/session-new']);
    assert.equal(useAppShellStore.getState().pendingHandoff, null, 'the flag is consumed');
  } finally {
    fetch.restore();
  }
});

test('optimistic sessions survive a shorter refetch page', async () => {
  const fetch = installFetch([{ body: [project()] }, { body: [project()] }]);
  try {
    const harness = renderHarness();
    await waitFor(() => assert.equal(harness.getState().projects.length, 1));

    act(() => {
      harness.getState().registerOptimisticSession({
        sessionId: 'session-optimistic',
        provider: 'gjc',
        project: project(),
        summary: 'Optimistic',
      });
    });
    await waitFor(() => assert.deepEqual(harness.getState().projects[0]?.sessions?.map((session) => session.id), ['session-optimistic']));

    await act(async () => {
      await harness.getState().refreshProjectsSilently();
    });

    assert.deepEqual(harness.getState().projects[0]?.sessions?.map((session) => session.id), ['session-optimistic']);
  } finally {
    fetch.restore();
  }
});

test('degraded refetches retain the previous project cache', async () => {
  const fetch = installFetch([
    { body: [project()] },
    { status: 401, body: { error: 'Unauthorized' } },
  ]);
  try {
    const harness = renderHarness();
    await waitFor(() => assert.deepEqual(harness.getState().projects.map((item) => item.displayName), ['Project one']));

    await act(async () => {
      await harness.getState().refreshProjectsSilently();
    });

    assert.deepEqual(harness.getState().projects.map((item) => item.displayName), ['Project one']);
    assert.equal(fetch.calls(), 2);
  } finally {
    fetch.restore();
  }
});

test('sidebar shared props contain only navigation dependencies while the hook return keeps shell state', async () => {
  const fetch = installFetch([{ body: [project()] }]);
  try {
    const harness = renderHarness();
    await waitFor(() => assert.equal(harness.getState().projects.length, 1));

    assert.deepEqual(Object.keys(harness.getState().sidebarSharedProps), [
      'activeSessions',
      'onProjectSelect',
      'onSessionSelect',
      'onNewSession',
      'onSessionDelete',
      'onLoadMoreSessions',
      'onProjectDelete',
      'onRefresh',
      'isMobile',
    ]);
    assert.ok('selectedProject' in harness.getState());
    assert.ok('selectedSession' in harness.getState());
  } finally {
    fetch.restore();
  }
});

test('a late session page updates its cache without switching the selected project back', async () => {
  const originalFetch = globalThis.fetch;
  const first = { ...project(), sessionMeta: { total: 2, hasMore: true } };
  const second = { ...project(), projectId: 'project-2', displayName: 'Project two' };
  let resolvePage!: (response: Response) => void;
  globalThis.fetch = async (url) => String(url).includes('/sessions?')
    ? new Promise<Response>((resolve) => { resolvePage = resolve; })
    : new Response(JSON.stringify([first, second]));
  try {
    const harness = renderHarness();
    await waitFor(() => assert.equal(harness.getState().projects.length, 2));
    act(() => harness.getState().handleProjectSelect(first));
    let loading!: Promise<void>;
    act(() => { loading = harness.getState().loadMoreProjectSessions(first.projectId); });
    act(() => harness.getState().handleProjectSelect(second));
    await act(async () => {
      resolvePage(new Response(JSON.stringify({ sessions: [{ id: 'late-session' }], sessionMeta: { total: 2, hasMore: true } })));
      await loading;
    });
    await waitFor(() => assert.equal(harness.getState().projects[0].sessions?.[0]?.id, 'late-session'));
    assert.equal(harness.getState().selectedProject?.projectId, second.projectId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a late sidebar refresh cannot restore the project or session the viewer left', async () => {
  const originalFetch = globalThis.fetch;
  const first = project([{ id: 'first-session', summary: 'Before' }]);
  const second = { ...project(), projectId: 'project-2', displayName: 'Project two' };
  let resolveRefresh!: (response: Response) => void;
  let calls = 0;
  globalThis.fetch = async () => calls++ === 0
    ? new Response(JSON.stringify([first, second]))
    : new Promise<Response>((resolve) => { resolveRefresh = resolve; });
  try {
    const harness = renderHarness();
    await waitFor(() => assert.equal(harness.getState().projects.length, 2));
    act(() => harness.getState().handleProjectSelect(first));
    act(() => harness.getState().handleSessionSelect(first.sessions![0]));
    let refreshing!: Promise<void>;
    act(() => { refreshing = harness.getState().handleSidebarRefresh(); });
    act(() => harness.getState().handleProjectSelect(second));
    await act(async () => {
      resolveRefresh(new Response(JSON.stringify([{ ...first, displayName: 'Renamed', sessions: [{ id: 'first-session', summary: 'After' }] }, second])));
      await refreshing;
    });
    await waitFor(() => assert.equal(harness.getState().projects[0].displayName, 'Renamed'));
    assert.equal(harness.getState().selectedProject?.projectId, second.projectId);
    assert.equal(harness.getState().selectedSession, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
