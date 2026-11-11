'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useBusiness } from '@/components/business-provider';
import { api, ApiError } from '@/lib/api-client';
import { useResource } from '@/lib/use-resource';
import type { CreativeGeneration, CreativeJobStatus, CreativeOverview } from './types';

export function useCreativeStatus() {
  const { active } = useBusiness();
  return useResource<CreativeOverview>('/creative/status', active?.id);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');

/**
 * Submits an image or video request (the API answers 202), then follows the background job until it is final and loads
 * the result. Each click sends its own Idempotency-Key, so a repeated delivery of the same request can never create (or
 * charge) a second generation. The job keeps running if the user leaves; it stays in the history.
 */
export function useCreativeJob() {
  const { active } = useBusiness();
  const [result, setResultState] = useState<CreativeGeneration | null>(null);
  const [job, setJob] = useState<CreativeJobStatus | null>(null);
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

  const setResult = useCallback((g: CreativeGeneration | null) => {
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
      const accepted = await api<CreativeGeneration>(path, { method: 'POST', json: body, businessId: active.id, headers: { 'Idempotency-Key': newKey() } });
      let delay = 700;
      let failures = 0;
      for (;;) {
        if (!current()) return null;
        try {
          const st = await api<CreativeJobStatus>(`/creative/generations/${accepted.id}/status`, { businessId: active.id });
          failures = 0;
          if (!current()) return null;
          setJob(st);
          if (st.final) break;
        } catch (err) {
          if (++failures >= 5 || (err instanceof ApiError && err.status === 404)) throw err;
        }
        await sleep(delay);
        delay = Math.min(2500, Math.round(delay * 1.25));
      }
      const g = await api<CreativeGeneration>(`/creative/generations/${accepted.id}`, { businessId: active.id });
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

  return { result, setResult, job, pending, error, run };
}
