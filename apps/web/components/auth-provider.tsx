'use client';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, authRequest, logout as apiLogout, refreshSession } from '@/lib/api-client';

export interface Profile {
  id: string;
  email: string;
  emailVerified?: boolean;
  fullName: string;
  locale: string;
  timezone: string;
  platformRole: string;
  createdAt: string;
  memberships: Array<{ role: string; business: { id: string; name: string; slug: string } }>;
}

type Status = 'loading' | 'authenticated' | 'anonymous';

interface AuthContextValue {
  status: Status;
  user: Profile | null;
  login: (email: string, password: string) => Promise<void>;
  register: (input: { email: string; password: string; fullName: string; locale: string }) => Promise<void>;
  logout: () => Promise<void>;
  logoutAll: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  updateProfile: (input: { fullName?: string; locale?: string; timezone?: string }) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<Profile | null>(null);

  const loadProfile = useCallback(async () => {
    const profile = await api<Profile>('/users/me');
    setUser(profile);
    setStatus('authenticated');
  }, []);

  useEffect(() => {
    (async () => {
      try {
        if (await refreshSession()) await loadProfile();
        else setStatus('anonymous');
      } catch {
        setStatus('anonymous');
      }
    })();
  }, [loadProfile]);

  const value: AuthContextValue = {
    status,
    user,
    login: async (email, password) => {
      await authRequest('/auth/login', { email, password });
      await loadProfile();
    },
    register: async (input) => {
      await authRequest('/auth/register', input);
      await loadProfile();
    },
    logout: async () => {
      await apiLogout();
      setUser(null);
      setStatus('anonymous');
    },
    logoutAll: async () => {
      await api('/auth/logout-all', { method: 'POST' });
      await apiLogout();
      setUser(null);
      setStatus('anonymous');
    },
    refreshProfile: loadProfile,
    updateProfile: async (input) => {
      await api('/users/me', { method: 'PATCH', json: input });
      await loadProfile();
    },
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
