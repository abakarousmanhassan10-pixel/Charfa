'use client';
import { AI_CONTENT_PURPOSES, AI_LANGUAGE_NAMES, AI_LANGUAGES, AI_PLATFORMS, AI_TONES } from '@touma/shared';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { qs, useResource, type Paged } from '@/lib/use-resource';

export function LanguageSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useI18n();
  return (
    <Field id="ai-language" label={t('ai.fields.language')}>
      <Select id="ai-language" value={value} onChange={(e) => onChange(e.target.value)}>
        {AI_LANGUAGES.map((l) => (
          <option key={l} value={l}>
            {AI_LANGUAGE_NAMES[l]}
          </option>
        ))}
      </Select>
    </Field>
  );
}

export function ToneSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useI18n();
  return (
    <Field id="ai-tone" label={t('ai.fields.tone')}>
      <Select id="ai-tone" value={value} onChange={(e) => onChange(e.target.value)}>
        {AI_TONES.map((x) => <option key={x} value={x}>{t(`ai.tones.${x}`)}</option>)}
      </Select>
    </Field>
  );
}

export function PurposeSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useI18n();
  return (
    <Field id="ai-purpose" label={t('ai.fields.purpose')}>
      <Select id="ai-purpose" value={value} onChange={(e) => onChange(e.target.value)}>
        {AI_CONTENT_PURPOSES.map((x) => <option key={x} value={x}>{t(`ai.purposes.${x}`)}</option>)}
      </Select>
    </Field>
  );
}

export function PlatformToggle({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const { t } = useI18n();
  return (
    <fieldset>
      <legend className="mb-2 text-sm font-medium">{t('ai.fields.platforms')}</legend>
      <div className="flex flex-wrap gap-2">
        {AI_PLATFORMS.map((p) => {
          const on = value.includes(p);
          return (
            <label key={p} className={`inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${on ? 'border-primary bg-primary/5' : ''}`}>
              <input type="checkbox" checked={on} onChange={() => onChange(on ? value.filter((x) => x !== p) : [...value, p])} className="accent-[var(--primary)]" />
              {t(`ai.platforms.${p}`)}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

interface Item {
  id: string;
  name: string;
}

/** ACTIVE products and services only: TOUMA AI only uses active catalog items as facts. */
export function ItemSelect({ value, onChange, optional = true }: { value: string; onChange: (v: string) => void; optional?: boolean }) {
  const { t } = useI18n();
  const { active } = useBusiness();
  const products = useResource<Paged<Item>>(`/products${qs({ status: 'ACTIVE', pageSize: 100, sort: 'name', order: 'asc' })}`, active?.id);
  const services = useResource<Paged<Item>>(`/services${qs({ status: 'ACTIVE', pageSize: 100, sort: 'name', order: 'asc' })}`, active?.id);
  return (
    <Field id="ai-item" label={t('ai.fields.item')} hint={t('ai.itemHint')}>
      <Select id="ai-item" value={value} onChange={(e) => onChange(e.target.value)} aria-describedby="ai-item-hint">
        {optional && <option value="">{t('ai.wholeBusiness')}</option>}
        {!optional && !value && <option value="">{t('ai.chooseItem')}</option>}
        {products.data && products.data.items.length > 0 && (
          <optgroup label={t('dashboard.nav.products')}>
            {products.data.items.map((p) => <option key={p.id} value={`PRODUCT:${p.id}`}>{p.name}</option>)}
          </optgroup>
        )}
        {services.data && services.data.items.length > 0 && (
          <optgroup label={t('dashboard.nav.services')}>
            {services.data.items.map((s) => <option key={s.id} value={`SERVICE:${s.id}`}>{s.name}</option>)}
          </optgroup>
        )}
      </Select>
    </Field>
  );
}

export function parseItem(v: string) {
  const [itemType, itemId] = v.split(':');
  return itemType && itemId ? { itemType: itemType as 'PRODUCT' | 'SERVICE', itemId } : {};
}
