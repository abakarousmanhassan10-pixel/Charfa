'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { Permission } from '@touma/shared';
import { api } from '@/lib/api-client';
import { useAuth } from './auth-provider';

export interface Business {
  id: string;
  name: string;
  slug: string;
  type: string;
  description: string | null;
  website: string | null;
  industry: string | null;
  country: string | null;
  defaultLocale: string;
  timezone: string;
  currency: string;
  brandVoice: string | null;
  targetAudience: string | null;
  objectives: string | null;
  createdAt: string;
  role: 'OWNER' | 'ADMIN' | 'EDITOR' | 'VIEWER';
  permissions: Permission[];
}

interface BusinessContextValue {
  status: 'loading' | 'ready' | 'error';
  businesses: Business[];
  active: Business | null;
  setActive: (id: string) => void;
  reload: () => Promise<Business[]>;
  upsert: (b: Business) => void;
  /** UI hint only; the API enforces every permission. */
  can: (permission: Permission) => boolean;
}

const BusinessContext = createContext<BusinessContextValue | null>(null);
const ACTIVE_KEY = 'touma.activeBusinessId';

function readActive(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export function BusinessProvider({ children }: { children: React.ReactNode }) {
  const { status: authStatus } = useAuth();
  const [status, setStatus] = useState<BusinessContextValue['status']>('loading');
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const list = await api<Business[]>('/businesses');
      setBusinesses(list);
      setActiveId((current) => {
        const preferred = current ?? readActive();
        return list.find((b) => b.id === preferred)?.id ?? list[0]?.id ?? null;
      });
      setStatus('ready');
      return list;
    } catch {
      setStatus('error');
      return [];
    }
  }, []);

  useEffect(() => {
    if (authStatus === 'authenticated') void reload();
    if (authStatus === 'anonymous') {
      setBusinesses([]);
      setActiveId(null);
      setStatus('loading');
    }
  }, [authStatus, reload]);

  const setActive = useCallback((id: string) => {
    setActiveId(id);
    try {
      localStorage.setItem(ACTIVE_KEY, id);
    } catch {
      /* storage unavailable: selection lasts for this tab only */
    }
  }, []);

  const value = useMemo<BusinessContextValue>(() => {
    const active = businesses.find((b) => b.id === activeId) ?? null;
    return {
      status,
      businesses,
      active,
      setActive,
      reload,
      upsert: (b) => setBusinesses((list) => (list.some((x) => x.id === b.id) ? list.map((x) => (x.id === b.id ? b : x)) : [...list, b])),
      can: (p) => Boolean(active?.permissions.includes(p)),
    };
  }, [status, businesses, activeId, setActive, reload]);

  return <BusinessContext.Provider value={value}>{children}</BusinessContext.Provider>;
}

export function useBusiness() {
  const ctx = useContext(BusinessContext);
  if (!ctx) throw new Error('useBusiness must be used inside BusinessProvider');
  return ctx;
}
