import { useId, useState } from 'react';
import { ChevronDown, CircleCheck, CircleDashed, CircleX, ListTodo, LoaderCircle, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../../shared/view/ui/Collapsible';
import type { SessionStore } from '../../../stores/useSessionStore';
import { cn } from '../../../utils/cn';
import { useSessionTodos, type SessionTodoPhase, type SessionTodoStatus } from '../hooks/useSessionTodos';

const STATUS_ICON: Record<SessionTodoStatus, { Icon: LucideIcon; className: string }> = {
  pending: { Icon: CircleDashed, className: 'text-muted-foreground/60' },
  in_progress: { Icon: LoaderCircle, className: 'animate-spin text-primary' },
  completed: { Icon: CircleCheck, className: 'text-muted-foreground' },
  abandoned: { Icon: CircleX, className: 'text-muted-foreground/50' },
};

function TaskListDisclosure({ phases }: { phases: SessionTodoPhase[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const contentId = useId();
  const label = t('workspace.tabs.tasks');
  const tasks = phases.flatMap((phase) => phase.tasks);
  const done = tasks.filter((task) => task.status === 'completed').length;
  const currentTask = tasks.find((task) => task.status === 'in_progress') ?? tasks.find((task) => task.status === 'pending');

  return (
    <section aria-label={label} className="shrink-0 px-2 py-2 sm:px-4">
      <Collapsible open={open} onOpenChange={setOpen} className="mx-auto w-full max-w-chat rounded-xl border border-border/60 bg-card/50">
        <CollapsibleTrigger
          aria-label={label}
          aria-controls={contentId}
          className="group flex min-h-11 w-full items-center gap-2 rounded-xl px-3 py-2 text-left transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <ListTodo className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-medium">{label}</span>
            {!open && currentTask && <span className="block truncate text-xs text-muted-foreground">{currentTask.content}</span>}
          </span>
          <span role="status" aria-live="polite" aria-atomic="true" className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {t('workspace.tasks.progress', { done, total: tasks.length })}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none" aria-hidden />
        </CollapsibleTrigger>
        <CollapsibleContent id={contentId} className="motion-reduce:transition-none">
          <div role="group" aria-label={label} tabIndex={0} className="max-h-[min(20vh,8rem)] space-y-3 overflow-y-auto overscroll-contain border-t border-border/50 px-3 py-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset sm:max-h-[min(28vh,14rem)]">
            {phases.filter((phase) => phase.tasks.length > 0).map((phase, phaseIndex) => (
              <div key={`${phaseIndex}:${phase.name}`} className="space-y-1">
                {phase.name && <h3 className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">{phase.name}</h3>}
                <ul className="space-y-0.5">
                  {phase.tasks.map((task, taskIndex) => {
                    const { Icon, className } = STATUS_ICON[task.status];
                    return (
                      <li key={`${taskIndex}:${task.content}`} className="rounded-md px-1 py-1.5">
                        <div className="flex items-start gap-2">
                          <Icon className={cn('mt-0.5 size-3.5 shrink-0', className)} aria-hidden />
                          <span className="sr-only">{t(`workspace.tasks.status.${task.status}`)}: </span>
                          <span className={cn('min-w-0 flex-1 text-sm wrap-anywhere',
                            (task.status === 'completed' || task.status === 'abandoned') && 'text-muted-foreground line-through decoration-muted-foreground/50')}
                          >
                            {task.content}
                          </span>
                        </div>
                        {task.status === 'in_progress' && task.notes.map((note, noteIndex) => (
                          <p key={`${noteIndex}:${note}`} className="mt-1 ml-5.5 text-xs wrap-anywhere whitespace-pre-wrap text-muted-foreground">{note}</p>
                        ))}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

/** The runtime's read-only task list stays above the transcript, even with the workspace rail closed. */
export default function ChatTasksPanel({ sessionId, sessionStore }: { sessionId?: string; sessionStore: SessionStore }) {
  const phases = useSessionTodos(sessionStore, sessionId, true);
  if (!sessionId || !phases.some((phase) => phase.tasks.length > 0)) return null;
  // A different conversation starts with its own expanded disclosure state.
  return <TaskListDisclosure key={sessionId} phases={phases} />;
}
