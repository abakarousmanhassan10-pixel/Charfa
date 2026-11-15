'use client';
import { useState } from 'react';
import { Rocket } from 'lucide-react';
import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

export interface CampaignForm {
  name: string; subject: string; objective: string; audience: string; platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'; language: 'en' | 'fr';
  brand: { tone?: string; colors?: string[]; style?: string; tagline?: string };
  photoCount: number; videoCount: number; startAt: string; intervalHours: number; publishMode: 'AUTO' | 'HYBRID';
}
const tomorrowAt10 = () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:00`; };
const STYLES = ['MINIMAL', 'LUXURY', 'PLAYFUL', 'BOLD', 'NATURAL', 'MODERN'];

/** The campaign form. Limits (5 photos, 5 videos) are the daily quotas; the server enforces them again. */
export function CampaignBuilder({ canAuto, disabled, onCreate }: { canAuto: boolean; disabled: boolean; onCreate: (f: CampaignForm) => Promise<boolean> }) {
  const { t, locale } = useI18n();
  const [f, setF] = useState({ name: '', subject: '', objective: '', audience: '', platform: 'INSTAGRAM' as CampaignForm['platform'], language: (locale === 'fr' ? 'fr' : 'en') as 'en' | 'fr', tone: '', color: '#d01010', style: 'MINIMAL', tagline: '', photoCount: 2, videoCount: 1, startAt: tomorrowAt10(), intervalHours: 24, publishMode: 'HYBRID' as 'AUTO' | 'HYBRID' });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const num = (k: 'photoCount' | 'videoCount' | 'intervalHours', min: number, max: number) => (e: React.ChangeEvent<HTMLInputElement>) => set(k, Math.max(min, Math.min(max, Number(e.target.value) || 0)));
  const valid = f.name.trim() && f.subject.trim() && f.objective.trim() && f.audience.trim() && f.photoCount + f.videoCount >= 1;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const ok = await onCreate({
      name: f.name.trim(), subject: f.subject.trim(), objective: f.objective.trim(), audience: f.audience.trim(), platform: f.platform, language: f.language,
      brand: { ...(f.tone.trim() ? { tone: f.tone.trim() } : {}), colors: [f.color], style: f.style, ...(f.tagline.trim() ? { tagline: f.tagline.trim() } : {}) },
      photoCount: f.photoCount, videoCount: f.videoCount, startAt: new Date(f.startAt).toISOString(), intervalHours: f.intervalHours, publishMode: f.publishMode,
    });
    if (ok) setF((s) => ({ ...s, name: '', subject: '', objective: '', audience: '' }));
  }
  return (
    <Card><CardContent className="p-4 sm:p-6">
      <form onSubmit={(e) => void submit(e)} className="grid gap-4" data-testid="campaign-form" aria-label={t('creative.campaigns.builder')}>
        <h2 className="text-base font-semibold">{t('creative.campaigns.builder')}</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <Field id="cb-name" label={t('creative.campaigns.name')}><Input id="cb-name" value={f.name} maxLength={80} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field id="cb-subject" label={t('creative.campaigns.subject')} hint={t('creative.campaigns.subjectHint')}><Input id="cb-subject" value={f.subject} maxLength={200} onChange={(e) => set('subject', e.target.value)} /></Field>
          <Field id="cb-objective" label={t('creative.campaigns.objective')}><Textarea id="cb-objective" rows={2} maxLength={300} value={f.objective} onChange={(e) => set('objective', e.target.value)} /></Field>
          <Field id="cb-audience" label={t('creative.campaigns.audience')}><Textarea id="cb-audience" rows={2} maxLength={300} value={f.audience} onChange={(e) => set('audience', e.target.value)} /></Field>
          <Field id="cb-platform" label={t('creative.campaigns.platform')}>
            <Select id="cb-platform" value={f.platform} onChange={(e) => set('platform', e.target.value as CampaignForm['platform'])}>{(['INSTAGRAM', 'TIKTOK', 'YOUTUBE'] as const).map((p) => <option key={p} value={p}>{p}</option>)}</Select>
          </Field>
          <Field id="cb-lang" label={t('creative.campaigns.language')}>
            <Select id="cb-lang" value={f.language} onChange={(e) => set('language', e.target.value as 'en' | 'fr')}><option value="en">English</option><option value="fr">Français</option></Select>
          </Field>
        </div>
        <fieldset className="grid gap-4 rounded-lg border p-3 md:grid-cols-4">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('creative.campaigns.brand')}</legend>
          <Field id="cb-tone" label={t('creative.campaigns.tone')}><Input id="cb-tone" value={f.tone} maxLength={60} onChange={(e) => set('tone', e.target.value)} /></Field>
          <Field id="cb-style" label={t('creative.campaigns.style')}><Select id="cb-style" value={f.style} onChange={(e) => set('style', e.target.value)}>{STYLES.map((s) => <option key={s} value={s}>{t(`creative.enums.styles.${s}`)}</option>)}</Select></Field>
          <Field id="cb-color" label={t('creative.campaigns.color')}><Input id="cb-color" type="color" value={f.color} onChange={(e) => set('color', e.target.value)} className="h-10 p-1" /></Field>
          <Field id="cb-tagline" label={t('creative.campaigns.tagline')}><Input id="cb-tagline" value={f.tagline} maxLength={100} onChange={(e) => set('tagline', e.target.value)} /></Field>
        </fieldset>
        <div className="grid gap-4 md:grid-cols-4">
          <Field id="cb-photos" label={t('creative.campaigns.photos')} hint={t('creative.campaigns.maxFive')}><Input id="cb-photos" type="number" min={0} max={5} value={f.photoCount} onChange={num('photoCount', 0, 5)} /></Field>
          <Field id="cb-videos" label={t('creative.campaigns.videos')} hint={t('creative.campaigns.videoSeconds')}><Input id="cb-videos" type="number" min={0} max={5} value={f.videoCount} onChange={num('videoCount', 0, 5)} /></Field>
          <Field id="cb-start" label={t('creative.campaigns.start')}><Input id="cb-start" type="datetime-local" value={f.startAt} onChange={(e) => set('startAt', e.target.value)} /></Field>
          <Field id="cb-interval" label={t('creative.campaigns.interval')}><Input id="cb-interval" type="number" min={1} max={168} value={f.intervalHours} onChange={num('intervalHours', 1, 168)} /></Field>
        </div>
        <div role="radiogroup" aria-label={t('creative.campaigns.mode')} className="grid gap-2 sm:grid-cols-2">
          {(['HYBRID', 'AUTO'] as const).map((m) => (
            <label key={m} className={`flex cursor-pointer gap-3 rounded-lg border p-3 text-sm ${f.publishMode === m ? 'border-primary bg-primary/5' : ''} ${m === 'AUTO' && !canAuto ? 'opacity-50' : ''}`}>
              <input type="radio" name="publishMode" className="mt-1" checked={f.publishMode === m} disabled={m === 'AUTO' && !canAuto} onChange={() => set('publishMode', m)} data-testid={`mode-${m}`} />
              <span><span className="block font-medium">{t(`creative.campaigns.modes.${m}`)}</span><span className="block text-xs text-muted-foreground">{t(`creative.campaigns.modes.${m}Hint`)}</span></span>
            </label>
          ))}
        </div>
        <Button type="submit" disabled={disabled || !valid} data-testid="campaign-create"><Rocket className="h-4 w-4" aria-hidden />{t('creative.campaigns.create')}</Button>
      </form>
    </CardContent></Card>
  );
}
