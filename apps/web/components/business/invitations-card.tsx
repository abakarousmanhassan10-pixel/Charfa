'use client';
import { useCallback, useEffect, useState } from 'react';
import { canManageRole, BUSINESS_ROLES, type BusinessRole } from '@touma/shared';
import { useI18n } from '@/components/i18n-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { api, ApiError } from '@/lib/api-client';

interface Invitation {
  id: string;
  email: string;
  role: BusinessRole;
  expiresAt: string;
  sendCount: number;
  invitedBy: string | null;
}

const KNOWN = ['ALREADY_MEMBER', 'EMAIL_NOT_VERIFIED', 'INVITATION_LIMIT', 'RESEND_LIMIT', 'ROLE_HIERARCHY', 'TOO_SOON', 'VALIDATION_ERROR'];

/** Pending invitations; only rendered for members holding `members.manage`. */
export function InvitationsCard({ businessId, myRole }: { businessId: string; myRole: BusinessRole }) {
  const { t, locale } = useI18n();
  const roles = BUSINESS_ROLES.filter((r) => r !== 'OWNER' && canManageRole(myRole, r));
  const [items, setItems] = useState<Invitation[] | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<BusinessRole>(roles.includes('EDITOR') ? 'EDITOR' : (roles[roles.length - 1] ?? 'VIEWER'));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => setItems(await api<Invitation[]>(`/businesses/${businessId}/invitations`)), [businessId]);
  useEffect(() => {
    void load().catch(() => setError(t('common.loadError')));
  }, [load, t]);

  const message = (err: unknown) => {
    const code = err instanceof ApiError ? err.code : 'UNKNOWN';
    return KNOWN.includes(code) ? t(`invite.errors.${code}`) : t('auth.errors.UNKNOWN');
  };

  async function run(fn: () => Promise<unknown>, ok: string) {
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      await fn();
      setNotice(ok);
      await load();
    } catch (err) {
      setError(message(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('invite.cardTitle')}</CardTitle>
        <CardDescription>{t('invite.cardHint')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <form
          className="grid gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () => api(`/businesses/${businessId}/invitations`, { method: 'POST', json: { email, role } }).then(() => setEmail('')),
              t('invite.sent', { email }),
            );
          }}
        >
          <Field id="invite-email" label={t('auth.email')}>
            <Input id="invite-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="off" />
          </Field>
          <Field id="invite-role" label={t('invite.role')}>
            <Select id="invite-role" value={role} onChange={(e) => setRole(e.target.value as BusinessRole)}>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {t(`business.roles.${r}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" disabled={pending || !email}>
            {t('invite.send')}
          </Button>
        </form>
        {error && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="rounded-md bg-emerald-500/10 px-3 py-2 text-sm">
            {notice}
          </p>
        )}
        {items && items.length > 0 && (
          <ul className="divide-y" data-testid="invitations">
            {items.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{i.email}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('invite.expires', { date: new Date(i.expiresAt).toLocaleDateString(locale) })}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="muted">{t(`business.roles.${i.role}`)}</Badge>
                  <Button variant="ghost" size="sm" disabled={pending} onClick={() => run(() => api(`/businesses/${businessId}/invitations/${i.id}/resend`, { method: 'POST' }), t('invite.sent', { email: i.email }))}>
                    {t('invite.resend')}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={pending} onClick={() => run(() => api(`/businesses/${businessId}/invitations/${i.id}`, { method: 'DELETE' }), t('invite.revoked'))}>
                    {t('invite.revoke')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
