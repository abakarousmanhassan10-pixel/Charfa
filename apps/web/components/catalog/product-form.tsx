'use client';
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { PRODUCT_AVAILABILITY, productInputSchema } from '@touma/shared';
import { useI18n } from '@/components/i18n-provider';
import type { MediaItem } from '@/components/media/media-types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/api-client';
import { apiFieldErrors, zodFieldErrors } from '@/lib/form-errors';
import { cleanList, ListInput } from './list-input';
import { MediaGalleryField } from './media-gallery-field';
import type { Category, Product } from './types';

type Values = {
  name: string; description: string; categoryId: string; status: string; price: string; discountPrice: string; currency: string;
  sku: string; stockQuantity: string; availability: string; features: string[]; benefits: string[]; targetAudience: string; url: string;
};
const TEXT = ['description', 'categoryId', 'price', 'discountPrice', 'sku', 'stockQuantity', 'targetAudience', 'url'] as const;

export function ProductForm({
  product,
  categories,
  businessId,
  currency,
  readOnly,
  submitLabel,
  onSubmit,
}: {
  product?: Product;
  categories: Category[];
  businessId: string;
  currency: string;
  readOnly?: boolean;
  submitLabel: string;
  onSubmit: (payload: Record<string, unknown>, media: MediaItem[]) => Promise<void>;
}) {
  const { t } = useI18n();
  const [v, setV] = useState<Values>({
    name: product?.name ?? '',
    description: product?.description ?? '',
    categoryId: product?.categoryId ?? '',
    status: product?.status ?? 'DRAFT',
    price: product?.price ?? '',
    discountPrice: product?.discountPrice ?? '',
    currency: product?.currency ?? currency,
    sku: product?.sku ?? '',
    stockQuantity: product?.stockQuantity?.toString() ?? '',
    availability: product?.availability ?? 'IN_STOCK',
    features: product?.features ?? [],
    benefits: product?.benefits ?? [],
    targetAudience: product?.targetAudience ?? '',
    url: product?.url ?? '',
  });
  const [media, setMedia] = useState<MediaItem[]>(product?.media ?? []);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);

  const set = (k: keyof Values) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    setSaved(false);
    setV((x) => ({ ...x, [k]: e.target.value }));
  };
  const f = (k: keyof Values) => ({
    id: `product-${k}`,
    value: v[k] as string,
    onChange: set(k),
    disabled: readOnly || pending,
    'aria-invalid': Boolean(errors[k]),
    'aria-describedby': errors[k] ? `product-${k}-error` : `product-${k}-hint`,
  });
  const L = (k: string) => t(`catalog.fields.${k}`);
  const opt = t('common.optional');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    setFormError(null);
    setSaved(false);
    const input = { ...v, features: cleanList(v.features), benefits: cleanList(v.benefits), stockQuantity: v.stockQuantity === '' ? undefined : v.stockQuantity };
    const parsed = productInputSchema.safeParse(input);
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      setFormError(t('auth.errors.VALIDATION'));
      return;
    }
    const payload: Record<string, unknown> = { ...parsed.data };
    // On edit, an emptied field is sent as null so the API clears it.
    for (const k of TEXT) if (payload[k] === undefined) payload[k] = product ? null : undefined;
    setPending(true);
    try {
      await onSubmit(payload, media);
      setSaved(true);
    } catch (err) {
      setErrors(apiFieldErrors(err, Object.keys(v)));
      const code = err instanceof ApiError ? err.code : 'UNKNOWN';
      const known = t(`catalog.errors.${code}`);
      setFormError(known.startsWith('catalog.errors.') ? (err instanceof Error ? err.message : t('auth.errors.UNKNOWN')) : known);
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
            <Field id="product-name" label={L('name')} error={errors.name}>
              <Input {...f('name')} required maxLength={200} />
            </Field>
            <Field id="product-description" label={L('description')} error={errors.description} optional optionalLabel={opt}>
              <Textarea {...f('description')} rows={5} maxLength={5000} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="product-features" label={L('features')} hint={t('catalog.onePerLine')} optional optionalLabel={opt} error={errors.features}>
                <ListInput id="product-features" value={v.features} onChange={(x) => setV((s) => ({ ...s, features: x }))} disabled={readOnly || pending} describedBy="product-features-hint" />
              </Field>
              <Field id="product-benefits" label={L('benefits')} hint={t('catalog.onePerLine')} optional optionalLabel={opt} error={errors.benefits}>
                <ListInput id="product-benefits" value={v.benefits} onChange={(x) => setV((s) => ({ ...s, benefits: x }))} disabled={readOnly || pending} describedBy="product-benefits-hint" />
              </Field>
            </div>
            <Field id="product-targetAudience" label={L('targetAudience')} optional optionalLabel={opt} error={errors.targetAudience}>
              <Textarea {...f('targetAudience')} rows={2} maxLength={2000} />
            </Field>
            <Field id="product-url" label={L('url')} optional optionalLabel={opt} error={errors.url}>
              <Input {...f('url')} type="url" placeholder="https://" />
            </Field>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>{t('catalog.sections.media')}</CardTitle></CardHeader>
          <CardContent>
            <MediaGalleryField businessId={businessId} value={media} onChange={(m) => { setSaved(false); setMedia(m); }} disabled={readOnly || pending} />
          </CardContent>
        </Card>
      </div>

      <div className="grid content-start gap-6">
        <Card>
          <CardHeader><CardTitle>{t('catalog.sections.organisation')}</CardTitle></CardHeader>
          <CardContent className="grid gap-4">
            <Field id="product-status" label={L('status')}>
              <Select {...f('status')}>
                {['DRAFT', 'ACTIVE', 'ARCHIVED'].map((s) => <option key={s} value={s}>{t(`catalog.status.${s}`)}</option>)}
              </Select>
            </Field>
            <Field id="product-categoryId" label={L('category')} optional optionalLabel={opt} error={errors.categoryId}>
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
                <Field id="product-price" label={L('price')} optional optionalLabel={opt} error={errors.price}>
                  <Input {...f('price')} inputMode="decimal" placeholder="0.00" />
                </Field>
              </div>
              <Field id="product-currency" label={L('currency')} error={errors.currency}>
                <Input {...f('currency')} maxLength={3} className="uppercase" />
              </Field>
            </div>
            <Field id="product-discountPrice" label={L('discountPrice')} hint={t('catalog.discountHint')} optional optionalLabel={opt} error={errors.discountPrice}>
              <Input {...f('discountPrice')} inputMode="decimal" placeholder="0.00" />
            </Field>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>{t('catalog.sections.inventory')}</CardTitle></CardHeader>
          <CardContent className="grid gap-4">
            <Field id="product-sku" label={L('sku')} optional optionalLabel={opt} error={errors.sku}>
              <Input {...f('sku')} maxLength={64} />
            </Field>
            <Field id="product-stockQuantity" label={L('stockQuantity')} hint={t('catalog.stockHint')} optional optionalLabel={opt} error={errors.stockQuantity}>
              <Input {...f('stockQuantity')} type="number" min={0} inputMode="numeric" />
            </Field>
            <Field id="product-availability" label={L('availability')}>
              <Select {...f('availability')}>
                {PRODUCT_AVAILABILITY.map((a) => <option key={a} value={a}>{t(`catalog.availability.${a}`)}</option>)}
              </Select>
            </Field>
          </CardContent>
        </Card>
      </div>

      <div className="lg:col-span-3">
        {formError && (
          <p role="alert" data-testid="form-error" className="mb-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{formError}</p>
        )}
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
