'use client';
import type { EntryStatus } from '@touma/shared';
import { useI18n } from '@/components/i18n-provider';
import { cn } from '@/lib/utils';
import { PlatformDot, STATUS_STYLE } from './status';
import type { Entry } from './types';

export const MOVABLE: EntryStatus[] = ['DRAFT', 'IN_REVIEW', 'REJECTED', 'APPROVED', 'SCHEDULED', 'FAILED'];

/** One calendar entry as a compact, keyboard-reachable chip. Draggable when the person may move it. */
export function EntryChip({
  entry,
  onOpen,
  draggable,
  onDragStart,
  conflict,
  showDate,
}: {
  entry: Entry;
  onOpen: (e: Entry) => void;
  draggable?: boolean;
  onDragStart?: (e: Entry) => void;
  conflict?: boolean;
  showDate?: boolean;
}) {
  const { t } = useI18n();
  const style = STATUS_STYLE[entry.status] ?? STATUS_STYLE.DRAFT;
  return (
    <button
      type="button"
      draggable={draggable}
      onDragStart={(ev) => {
        ev.dataTransfer.setData('text/plain', entry.id);
        ev.dataTransfer.effectAllowed = 'move';
        onDragStart?.(entry);
      }}
      onClick={() => onOpen(entry)}
      data-testid="calendar-entry"
      data-entry-id={entry.id}
      data-status={entry.status}
      data-platform={entry.platform ?? ''}
      aria-label={`${entry.local.time} ${entry.title} — ${t(`calendar.status.${entry.status}`)}${entry.platform ? ` — ${t(`calendar.platforms.${entry.platform}`)}` : ''}`}
      className={cn('flex w-full min-w-0 items-center gap-1.5 rounded-md border px-1.5 py-1 text-start text-xs leading-tight transition-shadow hover:shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', style.chip, draggable && 'cursor-grab active:cursor-grabbing', conflict && 'ring-1 ring-amber-500')}
    >
      <span className={cn('h-2 w-2 shrink-0 rounded-full', style.dot)} aria-hidden />
      <PlatformDot platform={entry.platform} />
      <span className="shrink-0 font-mono tabular-nums text-[11px] text-muted-foreground">{showDate ? `${entry.local.date.slice(5)} ` : ''}{entry.local.time}</span>
      <span className="min-w-0 truncate font-medium">{entry.title}</span>
      {conflict && <span className="ms-auto shrink-0 text-amber-600" title={t('calendar.conflict.badge')} aria-hidden>!</span>}
    </button>
  );
}
