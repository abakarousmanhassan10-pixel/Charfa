'use client';
import { useI18n } from '@/components/i18n-provider';
import { PlatformDot, StatusBadge } from '@/components/calendar/status';
import type { Platform } from '@/components/calendar/types';
import { cn } from '@/lib/utils';
import type { AccountStatus, PublicationStatus } from './types';

export function PlatformLabel({ platform, className }: { platform: Platform; className?: string }) {
  const { t } = useI18n();
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <PlatformDot platform={platform} />
      {t(`calendar.platforms.${platform}`)}
    </span>
  );
}

const ACCOUNT_STYLE: Record<AccountStatus, string> = {
  CONNECTED: 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300',
  TOKEN_EXPIRED: 'bg-red-500/15 text-red-800 dark:text-red-300',
  PERMISSION_MISSING: 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
  DISCONNECTED: 'bg-zinc-500/10 text-zinc-600 dark:text-zinc-400',
  ERROR: 'bg-red-500/15 text-red-800 dark:text-red-300',
};

export function AccountStatusBadge({ status }: { status: AccountStatus }) {
  const { t } = useI18n();
  return <span className={cn('inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium', ACCOUNT_STYLE[status])} data-status={status}>{t(`social.accountStatus.${status}`)}</span>;
}

const PUB_STYLE: Record<PublicationStatus, string> = {
  PENDING: 'bg-slate-500/10 text-slate-700 dark:text-slate-300',
  QUEUED: 'bg-sky-500/15 text-sky-800 dark:text-sky-300',
  PUBLISHING: 'bg-cyan-500/15 text-cyan-800 dark:text-cyan-300',
  AWAITING_PROVIDER: 'bg-cyan-500/15 text-cyan-800 dark:text-cyan-300',
  PUBLISHED: 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300',
  FAILED: 'bg-red-500/15 text-red-800 dark:text-red-300',
  CANCELLED: 'bg-zinc-500/10 text-zinc-600 line-through dark:text-zinc-400',
  MANUAL_REQUIRED: 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
};

export function PublicationStatusBadge({ status }: { status: PublicationStatus }) {
  const { t } = useI18n();
  return <span className={cn('inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium', PUB_STYLE[status])} data-status={status}>{t(`social.pubStatus.${status}`)}</span>;
}

export { StatusBadge };
