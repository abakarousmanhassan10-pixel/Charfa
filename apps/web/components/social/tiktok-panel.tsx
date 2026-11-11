'use client';
/* eslint-disable @next/next/no-img-element -- creator avatars and signed media previews come from TikTok and the TOUMA media API, not from next/image */
import { useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { checkTikTokSettings, tiktokLabel, TIKTOK_PRIVACY_LEVELS, type ContentKind, type TikTokCreatorInfo, type TikTokPostSettings, type TikTokPrivacyLevel } from '@touma/shared';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import type { MediaItem } from '@/components/media/media-types';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { api, ApiError } from '@/lib/api-client';

const MUSIC_URL = 'https://www.tiktok.com/legal/page/global/music-usage-confirmation/en';
const BRANDED_URL = 'https://www.tiktok.com/legal/page/global/bc-policy/en';

export type TikTokDraft = {
  privacyLevel: TikTokPrivacyLevel | '';
  allowComment: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  commercial: { enabled: boolean; yourBrand: boolean; brandedContent: boolean };
  consent: boolean;
};

/** Nothing is pre-selected for the creator: no privacy level, interactions off, disclosure off, consent unchecked. */
export const emptyTikTokDraft = (from?: Partial<TikTokPostSettings> | null): TikTokDraft => ({
  privacyLevel: from?.privacyLevel ?? '', allowComment: from?.allowComment === true, allowDuet: from?.allowDuet === true, allowStitch: from?.allowStitch === true,
  commercial: { enabled: from?.commercial?.enabled === true, yourBrand: from?.commercial?.yourBrand === true, brandedContent: from?.commercial?.brandedContent === true }, consent: from?.consent === true,
});

/** What the person sees and confirms before a post goes to TikTok, following TikTok's Content Sharing Guidelines. */
export function TikTokPanel({ accountId, kind, media, draft, onChange, onValidity }: { accountId: string | null; kind: ContentKind; media: MediaItem[]; draft: TikTokDraft; onChange: (d: TikTokDraft) => void; onValidity?: (ok: boolean) => void }) {
  const { t } = useI18n();
  const { active } = useBusiness();
  const [info, setInfo] = useState<(TikTokCreatorInfo & { queriedAt: string }) | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isVideo = kind === 'VIDEO';

  async function load() {
    if (!accountId || !active) return;
    setLoading(true);
    setError(null);
    try {
      setInfo(await api(`/social/accounts/${accountId}/tiktok/creator-info`, { businessId: active.id }));
    } catch (e) {
      setInfo(null);
      setError(e instanceof ApiError ? e.message : t('common.loadError'));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, active?.id]);

  // A visibility the account no longer offers must be chosen again, never silently replaced.
  const options = useMemo(() => TIKTOK_PRIVACY_LEVELS.filter((l) => info?.privacyOptions.includes(l)), [info]);
  useEffect(() => {
    if (info && draft.privacyLevel && !info.privacyOptions.includes(draft.privacyLevel)) onChange({ ...draft, privacyLevel: '' });
  }, [info]); // eslint-disable-line react-hooks/exhaustive-deps

  const check = checkTikTokSettings({ ...draft, privacyLevel: draft.privacyLevel || undefined }, kind);
  const ready = check.ok && Boolean(info);
  useEffect(() => { onValidity?.(ready); }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (p: Partial<TikTokDraft>) => onChange({ ...draft, ...p });
  const setCommercial = (p: Partial<TikTokDraft['commercial']>) => onChange({ ...draft, commercial: { ...draft.commercial, ...p } });
  const isPrivate = draft.privacyLevel === 'SELF_ONLY';
  const label = tiktokLabel({ commercial: draft.commercial });
  const branded = draft.commercial.enabled && draft.commercial.brandedContent;

  return (
    <section className="grid gap-4 rounded-lg border p-4" data-testid="tiktok-panel" aria-label={t('social.tiktok.title')}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold">{t('social.tiktok.title')}</h3>
        <Button type="button" variant="ghost" size="sm" onClick={() => void load()} disabled={loading} data-testid="tiktok-refresh">{loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}{t('social.tiktok.refresh')}</Button>
      </header>

      {/* 1. Creator information, read from TikTok right now */}
      <div className="flex items-center gap-3" data-testid="tiktok-creator">
        {info?.avatarUrl ? <img src={info.avatarUrl} alt="" className="h-10 w-10 rounded-full object-cover" /> : <span className="h-10 w-10 rounded-full bg-muted" aria-hidden />}
        <div className="min-w-0">
          {loading && !info && <p className="text-sm text-muted-foreground">{t('social.tiktok.loadingCreator')}</p>}
          {info && <><p className="truncate font-medium" data-testid="tiktok-nickname">{info.nickname ?? info.username}</p>{info.username && <p className="truncate text-xs text-muted-foreground">@{info.username}</p>}</>}
          {!info && !loading && !accountId && <p className="text-sm text-muted-foreground">{t('social.tiktok.noAccount')}</p>}
        </div>
      </div>
      {error && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="tiktok-error">{t('social.tiktok.creatorError')} {error}</p>}
      {info && info.maxVideoPostDurationSec != null && isVideo && <p className="text-xs text-muted-foreground">{t('social.tiktok.maxDuration', { seconds: info.maxVideoPostDurationSec })}</p>}

      {/* 2. Media preview */}
      {media.length > 0 && (
        <div className="grid gap-2" data-testid="tiktok-preview">
          <span className="text-sm font-medium">{t('social.tiktok.preview')}</span>
          <div className="flex flex-wrap gap-2">
            {media.map((m) => m.url ? (m.type === 'VIDEO'
              ? <video key={m.id} src={m.url} controls preload="metadata" className="max-h-64 rounded-md border bg-black" aria-label={m.originalFilename} />
              : <img key={m.id} src={m.url} alt={m.altText ?? m.originalFilename} className="max-h-48 rounded-md border object-contain" />) : <span key={m.id} className="rounded-md border px-2 py-1 text-xs">{m.originalFilename}</span>)}
          </div>
        </div>
      )}

      {/* 3. Privacy: chosen by the person, from what TikTok offers this account */}
      <div className="grid gap-2">
        <label htmlFor="tt-privacy" className="text-sm font-medium">{t('social.tiktok.privacy')}</label>
        <Select id="tt-privacy" value={draft.privacyLevel} onChange={(e) => { const v = e.target.value as TikTokPrivacyLevel | ''; set({ privacyLevel: v, ...(v === 'SELF_ONLY' && draft.commercial.brandedContent ? { commercial: { ...draft.commercial, brandedContent: false } } : {}) }); }} disabled={!info} data-testid="tiktok-privacy" aria-describedby="tt-privacy-hint">
          <option value="">{t('social.tiktok.privacyPlaceholder')}</option>
          {options.map((o) => <option key={o} value={o} disabled={o === 'SELF_ONLY' && branded}>{t(`social.tiktok.privacyLevels.${o}`)}</option>)}
        </Select>
        <p id="tt-privacy-hint" className="text-xs text-muted-foreground">{info && options.length === 1 && options[0] === 'SELF_ONLY' ? t('social.tiktok.onlyPrivate') : t('social.tiktok.privacyHint')}</p>
        {branded && <p className="text-xs text-muted-foreground" data-testid="tiktok-branded-private">{t('social.tiktok.brandedNotPrivate')}</p>}
      </div>

      {/* 4. Interactions: off unless the person turns them on; greyed out when the creator disabled them in TikTok */}
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">{t('social.tiktok.interactions')}</legend>
        {([['allowComment', 'comment', info?.commentDisabled], ...(isVideo ? [['allowDuet', 'duet', info?.duetDisabled], ['allowStitch', 'stitch', info?.stitchDisabled]] : [])] as Array<[keyof TikTokDraft, string, boolean | undefined]>).map(([key, name, disabled]) => (
          <label key={name} className={`flex items-center gap-2 text-sm ${disabled ? 'text-muted-foreground' : ''}`}>
            <input type="checkbox" checked={disabled ? false : draft[key] === true} disabled={!info || Boolean(disabled)} onChange={(e) => set({ [key]: e.target.checked } as Partial<TikTokDraft>)} data-testid={`tiktok-${name}`} />
            <span>{t(`social.tiktok.allow.${name}`)}{disabled ? ` — ${t('social.tiktok.disabledByCreator')}` : ''}</span>
          </label>
        ))}
        {!isVideo && <p className="text-xs text-muted-foreground">{t('social.tiktok.photoNote')}</p>}
      </fieldset>

      {/* 5. Commercial content disclosure */}
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">{t('social.tiktok.disclosure')}</legend>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={draft.commercial.enabled} onChange={(e) => setCommercial({ enabled: e.target.checked, ...(e.target.checked ? {} : { yourBrand: false, brandedContent: false }) })} data-testid="tiktok-commercial" />
          <span>{t('social.tiktok.disclosureToggle')}<span className="block text-xs text-muted-foreground">{t('social.tiktok.disclosureHint')}</span></span>
        </label>
        {draft.commercial.enabled && (
          <div className="ml-6 grid gap-2" data-testid="tiktok-commercial-options">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.commercial.yourBrand} onChange={(e) => setCommercial({ yourBrand: e.target.checked })} data-testid="tiktok-your-brand" />{t('social.tiktok.yourBrand')}</label>
            <label className={`flex items-center gap-2 text-sm ${isPrivate ? 'text-muted-foreground' : ''}`}><input type="checkbox" checked={draft.commercial.brandedContent} disabled={isPrivate} onChange={(e) => setCommercial({ brandedContent: e.target.checked })} data-testid="tiktok-branded" />{t('social.tiktok.brandedContent')}{isPrivate ? ` — ${t('social.tiktok.brandedNotPrivate')}` : ''}</label>
            {!draft.commercial.yourBrand && !draft.commercial.brandedContent && <p className="text-xs text-destructive" data-testid="tiktok-disclosure-incomplete">{t('social.tiktok.disclosureIncomplete')}</p>}
            {label !== 'NONE' && <p className="rounded-md bg-muted px-3 py-2 text-xs" data-testid="tiktok-label">{t(`social.tiktok.label.${label}`)}</p>}
          </div>
        )}
      </fieldset>

      {/* 6. Declaration and consent */}
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={draft.consent} onChange={(e) => set({ consent: e.target.checked })} data-testid="tiktok-consent" />
        <span>
          {branded ? t('social.tiktok.consentBranded') : t('social.tiktok.consentMusic')}{' '}
          <a href={MUSIC_URL} target="_blank" rel="noopener noreferrer" className="text-primary underline">{t('social.tiktok.musicLink')}</a>
          {branded && <>{' '}<a href={BRANDED_URL} target="_blank" rel="noopener noreferrer" className="text-primary underline">{t('social.tiktok.brandedLink')}</a></>}
        </span>
      </label>
      <p className="text-xs text-muted-foreground">{t('social.tiktok.processing')}</p>
      {!check.ok && <ul className="list-disc pl-5 text-xs text-muted-foreground" data-testid="tiktok-missing">{check.errors.map((e) => <li key={e.code}>{e.message}</li>)}</ul>}
    </section>
  );
}

/** Read-only summary of what was confirmed, for the final confirmation step. */
export function TikTokSummary({ settings, nickname }: { settings: Partial<TikTokPostSettings> | null | undefined; nickname?: string | null }) {
  const { t } = useI18n();
  if (!settings?.privacyLevel) return <p className="rounded-md bg-amber-500/10 px-3 py-2 text-sm" data-testid="tiktok-summary-missing">{t('social.tiktok.summaryMissing')}</p>;
  const label = tiktokLabel({ commercial: { enabled: settings.commercial?.enabled === true, yourBrand: settings.commercial?.yourBrand === true, brandedContent: settings.commercial?.brandedContent === true } });
  const on = (v?: boolean) => (v ? t('social.tiktok.summaryOn') : t('social.tiktok.summaryOff'));
  return (
    <dl className="grid gap-1 rounded-md border px-3 py-2 text-sm" data-testid="tiktok-summary">
      {nickname && <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t('social.tiktok.summaryAccount')}</dt><dd>{nickname}</dd></div>}
      <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t('social.tiktok.privacy')}</dt><dd data-testid="tiktok-summary-privacy">{t(`social.tiktok.privacyLevels.${settings.privacyLevel}`)}</dd></div>
      <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t('social.tiktok.allow.comment')}</dt><dd>{on(settings.allowComment)}</dd></div>
      <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t('social.tiktok.allow.duet')}</dt><dd>{on(settings.allowDuet)}</dd></div>
      <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t('social.tiktok.allow.stitch')}</dt><dd>{on(settings.allowStitch)}</dd></div>
      <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t('social.tiktok.disclosure')}</dt><dd data-testid="tiktok-summary-label">{label === 'NONE' ? t('social.tiktok.summaryNone') : t(`social.tiktok.label.${label}`)}</dd></div>
    </dl>
  );
}
