'use client';
import { useEffect, useState } from 'react';
import { qs, useDebounced, useResource, type Paged } from '@/lib/use-resource';
import type { CatalogFilters } from './list-toolbar';
import type { Category } from './types';

/** Shared list state: debounced search, filters, sort and pagination (reset to page 1 on change). */
export function useCatalogList<T>(resource: 'products' | 'services', businessId: string | undefined) {
  const [filters, setFilters] = useState<CatalogFilters>({ q: '', categoryId: '', status: '', availability: '', sort: 'updatedAt:desc' });
  const [page, setPage] = useState(1);
  const q = useDebounced(filters.q);
  useEffect(() => setPage(1), [q, filters.categoryId, filters.status, filters.availability, filters.sort, businessId]);
  const [sort, order] = filters.sort.split(':');
  const path = `/${resource}${qs({ q, categoryId: filters.categoryId, status: filters.status, availability: filters.availability, sort, order, page, pageSize: 10 })}`;
  const list = useResource<Paged<T>>(path, businessId);
  const categories = useResource<Category[]>(resource === 'products' ? '/product-categories' : '/service-categories', businessId);
  return { filters, setFilters, page, setPage, list, categories: categories.data ?? [] };
}
