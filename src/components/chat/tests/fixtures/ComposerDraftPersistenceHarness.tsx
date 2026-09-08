import { useEffect, useState } from 'react';

import type { Project, ProjectSession } from '../../../../types/app';
import { useChatComposerState } from '../../hooks/useChatComposerState';
import type { ComposerDraftRepository } from '../../utils/composerDraftStorage';

// Test-only surface, not routed by the app. Both DOM tests and isolated browser
// QA exercise the production composer hook, not a parallel persistence UI.
export function ComposerDraftPersistenceHarness({ repository }: { repository?: ComposerDraftRepository }) {
  const [projectId, setProjectId] = useState('draft-qa-project-a');
  const [conversation, setConversation] = useState('draft-qa-session-a');
  const [busy, setBusy] = useState(true);
  const [sent, setSent] = useState(0);
  const [bodies, setBodies] = useState('');
  const project: Project = { projectId, fullPath: '/isolated-qa', displayName: projectId, origin: 'explicit' };
  const composer = useChatComposerState({
    draftRepository: repository, selectedProject: project,
    selectedSession: { id: conversation, __provider: 'gjc' } as ProjectSession,
    currentSessionId: null, gjcModel: 'fixture/model', isLoading: busy,
    canAbortSession: false, tokenBudget: null,
    sendMessage: () => { setSent((n) => n + 1); return true; },
    scrollToBottom() {}, addMessage() {}, setIsUserScrolledUp() {}, setPendingPermissionRequests() {},
  });
  useEffect(() => {
    let current = true;
    const files = [...composer.attachedImages, ...composer.queuedDrafts.flatMap((item) => item.images)];
    void Promise.all(files.map(async (file) => `${file instanceof File}:${file.name}:${file.type}:${file.lastModified}:${await file.text()}`))
      .then((text) => { if (current) setBodies(text.join('\n')); });
    return () => { current = false; };
  }, [composer.attachedImages, composer.queuedDrafts]); // File bytes are shown for synthetic fixtures only.
  return <main>
    <h1>Isolated composer draft persistence QA</h1>
    <label>Project<select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
      <option value="draft-qa-project-a">Project A</option><option value="draft-qa-project-b">Project B</option>
    </select></label>
    <label>Conversation<select value={conversation} onChange={(event) => setConversation(event.target.value)}>
      <option value="draft-qa-session-a">Conversation A</option><option value="draft-qa-session-b">Conversation B</option>
    </select></label>
    <label>Busy<input type="checkbox" checked={busy} onChange={(event) => setBusy(event.target.checked)} /></label>
    <p role="status">{composer.draftPersistence.phase}:{composer.draftPersistence.reason ?? 'none'}</p>
    <p>Ready: {String(composer.draftReady)}; sends: {sent}</p>
    <form onSubmit={composer.handleSubmit}>
      <label>Draft<textarea ref={composer.textareaRef} value={composer.input} onChange={composer.handleInputChange} /></label>
      <button type="button" onClick={() => {
        const file = new File(['<svg xmlns="http://www.w3.org/2000/svg">fixture attachment</svg>'], 'draft-fixture.svg', { type: 'image/svg+xml', lastModified: 1234567 });
        composer.handlePaste({ clipboardData: { items: [{ type: file.type, getAsFile: () => file }], files: [] } as unknown } as never);
      }}>Paste fixture image</button>
      <button type="submit">Submit draft</button>
      <button type="button" onClick={composer.handleClearInput}>Clear draft</button>
    </form>
    <ol>{composer.queuedDrafts.map((item, index) => <li key={item.id ?? index}>
      {item.id}: {item.content}; images: {item.images.length}; review: {String(Boolean(item.requiresReview))}
      <button onClick={() => composer.editQueuedDraft(index)}>Edit intent {index + 1}</button>
      <button onClick={() => composer.deleteQueuedDraft(index)}>Delete intent {index + 1}</button>
    </li>)}</ol>
    <pre aria-label="Fixture file hydration">{bodies}</pre>
  </main>;
}
