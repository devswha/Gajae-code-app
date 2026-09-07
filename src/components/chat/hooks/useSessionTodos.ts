import { useCallback, useMemo, useSyncExternalStore } from 'react';

import type { NormalizedMessage, SessionStore } from '../../../stores/useSessionStore';

export type SessionTodoStatus = 'pending' | 'in_progress' | 'completed' | 'abandoned';
export type SessionTodo = { content: string; status: SessionTodoStatus; notes: string[] };
export type SessionTodoPhase = { name: string; tasks: SessionTodo[] };

type TodoOp = {
  op?: string;
  list?: Array<{ phase?: string; items?: string[] }>;
  task?: string;
  phase?: string;
  items?: string[];
  text?: string;
};

type TodoWriteDetails = {
  phases?: Array<{ name?: string; tasks?: Array<{ content?: string; status?: string; notes?: string[] }> }>;
};

const EMPTY_MESSAGES: NormalizedMessage[] = [];
const EMPTY_PHASES: SessionTodoPhase[] = [];

const STATUS: Record<string, SessionTodoStatus> = {
  pending: 'pending',
  in_progress: 'in_progress',
  completed: 'completed',
  abandoned: 'abandoned',
};

const findTask = (phases: SessionTodoPhase[], content: string): SessionTodo | undefined => {
  for (const phase of phases) {
    const task = phase.tasks.find((candidate) => candidate.content === content);
    if (task) return task;
  }
  return undefined;
};

const applyOps = (phases: SessionTodoPhase[], ops: TodoOp[]): SessionTodoPhase[] => {
  let next = phases;
  for (const op of ops) {
    if (op.op === 'init') {
      next = (Array.isArray(op.list) ? op.list : []).map((phase) => ({
        name: String(phase.phase ?? ''),
        tasks: (Array.isArray(phase.items) ? phase.items : []).map((content) => ({ content: String(content), status: 'pending' as const, notes: [] })),
      }));
      continue;
    }
    if (op.op === 'append' && op.phase && Array.isArray(op.items)) {
      const phasesCopy = next.map((phase) => ({ ...phase, tasks: [...phase.tasks] }));
      let phase = phasesCopy.find((candidate) => candidate.name === op.phase);
      if (!phase) {
        phase = { name: op.phase, tasks: [] };
        phasesCopy.push(phase);
      }
      phase.tasks.push(...op.items.map((content) => ({ content: String(content), status: 'pending' as const, notes: [] })));
      next = phasesCopy;
      continue;
    }
    if (!op.task) continue;
    if (op.op === 'rm') {
      next = next
        .map((phase) => ({ ...phase, tasks: phase.tasks.filter((task) => task.content !== op.task) }))
        .filter((phase) => phase.tasks.length > 0);
      continue;
    }
    const target = findTask(next, op.task);
    if (!target) continue;
    if (op.op === 'start') target.status = 'in_progress';
    else if (op.op === 'done') target.status = 'completed';
    else if (op.op === 'drop') target.status = 'abandoned';
    else if (op.op === 'note' && typeof op.text === 'string' && op.text) target.notes.push(op.text);
  }
  return next;
};

const phasesFromDetails = (details: TodoWriteDetails): SessionTodoPhase[] => (
  (Array.isArray(details.phases) ? details.phases : []).map((phase) => ({
    name: String(phase.name ?? ''),
    tasks: (Array.isArray(phase.tasks) ? phase.tasks : []).map((task) => ({
      content: String(task.content ?? ''),
      status: STATUS[String(task.status)] ?? 'pending',
      notes: Array.isArray(task.notes) ? task.notes.map(String) : [],
    })),
  }))
);

/**
 * The session's todo list as the agent last wrote it. The runtime's
 * structured result (`toolUseResult.phases`) is authoritative when present;
 * older sessions without it fold the todo_write ops in order, which yields
 * the same state for the ops the tool documents.
 */
export function sessionTodos(messages: readonly NormalizedMessage[]): SessionTodoPhase[] {
  // The runtime's structured result is authoritative; the latest one wins.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.kind !== 'tool_use' || message.toolName !== 'todo_write') continue;
    const details = message.toolResult?.toolUseResult as TodoWriteDetails | undefined;
    if (details && Array.isArray(details.phases)) return phasesFromDetails(details);
  }
  let phases: SessionTodoPhase[] = [];
  let sawOps = false;
  for (const message of messages) {
    if (message.kind !== 'tool_use' || message.toolName !== 'todo_write') continue;
    const ops = (message.toolInput as { ops?: TodoOp[] } | undefined)?.ops;
    if (Array.isArray(ops)) {
      sawOps = true;
      phases = applyOps(phases, ops);
    }
  }
  return sawOps ? phases : [];
}

/** Latest todo state for the visible chat, re-read when its messages change. */
export function useSessionTodos(sessionStore: SessionStore, sessionId: string | undefined, enabled: boolean): SessionTodoPhase[] {
  const { getMessages, subscribeSession } = sessionStore;
  const subscribe = useCallback(
    (listener: () => void) => (sessionId ? subscribeSession(sessionId, listener) : () => {}),
    [sessionId, subscribeSession],
  );
  const read = useCallback(() => (sessionId ? getMessages(sessionId) : EMPTY_MESSAGES), [getMessages, sessionId]);
  const messages = useSyncExternalStore(subscribe, read, read);
  return useMemo(() => (enabled && sessionId ? sessionTodos(messages) : EMPTY_PHASES), [enabled, sessionId, messages]);
}
