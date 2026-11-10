'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { canManageRole, BUSINESS_ROLES, type BusinessRole } from '@touma/shared';
import { useAuth } from '@/components/auth-provider';
import { BusinessForm, initialValues } from '@/components/business-form';
import { useBusiness, type Business } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { api, ApiError } from '@/lib/api-client';
import { MediaPicker } from '@/components/media/media-picker';

interface Member {
  id: string;
  role: BusinessRole;
  status: string;
  user: { id: string; fullName: string; email: string };
}

export function BusinessSettings() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { active, can, upsert, reload } = useBusiness();
  const router = useRouter();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [pickLogo, setPickLogo] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);

  const businessId = active?.id;
  const loadMembers = useCallback(async () => {
    if (!businessId) return;
    setMembers(await api<Member[]>(`/businesses/${businessId}/members`));
  }, [businessId]);

  useEffect(() => {
    setConfirm('');
    void loadMembers().catch(() => setMemberError(t('common.loadError')));
  }, [loadMembers, t]);

  if (!active) return null;
  const canEdit = can('business.update');
  const canManage = can('members.manage');
  const showError = (err: unknown) => setMemberError(err instanceof ApiError ? err.message : t('auth.errors.UNKNOWN'));

  async function changeRole(m: Member, role: string) {
    setMemberError(null);
    try {
      setMembers(await api<Member[]>(`/businesses/${active!.id}/members/${m.id}`, { method: 'PATCH', json: { role } }));
    } catch (err) {
      showError(err);
    }
  }

  async function removeMember(m: Member) {
    setMemberError(null);
    try {
      await api(`/businesses/${active!.id}/members/${m.id}`, { method: 'DELETE' });
      if (m.user.id === user?.id) {
        await reload();
        router.replace('/dashboard');
      } else await loadMembers();
    } catch (err) {
      showError(err);
    }
  }

  async function deleteBusiness() {
    setDeleteError(null);
    setDeleting(true);
    try {
      await api(`/businesses/${active!.id}`, { method: 'DELETE', json: { confirmName: confirm } });
      await reload();
      router.replace('/dashboard/businesses');
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : t('auth.errors.UNKNOWN'));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="mx-auto grid max-w-4xl gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t('settings.businessTitle')}</h1>
        <p className="mt-1 text-muted-foreground">{t('settings.businessSubtitle', { name: active.name })}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('business.logo')}</CardTitle>
          <CardDescription>{t('business.logoHint')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-4">
          <div className="grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-xl border bg-muted text-2xl font-bold text-muted-foreground" data-testid="business-logo">
            {active.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={active.logoUrl} alt={t('business.logoAlt', { name: active.name })} className="h-full w-full object-cover" />
            ) : (
              active.name.slice(0, 1).toUpperCase()
            )}
          </div>
          {canEdit && (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setPickLogo(true)}>
                {active.logoUrl ? t('business.changeLogo') : t('business.uploadLogo')}
              </Button>
              {active.logoUrl && (
                <Button
                  variant="ghost"
                  onClick={async () => {
                    setLogoError(null);
                    try {
                      upsert(await api<Business>(`/businesses/${active.id}`, { method: 'PATCH', json: { logoMediaId: null } }));
                    } catch (err) {
                      setLogoError(err instanceof ApiError ? err.message : t('auth.errors.UNKNOWN'));
                    }
                  }}
                >
                  {t('business.removeLogo')}
                </Button>
              )}
            </div>
          )}
          {logoError && <p role="alert" className="w-full text-sm text-destructive">{logoError}</p>}
        </CardContent>
      </Card>
      {pickLogo && (
        <MediaPicker
          open
          onClose={() => setPickLogo(false)}
          businessId={active.id}
          type="IMAGE"
          multiple={false}
          onSelect={async ([m]) => {
            if (!m) return;
            setLogoError(null);
            try {
              upsert(await api<Business>(`/businesses/${active.id}`, { method: 'PATCH', json: { logoMediaId: m.id } }));
            } catch (err) {
              setLogoError(err instanceof ApiError ? err.message : t('auth.errors.UNKNOWN'));
            }
          }}
        />
      )}

      <Card>
        <CardContent className="pt-6">
          {!canEdit && (
            <p className="mb-6 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground" data-testid="read-only-notice">
              {t('settings.readOnly', { role: t(`business.roles.${active.role}`) })}
            </p>
          )}
          <BusinessForm
            key={active.id}
            initial={initialValues(active)}
            submitLabel={t('common.save')}
            readOnly={!canEdit}
            onSubmit={async (values) => {
              upsert(await api<Business>(`/businesses/${active.id}`, { method: 'PATCH', json: values }));
            }}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.members')}</CardTitle>
          <CardDescription>{t('settings.membersHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          {memberError && (
            <p role="alert" className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {memberError}
            </p>
          )}
          <ul className="divide-y" data-testid="members">
            {members?.map((m) => {
              const self = m.user.id === user?.id;
              const manageable = canManage && !self && canManageRole(active.role, m.role);
              return (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {m.user.fullName} {self && <span className="text-muted-foreground">({t('settings.you')})</span>}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">{m.user.email}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {manageable ? (
                      <Select
                        aria-label={`${t('settings.changeRole')}: ${m.user.fullName}`}
                        value={m.role}
                        onChange={(e) => changeRole(m, e.target.value)}
                        className="h-9 w-36"
                      >
                        {BUSINESS_ROLES.filter((r) => canManageRole(active.role, r)).map((r) => (
                          <option key={r} value={r}>
                            {t(`business.roles.${r}`)}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <Badge variant="muted">{t(`business.roles.${m.role}`)}</Badge>
                    )}
                    {(manageable || self) && (
                      <Button variant="ghost" size="sm" onClick={() => removeMember(m)}>
                        {self ? t('settings.leave') : t('settings.remove')}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      {can('business.delete') && (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-destructive">{t('settings.danger')}</CardTitle>
            <CardDescription>{t('settings.deleteHint')}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:max-w-md">
            <Field id="confirm-delete" label={`${t('settings.deleteConfirmLabel')}: ${active.name}`} error={deleteError ?? undefined}>
              <Input id="confirm-delete" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
            </Field>
            <Button
              className="bg-destructive text-white hover:bg-destructive/90 sm:w-fit"
              disabled={confirm !== active.name || deleting}
              onClick={deleteBusiness}
            >
              {t('settings.deleteButton')}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
