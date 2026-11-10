'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Modal built on the native <dialog> element: focus is trapped and restored by the browser,
 * Escape closes it, and the rest of the page is inert while open.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  className,
  closeLabel = 'Close',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  closeLabel?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open, mounted]);

  if (!mounted) return null;
  // Portalled to <body> so a dialog is never nested inside a surrounding <form>.
  return createPortal(
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      className={cn(
        'm-auto w-[calc(100%-2rem)] max-w-lg rounded-xl border bg-card p-0 text-card-foreground shadow-xl backdrop:bg-black/50',
        className,
      )}
    >
      {open && (
        <div className="p-6">
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <h2 id={titleId} className="text-lg font-semibold">
                {title}
              </h2>
              {description && <p id={descId} className="mt-1 text-sm text-muted-foreground">{description}</p>}
            </div>
            <button type="button" onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-accent" aria-label={closeLabel}>
              <X className="h-4 w-4" />
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>,
    document.body,
  );
}
