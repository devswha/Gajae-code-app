import { useTranslation } from 'react-i18next';
import { ArrowDownIcon, ArrowUpIcon, PencilIcon, XIcon } from 'lucide-react';

interface QueuedMessageCardProps {
  content: string;
  imageCount?: number;
  pendingSteer?: boolean;
  requiresReview?: boolean;
  /** 1-based place in the send order. */
  position: number;
  total: number;
  onEdit: () => void;
  onDelete: () => void;
  /** Absent at the ends of the queue, where the move would do nothing. */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}

export default function QueuedMessageCard({
  content,
  imageCount = 0,
  pendingSteer = false,
  requiresReview = false,
  position,
  total,
  onEdit,
  onDelete,
  onMoveUp,
  onMoveDown,
}: QueuedMessageCardProps) {
  const { t } = useTranslation('chat');
  const isNext = position === 1;

  return (
    <div className="mx-auto mb-1.5 max-w-chat settings-content-enter rounded-xl border border-dashed border-primary/25 bg-primary/4 px-3 py-2">
      <div className="flex items-start gap-2.5">
        {total > 1 ? (
          <span
            className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary/80"
            aria-hidden
          >
            {position}
          </span>
        ) : (
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60" aria-hidden />
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-primary/70 uppercase">
            <span>{t('input.queue.label')}</span>
            <span className="text-muted-foreground/60 normal-case">
              {/* Only the head is sent when the current turn ends; the rest
                  follow one per turn, so promising otherwise would be a lie. */}
              · {requiresReview ? t('input.queue.reviewBeforeSending', { defaultValue: 'Edit and review before sending' }) : pendingSteer ? t('input.queue.awaitingSteer') : isNext ? t('input.queue.willSend') : t('input.queue.willFollow')}
            </span>
          </div>
          <p className="mt-0.5 line-clamp-2 text-sm wrap-break-word text-foreground/90">{content}</p>
          {imageCount > 0 && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('input.queue.images', { count: imageCount })}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {total > 1 && (
            <>
              <button
                type="button"
                onClick={onMoveUp}
                disabled={!onMoveUp}
                aria-label={t('input.queue.moveUp')}
                title={t('input.queue.moveUp')}
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
              >
                <ArrowUpIcon className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={onMoveDown}
                disabled={!onMoveDown}
                aria-label={t('input.queue.moveDown')}
                title={t('input.queue.moveDown')}
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
              >
                <ArrowDownIcon className="h-3.5 w-3.5" />
              </button>
            </>
          )}
          <button
            type="button"
            onClick={onEdit}
            aria-label={t('input.queue.edit')}
            title={t('input.queue.edit')}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <PencilIcon className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            aria-label={t('input.queue.delete')}
            title={t('input.queue.delete')}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
