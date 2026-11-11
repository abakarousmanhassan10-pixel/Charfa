'use client';
import { useEffect, useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { EmptyState, ErrorState, LoadingRows } from '@/components/ui/states';
import { api, ApiError } from '@/lib/api-client';
import { qs, useResource, type Paged } from '@/lib/use-resource';
import { IntentBadge, LeadBadge, flag } from './badges';
import { LEAD_STATUSES, type CustomerDetail, type CustomerRow } from './types';

export function CustomersView() {
  const { t, locale } = useI18n();
  const { active, can } = useBusiness();
  const [q, setQ] = useState('');
  const [lead, setLead] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => setPage(1), [q, lead, active?.id]);
  const list = useResource<Paged<CustomerRow>>(`/sales/customers${qs({ q: q || undefined, leadStatus: lead || undefined, page, pageSize: 15 })}`, active?.id);
  const fmt = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso));
  return (
    <Card>
      <CardContent className="grid gap-4 pt-6">
        <div className="grid gap-2 sm:grid-cols-[1fr_220px]">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('sales.customers.search')} aria-label={t('sales.customers.search')} data-testid="customer-search" />
          <Select value={lead} onChange={(e) => setLead(e.target.value)} aria-label={t('sales.fields.leadStatus')} data-testid="customer-lead-filter"><option value="">{t('sales.customers.allLeads')}</option>{LEAD_STATUSES.map((s) => <option key={s} value={s}>{t(`sales.lead.${s}`)}</option>)}</Select>
        </div>
        {list.loading && !list.data ? <LoadingRows rows={4} label={t('common.loading')} /> : list.error && !list.data ? <ErrorState message={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => void list.reload()} /> : (list.data?.items.length ?? 0) === 0 ? <EmptyState title={t('sales.customers.emptyTitle')} hint={t('sales.customers.emptyHint')} /> : (
          <ul className="grid gap-2" data-testid="customer-list">
            {list.data!.items.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => setOpen(c.id)} className="grid w-full gap-1 rounded-lg border p-3 text-start hover:bg-muted/50 sm:grid-cols-[1fr_auto] sm:items-center" data-testid="customer-item" data-lead={c.leadStatus}>
                  <span className="min-w-0"><span className="font-medium">{c.name ?? t('sales.anonymousVisitor')}</span><span className="block truncate text-sm text-muted-foreground">{[c.email, c.phone].filter(Boolean).join(' · ') || t('sales.customers.noContact')}</span></span>
                  <span className="flex flex-wrap items-center gap-1.5"><span className="text-xs text-muted-foreground">{flag(c.language)} · {fmt(c.lastSeenAt)}</span><IntentBadge intent={c.purchaseIntent} /><LeadBadge status={c.leadStatus} /></span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {list.data && list.data.pageCount > 1 && <Pagination page={list.data.page} pageCount={list.data.pageCount} total={list.data.total} onPage={setPage} labels={{ previous: t('common.previous'), next: t('common.next'), summary: t('common.resultCount', { count: list.data.total }) }} />}
      </CardContent>
      <CustomerDialog id={open} onClose={() => setOpen(null)} onChanged={() => void list.reload()} canEdit={can('inbox.reply')} canErase={can('business.update')} />
    </Card>
  );
}

function CustomerDialog({ id, onClose, onChanged, canEdit, canErase }: { id: string | null; onClose: () => void; onChanged: () => void; canEdit: boolean; canErase: boolean }) {
  const { t, locale } = useI18n();
  const { active } = useBusiness();
  const res = useResource<CustomerDetail>(id ? `/sales/customers/${id}` : null, active?.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [erase, setErase] = useState(false);
  const d = res.data && res.data.id === id ? res.data : null;

  async function patch(json: Record<string, unknown>) {
    if (!active || !id) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/sales/customers/${id}`, { method: 'PATCH', json, businessId: active.id });
      await res.reload();
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('common.loadError'));
    } finally {
      setBusy(false);
    }
  }
  async function addNote() {
    if (!active || !id || !note.trim()) return;
    setBusy(true);
    try {
      await api(`/sales/customers/${id}/notes`, { method: 'POST', json: { body: note.trim() }, businessId: active.id });
      setNote('');
      await res.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('common.loadError'));
    } finally {
      setBusy(false);
    }
  }
  async function doErase() {
    if (!active || !id) return;
    await api(`/sales/customers/${id}`, { method: 'DELETE', businessId: active.id });
    setErase(false);
    onClose();
    onChanged();
  }
  const fmt = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  return (
    <>
      <Dialog open={id !== null} onClose={onClose} title={d?.name ?? t('sales.anonymousVisitor')} description={t('sales.customers.profile')} closeLabel={t('common.close')}>
        {!d ? <LoadingRows rows={3} label={t('common.loading')} /> : (
          <div className="grid gap-4" data-testid="customer-dialog">
            {error && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div><dt className="text-xs text-muted-foreground">{t('sales.fields.email')}</dt><dd>{d.email ?? '—'}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{t('sales.fields.phone')}</dt><dd>{d.phone ?? '—'}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{t('sales.fields.consent')}</dt><dd>{d.consent ? t('sales.yes') : t('sales.no')}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{t('sales.fields.language')}</dt><dd>{flag(d.language)}</dd></div>
            </dl>
            <label className="grid gap-1 text-sm">{t('sales.fields.leadStatus')}
              <Select value={d.leadStatus} onChange={(e) => void patch({ leadStatus: e.target.value })} disabled={!canEdit || busy || d.anonymized} data-testid="customer-lead-select">{LEAD_STATUSES.map((s) => <option key={s} value={s}>{t(`sales.lead.${s}`)}</option>)}</Select>
            </label>
            <label className="grid gap-1 text-sm">{t('sales.fields.followUp')}
              <Input type="date" value={d.followUpAt ? d.followUpAt.slice(0, 10) : ''} onChange={(e) => void patch({ followUpAt: e.target.value ? new Date(`${e.target.value}T09:00:00`).toISOString() : null })} disabled={!canEdit || busy || d.anonymized} data-testid="customer-followup" />
            </label>
            <div>
              <h3 className="text-sm font-medium">{t('sales.customers.conversations')}</h3>
              <ul className="mt-1 grid gap-1 text-sm">{d.conversationList.map((c) => <li key={c.id}><a className="text-primary hover:underline" href={`/dashboard/sales?c=${c.id}`}>{c.lastMessageAt ? fmt(c.lastMessageAt) : '—'} · {t(`sales.mode.${c.aiMode}`)}</a></li>)}</ul>
            </div>
            <div>
              <h3 className="text-sm font-medium">{t('sales.notes.title')}</h3>
              <p className="text-xs text-muted-foreground">{t('sales.notes.hint')}</p>
              <ul className="mt-2 grid gap-2">{d.notes.map((n) => <li key={n.id} className="rounded-md bg-muted/50 px-3 py-2 text-sm" data-testid="customer-note">{n.body}<span className="block text-xs text-muted-foreground">{n.authorName ?? ''} · {fmt(n.createdAt)}</span></li>)}</ul>
              {canEdit && !d.anonymized && <div className="mt-2 flex gap-2"><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder={t('sales.notes.placeholder')} aria-label={t('sales.notes.placeholder')} data-testid="customer-note-input" /><Button size="sm" onClick={() => void addNote()} disabled={busy || !note.trim()} data-testid="customer-note-add">{busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}{t('sales.notes.add')}</Button></div>}
            </div>
            {canErase && !d.anonymized && <Button variant="outline" className="text-destructive" onClick={() => setErase(true)} data-testid="customer-erase"><Trash2 className="h-4 w-4" aria-hidden />{t('sales.customers.erase')}</Button>}
            {d.anonymized && <p className="text-sm text-muted-foreground">{t('sales.customers.erased')}</p>}
          </div>
        )}
      </Dialog>
      <ConfirmDialog open={erase} onClose={() => setErase(false)} onConfirm={doErase} title={t('sales.customers.eraseTitle')} description={t('sales.customers.eraseText')} confirmLabel={t('sales.customers.erase')} cancelLabel={t('common.cancel')} destructive />
    </>
  );
}
