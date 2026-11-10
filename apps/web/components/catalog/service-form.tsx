'use client';
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { SERVICE_AVAILABILITY, serviceInputSchema } from '@touma/shared';
import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/api-client';
import { apiFieldErrors, zodFieldErrors } from '@/lib/form-errors';
import { cleanList, ListInput } from './list-input';
import type { Category, Service } from './types';

type Values = {
  name: string; description: string; categoryId: string; status: string; price: string; currency: string; durationMinutes: string;
  availability: string; availabilityNotes: string; bookingInfo: string; bookingUrl: string; features: string[]; benefits: string[]; targetAudience: string;
};
const TEXT = ['description', 'categoryId', 'price', 'durationMinutes', 'availabilityNotes', 'bookingInfo', 'bookingUrl', 'targetAudience'] as const;

export function ServiceForm({
  service,
  categories,
  currency,
  readOnly,
  submitLabel,
  onSubmit,
}: {
  service?: Service;
  categories: Category[];
  currency: string;
  readOnly?: boolean;
  submitLabel: string;
  onSubmit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const { t } = useI18n();
  const [v, setV] = useState<Values>({
    name: service?.name ?? '',
    description: service?.description ?? '',
    categoryId: service?.categoryId ?? '',
    status: service?.status ?? 'DRAFT',
    price: service?.price ?? '',
    currency: service?.currency ?? currency,
    durationMinutes: service?.durationMinutes?.toString() ?? '',
    availability: service?.availability ?? 'AVAILABLE',
    availabilityNotes: service?.availabilityNotes ?? '',
    bookingInfo: service?.bookingInfo ?? '',
    bookingUrl: service?.bookingUrl ?? '',
    features: service?.features ?? [],
    benefits: service?.benefits ?? [],
    targetAudience: service?.targetAudience ?? '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const set = (k: keyof Values) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    setSaved(false);
    setV((x) => ({ ...x, [k]: e.target.value }));
  };
  const f = (k: keyof Values) => ({
    id: `service-${k}`,
    value: v[k] as string,
    onChange: set(k),
    disabled: readOnly || pending,
    'aria-invalid': Boolean(errors[k]),
    'aria-describedby': errors[k] ? `service-${k}-error` : `service-${k}-hint`,
  });
  const L = (k: string) => t(`catalog.fields.${k}`);
  const opt = t('common.optional');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    setFormError(null);
    setSaved(false);
    const parsed = serviceInputSchema.safeParse({
      ...v,
      features: cleanList(v.features),
      benefits: cleanList(v.benefits),
      durationMinutes: v.durationMinutes === '' ? undefined : v.durationMinutes,
    });
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      setFormError(t('auth.errors.VALIDATION'));
      return;
    }
    const payload: Record<string, unknown> = { ...parsed.data };
    for (const k of TEXT) if (payload[k] === undefined) payload[k] = service ? null : undefined;
    setPending(true);
    try {
      await onSubmit(payload);
      setSaved(true);
    } catch (err) {
      setErrors(apiFieldErrors(err, Object.keys(v)));
      setFormError(err instanceof ApiError ? err.message : t('auth.errors.UNKNOWN'));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-6 lg:grid-cols-3">
      <div className="grid gap-6 lg:col-span-2">
        <Card>
          <CardHeader><CardTitle>{t('catalog.sections.details')}</CardTitle></CardHeader>
          <CardContent className="grid gap-4">
            <Field id="service-name" label={L('name')} error={errors.name}>
              <Input {...f('name')} required maxLength={200} />
            </Field>
            <Field id="service-description" label={L('description')} optional optionalLabel={opt} error={errors.description}>
              <Textarea {...f('description')} rows={5} maxLength={5000} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="service-features" label={L('features')} hint={t('catalog.onePerLine')} optional optionalLabel={opt}>
                <ListInput id="service-features" value={v.features} onChange={(x) => setV((s) => ({ ...s, features: x }))} disabled={readOnly || pending} describedBy="service-features-hint" />
              </Field>
              <Field id="service-benefits" label={L('benefits')} hint={t('catalog.onePerLine')} optional optionalLabel={opt}>
                <ListInput id="service-benefits" value={v.benefits} onChange={(x) => setV((s) => ({ ...s, benefits: x }))} disabled={readOnly || pending} describedBy="service-benefits-hint" />
              </Field>
            </div>
            <Field id="service-targetAudience" label={L('targetAudience')} optional optionalLabel={opt} error={errors.targetAudience}>
              <Textarea {...f('targetAudience')} rows={2} maxLength={2000} />
            </Field>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>{t('catalog.sections.booking')}</CardTitle></CardHeader>
          <CardContent className="grid gap-4">
            <Field id="service-bookingInfo" label={L('bookingInfo')} hint={t('catalog.bookingHint')} optional optionalLabel={opt} error={errors.bookingInfo}>
              <Textarea {...f('bookingInfo')} rows={3} maxLength={2000} />
            </Field>
            <Field id="service-bookingUrl" label={L('bookingUrl')} optional optionalLabel={opt} error={errors.bookingUrl}>
              <Input {...f('bookingUrl')} type="url" placeholder="https://" />
            </Field>
          </CardContent>
        </Card>
      </div>
      <div className="grid content-start gap-6">
        <Card>
          <CardHeader><CardTitle>{t('catalog.sections.organisation')}</CardTitle></CardHeader>
          <CardContent className="grid gap-4">
            <Field id="service-status" label={L('status')}>
              <Select {...f('status')}>
                {['DRAFT', 'ACTIVE', 'ARCHIVED'].map((s) => <option key={s} value={s}>{t(`catalog.status.${s}`)}</option>)}
              </Select>
            </Field>
            <Field id="service-categoryId" label={L('category')} optional optionalLabel={opt} error={errors.categoryId}>
              <Select {...f('categoryId')}>
                <option value="">{t('catalog.uncategorised')}</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>{t('catalog.sections.pricing')}</CardTitle></CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <Field id="service-price" label={L('price')} optional optionalLabel={opt} error={errors.price}>
                  <Input {...f('price')} inputMode="decimal" placeholder="0.00" />
                </Field>
              </div>
              <Field id="service-currency" label={L('currency')} error={errors.currency}>
                <Input {...f('currency')} maxLength={3} className="uppercase" />
              </Field>
            </div>
            <Field id="service-durationMinutes" label={L('durationMinutes')} optional optionalLabel={opt} error={errors.durationMinutes}>
              <Input {...f('durationMinutes')} type="number" min={1} inputMode="numeric" />
            </Field>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>{t('catalog.sections.availability')}</CardTitle></CardHeader>
          <CardContent className="grid gap-4">
            <Field id="service-availability" label={L('availability')}>
              <Select {...f('availability')}>
                {SERVICE_AVAILABILITY.map((a) => <option key={a} value={a}>{t(`catalog.availability.${a}`)}</option>)}
              </Select>
            </Field>
            <Field id="service-availabilityNotes" label={L('availabilityNotes')} hint={t('catalog.availabilityHint')} optional optionalLabel={opt} error={errors.availabilityNotes}>
              <Input {...f('availabilityNotes')} maxLength={500} />
            </Field>
          </CardContent>
        </Card>
      </div>
      <div className="lg:col-span-3">
        {formError && <p role="alert" data-testid="form-error" className="mb-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{formError}</p>}
        {!readOnly && (
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              {pending ? t('common.saving') : submitLabel}
            </Button>
            {saved && <span role="status" className="text-sm text-emerald-700 dark:text-emerald-400">{t('common.saved')}</span>}
          </div>
        )}
      </div>
    </form>
  );
}
