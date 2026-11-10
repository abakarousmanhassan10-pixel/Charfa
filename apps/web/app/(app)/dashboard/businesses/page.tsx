'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Building2, MapPin, Plus } from 'lucide-react';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';

export default function BusinessesPage() {
  const { t } = useI18n();
  const { businesses, active, setActive } = useBusiness();
  const router = useRouter();
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={t('businesses.title')}
        description={t('businesses.subtitle')}
        actions={
          <Button asChild>
            <Link href="/dashboard/businesses/new">
              <Plus className="h-4 w-4" aria-hidden />
              {t('businesses.new')}
            </Link>
          </Button>
        }
      />
      <ul className="grid gap-4 sm:grid-cols-2" data-testid="business-list">
        {businesses.map((b) => (
          <li key={b.id}>
            <Card className="h-full">
              <CardContent className="flex h-full items-start gap-4 pt-6">
                <div className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-lg border bg-muted text-lg font-bold text-muted-foreground">
                  {b.logoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={b.logoUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <Building2 className="h-6 w-6" aria-hidden />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate font-semibold">{b.name}</h2>
                    {active?.id === b.id && <Badge variant="success">{t('businesses.active')}</Badge>}
                  </div>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {t(`business.types.${b.type}`)} · {t(`business.roles.${b.role}`)}
                  </p>
                  {(b.city || b.country) && (
                    <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                      <MapPin className="h-3 w-3" aria-hidden />
                      {[b.city, b.country].filter(Boolean).join(', ')}
                    </p>
                  )}
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setActive(b.id);
                        router.push(`/dashboard/businesses/${b.id}`);
                      }}
                    >
                      {t('businesses.manage')}
                    </Button>
                    {active?.id !== b.id && (
                      <Button size="sm" variant="ghost" onClick={() => setActive(b.id)}>
                        {t('businesses.switchTo')}
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
