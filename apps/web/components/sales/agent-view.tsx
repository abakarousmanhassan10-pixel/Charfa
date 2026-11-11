'use client';
import { useEffect, useState } from 'react';
import { Bot, Copy, ExternalLink, Loader2, Send } from 'lucide-react';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ErrorState, LoadingRows } from '@/components/ui/states';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError } from '@/lib/api-client';
import { useResource } from '@/lib/use-resource';
import { cn } from '@/lib/utils';
import { LANGS, type AgentConfig, type ConversationDetail } from './types';

function Config() {
  const { t } = useI18n();
  const { active, can } = useBusiness();
  const res = useResource<AgentConfig>('/sales/agent', active?.id);
  const [f, setF] = useState<AgentConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmAuto, setConfirmAuto] = useState(false);
  const [origin, setOrigin] = useState('');
  useEffect(() => { if (res.data) setF(res.data); }, [res.data]);
  useEffect(() => setOrigin(window.location.origin), []);
  const edit = can('business.update');
  if (res.loading && !f) return <LoadingRows rows={4} label={t('common.loading')} />;
  if (res.error && !f) return <ErrorState message={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => void res.reload()} />;
  if (!f || !active) return null;

  async function save(next: AgentConfig) {
    if (!active) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const saved = await api<AgentConfig>('/sales/agent', { method: 'PUT', json: { enabled: next.enabled, name: next.name, languages: next.languages, defaultLanguage: next.defaultLanguage, tone: next.tone ?? null, greeting: next.greeting ?? null, replyMode: next.replyMode, maxAiRepliesPerConversation: next.maxAiRepliesPerConversation, autoMinConfidence: next.autoMinConfidence, privacyNoticeUrl: next.privacyNoticeUrl || null, retentionDays: next.retentionDays }, businessId: active.id });
      setF(saved);
      setMessage(t('sales.agent.saved'));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('common.loadError'));
    } finally {
      setBusy(false);
    }
  }
  const toggleLang = (l: string) => setF({ ...f, languages: f.languages.includes(l) ? f.languages.filter((x) => x !== l) : [...f.languages, l] });
  const link = `${origin}/chat/${active.slug}`;
  return (
    <Card data-testid="agent-config">
      <CardHeader><CardTitle>{t('sales.agent.configTitle')}</CardTitle></CardHeader>
      <CardContent>
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); if (f.replyMode === 'AUTO' && !f.autoReplyAuthorizedAt) setConfirmAuto(true); else void save(f); }}>
          {error && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="agent-error">{error}</p>}
          {message && <p role="status" className="rounded-md bg-emerald-500/10 px-3 py-2 text-sm" data-testid="agent-message">{message}</p>}
          <label className="flex items-start gap-3 rounded-lg border p-3 text-sm">
            <input type="checkbox" className="mt-1" checked={f.enabled} disabled={!edit} onChange={(e) => setF({ ...f, enabled: e.target.checked })} data-testid="agent-enabled" />
            <span><span className="font-medium">{t('sales.agent.enabled')}</span><span className="block text-xs text-muted-foreground">{t('sales.agent.enabledHint')}</span></span>
          </label>
          <label className="grid gap-1 text-sm">{t('sales.agent.name')}<Input value={f.name} disabled={!edit} maxLength={60} onChange={(e) => setF({ ...f, name: e.target.value })} data-testid="agent-name" /></label>
          <fieldset className="grid gap-2"><legend className="text-sm font-medium">{t('sales.agent.languages')}</legend>
            <div className="flex flex-wrap gap-3">{LANGS.map((l) => <label key={l} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.languages.includes(l)} disabled={!edit} onChange={() => toggleLang(l)} data-testid={`agent-lang-${l}`} />{t(`sales.languages.${l}`)}</label>)}</div>
            <p className="text-xs text-muted-foreground">{t('sales.agent.languagesHint')}</p>
          </fieldset>
          <label className="grid gap-1 text-sm">{t('sales.agent.defaultLanguage')}<Select value={f.defaultLanguage} disabled={!edit} onChange={(e) => setF({ ...f, defaultLanguage: e.target.value })} data-testid="agent-default-language">{LANGS.filter((l) => f.languages.includes(l)).map((l) => <option key={l} value={l}>{t(`sales.languages.${l}`)}</option>)}</Select></label>
          <label className="grid gap-1 text-sm">{t('sales.agent.tone')}<Input value={f.tone ?? ''} disabled={!edit} maxLength={200} onChange={(e) => setF({ ...f, tone: e.target.value })} placeholder={t('sales.agent.tonePlaceholder')} data-testid="agent-tone" /></label>
          <label className="grid gap-1 text-sm">{t('sales.agent.greeting')}<Textarea value={f.greeting ?? ''} disabled={!edit} rows={2} maxLength={500} onChange={(e) => setF({ ...f, greeting: e.target.value })} placeholder={t('sales.agent.greetingPlaceholder')} data-testid="agent-greeting" /></label>
          <fieldset className="grid gap-2"><legend className="text-sm font-medium">{t('sales.agent.replyMode')}</legend>
            {(['REVIEW', 'AUTO'] as const).map((m) => (
              <label key={m} className="flex items-start gap-2 rounded-lg border p-3 text-sm"><input type="radio" name="replyMode" className="mt-1" checked={f.replyMode === m} disabled={!edit} onChange={() => setF({ ...f, replyMode: m })} data-testid={`agent-mode-${m}`} /><span><span className="font-medium">{t(`sales.agent.modes.${m}.title`)}</span><span className="block text-xs text-muted-foreground">{t(`sales.agent.modes.${m}.text`)}</span></span></label>
            ))}
            {f.autoReplyAuthorizedAt && f.replyMode === 'AUTO' && <p className="text-xs text-muted-foreground" data-testid="agent-authorized">{t('sales.agent.authorizedAt', { when: new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(f.autoReplyAuthorizedAt)) })}</p>}
          </fieldset>
          {f.replyMode === 'AUTO' && (
            <label className="grid gap-1 text-sm sm:max-w-md">{t('sales.agent.minConfidence')}
              <Select value={f.autoMinConfidence} disabled={!edit} onChange={(e) => setF({ ...f, autoMinConfidence: e.target.value as 'HIGH' | 'MEDIUM' })} data-testid="agent-min-confidence"><option value="HIGH">{t('sales.agent.minConfidenceHigh')}</option><option value="MEDIUM">{t('sales.agent.minConfidenceMedium')}</option></Select>
              <span className="text-xs text-muted-foreground">{t('sales.agent.minConfidenceHint')}</span>
            </label>
          )}
          <label className="grid gap-1 text-sm sm:max-w-xs">{t('sales.agent.maxReplies')}<Input type="number" min={1} max={200} value={f.maxAiRepliesPerConversation} disabled={!edit} onChange={(e) => setF({ ...f, maxAiRepliesPerConversation: Number(e.target.value) })} data-testid="agent-max-replies" /><span className="text-xs text-muted-foreground">{t('sales.agent.maxRepliesHint')}</span></label>
          <fieldset className="grid gap-3 rounded-lg border p-3"><legend className="px-1 text-sm font-medium">{t('sales.agent.privacy')}</legend>
            <label className="grid gap-1 text-sm">{t('sales.agent.privacyUrl')}<Input type="url" value={f.privacyNoticeUrl ?? ''} disabled={!edit} maxLength={500} onChange={(e) => setF({ ...f, privacyNoticeUrl: e.target.value })} placeholder="https://" data-testid="agent-privacy-url" /><span className="text-xs text-muted-foreground">{t('sales.agent.privacyUrlHint')}</span></label>
            <label className="grid gap-1 text-sm sm:max-w-xs">{t('sales.agent.retention')}<Input type="number" min={30} max={1825} value={f.retentionDays} disabled={!edit} onChange={(e) => setF({ ...f, retentionDays: Number(e.target.value) })} data-testid="agent-retention" /><span className="text-xs text-muted-foreground">{t('sales.agent.retentionHint')}</span></label>
          </fieldset>
          <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">{t('sales.agent.safetyNote')}</p>
          {edit ? <div><Button type="submit" disabled={busy || f.languages.length === 0} data-testid="agent-save">{busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}{t('sales.agent.save')}</Button></div> : <p className="text-sm text-muted-foreground">{t('sales.agent.readOnly')}</p>}
        </form>
        {f.enabled && (
          <div className="mt-6 rounded-lg border p-3" data-testid="agent-link">
            <p className="text-sm font-medium">{t('sales.agent.publicLink')}</p>
            <p className="text-xs text-muted-foreground">{t('sales.agent.publicLinkHint')}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2"><code className="break-all rounded bg-muted px-2 py-1 text-xs">{link}</code><Button size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(link)}><Copy className="h-4 w-4" aria-hidden />{t('sales.agent.copy')}</Button><Button size="sm" variant="outline" asChild><a href={link} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-4 w-4" aria-hidden />{t('sales.agent.open')}</a></Button></div>
          </div>
        )}
        <Dialog open={confirmAuto} onClose={() => setConfirmAuto(false)} title={t('sales.agent.autoTitle')} description={t('sales.agent.autoText')} closeLabel={t('common.close')}>
          <div className="grid gap-3" data-testid="auto-dialog">
            <p className="text-sm">{t('sales.agent.autoDetails')}</p>
            <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setConfirmAuto(false)}>{t('common.cancel')}</Button><Button onClick={() => { setConfirmAuto(false); void save(f); }} data-testid="auto-confirm">{t('sales.agent.autoConfirm')}</Button></div>
          </div>
        </Dialog>
      </CardContent>
    </Card>
  );
}

/** Try the agent exactly as a customer would. Test conversations are never counted and nothing is sent anywhere. */
function Playground() {
  const { t } = useI18n();
  const { active, can } = useBusiness();
  const [convId, setConvId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function send() {
    const message = text.trim();
    if (!message || !active) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<ConversationDetail>('/sales/playground', { method: 'POST', json: { message, ...(convId ? { conversationId: convId } : {}) }, businessId: active.id });
      setDetail(res);
      setConvId(res.conversation.id);
      setText('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('common.loadError'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card data-testid="playground">
      <CardHeader><CardTitle className="flex items-center gap-2"><Bot className="h-5 w-5" aria-hidden />{t('sales.playground.title')}</CardTitle></CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-sm text-muted-foreground">{t('sales.playground.hint')}</p>
        <ol className="grid min-h-40 max-h-[50vh] gap-2 overflow-y-auto rounded-lg bg-muted/30 p-3" aria-label={t('sales.thread')} data-testid="playground-thread">
          {(detail?.messages ?? []).map((m) => (
            <li key={m.id} className={cn('flex', m.direction === 'OUTBOUND' ? 'justify-start' : 'justify-end')} data-testid="playground-message" data-author={m.author}>
              <div className={cn('max-w-[85%] rounded-2xl px-3 py-2 text-sm', m.direction === 'INBOUND' ? 'bg-primary text-primary-foreground' : m.author === 'SYSTEM' ? 'bg-muted italic' : 'border bg-background')}>
                <p className="whitespace-pre-wrap break-words" dir="auto">{m.body}</p>
                {m.ai && m.ai.kind !== 'handoff' && <p className="mt-1 text-[11px] opacity-70" data-testid="playground-details">{m.ai.confidence && t('sales.msg.confidence', { level: t(`sales.confidence.${m.ai.confidence}`) })}{m.ai.sources.length > 0 && ` · ${t('sales.msg.sources', { count: m.ai.sources.length })}`}</p>}
                {m.ai?.cards.map((c) => <p key={c.id} className="mt-1 text-[11px] opacity-80" data-testid="playground-card">{c.name} · {c.discountPrice ?? c.price ?? t('sales.priceOnRequest')} {c.currency}</p>)}
              </div>
            </li>
          ))}
        </ol>
        {error && <p role="alert" className="text-sm text-destructive" data-testid="playground-error">{error}</p>}
        {can('ai.use') ? (
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
            <Input value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} placeholder={t('sales.playground.placeholder')} aria-label={t('sales.playground.placeholder')} data-testid="playground-input" />
            <Button type="submit" disabled={busy || !text.trim()} data-testid="playground-send">{busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}<span className="sr-only sm:not-sr-only">{t('sales.reply.send')}</span></Button>
            {detail && <Button type="button" variant="ghost" onClick={() => { setConvId(null); setDetail(null); }} data-testid="playground-reset">{t('sales.playground.reset')}</Button>}
          </form>
        ) : <p className="text-sm text-muted-foreground">{t('sales.agent.readOnly')}</p>}
      </CardContent>
    </Card>
  );
}

export function AgentView() {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Config />
      <Playground />
    </div>
  );
}
