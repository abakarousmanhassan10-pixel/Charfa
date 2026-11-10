'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api-client';

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

/** Fetches a tenant resource; refetches when the path or business changes; ignores stale responses. */
export function useResource<T>(path: string | null, businessId: string | undefined) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!path || !businessId) return;
    const id = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await api<T>(path, { businessId });
      if (id === seq.current) setData(res);
    } catch (err) {
      if (id === seq.current) setError(err);
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [path, businessId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, error, loading, reload: load, setData };
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function qs(params: Record<string, string | number | undefined | null>) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export function formatMoney(amount: string | null, currency: string | null, locale: string) {
  if (amount === null) return null;
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: currency ?? 'USD', maximumFractionDigits: 2 }).format(Number(amount));
  } catch {
    return `${amount} ${currency ?? ''}`.trim();
  }
}

export function formatBytes(bytes: number | null) {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
