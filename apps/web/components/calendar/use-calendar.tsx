'use client';
import { useCallback, useRef, useState } from 'react';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { api, ApiError } from '@/lib/api-client';
import { useResource } from '@/lib/use-resource';
import type { Conflict, Entry, Overview, RangeResponse } from './types';

export function useOverview() {
  const { active } = useBusiness();
  return useResource<Overview>('/calendar/overview', active?.id);
}

export function useRange(from: string, to: string, platform: string) {
  const { active } = useBusiness();
  return useResource<RangeResponse>(`/calendar/entries?from=${from}&to=${to}${platform ? `&platform=${platform}` : ''}`, active?.id);
}

/** A readable message for an API error: a calendar-specific text when we have one, else the server message. */
export function useErrorText() {
  const { t } = useI18n();
  return useCallback(
    (e: unknown) => {
      if (!(e instanceof ApiError)) return t('common.loadError');
      const key = `calendar.errors.${e.code}`;
      const known = t(key);
      const base = known === key ? e.message : known;
      return e.details?.length ? `${base} ${e.details.slice(0, 3).join('; ')}` : base;
    },
    [t],
  );
}

/**
 * Asks the person to confirm soft conflicts (posts too close together, daily limit, no connected account).
 * `ask(conflicts)` resolves true when they confirm. Render `dialog` once in the page.
 */
export function useConflictConfirm() {
  const { t } = useI18n();
  const [pending, setPending] = useState<Conflict[] | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);
  const ask = useCallback(
    (conflicts: Conflict[]) =>
      new Promise<boolean>((resolve) => {
        resolver.current = resolve;
        setPending(conflicts);
      }),
    [],
  );
  const settle = (v: boolean) => {
    resolver.current?.(v);
    resolver.current = null;
    setPending(null);
  };
  const dialog = (
    <Dialog open={pending !== null} onClose={() => settle(false)} title={t('calendar.conflict.title')} description={t('calendar.conflict.text')} closeLabel={t('common.close')}>
      <ul className="mb-4 grid gap-2" data-testid="conflict-list">
        {(pending ?? []).map((c, i) => (
          <li key={i} className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm dark:bg-amber-950/30">
            <span className="font-medium">{t(`calendar.conflict.codes.${c.code}`)}</span>
            {c.withTitle && <span className="text-muted-foreground"> · {c.withTitle}</span>}
          </li>
        ))}
      </ul>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={() => settle(false)}>{t('calendar.conflict.cancel')}</Button>
        <Button onClick={() => settle(true)} data-testid="conflict-confirm">{t('calendar.conflict.confirm')}</Button>
      </div>
    </Dialog>
  );
  return { ask, dialog };
}

/** Sends a write request; soft conflicts are confirmed once and the request is repeated with the acknowledgement. */
export function useCalendarWrite() {
  const { active } = useBusiness();
  const { ask, dialog } = useConflictConfirm();
  const send = useCallback(
    async <T = Entry,>(path: string, method: 'POST' | 'PATCH' | 'DELETE' | 'PUT', body?: Record<string, unknown>): Promise<T | null> => {
      if (!active) return null;
      try {
        return await api<T>(`/calendar${path}`, { method, json: body ?? {}, businessId: active.id });
      } catch (e) {
        if (e instanceof ApiError && e.code === 'CONFLICT_CONFIRMATION_REQUIRED' && e.extra?.conflicts) {
          if (!(await ask(e.extra.conflicts as Conflict[]))) return null;
          return api<T>(`/calendar${path}`, { method, json: { ...(body ?? {}), acknowledgeConflicts: true }, businessId: active.id });
        }
        throw e;
      }
    },
    [active, ask],
  );
  return { send, dialog };
}
