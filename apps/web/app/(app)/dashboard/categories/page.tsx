'use client';
import { useState } from 'react';
import { FolderTree, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useBusiness } from '@/components/business-provider';
import type { Category } from '@/components/catalog/types';
import { useI18n } from '@/components/i18n-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, ErrorState, LoadingRows } from '@/components/ui/states';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError } from '@/lib/api-client';
import { useResource } from '@/lib/use-resource';
import { cn } from '@/lib/utils';

type Kind = 'product' | 'service';

export default function CategoriesPage() {
  const { t } = useI18n();
  const { active, can } = useBusiness();
  const [kind, setKind] = useState<Kind>('product');
  const path = kind === 'product' ? '/product-categories' : '/service-categories';
  const cats = useResource<Category[]>(path, active?.id);
  const [editing, setEditing] = useState<Category | 'new' | null>(null);
  const [toDelete, setToDelete] = useState<Category | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  if (!active) return null;
  const canWrite = can('catalog.write');

  const openEditor = (c: Category | 'new') => {
    setEditing(c);
    setName(c === 'new' ? '' : c.name);
    setDescription(c === 'new' ? '' : (c.description ?? ''));
    setError(null);
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError(t('auth.errors.VALIDATION'));
    try {
      const body = { name, description };
      if (editing === 'new') await api(path, { method: 'POST', json: body, businessId: active!.id });
      else if (editing) await api(`${path}/${editing.id}`, { method: 'PATCH', json: body, businessId: active!.id });
      setEditing(null);
      await cats.reload();
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'CATEGORY_EXISTS' ? t('categories.exists') : err instanceof Error ? err.message : t('auth.errors.UNKNOWN'));
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title={t('categories.title')}
        description={t('categories.subtitle')}
        actions={
          canWrite && (
            <>
              <Button
                variant="outline"
                onClick={async () => {
                  const res = await api<{ created: number }>(`${path}/restore-defaults`, { method: 'POST', businessId: active.id });
                  setNotice(t('categories.restored', { count: res.created }));
                  await cats.reload();
                }}
              >
                <RotateCcw className="h-4 w-4" aria-hidden />
                {t('categories.restore')}
              </Button>
              <Button onClick={() => openEditor('new')}>
                <Plus className="h-4 w-4" aria-hidden />
                {t('categories.new')}
              </Button>
            </>
          )
        }
      />
      <div role="tablist" aria-label={t('categories.title')} className="mb-4 inline-flex rounded-lg border bg-muted p-1">
        {(['product', 'service'] as const).map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={kind === k}
            onClick={() => {
              setKind(k);
              setNotice(null);
            }}
            className={cn('rounded-md px-4 py-1.5 text-sm font-medium', kind === k ? 'bg-background shadow-sm' : 'text-muted-foreground')}
          >
            {t(k === 'product' ? 'categories.products' : 'categories.services')}
          </button>
        ))}
      </div>
      {notice && <p role="status" className="mb-4 text-sm text-muted-foreground">{notice}</p>}
      <Card>
        <CardContent className="pt-6" role="tabpanel">
          {cats.error ? (
            <ErrorState message={t('common.loadError')} retryLabel={t('common.retry')} onRetry={cats.reload} />
          ) : cats.loading && !cats.data ? (
            <LoadingRows rows={4} label={t('common.loading')} />
          ) : cats.data?.length === 0 ? (
            <EmptyState icon={FolderTree} title={t('categories.empty')} />
          ) : (
            <ul className="divide-y" data-testid="category-list">
              {cats.data?.map((c) => (
                <li key={c.id} className="flex items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      {c.name}
                      {c.isDefault && <Badge variant="muted">{t('categories.default')}</Badge>}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {t('categories.itemCount', { count: c.itemCount })}
                      {c.description ? ` · ${c.description}` : ''}
                    </p>
                  </div>
                  {canWrite && (
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" onClick={() => openEditor(c)} aria-label={t('common.editItem', { name: c.name })}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => setToDelete(c)} aria-label={t('common.deleteItem', { name: c.name })}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? t('categories.new') : t('categories.edit')} closeLabel={t('common.close')}>
        <form onSubmit={save} className="grid gap-4" noValidate>
          <Field id="category-name" label={t('catalog.fields.name')} error={error ?? undefined}>
            <Input id="category-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required autoFocus aria-invalid={Boolean(error)} />
          </Field>
          <Field id="category-description" label={t('catalog.fields.description')} optional optionalLabel={t('common.optional')}>
            <Textarea id="category-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} rows={2} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setEditing(null)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit">{t('common.save')}</Button>
          </div>
        </form>
      </Dialog>

      <ConfirmDialog
        open={Boolean(toDelete)}
        title={t('categories.deleteTitle')}
        description={t('categories.deleteText', { name: toDelete?.name ?? '', count: toDelete?.itemCount ?? 0 })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        onClose={() => setToDelete(null)}
        onConfirm={async () => {
          await api(`${path}/${toDelete!.id}`, { method: 'DELETE', businessId: active.id });
          await cats.reload();
        }}
      />
    </div>
  );
}
