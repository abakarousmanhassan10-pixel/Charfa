'use client';
import { useI18n } from '@/components/i18n-provider';
import { Select } from '@/components/ui/select';
import { SearchInput } from '@/components/ui/search-input';
import type { Category } from './types';

export interface CatalogFilters {
  q: string;
  categoryId: string;
  status: string;
  availability: string;
  sort: string;
}

export function ListToolbar({
  filters,
  onChange,
  categories,
  availability,
  searchLabel,
}: {
  filters: CatalogFilters;
  onChange: (f: CatalogFilters) => void;
  categories: Category[];
  availability: readonly string[];
  searchLabel: string;
}) {
  const { t } = useI18n();
  const set = (k: keyof CatalogFilters) => (v: string) => onChange({ ...filters, [k]: v });
  return (
    <div className="mb-4 grid gap-3 lg:flex lg:items-center">
      <SearchInput value={filters.q} onChange={set('q')} label={searchLabel} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:flex">
        <Select aria-label={t('catalog.fields.category')} value={filters.categoryId} onChange={(e) => set('categoryId')(e.target.value)} className="lg:w-44">
          <option value="">{t('catalog.allCategories')}</option>
          <option value="none">{t('catalog.uncategorised')}</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select aria-label={t('catalog.fields.status')} value={filters.status} onChange={(e) => set('status')(e.target.value)} className="lg:w-36">
          <option value="">{t('catalog.allStatuses')}</option>
          {['ACTIVE', 'DRAFT', 'ARCHIVED'].map((s) => (
            <option key={s} value={s}>
              {t(`catalog.status.${s}`)}
            </option>
          ))}
        </Select>
        <Select aria-label={t('catalog.fields.availability')} value={filters.availability} onChange={(e) => set('availability')(e.target.value)} className="lg:w-44">
          <option value="">{t('catalog.allAvailability')}</option>
          {availability.map((a) => (
            <option key={a} value={a}>
              {t(`catalog.availability.${a}`)}
            </option>
          ))}
        </Select>
        <Select aria-label={t('catalog.sortBy')} value={filters.sort} onChange={(e) => set('sort')(e.target.value)} className="lg:w-44">
          <option value="updatedAt:desc">{t('catalog.sort.recent')}</option>
          <option value="name:asc">{t('catalog.sort.nameAsc')}</option>
          <option value="price:asc">{t('catalog.sort.priceAsc')}</option>
          <option value="price:desc">{t('catalog.sort.priceDesc')}</option>
        </Select>
      </div>
    </div>
  );
}
