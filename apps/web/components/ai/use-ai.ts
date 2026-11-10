'use client';
import { useState } from 'react';
import { useBusiness } from '@/components/business-provider';
import { api, ApiError } from '@/lib/api-client';
import { useResource } from '@/lib/use-resource';
import type { AiStatus, Generation } from './types';

export function useAiStatus() {
  const { active } = useBusiness();
  return useResource<AiStatus>('/ai/status', active?.id);
}

/** Runs a generation request and keeps the latest result, pending state and error. */
export function useGenerate<T = unknown>() {
  const { active } = useBusiness();
  const [result, setResult] = useState<Generation<T> | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function run(path: string, body: Record<string, unknown>) {
    if (!active) return null;
    setPending(true);
    setError(null);
    try {
      const g = await api<Generation<T>>(path, { method: 'POST', json: body, businessId: active.id });
      setResult(g);
      return g;
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'UNKNOWN', String(err)));
      return null;
    } finally {
      setPending(false);
    }
  }

  return { result, setResult, pending, error, run, regenerate: (id: string, instructions?: string) => run(`/ai/generations/${id}/regenerate`, instructions ? { instructions } : {}) };
}
