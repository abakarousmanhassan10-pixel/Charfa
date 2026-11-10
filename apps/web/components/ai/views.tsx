'use client';
import { CircleAlert, Quote } from 'lucide-react';
import { useI18n } from '@/components/i18n-provider';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/* eslint-disable @typescript-eslint/no-explicit-any */

function Section({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <Card data-testid={testId}>
      <CardHeader className="pb-3">
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="text-sm">{children}</CardContent>
    </Card>
  );
}

function Bullets({ items }: { items: string[] }) {
  if (!items?.length) return <p className="text-muted-foreground">—</p>;
  return (
    <ul className="list-disc space-y-1 ps-5">
      {items.map((x, i) => <li key={i}>{x}</li>)}
    </ul>
  );
}

function Sourced({ items }: { items: Array<{ text: string; source: string }> }) {
  const { t } = useI18n();
  if (!items?.length) return <p className="text-muted-foreground">{t('ai.noVerifiedData')}</p>;
  return (
    <ul className="space-y-1.5">
      {items.map((x, i) => (
        <li key={i} className="flex flex-wrap items-start gap-2">
          <span>{x.text}</span>
          <Badge variant="muted" className="font-mono text-[10px]">{x.source.split(':')[0]}</Badge>
        </li>
      ))}
    </ul>
  );
}

export function MissingInfo({ items }: { items: string[] }) {
  const { t } = useI18n();
  if (!items?.length) return null;
  return (
    <div role="note" data-testid="missing-info" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
      <p className="flex items-center gap-1.5 font-medium">
        <CircleAlert className="h-4 w-4 text-amber-600" aria-hidden />
        {t('ai.missingInformation')}
      </p>
      <ul className="mt-2 list-disc space-y-1 ps-5 text-muted-foreground">
        {items.map((m, i) => <li key={i}>{m}</li>)}
      </ul>
    </div>
  );
}

export function BusinessAnalysisView({ data }: { data: any }) {
  const { t } = useI18n();
  return (
    <div className="grid gap-4" data-testid="business-analysis" dir="auto">
      <Section title={t('ai.ba.summary')}>
        <p className="whitespace-pre-line">{data.summary}</p>
        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          <div><dt className="text-muted-foreground">{t('ai.ba.industry')}</dt><dd className="font-medium">{data.industry}</dd></div>
          <div><dt className="text-muted-foreground">{t('ai.ba.market')}</dt><dd className="font-medium">{data.geographicMarket.primaryMarket}</dd></div>
        </dl>
        <p className="mt-4"><span className="text-muted-foreground">{t('ai.ba.positioning')}: </span>{data.positioning}</p>
      </Section>
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title={t('ai.ba.segments')}>
          <ul className="space-y-3">
            {data.targetSegments.map((s: any, i: number) => (
              <li key={i}>
                <p className="font-medium">{s.name}</p>
                <p className="text-muted-foreground">{s.description}</p>
                <div className="mt-1 flex flex-wrap gap-1">{s.preferredPlatforms.map((p: string) => <Badge key={p} variant="muted">{t(`ai.platforms.${p}`)}</Badge>)}</div>
              </li>
            ))}
          </ul>
        </Section>
        <Section title={t('ai.ba.brand')}>
          <p className="mb-2"><span className="text-muted-foreground">{t('ai.ba.tone')}: </span>{data.communicationStyle.recommendedTone}</p>
          <p className="font-medium">{t('ai.ba.do')}</p>
          <Bullets items={data.communicationStyle.do} />
          <p className="mt-2 font-medium">{t('ai.ba.avoid')}</p>
          <Bullets items={data.communicationStyle.avoid} />
          <div className="mt-3 flex flex-wrap gap-1">{data.brandIdentity.personality.map((p: string, i: number) => <Badge key={i}>{p}</Badge>)}</div>
        </Section>
        <Section title={t('ai.ba.needs')}><Bullets items={data.customerNeeds} /></Section>
        <Section title={t('ai.ba.strengths')}><Sourced items={data.strengths} /></Section>
        <Section title={t('ai.ba.objectives')}><Bullets items={data.marketingObjectives} /></Section>
        <Section title={t('ai.ba.platforms')}>
          <ul className="space-y-2">
            {data.recommendedPlatforms.map((p: any, i: number) => (
              <li key={i}><Badge variant={p.priority === 'HIGH' ? 'success' : 'muted'}>{t(`ai.platforms.${p.platform}`)} · {t(`ai.priority.${p.priority}`)}</Badge> <span className="text-muted-foreground">{p.reason}</span></li>
            ))}
          </ul>
        </Section>
      </div>
      <MissingInfo items={data.missingInformation} />
      {data.assumptions?.length > 0 && <Section title={t('ai.assumptions')}><Bullets items={data.assumptions} /></Section>}
    </div>
  );
}

export function ProductAnalysisView({ data }: { data: any }) {
  const { t } = useI18n();
  return (
    <div className="grid gap-4" data-testid="product-analysis" dir="auto">
      <Section title={data.item.name}>
        <p className="whitespace-pre-line">{data.summary}</p>
        <p className="mt-3"><span className="text-muted-foreground">{t('ai.pa.positioning')}: </span>{data.positioning}</p>
      </Section>
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title={t('ai.pa.characteristics')}><Sourced items={data.characteristics} /></Section>
        <Section title={t('ai.pa.benefits')}><Sourced items={data.verifiedBenefits} /></Section>
        <Section title={t('ai.pa.problems')}><Bullets items={data.customerProblems} /></Section>
        <Section title={t('ai.pa.segments')}>
          <ul className="space-y-2">{data.customerSegments.map((s: any, i: number) => <li key={i}><span className="font-medium">{s.name}</span> — <span className="text-muted-foreground">{s.reason}</span></li>)}</ul>
        </Section>
        <Section title={t('ai.pa.angles')}>
          <ul className="space-y-3">
            {data.marketingAngles.map((a: any, i: number) => (
              <li key={i}>
                <p className="font-medium">{a.name}</p>
                <p className="flex gap-1 italic"><Quote className="h-3.5 w-3.5 shrink-0" aria-hidden />{a.hook}</p>
                <p className="text-muted-foreground">{a.description}</p>
              </li>
            ))}
          </ul>
        </Section>
        <Section title={t('ai.pa.differentiation')}><Bullets items={data.differentiationOpportunities} /></Section>
        <Section title={t('ai.pa.objections')}>
          <ul className="space-y-3">
            {data.possibleObjections.map((o: any, i: number) => (
              <li key={i}>
                <p className="font-medium">{o.objection}</p>
                <p className="text-muted-foreground">{o.suggestedResponse}</p>
                {o.needsBusinessInput && <Badge variant="warning">{t('ai.needsInput')}</Badge>}
              </li>
            ))}
          </ul>
        </Section>
        <Section title={t('ai.pa.faq')}>
          <ul className="space-y-3">
            {data.faq.map((f: any, i: number) => (
              <li key={i}>
                <p className="font-medium">{f.question}</p>
                {f.answer ? <p className="text-muted-foreground">{f.answer}</p> : <Badge variant="warning">{t('ai.needsInput')}</Badge>}
              </li>
            ))}
          </ul>
        </Section>
      </div>
      <MissingInfo items={data.missingInformation} />
    </div>
  );
}

export function StrategyView({ data }: { data: any }) {
  const { t } = useI18n();
  return (
    <div className="grid gap-4" data-testid="strategy" dir="auto">
      <Section title={t('ai.st.summary')}>
        <p className="whitespace-pre-line">{data.summary}</p>
        <p className="mt-3"><span className="text-muted-foreground">{t('ai.st.goal')}: </span>{data.goal}</p>
      </Section>
      {data.platforms.map((p: any) => (
        <Section key={p.platform} title={t(`ai.platforms.${p.platform}`)} testId={`strategy-${p.platform}`}>
          <p><span className="text-muted-foreground">{t('ai.st.objective')}: </span>{p.objective}</p>
          <p className="mt-1"><span className="text-muted-foreground">{t('ai.st.audience')}: </span>{p.targetAudience}</p>
          <p className="mt-1"><span className="text-muted-foreground">{t('ai.st.frequency')}: </span>{p.postingFrequency}</p>
          <p className="mt-3 font-medium">{t('ai.st.pillars')}</p>
          <ul className="mt-1 grid gap-2 sm:grid-cols-2">{p.contentPillars.map((c: any, i: number) => <li key={i} className="rounded-md border p-2"><p className="font-medium">{c.name}</p><p className="text-muted-foreground">{c.description}</p></li>)}</ul>
          <p className="mt-3 font-medium">{t('ai.st.weekly')}</p>
          <div className="mt-1 overflow-x-auto">
            <table className="w-full text-start text-sm">
              <thead className="text-xs text-muted-foreground"><tr><th className="py-1 text-start">{t('ai.st.day')}</th><th className="text-start">{t('ai.st.format')}</th><th className="text-start">{t('ai.st.idea')}</th></tr></thead>
              <tbody>{p.weeklyPlan.map((w: any, i: number) => <tr key={i} className="border-t align-top"><td className="py-2 pe-3">{t(`ai.days.${w.day}`)}</td><td className="pe-3">{t(`ai.formats.${w.format}`)}</td><td>{w.idea}<span className="block text-xs text-muted-foreground">{w.callToAction}</span></td></tr>)}</tbody>
            </table>
          </div>
          <p className="mt-3 font-medium">{t('ai.st.kpis')}</p>
          <Bullets items={p.kpis} />
        </Section>
      ))}
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title={t('ai.st.campaigns')}>
          <ul className="space-y-3">
            {data.campaigns.map((c: any, i: number) => (
              <li key={i}>
                <p className="font-medium">{c.name} <span className="text-xs text-muted-foreground">· {t('ai.st.weeks', { count: c.durationWeeks })}</span></p>
                <p className="text-muted-foreground">{c.concept}</p>
                <p className="mt-1">{c.promotionalIdea}</p>
                <p className="mt-1 text-xs"><span className="text-muted-foreground">CTA: </span>{c.callToAction}</p>
              </li>
            ))}
          </ul>
        </Section>
        <Section title={t('ai.st.monthly')}>
          <ol className="space-y-3">{data.monthlyPlan.map((w: any) => <li key={w.week}><p className="font-medium">{t('ai.st.week', { n: w.week })} — {w.theme}</p><p className="text-muted-foreground">{w.focus}</p><Bullets items={w.actions} /></li>)}</ol>
        </Section>
        <Section title={t('ai.st.promotions')}><Bullets items={data.promotionalIdeas} /></Section>
        <Section title={t('ai.st.ctas')}><Bullets items={data.callsToAction} /></Section>
      </div>
      <MissingInfo items={data.missingInformation} />
    </div>
  );
}
