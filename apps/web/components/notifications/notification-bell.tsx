'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Bell } from 'lucide-react';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import type { NotificationItem } from '@/components/calendar/types';

interface Page {
  items: NotificationItem[];
  unread: number;
}

const HREF: Record<string, string> = {
  'calendar.approval_requested': '/dashboard/calendar/approvals',
  'calendar.upcoming': '/dashboard/calendar/month',
  'calendar.failed': '/dashboard/calendar/month',
  'calendar.conflict': '/dashboard/calendar/month',
  'calendar.blocked': '/dashboard/calendar/month',
};

/** In-app notifications of the signed-in person for the active business: approvals, upcoming publications, failures, conflicts. */
export function NotificationBell() {
  const { t, locale } = useI18n();
  const { active } = useBusiness();
  const [page, setPage] = useState<Page>({ items: [], unread: 0 });
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!active) return;
    try {
      setPage(await api<Page>(`/notifications?businessId=${active.id}&pageSize=10`, { businessId: active.id }));
    } catch {
      /* the bell is a convenience: a failed refresh keeps the last state */
    }
  }, [active]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function read(n: NotificationItem) {
    if (n.readAt || !active) return;
    await api(`/notifications/${n.id}/read`, { method: 'POST', json: {}, businessId: active.id }).catch(() => undefined);
    void load();
  }
  async function readAll() {
    if (!active) return;
    await api(`/notifications/read-all?businessId=${active.id}`, { method: 'POST', json: {}, businessId: active.id }).catch(() => undefined);
    void load();
  }
  const text = (n: NotificationItem) => {
    const key = `notifications.types.${n.type}`;
    const d = (n.data ?? {}) as Record<string, unknown>;
    const msg = t(key, { title: String(d.entryTitle ?? ''), count: Number(d.count ?? 0) });
    return msg === key ? n.title : msg;
  };
  const fmt = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));

  return (
    <div className="relative" ref={box}>
      <Button variant="ghost" size="icon" className="relative" onClick={() => setOpen((o) => !o)} aria-label={t('notifications.title')} aria-expanded={open} aria-haspopup="true" data-testid="notification-bell">
        <Bell className="h-5 w-5" aria-hidden />
        {page.unread > 0 && <span className="absolute -end-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-destructive px-1 text-[10px] font-bold text-white" data-testid="notification-count" aria-label={t('notifications.unread', { count: page.unread })}>{page.unread > 9 ? '9+' : page.unread}</span>}
      </Button>
      {open && (
        <div role="region" aria-label={t('notifications.title')} className="absolute end-0 z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-xl border bg-card p-2 shadow-xl" data-testid="notification-panel">
          <div className="flex items-center justify-between px-2 py-1.5">
            <p className="text-sm font-semibold">{t('notifications.title')}</p>
            {page.unread > 0 && <button type="button" className="text-xs text-primary hover:underline" onClick={() => void readAll()} data-testid="notification-read-all">{t('notifications.readAll')}</button>}
          </div>
          {page.items.length === 0 ? <p className="px-2 py-6 text-center text-sm text-muted-foreground">{t('notifications.empty')}</p> : (
            <ul className="grid max-h-96 gap-1 overflow-y-auto">
              {page.items.map((n) => (
                <li key={n.id}>
                  <Link href={HREF[n.type] ?? '/dashboard/calendar'} onClick={() => { void read(n); setOpen(false); }} className={cn('block rounded-md px-2 py-2 text-sm hover:bg-accent', !n.readAt && 'bg-primary/5 font-medium')} data-testid="notification-item" data-type={n.type}>
                    <span className="block">{text(n)}</span>
                    <span className="block text-xs font-normal text-muted-foreground">{fmt(n.createdAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
