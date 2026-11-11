'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Bot } from 'lucide-react';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Select } from '@/components/ui/select';
import { useResource } from '@/lib/use-resource';
import type { Monitoring } from './monitoring-view';
import { cn } from '@/lib/utils';

const TABS = [
  ['conversations', '/dashboard/sales'],
  ['customers', '/dashboard/sales/customers'],
  ['leads', '/dashboard/sales/leads'],
  ['opportunities', '/dashboard/sales/opportunities'],
  ['faq', '/dashboard/sales/faq'],
  ['analytics', '/dashboard/sales/analytics'],
  ['monitoring', '/dashboard/sales/monitoring'],
  ['agent', '/dashboard/sales/agent'],
] as const;

/** Shared header of the AI sales agent pages: title, business selector and scrollable sub-navigation (works on phones). */
export function SalesSection({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const { businesses, active, setActive } = useBusiness();
  const mon = useResource<Monitoring>('/sales/monitoring?days=1', active?.id);
  const bad = mon.data && (mon.data.health.status === 'DOWN' || mon.data.health.status === 'DEGRADED');
  return (
    <div className="mx-auto max-w-7xl">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-primary"><Bot className="h-3.5 w-3.5" aria-hidden />{t('sales.title')}</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">{title}</h1>
          {description && <p className="mt-1 text-muted-foreground">{description}</p>}
        </div>
        {businesses.length > 1 && (
          <div className="w-full sm:w-56">
            <label htmlFor="sales-business" className="mb-1 block text-xs font-medium text-muted-foreground">{t('ai.fields.business')}</label>
            <Select id="sales-business" value={active?.id ?? ''} onChange={(e) => setActive(e.target.value)}>{businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>
          </div>
        )}
      </div>
      {bad && <p role="alert" className="mb-4 rounded-md bg-amber-500/10 px-4 py-3 text-sm" data-testid="ai-health-banner">{t(mon.data!.health.status === 'DOWN' ? 'sales.monitoring.bannerDown' : 'sales.monitoring.bannerDegraded')} <Link className="font-medium underline" href="/dashboard/sales/monitoring">{t('sales.monitoring.openMonitoring')}</Link></p>}
      <nav aria-label={t('sales.title')} className="-mx-4 mb-6 flex gap-1 overflow-x-auto border-b px-4 sm:mx-0 sm:px-0" data-testid="sales-tabs">
        {TABS.map(([key, href]) => (
          <Link key={key} href={href} aria-current={pathname === href ? 'page' : undefined} className={cn('whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium', pathname === href ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>{t(`sales.tabs.${key}`)}</Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
