'use client';
import { useEffect, useState } from 'react';
import { BookOpenCheck, CheckCircle2, CircleAlert, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { KNOWLEDGE_CATEGORIES } from '@touma/shared';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Pagination } from '@/components/ui/pagination';
import { SearchInput } from '@/components/ui/search-input';
import { Select } from '@/components/ui/select';
import { EmptyState, ErrorState, LoadingRows } from '@/components/ui/states';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError } from '@/lib/api-client';
import { qs, useDebounced, useResource, type Paged } from '@/lib/use-resource';

interface Entry {
  id: string;
  category: string;
  title: string;
  body: string;
  verified: boolean;
  verifiedAt: string | null;
  verifiedBy: { id: string; fullName: string } | null;
  updatedAt: string;
}
interface Context {
  products: unknown[];
  services: unknown[];
  knowledge: unknown[];
  missingInformation: string[];
}

export default function KnowledgePage() {
  const { t } = useI18n();
  const { active, can } = useBusiness();
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [verified, setVerified] = useState('');
  const [page, setPage] = useState(1);
  const dq = useDebounced(q);
  useEffect(() => setPage(1), [dq, category, verified, active?.id]);
  const list = useResource<Paged<Entry>>(`/business-knowledge${qs({ q: dq, category, verified, page, pageSize: 10 })}`, active?.id);
  const ctx = useResource<Context>('/business-knowledge/context', active?.id);
  const [editing, setEditing] = useState<Entry | 'new' | null>(null);
  const [form, setForm] = useState({ category: 'FAQ', title: '', body: '' });
  const [error, setError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<Entry | null>(null);
  if (!active) return null;
  const canWrite = can('knowledge.write');
  const canVerify = can('knowledge.verify');
  const refresh = () => Promise.all([list.reload(), ctx.reload()]);

  const openEditor = (e: Entry | 'new') => {
    setEditing(e);
    setForm(e === 'new' ? { category: category || 'FAQ', title: '', body: '' } : { category: e.category, title: e.title, body: e.body });
    setError(null);
  };

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={t('knowledge.title')}
        description={t('knowledge.subtitle')}
        actions={
          canWrite && (
            <Button onClick={() => openEditor('new')}>
              <Plus className="h-4 w-4" aria-hidden />
              {t('knowledge.new')}
            </Button>
          )
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardContent className="pt-6">
            <div className="mb-4 grid gap-3 sm:flex">
              <SearchInput value={q} onChange={setQ} label={t('knowledge.search')} />
              <Select aria-label={t('knowledge.category')} value={category} onChange={(e) => setCategory(e.target.value)} className="sm:w-48">
                <option value="">{t('knowledge.allCategories')}</option>
                {KNOWLEDGE_CATEGORIES.map((c) => <option key={c} value={c}>{t(`knowledge.categories.${c}`)}</option>)}
              </Select>
              <Select aria-label={t('knowledge.verification')} value={verified} onChange={(e) => setVerified(e.target.value)} className="sm:w-40">
                <option value="">{t('knowledge.allEntries')}</option>
                <option value="true">{t('knowledge.verified')}</option>
                <option value="false">{t('knowledge.pending')}</option>
              </Select>
            </div>
            {list.error ? (
              <ErrorState message={t('common.loadError')} retryLabel={t('common.retry')} onRetry={list.reload} />
            ) : list.loading && !list.data ? (
              <LoadingRows label={t('common.loading')} />
            ) : list.data?.items.length === 0 ? (
              <EmptyState icon={BookOpenCheck} title={t('knowledge.empty')} hint={t('knowledge.emptyHint')} />
            ) : (
              <>
                <ul className="divide-y" data-testid="knowledge-list">
                  {list.data?.items.map((e) => (
                    <li key={e.id} className="py-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="muted">{t(`knowledge.categories.${e.category}`)}</Badge>
                        {e.verified ? (
                          <Badge variant="success">
                            <CheckCircle2 className="me-1 h-3 w-3" aria-hidden />
                            {t('knowledge.verifiedBy', { name: e.verifiedBy?.fullName ?? '' })}
                          </Badge>
                        ) : (
                          <Badge variant="warning">{t('knowledge.pending')}</Badge>
                        )}
                      </div>
                      <p className="mt-2 font-medium">{e.title}</p>
                      <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">{e.body}</p>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {canVerify && (
                          <Button
                            size="sm"
                            variant={e.verified ? 'ghost' : 'outline'}
                            onClick={async () => {
                              await api(`/business-knowledge/${e.id}/${e.verified ? 'unverify' : 'verify'}`, { method: 'POST', businessId: active.id });
                              await refresh();
                            }}
                          >
                            <ShieldCheck className="h-4 w-4" aria-hidden />
                            {e.verified ? t('knowledge.unverify') : t('knowledge.verify')}
                          </Button>
                        )}
                        {canWrite && (
                          <>
                            <Button size="sm" variant="ghost" onClick={() => openEditor(e)} aria-label={t('common.editItem', { name: e.title })}>
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setToDelete(e)} aria-label={t('common.deleteItem', { name: e.title })}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
                {list.data && (
                  <Pagination page={list.data.page} pageCount={list.data.pageCount} total={list.data.total} onPage={setPage} labels={{ previous: t('common.previous'), next: t('common.next'), summary: t('common.resultCount', { count: list.data.total }) }} />
                )}
              </>
            )}
          </CardContent>
        </Card>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle>{t('knowledge.aiTitle')}</CardTitle>
            <CardDescription>{t('knowledge.aiHint')}</CardDescription>
          </CardHeader>
          <CardContent data-testid="ai-context">
            {ctx.data ? (
              <>
                <dl className="grid grid-cols-3 gap-2 text-center">
                  {[
                    [t('knowledge.aiFacts'), ctx.data.knowledge.length],
                    [t('dashboard.nav.products'), ctx.data.products.length],
                    [t('dashboard.nav.services'), ctx.data.services.length],
                  ].map(([k, v]) => (
                    <div key={String(k)} className="rounded-md border p-2">
                      <dd className="text-xl font-semibold tabular-nums">{v}</dd>
                      <dt className="text-xs text-muted-foreground">{k}</dt>
                    </div>
                  ))}
                </dl>
                {ctx.data.missingInformation.length > 0 && (
                  <div className="mt-4">
                    <p className="flex items-center gap-1 text-sm font-medium">
                      <CircleAlert className="h-4 w-4 text-amber-600" aria-hidden />
                      {t('knowledge.missing')}
                    </p>
                    <ul className="mt-2 list-disc space-y-1 ps-5 text-xs text-muted-foreground">
                      {ctx.data.missingInformation.slice(0, 8).map((m) => <li key={m}>{m}</li>)}
                    </ul>
                  </div>
                )}
              </>
            ) : (
              <LoadingRows rows={2} label={t('common.loading')} />
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? t('knowledge.new') : t('knowledge.edit')} description={editing !== 'new' && editing?.verified ? t('knowledge.editResets') : undefined} closeLabel={t('common.close')}>
        <form
          className="grid gap-4"
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            if (form.title.trim().length < 2 || form.body.trim().length < 2) return setError(t('auth.errors.VALIDATION'));
            try {
              if (editing === 'new') await api('/business-knowledge', { method: 'POST', json: form, businessId: active.id });
              else if (editing) await api(`/business-knowledge/${editing.id}`, { method: 'PATCH', json: form, businessId: active.id });
              setEditing(null);
              await refresh();
            } catch (err) {
              setError(err instanceof ApiError ? err.message : t('auth.errors.UNKNOWN'));
            }
          }}
        >
          <Field id="knowledge-category" label={t('knowledge.category')}>
            <Select id="knowledge-category" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {KNOWLEDGE_CATEGORIES.map((c) => <option key={c} value={c}>{t(`knowledge.categories.${c}`)}</option>)}
            </Select>
          </Field>
          <Field id="knowledge-title" label={form.category === 'FAQ' ? t('knowledge.question') : t('knowledge.entryTitle')}>
            <Input id="knowledge-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={200} required />
          </Field>
          <Field id="knowledge-body" label={form.category === 'FAQ' ? t('knowledge.answer') : t('knowledge.content')} hint={t('knowledge.bodyHint')} error={error ?? undefined}>
            <Textarea id="knowledge-body" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} rows={6} maxLength={10000} required />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setEditing(null)}>{t('common.cancel')}</Button>
            <Button type="submit">{t('common.save')}</Button>
          </div>
        </form>
      </Dialog>
      <ConfirmDialog
        open={Boolean(toDelete)}
        title={t('knowledge.deleteTitle')}
        description={t('knowledge.deleteText', { name: toDelete?.title ?? '' })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        onClose={() => setToDelete(null)}
        onConfirm={async () => {
          await api(`/business-knowledge/${toDelete!.id}`, { method: 'DELETE', businessId: active.id });
          await refresh();
        }}
      />
    </div>
  );
}
