'use client';
import { useEffect, useState } from 'react';
import { Check, ImagePlus, Loader2, Plus, Trash2 } from 'lucide-react';
import { AI_TONES, BRAND_COLOR_ROLES, BRAND_FONTS, HEX_COLOR, IMAGE_STYLES } from '@touma/shared';
import { useBusiness } from '@/components/business-provider';
import { CreativeSection } from '@/components/creative/creative-section';
import { CreativeError } from '@/components/creative/job';
import type { BrandColor, BrandKit } from '@/components/creative/types';
import { useI18n } from '@/components/i18n-provider';
import { MediaPicker } from '@/components/media/media-picker';
import type { MediaItem } from '@/components/media/media-types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { LoadingRows } from '@/components/ui/states';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError } from '@/lib/api-client';
import { useResource } from '@/lib/use-resource';

const MAX_COLORS = 8;

export default function BrandKitPage() {
  const { t } = useI18n();
  const { active, can } = useBusiness();
  const kit = useResource<BrandKit>('/creative/brand-kit', active?.id);
  const editable = can('business.update');
  const [colors, setColors] = useState<BrandColor[]>([]);
  const [headingFont, setHeadingFont] = useState('');
  const [bodyFont, setBodyFont] = useState('');
  const [visualStyle, setVisualStyle] = useState('');
  const [tone, setTone] = useState('');
  const [guidelines, setGuidelines] = useState('');
  const [logo, setLogo] = useState<MediaItem | null>(null);
  const [picker, setPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);

  useEffect(() => {
    const k = kit.data;
    if (!k) return;
    setColors(k.colors);
    setHeadingFont(k.headingFont ?? '');
    setBodyFont(k.bodyFont ?? '');
    setVisualStyle(k.visualStyle ?? '');
    setTone(k.preferredTone ?? '');
    setGuidelines(k.guidelines ?? '');
    setLogo(k.logo);
  }, [kit.data]);

  const setColor = (i: number, patch: Partial<BrandColor>) => setColors((c) => c.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  async function save() {
    if (!active) return;
    setInvalid(null);
    if (colors.some((c) => !HEX_COLOR.test(c.hex) || !c.name.trim())) return setInvalid(t('creative.brandKit.invalidColor'));
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await api<BrandKit>('/creative/brand-kit', {
        method: 'PUT',
        businessId: active.id,
        json: { colors: colors.map((c) => ({ ...c, name: c.name.trim() })), headingFont: headingFont || null, bodyFont: bodyFont || null, visualStyle: visualStyle || null, preferredTone: tone || null, guidelines: guidelines.trim() || null, logoMediaId: logo?.id ?? null },
      });
      kit.setData(res);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'UNKNOWN', String(err)));
    } finally {
      setSaving(false);
    }
  }

  const role = (r: string) => colors.find((c) => c.role === r)?.hex;
  const primary = role('PRIMARY') ?? '#2a6a4a';
  const background = role('BACKGROUND') ?? '#f6f4ef';
  const text = role('TEXT') ?? '#1c1c1c';
  const fam = (name: string) => (name && name in BRAND_FONTS ? `'${name}', ${BRAND_FONTS[name as keyof typeof BRAND_FONTS]}` : 'sans-serif');

  return (
    <CreativeSection title={t('creative.brandKit.title')} description={t('creative.brandKit.subtitle')}>
      {!editable && <p role="status" className="mb-4 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">{t('creative.brandKit.readOnly')}</p>}
      {!kit.data ? (
        <LoadingRows rows={4} label={t('common.loading')} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          <div className="grid gap-6">
            <Card>
              <CardHeader><CardTitle className="text-base">{t('creative.brandKit.logo')}</CardTitle><CardDescription>{t('creative.brandKit.logoHint')}</CardDescription></CardHeader>
              <CardContent>
                <div className="flex items-center gap-4">
                  <div className="grid h-20 w-20 place-items-center overflow-hidden rounded-xl border bg-muted" data-testid="brand-logo">
                    {logo ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={logo.thumbnailUrl ?? logo.url ?? undefined} alt={t('creative.brandKit.logoAlt')} className="h-full w-full object-contain" />
                    ) : (
                      <ImagePlus className="h-6 w-6 text-muted-foreground" aria-hidden />
                    )}
                  </div>
                  {editable && (
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" onClick={() => setPicker(true)}>{logo ? t('creative.brandKit.changeLogo') : t('creative.brandKit.chooseLogo')}</Button>
                      {logo && <Button variant="ghost" onClick={() => setLogo(null)}>{t('creative.brandKit.removeLogo')}</Button>}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-base">{t('creative.brandKit.colors')}</CardTitle><CardDescription>{t('creative.brandKit.colorsHint')}</CardDescription></CardHeader>
              <CardContent className="grid gap-3">
                <ul className="grid gap-3" data-testid="brand-colors">
                  {colors.map((c, i) => (
                    <li key={i} className="grid grid-cols-[auto_minmax(0,1fr)] items-end gap-3 sm:grid-cols-[auto_minmax(0,1fr)_9rem_8rem_auto]">
                      <input type="color" value={HEX_COLOR.test(c.hex) ? c.hex : '#000000'} onChange={(e) => setColor(i, { hex: e.target.value.toUpperCase() })} disabled={!editable} aria-label={t('creative.brandKit.pick', { n: i + 1 })} className="h-10 w-12 cursor-pointer rounded-md border bg-transparent p-0.5" />
                      <Field id={`bc-name-${i}`} label={t('creative.brandKit.colorName')}>
                        <Input id={`bc-name-${i}`} value={c.name} maxLength={30} disabled={!editable} onChange={(e) => setColor(i, { name: e.target.value })} />
                      </Field>
                      <Field id={`bc-hex-${i}`} label={t('creative.brandKit.hex')}>
                        <Input id={`bc-hex-${i}`} value={c.hex} maxLength={7} disabled={!editable} onChange={(e) => setColor(i, { hex: e.target.value.toUpperCase() })} className="font-mono" />
                      </Field>
                      <Field id={`bc-role-${i}`} label={t('creative.brandKit.role')}>
                        <Select id={`bc-role-${i}`} value={c.role} disabled={!editable} onChange={(e) => setColor(i, { role: e.target.value })}>
                          {BRAND_COLOR_ROLES.map((r) => <option key={r} value={r}>{t(`creative.enums.colorRoles.${r}`)}</option>)}
                        </Select>
                      </Field>
                      {editable && <Button size="icon" variant="ghost" onClick={() => setColors((x) => x.filter((_, j) => j !== i))} aria-label={t('creative.brandKit.removeColor', { n: i + 1 })}><Trash2 className="h-4 w-4" aria-hidden /></Button>}
                    </li>
                  ))}
                </ul>
                {editable && colors.length < MAX_COLORS && (
                  <div>
                    <Button variant="outline" size="sm" onClick={() => setColors((x) => [...x, { name: '', hex: '#2A6A4A', role: x.some((c) => c.role === 'PRIMARY') ? 'ACCENT' : 'PRIMARY' }])}>
                      <Plus className="h-4 w-4" aria-hidden />
                      {t('creative.brandKit.addColor')}
                    </Button>
                  </div>
                )}
                {invalid && <p role="alert" className="text-sm text-destructive">{invalid}</p>}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-base">{t('creative.brandKit.identity')}</CardTitle></CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <Field id="bk-heading" label={t('creative.brandKit.headingFont')}>
                  <Select id="bk-heading" value={headingFont} disabled={!editable} onChange={(e) => setHeadingFont(e.target.value)}>
                    <option value="">{t('creative.brandKit.none')}</option>
                    {Object.keys(BRAND_FONTS).map((f) => <option key={f} value={f}>{f}</option>)}
                  </Select>
                </Field>
                <Field id="bk-body" label={t('creative.brandKit.bodyFont')}>
                  <Select id="bk-body" value={bodyFont} disabled={!editable} onChange={(e) => setBodyFont(e.target.value)}>
                    <option value="">{t('creative.brandKit.none')}</option>
                    {Object.keys(BRAND_FONTS).map((f) => <option key={f} value={f}>{f}</option>)}
                  </Select>
                </Field>
                <Field id="bk-style" label={t('creative.brandKit.visualStyle')} hint={t('creative.brandKit.visualStyleHint')}>
                  <Select id="bk-style" value={visualStyle} disabled={!editable} onChange={(e) => setVisualStyle(e.target.value)} aria-describedby="bk-style-hint">
                    <option value="">{t('creative.brandKit.none')}</option>
                    {IMAGE_STYLES.map((s) => <option key={s} value={s}>{t(`creative.enums.styles.${s}`)}</option>)}
                  </Select>
                </Field>
                <Field id="bk-tone" label={t('creative.brandKit.tone')} hint={t('creative.brandKit.toneHint')}>
                  <Select id="bk-tone" value={tone} disabled={!editable} onChange={(e) => setTone(e.target.value)} aria-describedby="bk-tone-hint">
                    <option value="">{t('creative.brandKit.none')}</option>
                    {AI_TONES.map((x) => <option key={x} value={x}>{t(`ai.tones.${x}`)}</option>)}
                  </Select>
                </Field>
                <div className="sm:col-span-2">
                  <Field id="bk-guidelines" label={t('creative.brandKit.guidelines')} hint={t('creative.brandKit.guidelinesHint', { count: guidelines.length })}>
                    <Textarea id="bk-guidelines" rows={4} maxLength={2000} value={guidelines} disabled={!editable} onChange={(e) => setGuidelines(e.target.value)} aria-describedby="bk-guidelines-hint" />
                  </Field>
                </div>
              </CardContent>
            </Card>

            <CreativeError error={error} />
            {editable && (
              <div className="flex items-center gap-3">
                <Button onClick={() => void save()} disabled={saving}>
                  {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                  {t('common.save')}
                </Button>
                {saved && <span role="status" className="flex items-center gap-1 text-sm text-emerald-700 dark:text-emerald-400"><Check className="h-4 w-4" aria-hidden />{t('creative.brandKit.saved')}</span>}
              </div>
            )}
          </div>

          <aside className="lg:sticky lg:top-6 lg:self-start" aria-label={t('creative.brandKit.preview')}>
            <Card data-testid="brand-preview" className="overflow-hidden">
              <div className="p-6" style={{ background: background, color: text }}>
                <div className="flex items-center gap-3">
                  {logo && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={logo.thumbnailUrl ?? logo.url ?? undefined} alt="" className="h-10 w-10 rounded-md object-contain" />
                  )}
                  <p className="text-xl font-bold" style={{ fontFamily: fam(headingFont) }}>{active?.name}</p>
                </div>
                <p className="mt-3 text-sm" style={{ fontFamily: fam(bodyFont) }}>{t('creative.brandKit.previewText')}</p>
                <span className="mt-4 inline-block rounded-full px-4 py-1.5 text-sm font-medium text-white" style={{ background: primary }}>{t('creative.brandKit.previewButton')}</span>
              </div>
              <CardContent className="grid gap-3 pt-4">
                <ul className="flex flex-wrap gap-2" aria-label={t('creative.brandKit.colors')}>
                  {colors.map((c, i) => <li key={i} title={`${c.name} ${c.hex}`} className="h-8 w-8 rounded-full border" style={{ background: HEX_COLOR.test(c.hex) ? c.hex : 'transparent' }} />)}
                </ul>
                <p className="text-xs text-muted-foreground">{t('creative.brandKit.previewHint')}</p>
              </CardContent>
            </Card>
          </aside>
        </div>
      )}
      {active && <MediaPicker open={picker} onClose={() => setPicker(false)} businessId={active.id} type="IMAGE" multiple={false} initial={logo ? [logo] : []} onSelect={(items) => { setLogo(items[0] ?? null); setPicker(false); }} />}
    </CreativeSection>
  );
}
