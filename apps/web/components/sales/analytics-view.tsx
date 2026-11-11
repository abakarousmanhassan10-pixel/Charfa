'use client';
import { useState } from 'react';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { ErrorState, LoadingRows } from '@/components/ui/states';
import { useResource } from '@/lib/use-resource';

interface Analytics {
  days: number; conversations: number; newCustomers: number; customerMessages: number; avgCustomerMessagesPerConversation: number | null;
  byStatus: Record<string, number>; byAiMode: Record<string, number>; byLanguage: Record<string, number>; byIntent: Record<string, number>;
  handoffs: { total: number; rate: number | null; byReason: Record<string, number> };
  aiReplies: { sentAutomatically: number; drafts: number; draftsApproved: number; draftsRejected: number; humanReplies: number };
  leads: Record<string, number>; daily: Array<{ day: string; conversations: number }>; note: string;
}

function Bars({ data, label }: { data: Record<string, number>; label: (k: string) => string }) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map((e) => e[1]));
  if (!entries.length) return <p className="text-sm text-muted-foreground">—</p>;
  return (
    <ul className="grid gap-2">
      {entries.map(([k, v]) => (
        <li key={k} className="grid gap-1 text-sm" data-testid="bar" data-key={k}>
          <span className="flex justify-between"><span>{label(k)}</span><span className="font-medium">{v}</span></span>
          <span className="h-2 rounded-full bg-muted"><span className="block h-2 rounded-full bg-primary" style={{ width: `${(v / max) * 100}%` }} /></span>
        </li>
      ))}
    </ul>
  );
}

/** Conversation analytics, counted from stored conversations (nothing estimated; conversion to sales is not measured because TOUMA has no order data). */
export function AnalyticsView() {
  const { t } = useI18n();
  const { active } = useBusiness();
  const [days, setDays] = useState(30);
  const res = useResource<Analytics>(`/sales/analytics?days=${days}`, active?.id);
  if (res.loading && !res.data) return <LoadingRows rows={4} label={t('common.loading')} />;
  if (res.error && !res.data) return <ErrorState message={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => void res.reload()} />;
  const a = res.data!;
  const tiles: Array<[string, string | number]> = [
    ['conversations', a.conversations], ['newCustomers', a.newCustomers], ['aiAnswered', a.aiReplies.sentAutomatically + a.aiReplies.draftsApproved], ['handoffs', a.handoffs.total],
    ['handoffRate', a.handoffs.rate === null ? '—' : `${a.handoffs.rate}%`], ['avgMessages', a.avgCustomerMessagesPerConversation ?? '—'],
  ];
  return (
    <div className="grid gap-6">
      <div className="w-48"><label htmlFor="an-days" className="mb-1 block text-xs font-medium text-muted-foreground">{t('sales.analytics.period')}</label><Select id="an-days" value={days} onChange={(e) => setDays(Number(e.target.value))} data-testid="analytics-days">{[7, 30, 90].map((d) => <option key={d} value={d}>{t('sales.analytics.lastDays', { days: d })}</option>)}</Select></div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6" data-testid="analytics-tiles">
        {tiles.map(([k, v]) => <div key={k} className="rounded-xl border p-4" data-testid="stat" data-stat={k}><p className="text-xs text-muted-foreground">{t(`sales.analytics.${k}`)}</p><p className="mt-1 text-2xl font-bold">{v}</p></div>)}
      </div>
      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        <Card><CardHeader><CardTitle>{t('sales.analytics.byIntent')}</CardTitle></CardHeader><CardContent><Bars data={a.byIntent} label={(k) => (k === 'UNKNOWN' ? t('sales.analytics.unknown') : t(`sales.intent.${k}`))} /></CardContent></Card>
        <Card><CardHeader><CardTitle>{t('sales.analytics.byLanguage')}</CardTitle></CardHeader><CardContent><Bars data={a.byLanguage} label={(k) => (k === 'UNKNOWN' ? t('sales.analytics.unknown') : k.toUpperCase())} /></CardContent></Card>
        <Card><CardHeader><CardTitle>{t('sales.analytics.handoffReasons')}</CardTitle></CardHeader><CardContent><Bars data={a.handoffs.byReason} label={(k) => t(`sales.handoffReasons.${k}`)} /></CardContent></Card>
        <Card><CardHeader><CardTitle>{t('sales.analytics.leads')}</CardTitle></CardHeader><CardContent><Bars data={a.leads} label={(k) => t(`sales.lead.${k}`)} /></CardContent></Card>
        <Card><CardHeader><CardTitle>{t('sales.analytics.aiWork')}</CardTitle></CardHeader><CardContent><dl className="grid gap-2 text-sm">{(['sentAutomatically', 'drafts', 'draftsApproved', 'draftsRejected', 'humanReplies'] as const).map((k) => <div key={k} className="flex justify-between"><dt>{t(`sales.analytics.ai.${k}`)}</dt><dd className="font-medium">{a.aiReplies[k]}</dd></div>)}</dl></CardContent></Card>
      </div>
      <p className="text-xs text-muted-foreground" data-testid="analytics-note">{t('sales.analytics.note')}</p>
    </div>
  );
}
