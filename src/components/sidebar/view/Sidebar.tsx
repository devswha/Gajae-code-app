import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { version as currentVersion } from '../../../../package.json';
import { useDesktopUpdate } from '../../../hooks/useDesktopUpdate';
import { useDeviceSettings } from '../../../hooks/useDeviceSettings';
import { useProjectsQuery } from '../../../hooks/useProjectsQuery';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useAppShellStore } from '../../../stores/useAppShellStore';
import { usePaletteOps } from '../../../stores/usePaletteOpsStore';
import type { LLMProvider, Project } from '../../../types/app';
import { useSessionStatusResolver } from '../hooks/useSessionStatusResolver';
import { useSidebarController } from '../hooks/useSidebarController';
import type { SidebarProps } from '../types/types';

import SidebarCollapsed from './SidebarCollapsed';
import SidebarContent from './SidebarContent';
import SidebarModals from './SidebarModals';
import type { SidebarProjectListProps } from './SidebarProjectList';

function Sidebar(props: SidebarProps) {
  // Keep the shared native client alive across expanded/collapsed subscriptions.
  useDesktopUpdate();
  const { activeSessions, onProjectSelect, onSessionSelect, onNewSession, onSessionDelete, onLoadMoreSessions, onProjectDelete, onRefresh, isMobile } = props;
  const { t } = useTranslation(['sidebar', 'common']);
  const { isPWA } = useDeviceSettings({ trackMobile: false });
  const { preferences, setPreference } = useUiPreferences();
  const palette = usePaletteOps();
  const projectQuery = useProjectsQuery();
  const selectedProject = useAppShellStore((shell) => shell.selectedProject);
  const selectedSession = useAppShellStore((shell) => shell.selectedSession);
  const getSessionStatus = useSessionStatusResolver(activeSessions, selectedSession?.id ?? null);
  const loadingProgress = useAppShellStore((shell) => shell.loadingProgress);
  const showSettings = useAppShellStore((shell) => shell.showSettings);
  const settingsInitialTab = useAppShellStore((shell) => shell.settingsInitialTab);
  const openSettings = useAppShellStore((shell) => shell.openSettings);
  const setShowSettings = useAppShellStore((shell) => shell.setShowSettings);
  const projects = projectQuery.data ?? [];
  const controller = useSidebarController({
    projects,
    selectedProject,
    selectedSession,
    isLoading: projectQuery.isLoading,
    isMobile,
    t,
    onRefresh,
    onProjectSelect,
    onSessionSelect,
    onSessionDelete,
    onLoadMoreSessions,
    onProjectDelete,
    setSidebarVisible: (visible) => setPreference('sidebarVisible', visible),
    sidebarVisible: preferences.sidebarVisible,
  });

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.classList.toggle('pwa-mode', isPWA);
    document.body.classList.toggle('pwa-mode', isPWA);
  }, [isPWA]);

  const isExplicit = (project: Project) => project.origin === 'explicit';
  const visibleProjects = projects.filter(isExplicit);
  const visibleFilteredProjects = controller.filteredProjects.filter(isExplicit);
  const projectListProps: SidebarProjectListProps = {
    projects: visibleProjects,
    filteredProjects: visibleFilteredProjects,
    selectedProject,
    selectedSession,
    isLoading: projectQuery.isLoading,
    isMobile,
    loadingProgress,
    expandedProjects: controller.expandedProjects,
    editingProject: controller.editingProject,
    editingName: controller.editingName,
    initialSessionsLoaded: controller.initialSessionsLoaded,
    currentTime: controller.currentTime,
    editingSession: controller.editingSession,
    editingSessionName: controller.editingSessionName,
    deletingProjects: controller.deletingProjects,
    getProjectSessions: controller.getProjectSessions,
    loadingMoreProjects: controller.loadingMoreProjects,
    activeSessions,
    getSessionStatus,
    isProjectStarred: controller.isProjectStarred,
    onEditingNameChange: controller.setEditingName,
    onToggleProject: controller.toggleProject,
    onProjectSelect: controller.handleProjectSelect,
    onToggleStarProject: controller.toggleStarProject,
    onStartEditingProject: controller.startEditing,
    onCancelEditingProject: controller.cancelEditing,
    onSaveProjectName: (projectId) => { void controller.saveProjectName(projectId); },
    onDeleteProject: controller.requestProjectDelete,
    onSessionSelect: controller.handleSessionClick,
    onDeleteSession: controller.showDeleteSessionConfirmation,
    onLoadMoreSessions: controller.loadMoreSessionsForProject,
    onNewSession,
    onEditingSessionNameChange: controller.setEditingSessionName,
    onStartEditingSession: (sessionId, initialName) => {
      controller.setEditingSession(sessionId);
      controller.setEditingSessionName(initialName);
    },
    onCancelEditingSession: () => {
      controller.setEditingSession(null);
      controller.setEditingSessionName('');
    },
    onSaveEditingSession: (projectId: string, sessionId: string, summary: string, provider: LLMProvider) => { void controller.updateSessionSummary(projectId, sessionId, summary, provider); },
    onRegenerateTitle: (sessionId) => { void controller.regenerateSessionTitle(sessionId); },
    onToggleSessionStar: (sessionId) => { void controller.toggleSessionStar(sessionId); },
    onExportSession: (sessionId) => { void controller.exportSession(sessionId); },
    onCopyDebugInfo: (sessionId) => { void controller.copyDebugInfo(sessionId); },
    t,
  };

  return (
    <>
      <SidebarModals
        projects={projects}
        showSettings={showSettings}
        settingsInitialTab={settingsInitialTab}
        onCloseSettings={() => setShowSettings(false)}
        showNewProject={controller.showNewProject}
        onCloseNewProject={() => controller.setShowNewProject(false)}
        onProjectCreated={() => { void palette.refreshProjects(); }}
        deleteConfirmation={controller.deleteConfirmation}
        onCancelDeleteProject={() => controller.setDeleteConfirmation(null)}
        onConfirmDeleteProject={controller.confirmDeleteProject}
        sessionDeleteConfirmation={controller.sessionDeleteConfirmation}
        onCancelDeleteSession={() => controller.setSessionDeleteConfirmation(null)}
        onConfirmDeleteSession={controller.confirmDeleteSession}
        t={t}
      />
      {controller.isSidebarCollapsed ? (
        <SidebarCollapsed onExpand={controller.expandSidebar} onShowSettings={() => openSettings()} t={t} />
      ) : (
        <SidebarContent
          isPWA={isPWA}
          isMobile={isMobile}
          isArchiveOpen={controller.isArchiveOpen}
          archivedProjects={controller.archivedProjects}
          archivedSessions={controller.archivedSessions}
          archivedSessionsCount={controller.archivedSessionsCount}
          isArchivedSessionsLoading={controller.isArchivedSessionsLoading}
          archiveLoadError={controller.archiveLoadError}
          onOpenArchive={controller.openArchive}
          onCloseArchive={controller.closeArchive}
          onRestoreArchivedProject={controller.restoreArchivedProject}
          onArchivedSessionClick={controller.openArchivedSession}
          onRestoreArchivedSession={controller.restoreArchivedSession}
          onDeleteArchivedSession={(session) => controller.showDeleteSessionConfirmation(session.projectId, session.sessionId, session.sessionTitle, session.provider, { isArchived: true })}
          onRefresh={() => { void controller.refreshProjects(); }}
          isRefreshing={controller.isRefreshing}
          onSearch={palette.openCommandPalette}
          onCreateProject={() => controller.setShowNewProject(true)}
          onCollapseSidebar={controller.collapseSidebar}
          currentVersion={currentVersion}
          onShowSettings={() => openSettings()}
          projectListProps={projectListProps}
          t={t}
        />
      )}
    </>
  );
}

export default Sidebar;
