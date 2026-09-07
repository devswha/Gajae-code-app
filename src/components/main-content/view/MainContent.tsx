import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';

import type { MainContentProps } from '../types/types';
import { usePaletteOpsRegister } from '../../../stores/usePaletteOpsStore';
import { SessionStatusProvider } from '../../../contexts/SessionStatusContext';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useFileOpenResolver } from '../../../hooks/useFileOpenResolver';
import { useProjectPermissions } from '../../../hooks/useProjectPermissions';
import { useSessionStore } from '../../../stores/useSessionStore';
import { useWorkspacePanel } from '../../workspace/hooks/useWorkspacePanel';
import { useBrowserAutoReveal } from '../../workspace/hooks/useBrowserAutoReveal';
import { MIN_WORKSPACE_CHAT_WIDTH } from '../../workspace/workspacePanelState';
import { api } from '../../../utils/api';
import { useSessionLocation } from '../../chat/hooks/useSessionLocation';

import MainContentHeader from './MainContentHeader';
import MainContentStateView from './MainContentStateView';
import ErrorBoundary from './ErrorBoundary';

const ChatInterface = lazy(() => import('../../chat/view/ChatInterface'));
const WorkspacePanel = lazy(() => import('../../workspace/view/WorkspacePanel'));

function MainContent({
  selectedProject,
  selectedSession,
  activeTab,
  setActiveTab,
  ws,
  sendMessage,
  isMobile,
  onMenuClick,
  isLoading,
  onInputFocusChange,
  onSessionProcessing,
  onSessionIdle,
  processingSessions,
  onNavigateToSession,
  onNewSession,
  onSessionEstablished,
  onShowSettings,
  newSessionTrigger,
}: MainContentProps) {
  const { showImagePreviews, toolOutputDensity, sendByCtrlEnter } = useUiPreferences().preferences;
  const sessionStore = useSessionStore();
  const panel = useWorkspacePanel({ isMobile });
  const composerInsertRef = useRef<((text: string) => void) | null>(null);
  const handleComposerInsert = useCallback((text: string) => {
    const insert = composerInsertRef.current;
    if (!insert) return false;
    insert(text);
    return true;
  }, []);
  const { closePanel, containerRef, expanded, handleResizeKeyDown, handleResizeStart, isOpen, resizeHandleRef, setTab, tab, toggleExpanded, togglePanel, width } = panel;
  const [pendingBrowserNavigation, setPendingBrowserNavigation] = useState<{ id: number; url: string } | null>(null);
  const navigationSequence = useRef(0);
  const { permissions: projectPermissions } = useProjectPermissions(selectedProject?.projectId);
  const sessionLocation = useSessionLocation(selectedSession?.id);
  const automationSessionId = selectedProject
    ? selectedSession?.id ?? `project-${selectedProject.projectId}`
    : undefined;
  useBrowserAutoReveal(isLoading ? undefined : automationSessionId, panel.openPanel);

  const revealFile = useCallback((path: string) => {
    void api.system.openFile(path).catch((error) => {
      console.error('Failed to open file in the system editor:', error);
    });
  }, []);

  const resolveFile = useFileOpenResolver(selectedProject, revealFile, selectedSession?.id, sessionLocation.data?.cwd);

  useEffect(() => {
    if (activeTab === 'shell' || activeTab === 'git' || activeTab === 'files') {
      setActiveTab('chat');
    }
  }, [activeTab, setActiveTab]);

  usePaletteOpsRegister({
    openFile: revealFile,
    openFileInEditor: resolveFile,
    openBrowser: (address: string) => {
      navigationSequence.current += 1;
      setPendingBrowserNavigation({ id: navigationSequence.current, url: address });
      setTab('browser');
    },
  });

  if (isLoading) {
    return (
      <MainContentStateView
        mode="loading"
        isMobile={isMobile}
        onMenuClick={onMenuClick}
        onNewSession={onNewSession}
      />
    );
  }

  if (!selectedProject) {
    return (
      <MainContentStateView
        mode="empty"
        isMobile={isMobile}
        onMenuClick={onMenuClick}
        onNewSession={onNewSession}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <MainContentHeader
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        isMobile={isMobile}
        onMenuClick={onMenuClick}
        workspaceOpen={isOpen}
        onToggleWorkspace={togglePanel}
      />

      <SessionStatusProvider>
      <div ref={containerRef} className="flex min-h-0 flex-1 overflow-hidden">
        <div style={{ minWidth: MIN_WORKSPACE_CHAT_WIDTH }} className={`flex min-h-0 flex-1 flex-col overflow-hidden ${expanded ? 'hidden' : ''}`}>
          <div className={`h-full ${activeTab === 'chat' ? 'block' : 'hidden'}`}>
            <ErrorBoundary showDetails>
              <Suspense fallback={null}>
                <ChatInterface
                  sessionStore={sessionStore}
                  composerInsertRef={composerInsertRef}
                  selectedProject={selectedProject}
                  selectedSession={selectedSession}
                  ws={ws}
                  sendMessage={sendMessage}
                  onFileOpen={resolveFile}
                  onInputFocusChange={onInputFocusChange}
                  onSessionProcessing={onSessionProcessing}
                  onSessionIdle={onSessionIdle}
                  processingSessions={processingSessions}
                  onNavigateToSession={onNavigateToSession}
                  onSessionEstablished={onSessionEstablished}
                  onShowSettings={onShowSettings}
                  toolOutputDensity={toolOutputDensity}
                  showImagePreviews={showImagePreviews}
                  sendByCtrlEnter={sendByCtrlEnter}
                  newSessionTrigger={newSessionTrigger}
                />
              </Suspense>
            </ErrorBoundary>
          </div>
        </div>

        {isOpen && (
          <Suspense fallback={null}>
            <WorkspacePanel
              sessionStore={sessionStore}
              tab={tab}
              width={width}
              expanded={expanded}
              isMobile={isMobile}
              projectName={selectedProject.displayName}
              projectPath={selectedSession ? sessionLocation.data?.cwd ?? undefined : selectedProject.fullPath}
              projectId={selectedProject.projectId}
              sessionId={selectedSession?.id}
              onComposerInsert={handleComposerInsert}
              permissionMode={projectPermissions?.mode ?? null}
              automationSessionId={automationSessionId!}
              browserNavigation={pendingBrowserNavigation}
              onBrowserNavigationHandled={() => setPendingBrowserNavigation(null)}
              resizeHandleRef={resizeHandleRef}
              onTabChange={setTab}
              onResizeStart={handleResizeStart}
              onResizeKeyDown={handleResizeKeyDown}
              onToggleExpand={toggleExpanded}
              onClose={closePanel}
            />
          </Suspense>
        )}
      </div>
      </SessionStatusProvider>
    </div>
  );
}

export default MainContent;
