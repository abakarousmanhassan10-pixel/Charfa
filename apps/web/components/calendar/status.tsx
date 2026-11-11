'use client';
import type { EntryStatus } from '@touma/shared';
import { useI18n } from '@/components/i18n-provider';
import { cn } from '@/lib/utils';
import type { Platform } from './types';

/** Visual language of the workflow states: dot color + badge classes. Text always accompanies color. */
export const STATUS_STYLE: Record<EntryStatus, { dot: string; badge: string; chip: string }> = {
  DRAFT: { dot: 'bg-slate-400', badge: 'bg-slate-500/10 text-slate-700 dark:text-slate-300', chip: 'border-slate-300 bg-slate-50 dark:bg-slate-900/40' },
  IN_REVIEW: { dot: 'bg-amber-500', badge: 'bg-amber-500/15 text-amber-800 dark:text-amber-300', chip: 'border-amber-300 bg-amber-50 dark:bg-amber-950/30' },
  REJECTED: { dot: 'bg-orange-500', badge: 'bg-orange-500/15 text-orange-800 dark:text-orange-300', chip: 'border-orange-300 bg-orange-50 dark:bg-orange-950/30' },
  APPROVED: { dot: 'bg-sky-500', badge: 'bg-sky-500/15 text-sky-800 dark:text-sky-300', chip: 'border-sky-300 bg-sky-50 dark:bg-sky-950/30' },
  SCHEDULED: { dot: 'bg-indigo-500', badge: 'bg-indigo-500/15 text-indigo-800 dark:text-indigo-300', chip: 'border-indigo-300 bg-indigo-50 dark:bg-indigo-950/30' },
  PUBLISHING: { dot: 'bg-cyan-500', badge: 'bg-cyan-500/15 text-cyan-800 dark:text-cyan-300', chip: 'border-cyan-300 bg-cyan-50 dark:bg-cyan-950/30' },
  PUBLISHED: { dot: 'bg-emerald-500', badge: 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300', chip: 'border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30' },
  FAILED: { dot: 'bg-red-500', badge: 'bg-red-500/15 text-red-800 dark:text-red-300', chip: 'border-red-300 bg-red-50 dark:bg-red-950/30' },
  CANCELLED: { dot: 'bg-zinc-400', badge: 'bg-zinc-500/10 text-zinc-600 line-through dark:text-zinc-400', chip: 'border-zinc-200 bg-zinc-50 opacity-70 dark:bg-zinc-900/40' },
};

export const PLATFORM_STYLE: Record<Platform, string> = {
  INSTAGRAM: 'bg-fuchsia-500',
  FACEBOOK: 'bg-blue-600',
  TIKTOK: 'bg-zinc-800 dark:bg-zinc-200',
  YOUTUBE: 'bg-red-600',
};

export function StatusBadge({ status, className }: { status: EntryStatus; className?: string }) {
  const { t } = useI18n();
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.DRAFT;
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium', s.badge, className)} data-status={status}>
      <span className={cn('h-1.5 w-1.5 rounded-full', s.dot)} aria-hidden />
      {t(`calendar.status.${status}`)}
    </span>
  );
}

export function PlatformDot({ platform }: { platform: Platform | null }) {
  return <span className={cn('inline-block h-2 w-2 shrink-0 rounded-sm', platform ? PLATFORM_STYLE[platform] : 'bg-muted')} aria-hidden />;
}

export function Legend() {
  const { t } = useI18n();
  const statuses: EntryStatus[] = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'SCHEDULED', 'PUBLISHED', 'FAILED', 'CANCELLED'];
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label={t('calendar.legend')} data-testid="calendar-legend">
      {statuses.map((s) => (
        <li key={s} className="flex items-center gap-1.5">
          <span className={cn('h-2 w-2 rounded-full', STATUS_STYLE[s].dot)} aria-hidden />
          {t(`calendar.status.${s}`)}
        </li>
      ))}
    </ul>
  );
}
