'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useBusiness } from '@/components/business-provider';
import { api, ApiError } from '@/lib/api-client';
import { useResource } from '@/lib/use-resource';
import type { AiStatus, Generation, JobStatus } from './types';

export function useAiStatus() {
  const { active } = useBusiness();
  return useResource<AiStatus>('/ai/status', active?.id);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Submits a generation (the API answers 202 with the generation id), then follows the background job
 * until it is final and loads the result. The job keeps running if the user leaves the page; its result
 * stays available in the history.
 */
export function useGenerate<T = unknown>() {
  const { active } = useBusiness();
  const [result, setResultState] = useState<Generation<T> | null>(null);
  const [job, setJob] = useState<JobStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const alive = useRef(true);
  const runId = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Clearing the result also abandons any run still being followed (e.g. after switching business). */
  const setResult = useCallback((g: Generation<T> | null) => {
    if (g === null) {
      runId.current++;
      setJob(null);
      setPending(false);
    }
    setResultState(g);
  }, []);

  async function run(path: string, body: Record<string, unknown>) {
    if (!active) return null;
    const mine = ++runId.current;
    const current = () => alive.current && runId.current === mine;
    setPending(true);
    setError(null);
    setJob(null);
    try {
      const accepted = await api<Generation<T>>(path, { method: 'POST', json: body, businessId: active.id });
      let delay = 700;
      let failures = 0;
      for (;;) {
        if (!current()) return null;
        try {
          const st = await api<JobStatus>(`/ai/generations/${accepted.id}/status`, { businessId: active.id });
          failures = 0;
          if (!current()) return null;
          setJob(st);
          if (st.final) break;
        } catch (err) {
          // A few network blips must not abandon a job that is still running on the server.
          if (++failures >= 5 || (err instanceof ApiError && err.status === 404)) throw err;
        }
        await sleep(delay);
        delay = Math.min(2000, Math.round(delay * 1.25));
      }
      const g = await api<Generation<T>>(`/ai/generations/${accepted.id}`, { businessId: active.id });
      if (!current()) return null;
      if (g.status !== 'SUCCEEDED') {
        setError(new ApiError(0, g.errorCode ?? 'UNKNOWN', g.errorMessage ?? 'The generation failed'));
        return null;
      }
      setResultState(g);
      return g;
    } catch (err) {
      if (current()) setError(err instanceof ApiError ? err : new ApiError(0, 'UNKNOWN', String(err)));
      return null;
    } finally {
      if (current()) {
        setPending(false);
        setJob(null);
      }
    }
  }

  return { result, setResult, job, pending, error, run, regenerate: (id: string, instructions?: string) => run(`/ai/generations/${id}/regenerate`, instructions ? { instructions } : {}) };
}
