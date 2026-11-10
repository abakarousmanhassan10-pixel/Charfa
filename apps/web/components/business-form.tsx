'use client';
import { useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { BUSINESS_TYPES, COMMON_CURRENCIES, SUPPORTED_LOCALES, businessInputSchema } from '@touma/shared';
import { useI18n } from '@/components/i18n-provider';
import type { Business } from '@/components/business-provider';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/api-client';
import { apiFieldErrors, zodFieldErrors } from '@/lib/form-errors';

export type BusinessFormValues = Record<
  'name' | 'type' | 'description' | 'website' | 'industry' | 'country' | 'defaultLocale' | 'timezone' | 'currency' | 'brandVoice' | 'targetAudience' | 'objectives',
  string
>;
const FIELDS = ['name', 'type', 'description', 'website', 'industry', 'country', 'defaultLocale', 'timezone', 'currency', 'brandVoice', 'targetAudience', 'objectives'];

function browserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function timezones(current: string): string[] {
  const all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const list = all.includes('UTC') ? all : ['UTC', ...all];
  return list.includes(current) ? list : [current, ...list];
}

export function initialValues(b?: Business | null, locale = 'en'): BusinessFormValues {
  return {
    name: b?.name ?? '',
    type: b?.type ?? 'SMALL_BUSINESS',
    description: b?.description ?? '',
    website: b?.website ?? '',
    industry: b?.industry ?? '',
    country: b?.country ?? '',
    defaultLocale: b?.defaultLocale ?? locale,
    timezone: b?.timezone ?? browserTimezone(),
    currency: b?.currency ?? 'USD',
    brandVoice: b?.brandVoice ?? '',
    targetAudience: b?.targetAudience ?? '',
    objectives: b?.objectives ?? '',
  };
}

/**
 * Create/edit form for a business. Validation mirrors the API (shared zod schema);
 * the API re-validates everything and remains authoritative.
 */
export function BusinessForm({
  initial,
  submitLabel,
  readOnly = false,
  onSubmit,
}: {
  initial: BusinessFormValues;
  submitLabel: string;
  readOnly?: boolean;
  onSubmit: (values: Record<string, unknown>) => Promise<void>;
}) {
  const { t } = useI18n();
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const tzList = useMemo(() => timezones(values.timezone), [values.timezone]);
  const currencies = useMemo(
    () => (COMMON_CURRENCIES as readonly string[]).includes(values.currency) ? COMMON_CURRENCIES : [values.currency, ...COMMON_CURRENCIES],
    [values.currency],
  );

  const set = (k: keyof BusinessFormValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    setSaved(false);
    setValues((v) => ({ ...v, [k]: e.target.value }));
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    setFormError(null);
    setSaved(false);
    const parsed = businessInputSchema.safeParse(values);
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      setFormError(t('auth.errors.VALIDATION'));
      return;
    }
    setPending(true);
    try {
      // Empty optional fields are sent as "" so the API can clear them on edit.
      const payload: Record<string, unknown> = { ...parsed.data };
      for (const k of ['description', 'website', 'industry', 'country', 'brandVoice', 'targetAudience', 'objectives'] as const) {
        if (payload[k] === undefined && initial[k] !== '') payload[k] = '';
      }
      await onSubmit(payload);
      setSaved(true);
    } catch (err) {
      setErrors(apiFieldErrors(err, FIELDS));
      const code = err instanceof ApiError ? err.code : 'UNKNOWN';
      const msg = t(`auth.errors.${code}`);
      setFormError(msg.startsWith('auth.errors.') ? (err instanceof ApiError ? err.message : t('auth.errors.UNKNOWN')) : msg);
    } finally {
      setPending(false);
    }
  }

  const common = (k: keyof BusinessFormValues) => ({
    id: `business-${k}`,
    name: k,
    value: values[k],
    onChange: set(k),
    disabled: readOnly || pending,
    'aria-invalid': Boolean(errors[k]),
    'aria-describedby': errors[k] ? `business-${k}-error` : `business-${k}-hint`,
  });
  const label = (k: string) => t(`business.fields.${k}`);
  const opt = t('common.optional');

  return (
    <form onSubmit={submit} noValidate className="grid gap-8">
      <fieldset className="grid gap-4">
        <legend className="mb-2 text-sm font-semibold">{t('business.sections.identity')}</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="business-name" label={label('name')} error={errors.name}>
            <Input {...common('name')} required autoComplete="organization" maxLength={120} />
          </Field>
          <Field id="business-type" label={label('type')} error={errors.type}>
            <Select {...common('type')}>
              {BUSINESS_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`business.types.${type}`)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field id="business-description" label={label('description')} hint={t('business.hints.description')} error={errors.description} optional optionalLabel={opt}>
          <Textarea {...common('description')} rows={3} maxLength={2000} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="business-website" label={label('website')} error={errors.website} optional optionalLabel={opt}>
            <Input {...common('website')} type="url" inputMode="url" placeholder="https://" />
          </Field>
          <Field id="business-industry" label={label('industry')} error={errors.industry} optional optionalLabel={opt}>
            <Input {...common('industry')} maxLength={120} />
          </Field>
        </div>
      </fieldset>

      <fieldset className="grid gap-4">
        <legend className="mb-2 text-sm font-semibold">{t('business.sections.locale')}</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="business-country" label={label('country')} hint={t('business.hints.country')} error={errors.country} optional optionalLabel={opt}>
            <Input {...common('country')} maxLength={2} className="uppercase" autoComplete="country" />
          </Field>
          <Field id="business-currency" label={label('currency')} error={errors.currency}>
            <Select {...common('currency')}>
              {currencies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="business-timezone" label={label('timezone')} hint={t('business.hints.timezone')} error={errors.timezone}>
            <Select {...common('timezone')}>
              {tzList.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="business-defaultLocale" label={label('defaultLocale')} error={errors.defaultLocale}>
            <Select {...common('defaultLocale')}>
              {SUPPORTED_LOCALES.map((l) => (
                <option key={l} value={l}>
                  {l === 'en' ? 'English' : l === 'fr' ? 'Français' : l}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </fieldset>

      <fieldset className="grid gap-4">
        <legend className="mb-2 text-sm font-semibold">{t('business.sections.marketing')}</legend>
        <Field id="business-brandVoice" label={label('brandVoice')} hint={t('business.hints.brandVoice')} error={errors.brandVoice} optional optionalLabel={opt}>
          <Input {...common('brandVoice')} maxLength={2000} />
        </Field>
        <Field id="business-targetAudience" label={label('targetAudience')} error={errors.targetAudience} optional optionalLabel={opt}>
          <Textarea {...common('targetAudience')} rows={2} maxLength={2000} />
        </Field>
        <Field id="business-objectives" label={label('objectives')} error={errors.objectives} optional optionalLabel={opt}>
          <Textarea {...common('objectives')} rows={2} maxLength={2000} />
        </Field>
      </fieldset>

      {formError && (
        <p role="alert" data-testid="form-error" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {formError}
        </p>
      )}
      {!readOnly && (
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={pending}>
            {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {pending ? t('common.saving') : submitLabel}
          </Button>
          {saved && (
            <span role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
              {t('common.saved')}
            </span>
          )}
        </div>
      )}
    </form>
  );
}
