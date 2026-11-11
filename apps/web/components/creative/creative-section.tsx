'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Palette } from 'lucide-react';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';

const TABS = [
  ['overview', '/dashboard/creative'],
  ['images', '/dashboard/creative/images'],
  ['videos', '/dashboard/creative/videos'],
  ['storyboards', '/dashboard/creative/storyboards'],
  ['brandKit', '/dashboard/creative/brand-kit'],
  ['history', '/dashboard/creative/history'],
] as const;

/** Shared header for the Creative Studio pages: title, business selector and scrollable sub-navigation. */
export function CreativeSection({ title, description, actions, children }: { title: string; description?: string; actions?: React.ReactNode; children: React.ReactNode }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const { businesses, active, setActive } = useBusiness();
  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-primary">
            <Palette className="h-3.5 w-3.5" aria-hidden />
            {t('creative.title')}
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">{title}</h1>
          {description && <p className="mt-1 text-muted-foreground">{description}</p>}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          {actions}
          {businesses.length > 1 && (
            <div className="w-full sm:w-56">
              <label htmlFor="creative-business" className="mb-1 block text-xs font-medium text-muted-foreground">{t('ai.fields.business')}</label>
              <Select id="creative-business" value={active?.id ?? ''} onChange={(e) => setActive(e.target.value)}>
                {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
            </div>
          )}
        </div>
      </div>
      <nav aria-label={t('creative.title')} className="-mx-4 mb-6 flex gap-1 overflow-x-auto border-b px-4 sm:mx-0 sm:px-0">
        {TABS.map(([key, href]) => (
          <Link
            key={key}
            href={href}
            aria-current={pathname === href ? 'page' : undefined}
            className={cn('whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium', pathname === href ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}
          >
            {t(`creative.tabs.${key}`)}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
