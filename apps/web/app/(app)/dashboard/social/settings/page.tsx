'use client';
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { PLATFORM_CAPABILITIES } from '@touma/shared';
import { PLATFORMS } from '@/components/calendar/types';
import { useI18n } from '@/components/i18n-provider';
import { PlatformLabel } from '@/components/social/platform';
import { SocialSection } from '@/components/social/social-section';
import { useSocialStatus } from '@/components/social/use-social';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState, LoadingRows } from '@/components/ui/states';

export default function SettingsPage() {
  const { t } = useI18n();
  const status = useSocialStatus();
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (text: string) => void navigator.clipboard?.writeText(text).then(() => { setCopied(text); setTimeout(() => setCopied(null), 1500); });
  const d = status.data;
  return (
    <SocialSection title={t('social.settings.title')} description={t('social.settings.subtitle')}>
      {status.loading && !d ? <LoadingRows rows={4} label={t('common.loading')} /> : !d ? <ErrorState message={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => void status.reload()} /> : (
        <div className="grid gap-6">
          <Card>
            <CardHeader><CardTitle>{t('social.settings.engine')}</CardTitle></CardHeader>
            <CardContent className="grid gap-2 text-sm">
              <p>{t('social.settings.publishing')}: <Badge variant={d.publishing.available ? 'success' : 'warning'} data-testid="engine-available">{d.publishing.available ? t('social.settings.available') : t('social.settings.unavailable')}</Badge></p>
              {d.platforms[0]?.mode === 'fake' && <p className="rounded-md bg-amber-500/10 px-3 py-2" data-testid="fake-mode">{t('social.settings.fakeMode')}</p>}
              <p className="text-muted-foreground">{t('social.settings.monitoring')}</p>
            </CardContent>
          </Card>
          <div className="grid gap-4 lg:grid-cols-2" data-testid="settings-platforms">
            {PLATFORMS.map((p) => {
              const info = d.platforms.find((x) => x.platform === p);
              if (!info) return null;
              const cap = PLATFORM_CAPABILITIES[p];
              return (
                <Card key={p} className="min-w-0" data-testid="settings-platform" data-platform={p}>
                  <CardHeader><CardTitle className="flex items-center justify-between"><PlatformLabel platform={p} /><Badge variant={info.configured ? 'success' : 'warning'}>{info.configured ? t('common.configured') : t('common.notConfigured')}</Badge></CardTitle></CardHeader>
                  <CardContent className="grid min-w-0 gap-3 text-sm">
                    {!info.configured && info.missingConfiguration.length > 0 && <p><span className="text-muted-foreground">{t('social.settings.missing')}: </span><span className="font-mono text-xs">{info.missingConfiguration.join(', ')}</span></p>}
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-muted-foreground">{t('social.settings.redirect')}</p>
                      <div className="mt-1 flex items-center gap-2"><code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs" title={info.redirectUri}>{info.redirectUri}</code><Button size="icon" variant="ghost" onClick={() => copy(info.redirectUri)} aria-label={t('social.settings.copy')}>{copied === info.redirectUri ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}</Button></div>
                    </div>
                    <div>
                      <p className="text-xs font-medium text-muted-foreground">{t('social.settings.permissions')}</p>
                      <p className="mt-1 flex flex-wrap gap-1">{info.requiredScopes.map((s) => <code key={s} className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{s.replace('https://www.googleapis.com/auth/', '')}</code>)}</p>
                    </div>
                    <div>
                      <p className="text-xs font-medium text-muted-foreground">{t('social.settings.formats')}</p>
                      <p className="mt-1 flex flex-wrap gap-1">{(['TEXT', 'IMAGE', 'CAROUSEL', 'VIDEO'] as const).map((k) => <Badge key={k} variant={cap.supports[k] ? 'success' : 'muted'}>{t(`calendar.types.${k}`)}{cap.supports[k] ? '' : ` · ${t('social.settings.manualOnly')}`}</Badge>)}</p>
                    </div>
                    <p className="text-xs text-muted-foreground">{t('social.settings.token')}: {info.supportsRefresh ? t('social.settings.refreshable') : t('social.settings.notRefreshable')}</p>
                    <p className="rounded-md bg-muted/50 px-3 py-2 text-xs" data-testid="restrictions">{t(`social.restrictions.${p}`)}</p>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}
    </SocialSection>
  );
}
