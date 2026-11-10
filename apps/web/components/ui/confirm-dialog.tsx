'use client';
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from './button';
import { Dialog } from './dialog';

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  destructive = true,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  destructive?: boolean;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open={open} onClose={onClose} title={title} description={description} closeLabel={cancelLabel}>
      {error && (
        <p role="alert" className="mb-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={onClose} disabled={pending}>
          {cancelLabel}
        </Button>
        <Button
          className={destructive ? 'bg-destructive text-white hover:bg-destructive/90' : undefined}
          disabled={pending}
          onClick={async () => {
            setPending(true);
            setError(null);
            try {
              await onConfirm();
              onClose();
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setPending(false);
            }
          }}
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
