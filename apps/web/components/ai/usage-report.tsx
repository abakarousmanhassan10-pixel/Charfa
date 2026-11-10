'use client';
import { useState } from 'react';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { LoadingRows } from '@/components/ui/states';
import { useResource } from '@/lib/use-resource';

interface Report {
  costConfigured: boolean;
  totals: { providerCalls: number; inputTokens: number; outputTokens: number; costUsd: number; generations: number; succeeded: number; failed: number };
  byAgent: Array<{ agent: string; calls: number; inputTokens: number; outputTokens: number; costUsd: number }>;
  byDay: Array<{ day: string; calls: number; inputTokens: number; outputTokens: number }>;
  monthToDate: { generations: number; generationLimit: number; tokens: number; tokenLimit: number };
}

/** Token consumption report: measured provider usage; cost = tokens × configured price. */
export function UsageReport() {
  const { t, locale } = useI18n();
  const { active } = useBusiness();
  const [days, setDays] = useState(30);
  const r = useResource<Report>(`/ai/usage?days=${days}`, active?.id);
  const n = (v: number) => new Intl.NumberFormat(locale).format(v);
  const max = Math.max(1, ...(r.data?.byDay.map((d) => d.inputTokens + d.outputTokens) ?? [1]));
  return (
    <Card data-testid="usage-report">
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle>{t('ai.usage.title')}</CardTitle>
          <CardDescription className="mt-1">{t('ai.usage.hint')}</CardDescription>
        </div>
        <Select aria-label={t('ai.usage.period')} value={String(days)} onChange={(e) => setDays(Number(e.target.value))} className="h-9 w-36">
          {[7, 30, 90].map((d) => <option key={d} value={d}>{t('ai.usage.lastDays', { count: d })}</option>)}
        </Select>
      </CardHeader>
      <CardContent>
        {!r.data ? (
          <LoadingRows rows={2} label={t('common.loading')} />
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                [t('ai.usage.generations'), `${n(r.data.totals.succeeded)} ✓ · ${n(r.data.totals.failed)} ✗`],
                [t('ai.usage.calls'), n(r.data.totals.providerCalls)],
                [t('ai.usage.tokens'), `${n(r.data.totals.inputTokens)} / ${n(r.data.totals.outputTokens)}`],
                [t('ai.usage.cost'), r.data.costConfigured ? `$${r.data.totals.costUsd.toFixed(4)}` : t('ai.usage.costNotConfigured')],
              ].map(([k, v]) => (
                <div key={k} className="rounded-md border p-3">
                  <dt className="text-xs text-muted-foreground">{k}</dt>
                  <dd className="mt-1 font-semibold tabular-nums">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-xs text-muted-foreground">
              {t('ai.usage.month', { gen: r.data.monthToDate.generations, genLimit: r.data.monthToDate.generationLimit, tokens: n(r.data.monthToDate.tokens), tokenLimit: n(r.data.monthToDate.tokenLimit) })}
            </p>
            {r.data.byDay.length > 0 && (
              <div className="mt-4" aria-label={t('ai.usage.perDay')} role="img">
                <div className="flex h-24 items-end gap-1">
                  {r.data.byDay.map((d) => (
                    <div key={d.day} title={`${d.day}: ${n(d.inputTokens + d.outputTokens)}`} className="max-w-8 flex-1 rounded-t bg-primary/70" style={{ height: `${Math.max(4, ((d.inputTokens + d.outputTokens) / max) * 100)}%` }} />
                  ))}
                </div>
              </div>
            )}
            {r.data.byAgent.length > 0 && (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground"><tr><th className="py-1 text-start">{t('ai.usage.agent')}</th><th className="text-end">{t('ai.usage.calls')}</th><th className="text-end">{t('ai.usage.input')}</th><th className="text-end">{t('ai.usage.output')}</th></tr></thead>
                  <tbody>{r.data.byAgent.map((a) => <tr key={a.agent} className="border-t"><td className="py-1.5">{t(`ai.agents.${a.agent}`)}</td><td className="text-end tabular-nums">{n(a.calls)}</td><td className="text-end tabular-nums">{n(a.inputTokens)}</td><td className="text-end tabular-nums">{n(a.outputTokens)}</td></tr>)}</tbody>
                </table>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
