'use client';
import { useI18n } from '@/components/i18n-provider';
import { Badge } from '@/components/ui/badge';

export function StatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  return <Badge variant={status === 'ACTIVE' ? 'success' : status === 'DRAFT' ? 'warning' : 'muted'}>{t(`catalog.status.${status}`)}</Badge>;
}

export function Price({ price, discount, currency, locale }: { price: string | null; discount?: string | null; currency: string | null; locale: string }) {
  const { t } = useI18n();
  const fmt = (v: string) => {
    try {
      return new Intl.NumberFormat(locale, { style: 'currency', currency: currency ?? 'USD' }).format(Number(v));
    } catch {
      return `${v} ${currency ?? ''}`;
    }
  };
  if (price === null) return <span className="text-muted-foreground">{t('catalog.noPrice')}</span>;
  if (!discount) return <span className="tabular-nums">{fmt(price)}</span>;
  return (
    <span className="tabular-nums">
      <span className="font-medium text-emerald-700 dark:text-emerald-400">{fmt(discount)}</span>{' '}
      <s className="text-xs text-muted-foreground">{fmt(price)}</s>
    </span>
  );
}
