import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, Dialog, DialogContent, DialogTitle } from '../../../shared/view/ui';

type BypassConfirmDialogProps = {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

/**
 * The one-time warning before a project's permission mode becomes `bypass`.
 * Shared by the composer picker and the command palette so the wording, and
 * the fact that it cannot be skipped, are the same wherever the switch lives.
 */
export default function BypassConfirmDialog({ open, onCancel, onConfirm }: BypassConfirmDialogProps) {
  const { t } = useTranslation('chat');
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent className="max-w-md animate-none p-5" data-testid="bypass-confirm">
        <DialogTitle className="not-sr-only flex items-center gap-2 text-base font-semibold text-destructive">
          <TriangleAlert className="size-4" aria-hidden />
          {t('permissionMode.bypassConfirm.title')}
        </DialogTitle>
        <p className="mt-2 text-sm text-foreground">{t('permissionMode.bypassConfirm.body')}</p>
        <p className="mt-2 text-xs text-muted-foreground">{t('permissionMode.bypassConfirm.scope')}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            {t('permissionMode.bypassConfirm.cancel')}
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm} data-action="confirm-bypass">
            {t('permissionMode.bypassConfirm.confirm')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
