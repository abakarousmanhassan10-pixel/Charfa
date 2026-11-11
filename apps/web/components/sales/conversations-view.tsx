'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, Bot, Check, Flag, Loader2, Pause, Play, Send, Sparkles, StickyNote, User, X } from 'lucide-react';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { EmptyState, ErrorState, LoadingRows } from '@/components/ui/states';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError } from '@/lib/api-client';
import { qs, useResource, type Paged } from '@/lib/use-resource';
import { cn } from '@/lib/utils';
import { IntentBadge, LeadBadge, ModeBadge, flag } from './badges';
import type { Card as ProductCard, ConversationDetail, ConversationRow, SalesMessage } from './types';

type Filter = '' | 'needsHuman' | 'AI_ACTIVE' | 'HUMAN' | 'RESOLVED';

function Cards({ cards, locale }: { cards: ProductCard[]; locale: string }) {
  if (!cards.length) return null;
  const money = (v: string | null, c: string | null) => (v === null ? null : new Intl.NumberFormat(locale, { style: 'currency', currency: c ?? 'USD', maximumFractionDigits: 2 }).format(Number(v)));
  return (
    <div className="mt-2 flex flex-wrap gap-2" data-testid="product-cards">
      {cards.map((c) => (
        <div key={c.id} className="rounded-md border bg-background px-2.5 py-1.5 text-xs" data-testid="product-card">
          <p className="font-medium">{c.name}</p>
          <p className="text-muted-foreground">{money(c.discountPrice ?? c.price, c.currency) ?? '—'}{c.availability && ` · ${c.availability.replace(/_/g, ' ').toLowerCase()}`}</p>
        </div>
      ))}
    </div>
  );
}

/** The two-pane conversation workspace: list and filters on the left, the selected conversation with the AI's work and human controls on the right (one pane at a time on phones). */
export function ConversationsView() {
  const { t, locale } = useI18n();
  const { active, can } = useBusiness();
  const router = useRouter();
  const params = useSearchParams();
  const selected = params.get('c');
  const [filter, setFilter] = useState<Filter>(params.get('needs') ? 'needsHuman' : '');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [filter, q, active?.id]);
  const query = qs({ needsHuman: filter === 'needsHuman' ? 'true' : undefined, aiMode: filter === 'AI_ACTIVE' || filter === 'HUMAN' ? filter : undefined, status: filter === 'RESOLVED' ? 'RESOLVED' : undefined, q: q || undefined, page, pageSize: 12 });
  const list = useResource<Paged<ConversationRow>>(`/sales/conversations${query}`, active?.id);
  const reply = can('inbox.reply');

  useEffect(() => {
    const id = setInterval(() => void list.reload(), 10_000);
    return () => clearInterval(id);
  }, [list]);

  const open = (id: string | null) => router.replace(id ? `/dashboard/sales?c=${id}` : '/dashboard/sales');
  const who = (c: ConversationRow) => c.customer?.name ?? t('sales.anonymousVisitor');

  return (
    <div className="grid gap-4 lg:grid-cols-[360px_1fr]" data-testid="conversations-view">
      <Card className={cn(selected && 'hidden lg:block')} data-testid="conversation-list-pane">
        <CardContent className="grid gap-3 pt-6">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('sales.search')} aria-label={t('sales.search')} data-testid="conversation-search" />
            <Select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} aria-label={t('sales.filter')} data-testid="conversation-filter">
              <option value="">{t('sales.filters.all')}</option>
              <option value="needsHuman">{t('sales.filters.needsHuman')}</option>
              <option value="AI_ACTIVE">{t('sales.filters.ai')}</option>
              <option value="HUMAN">{t('sales.filters.human')}</option>
              <option value="RESOLVED">{t('sales.filters.resolved')}</option>
            </Select>
          </div>
          {list.loading && !list.data ? <LoadingRows rows={4} label={t('common.loading')} /> : list.error && !list.data ? <ErrorState message={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => void list.reload()} /> : (list.data?.items.length ?? 0) === 0 ? (
            <EmptyState title={t('sales.conversations.emptyTitle')} hint={t('sales.conversations.emptyHint')} />
          ) : (
            <ul className="grid gap-2" data-testid="conversation-list">
              {list.data!.items.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => open(c.id)} className={cn('grid w-full gap-1 rounded-lg border p-3 text-start hover:bg-muted/50', selected === c.id && 'border-primary bg-muted/40')} data-testid="conversation-item" data-id={c.id} data-status={c.status} data-mode={c.aiMode}>
                    <span className="flex items-center justify-between gap-2"><span className="truncate font-medium">{who(c)}</span><span className="text-xs text-muted-foreground">{flag(c.language)}</span></span>
                    <span className="line-clamp-2 text-sm text-muted-foreground">{c.lastMessage?.body ?? '—'}</span>
                    <span className="flex flex-wrap items-center gap-1.5"><ModeBadge mode={c.aiMode} status={c.status} />{c.pendingDrafts > 0 && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs" data-testid="draft-pending">{t('sales.draftWaiting')}</span>}<IntentBadge intent={c.purchaseIntent} />{c.customer && <LeadBadge status={c.customer.leadStatus} />}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {list.data && list.data.pageCount > 1 && <Pagination page={list.data.page} pageCount={list.data.pageCount} total={list.data.total} onPage={setPage} labels={{ previous: t('common.previous'), next: t('common.next'), summary: t('common.resultCount', { count: list.data.total }) }} />}
        </CardContent>
      </Card>
      <div className={cn(!selected && 'hidden lg:block')} data-testid="conversation-detail-pane">
        {selected ? <Detail id={selected} onBack={() => open(null)} onChanged={() => void list.reload()} canReply={reply} locale={locale} /> : <Card><CardContent className="pt-6"><EmptyState title={t('sales.conversations.selectTitle')} hint={t('sales.conversations.selectHint')} /></CardContent></Card>}
      </div>
    </div>
  );
}

function Detail({ id, onBack, onChanged, canReply, locale }: { id: string; onBack: () => void; onChanged: () => void; canReply: boolean; locale: string }) {
  const { t } = useI18n();
  const { active } = useBusiness();
  const res = useResource<ConversationDetail>(`/sales/conversations/${id}`, active?.id);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [report, setReport] = useState<SalesMessage | null>(null);
  const [rep, setRep] = useState({ note: '', correction: '', addToKnowledge: false });
  const [note, setNote] = useState('');
  const d = res.data;

  useEffect(() => {
    const t0 = setInterval(() => void res.reload(), 6_000);
    return () => clearInterval(t0);
  }, [res]);

  const run = useCallback(async (key: string, path: string, json: unknown = {}, method = 'POST') => {
    if (!active) return;
    setBusy(key);
    setError(null);
    try {
      res.setData(await api<ConversationDetail>(`/sales${path}`, { method, json, businessId: active.id }));
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('common.loadError'));
    } finally {
      setBusy(null);
    }
  }, [active, res, onChanged, t]);

  if (res.loading && !d) return <Card><CardContent className="pt-6"><LoadingRows rows={4} label={t('common.loading')} /></CardContent></Card>;
  if (!d) return <Card><CardContent className="pt-6"><ErrorState message={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => void res.reload()} /></CardContent></Card>;
  const c = d.conversation;
  const human = c.aiMode === 'HUMAN';
  const fmt = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));

  async function sendReply() {
    const body = text.trim();
    if (!body) return;
    await run('reply', `/conversations/${id}/reply`, { body });
    setText('');
  }
  async function addNote() {
    if (!d?.customer || !note.trim() || !active) return;
    setBusy('note');
    try {
      await api(`/sales/customers/${d.customer.id}/notes`, { method: 'POST', json: { body: note.trim(), conversationId: id }, businessId: active.id });
      setNote('');
      await res.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('common.loadError'));
    } finally {
      setBusy(null);
    }
  }
  async function sendReport() {
    if (!report || !active) return;
    setBusy('report');
    try {
      await api(`/sales/messages/${report.id}/feedback`, { method: 'POST', json: { note: rep.note, correction: rep.correction || null, addToKnowledge: rep.addToKnowledge }, businessId: active.id });
      setReport(null);
      setRep({ note: '', correction: '', addToKnowledge: false });
      await res.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('common.loadError'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card data-testid="conversation-detail" data-id={id}>
      <CardContent className="grid gap-4 pt-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            <Button variant="ghost" size="sm" className="lg:hidden" onClick={onBack} aria-label={t('sales.back')} data-testid="back-to-list"><ArrowLeft className="h-4 w-4" aria-hidden /></Button>
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold">{d.customer?.name ?? t('sales.anonymousVisitor')}{c.isTest && <span className="ms-2 text-xs font-normal text-muted-foreground">({t('sales.test')})</span>}</h2>
              <div className="mt-1 flex flex-wrap gap-1.5"><ModeBadge mode={c.aiMode} status={c.status} /><IntentBadge intent={c.purchaseIntent} />{d.customer && <LeadBadge status={d.customer.leadStatus} />}<span className="text-xs text-muted-foreground">{flag(c.language)}{c.intent ? ` · ${t(`sales.intent.${c.intent}`)}` : ''}</span></div>
            </div>
          </div>
          {canReply && !c.isTest && (
            <div className="flex flex-wrap gap-2" data-testid="conversation-actions">
              {!human && <Button size="sm" onClick={() => void run('takeover', `/conversations/${id}/takeover`)} disabled={busy !== null} data-testid="takeover"><User className="h-4 w-4" aria-hidden />{t('sales.actions.takeover')}</Button>}
              {c.aiMode === 'AI_ACTIVE' && <Button size="sm" variant="outline" onClick={() => void run('pause', `/conversations/${id}/pause`)} disabled={busy !== null} data-testid="pause"><Pause className="h-4 w-4" aria-hidden />{t('sales.actions.pause')}</Button>}
              {c.aiMode !== 'AI_ACTIVE' && <Button size="sm" variant="outline" onClick={() => void run('resume', `/conversations/${id}/resume`)} disabled={busy !== null} data-testid="resume"><Play className="h-4 w-4" aria-hidden />{t('sales.actions.resume')}</Button>}
              {c.status === 'RESOLVED' ? <Button size="sm" variant="ghost" onClick={() => void run('reopen', `/conversations/${id}/reopen`)} disabled={busy !== null}>{t('sales.actions.reopen')}</Button> : <Button size="sm" variant="ghost" onClick={() => void run('resolve', `/conversations/${id}/resolve`)} disabled={busy !== null} data-testid="resolve">{t('sales.actions.resolve')}</Button>}
            </div>
          )}
        </div>
        {error && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="conversation-error">{error}</p>}
        {c.status === 'PENDING_HUMAN' && <p className="rounded-md bg-amber-500/10 px-3 py-2 text-sm" data-testid="handoff-banner">{t('sales.handoffBanner', { reason: t(`sales.handoffReasons.${c.handoffReason ?? 'OTHER'}`) })}</p>}
        <ol className="grid max-h-[55vh] gap-3 overflow-y-auto rounded-lg bg-muted/30 p-3" data-testid="message-thread" aria-label={t('sales.thread')}>
          {d.messages.map((m) => {
            const mine = m.direction === 'OUTBOUND';
            const draft = m.author === 'AI_SUGGESTION' && m.approvalStatus === 'PENDING';
            return (
              <li key={m.id} className={cn('flex', mine ? 'justify-end' : 'justify-start')} data-testid="message" data-author={m.author} data-approval={m.approvalStatus}>
                <div className={cn('max-w-[85%] rounded-2xl px-3 py-2 text-sm', m.author === 'CUSTOMER' ? 'bg-background border' : m.author === 'SYSTEM' ? 'bg-muted text-muted-foreground italic' : draft ? 'border border-dashed border-amber-500 bg-amber-500/10' : 'bg-primary/10')}>
                  <p className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {m.author === 'AI_REPLY' || m.author === 'AI_SUGGESTION' ? <><Bot className="h-3 w-3" aria-hidden />{draft ? t('sales.msg.draft') : m.author === 'AI_REPLY' ? t('sales.msg.ai') : t('sales.msg.aiApproved')}</> : m.author === 'HUMAN_AGENT' ? <><User className="h-3 w-3" aria-hidden />{m.authorName ?? t('sales.msg.team')}</> : m.author === 'SYSTEM' ? t('sales.msg.system') : t('sales.msg.customer')}
                    <span className="font-normal normal-case">{fmt(m.createdAt)}</span>
                    {m.ai?.flagged && <span className="rounded bg-red-500/15 px-1 normal-case text-red-700 dark:text-red-300" data-testid="flagged">{t('sales.msg.flagged')}</span>}
                    {m.ai?.edited && <span className="normal-case">{t('sales.msg.edited')}</span>}
                  </p>
                  {editing?.id === m.id ? <Textarea value={editing.body} onChange={(e) => setEditing({ id: m.id, body: e.target.value })} rows={3} aria-label={t('sales.msg.edit')} data-testid="draft-edit" /> : <p className="whitespace-pre-wrap break-words" dir="auto">{m.body}</p>}
                  {m.injectionFlags.length > 0 && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400" data-testid="injection-flag">{t('sales.msg.injection')}</p>}
                  {m.ai && m.ai.kind !== 'handoff' && <p className="mt-1 text-xs text-muted-foreground" data-testid="ai-details">{m.ai.confidence && t('sales.msg.confidence', { level: t(`sales.confidence.${m.ai.confidence}`) })}{m.ai.sources.length > 0 && ` · ${t('sales.msg.sources', { count: m.ai.sources.length })}`}</p>}
                  {m.ai && <Cards cards={m.ai.cards} locale={locale} />}
                  {canReply && !c.isTest && (m.author === 'AI_REPLY' || m.author === 'AI_SUGGESTION') && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {draft && (editing?.id === m.id
                        ? <Button size="sm" onClick={() => void run('approve', `/messages/${m.id}/approve`, { body: editing.body }).then(() => setEditing(null))} disabled={busy !== null || !editing.body.trim()} data-testid="approve-edited"><Check className="h-4 w-4" aria-hidden />{t('sales.actions.approveSend')}</Button>
                        : <>
                          <Button size="sm" onClick={() => void run('approve', `/messages/${m.id}/approve`)} disabled={busy !== null} data-testid="approve"><Check className="h-4 w-4" aria-hidden />{t('sales.actions.approveSend')}</Button>
                          <Button size="sm" variant="outline" onClick={() => setEditing({ id: m.id, body: m.body })} data-testid="edit-draft">{t('sales.actions.edit')}</Button>
                          <Button size="sm" variant="ghost" onClick={() => void run('reject', `/messages/${m.id}/reject`)} disabled={busy !== null} data-testid="reject"><X className="h-4 w-4" aria-hidden />{t('sales.actions.reject')}</Button>
                        </>)}
                      {!m.ai?.flagged && <Button size="sm" variant="ghost" onClick={() => setReport(m)} data-testid="report-inaccurate"><Flag className="h-4 w-4" aria-hidden />{t('sales.actions.reportInaccurate')}</Button>}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
        {canReply && !c.isTest && (
          <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); void sendReply(); }} data-testid="reply-form">
            <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={2000} placeholder={human ? t('sales.reply.placeholder') : t('sales.reply.placeholderTakeover')} aria-label={t('sales.reply.label')} data-testid="reply-input" />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={busy !== null || !text.trim()} data-testid="send-reply">{busy === 'reply' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}{t('sales.reply.send')}</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => void run('suggest', `/conversations/${id}/suggest`)} disabled={busy !== null} data-testid="suggest">{busy === 'suggest' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}{t('sales.actions.suggest')}</Button>
              {!human && <span className="self-center text-xs text-muted-foreground">{t('sales.reply.takesOver')}</span>}
            </div>
          </form>
        )}
        {d.customer && (
          <details className="rounded-lg border p-3" data-testid="customer-panel">
            <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium"><StickyNote className="h-4 w-4" aria-hidden />{t('sales.customerPanel')}</summary>
            <dl className="mt-3 grid gap-1 text-sm sm:grid-cols-2">
              <div><dt className="text-xs text-muted-foreground">{t('sales.fields.email')}</dt><dd>{d.customer.email ?? '—'}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{t('sales.fields.phone')}</dt><dd>{d.customer.phone ?? '—'}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{t('sales.fields.consent')}</dt><dd>{d.customer.consent ? t('sales.yes') : t('sales.no')}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{t('sales.fields.language')}</dt><dd>{flag(d.customer.language)}</dd></div>
            </dl>
            <h3 className="mt-4 text-sm font-medium">{t('sales.notes.title')}</h3>
            <p className="text-xs text-muted-foreground">{t('sales.notes.hint')}</p>
            <ul className="mt-2 grid gap-2" data-testid="notes">{d.notes.map((n) => <li key={n.id} className="rounded-md bg-muted/50 px-3 py-2 text-sm" data-testid="note">{n.body}<span className="block text-xs text-muted-foreground">{n.authorName ?? ''} · {fmt(n.createdAt)}</span></li>)}</ul>
            {canReply && <div className="mt-2 flex gap-2"><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder={t('sales.notes.placeholder')} aria-label={t('sales.notes.placeholder')} data-testid="note-input" /><Button size="sm" onClick={() => void addNote()} disabled={!note.trim() || busy !== null} data-testid="note-add">{t('sales.notes.add')}</Button></div>}
          </details>
        )}
        <Dialog open={report !== null} onClose={() => setReport(null)} title={t('sales.report.title')} description={t('sales.report.text')} closeLabel={t('common.close')}>
          <div className="grid gap-3" data-testid="report-dialog">
            <label className="grid gap-1 text-sm">{t('sales.report.what')}<Textarea value={rep.note} onChange={(e) => setRep({ ...rep, note: e.target.value })} rows={2} maxLength={1000} data-testid="report-note" /></label>
            <label className="grid gap-1 text-sm">{t('sales.report.correct')}<Textarea value={rep.correction} onChange={(e) => setRep({ ...rep, correction: e.target.value })} rows={3} maxLength={2000} data-testid="report-correction" /></label>
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={rep.addToKnowledge} onChange={(e) => setRep({ ...rep, addToKnowledge: e.target.checked })} data-testid="report-knowledge" /><span>{t('sales.report.addKnowledge')}<span className="block text-xs text-muted-foreground">{t('sales.report.addKnowledgeHint')}</span></span></label>
            <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setReport(null)}>{t('common.cancel')}</Button><Button onClick={() => void sendReport()} disabled={rep.note.trim().length < 3 || (rep.addToKnowledge && !rep.correction.trim()) || busy === 'report'} data-testid="report-send">{t('sales.report.send')}</Button></div>
          </div>
        </Dialog>
        {d.feedback.some((f) => f.status === 'OPEN') && <p className="text-xs text-muted-foreground" data-testid="feedback-open">{t('sales.report.open', { count: d.feedback.filter((f) => f.status === 'OPEN').length })}</p>}
      </CardContent>
    </Card>
  );
}
