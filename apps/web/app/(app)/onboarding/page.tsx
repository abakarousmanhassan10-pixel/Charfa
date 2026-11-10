'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { BusinessForm, initialValues } from '@/components/business-form';
import { useBusiness, type Business } from '@/components/business-provider';
import { LocaleSwitcher, useI18n } from '@/components/i18n-provider';
import { Logo } from '@/components/logo';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api-client';

export default function OnboardingPage() {
  const { t, locale } = useI18n();
  const { businesses, upsert, setActive } = useBusiness();
  const router = useRouter();

  return (
    <div className="min-h-screen">
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between px-4 py-5 sm:px-6">
        <Logo showProduct />
        <LocaleSwitcher />
      </header>
      <main className="mx-auto max-w-3xl px-4 pb-16 sm:px-6">
        <Card>
          <CardHeader>
            <p className="text-xs font-medium uppercase tracking-wide text-primary">{t('onboarding.step')}</p>
            <CardTitle className="text-2xl">{businesses.length ? t('onboarding.addAnother') : t('onboarding.title')}</CardTitle>
            <CardDescription>{t('onboarding.subtitle')}</CardDescription>
          </CardHeader>
          <CardContent>
            <BusinessForm
              initial={initialValues(null, locale)}
              submitLabel={t('onboarding.submit')}
              onSubmit={async (values) => {
                const created = await api<Business>('/businesses', { method: 'POST', json: values });
                upsert(created);
                setActive(created.id);
                router.replace('/dashboard');
              }}
            />
          </CardContent>
        </Card>
        {businesses.length > 0 && (
          <p className="mt-6 text-center text-sm">
            <Link href="/dashboard" className="text-primary hover:underline">
              {t('common.cancel')}
            </Link>
          </p>
        )}
      </main>
    </div>
  );
}
