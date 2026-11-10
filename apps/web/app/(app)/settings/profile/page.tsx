'use client';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { SUPPORTED_LOCALES } from '@touma/shared';
import { useAuth } from '@/components/auth-provider';
import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ApiError } from '@/lib/api-client';

export default function ProfilePage() {
  const { t, setLocale } = useI18n();
  const { user, updateProfile, logoutAll } = useAuth();
  const router = useRouter();
  const [fullName, setFullName] = useState(user?.fullName ?? '');
  const [locale, setLoc] = useState(user?.locale ?? 'en');
  const [timezone, setTimezone] = useState(user?.timezone ?? 'UTC');
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timezones = useMemo(() => {
    const all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
    const list = all.includes('UTC') ? all : ['UTC', ...all];
    return list.includes(timezone) ? list : [timezone, ...list];
  }, [timezone]);

  if (!user) return null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    if (fullName.trim().length === 0) {
      setError(t('auth.errors.VALIDATION'));
      return;
    }
    setPending(true);
    try {
      await updateProfile({ fullName: fullName.trim(), locale, timezone });
      setLocale(locale);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('auth.errors.UNKNOWN'));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mx-auto grid max-w-2xl gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t('settings.profileTitle')}</h1>
        <p className="mt-1 text-muted-foreground">{t('settings.profileSubtitle')}</p>
      </div>
      <Card>
        <CardContent className="pt-6">
          <form onSubmit={save} className="grid gap-4" noValidate>
            <Field id="profile-name" label={t('auth.fullName')}>
              <Input id="profile-name" value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={120} autoComplete="name" required />
            </Field>
            <Field id="profile-email" label={t('settings.email')} hint={t('settings.emailReadOnly')}>
              <Input id="profile-email" value={user.email} disabled aria-describedby="profile-email-hint" />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="profile-locale" label={t('common.language')}>
                <Select id="profile-locale" value={locale} onChange={(e) => setLoc(e.target.value)}>
                  {SUPPORTED_LOCALES.map((l) => (
                    <option key={l} value={l}>
                      {l === 'en' ? 'English' : l === 'fr' ? 'Français' : l}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field id="profile-timezone" label={t('business.fields.timezone')}>
                <Select id="profile-timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                  {timezones.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {error && (
              <p role="alert" data-testid="form-error" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={pending}>
                {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                {pending ? t('common.saving') : t('common.save')}
              </Button>
              {saved && (
                <span role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
                  {t('common.saved')}
                </span>
              )}
            </div>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.security')}</CardTitle>
          <CardDescription>{t('settings.logoutAllHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            onClick={async () => {
              await logoutAll();
              router.replace('/login');
            }}
          >
            {t('settings.logoutAll')}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
