'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { Bot, Loader2, Send, ShieldCheck, User } from 'lucide-react';
import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface Info { businessName: string; agentName: string; languages: string[]; defaultLanguage: string; greeting: string; disclosure: Record<string, string>; replyMode: 'REVIEW' | 'AUTO'; privacy: { retentionDays: number; url: string | null; notice: Record<string, string> }; captcha: { provider: 'turnstile'; siteKey: string } | null }
declare global { interface Window { turnstile?: { render: (el: HTMLElement, o: { sitekey: string; callback: (token: string) => void; 'expired-callback'?: () => void }) => string; reset: (id?: string) => void } } }
interface PublicMessage { id: string; role: 'customer' | 'assistant' | 'team' | 'system'; text: string; at: string; cards: Array<{ name?: string; price?: string | null; discountPrice?: string | null; currency?: string | null; availability?: string | null; url?: string | null }> }
interface ChatState { messages: PublicMessage[]; aiMode: 'AI' | 'TEAM' | 'WAITING_FOR_TEAM'; token?: string | null; assist?: { handoffOffered: boolean; followUpConsent: boolean } }

/** The customer-facing chat of a shop. No account: the conversation is held by a secret kept in this browser. */
export default function ChatPage() {
  const { t, locale } = useI18n();
  const { slug } = useParams<{ slug: string }>();
  const key = `touma-chat-${slug}`;
  const [info, setInfo] = useState<Info | null>(null);
  const [missing, setMissing] = useState(false);
  const [state, setState] = useState<ChatState>({ messages: [], aiMode: 'AI' });
  const [token, setToken] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contact, setContact] = useState({ name: '', email: '', phone: '', consent: false });
  const [trap, setTrap] = useState('');
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const captchaBox = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try { setToken(localStorage.getItem(key)); } catch { /* storage unavailable: the chat still works for this visit */ }
    void fetch(`/api/v1/public/chat/${slug}`).then(async (r) => { if (!r.ok) setMissing(true); else setInfo(await r.json()); }).catch(() => setMissing(true));
  }, [slug, key]);

  // Bot protection (only when the server enables it): the challenge is shown until the conversation has started.
  useEffect(() => {
    if (!info?.captcha || token || !captchaBox.current) return;
    const render = () => { if (window.turnstile && captchaBox.current && !captchaBox.current.hasChildNodes()) window.turnstile.render(captchaBox.current, { sitekey: info.captcha!.siteKey, callback: setCaptchaToken, 'expired-callback': () => setCaptchaToken(null) }); };
    if (window.turnstile) return render();
    const el = document.createElement('script');
    el.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    el.async = true;
    el.onload = render;
    document.head.appendChild(el);
  }, [info, token]);

  const poll = useCallback(async () => {
    if (!token) return;
    const r = await fetch(`/api/v1/public/chat/${slug}/messages?token=${encodeURIComponent(token)}`).catch(() => null);
    if (r?.ok) setState(await r.json());
    else if (r?.status === 404) { try { localStorage.removeItem(key); } catch { /* ignore */ } setToken(null); setState({ messages: [], aiMode: 'AI' }); }
  }, [slug, token, key]);
  useEffect(() => { void poll(); const id = setInterval(() => void poll(), 5000); return () => clearInterval(id); }, [poll]);
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }); }, [state.messages.length]);

  async function send() {
    const message = text.trim();
    if (!message) return;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { message, ...(token ? { token } : {}) };
      if (contact.consent) Object.assign(body, { consent: true, ...(contact.email ? { email: contact.email } : {}), ...(contact.phone ? { phone: contact.phone } : {}) });
      if (contact.name) body.name = contact.name;
      if (trap) body.website = trap; // honeypot: filled only by bots
      if (!token && captchaToken) body.captchaToken = captchaToken;
      const r = await fetch(`/api/v1/public/chat/${slug}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) { setError(r.status === 429 || json.code === 'CAPTCHA_REQUIRED' ? (json.message ?? t('sales.chat.tooMany')) : t('sales.chat.error')); return; }
      if (json.token) { try { localStorage.setItem(key, json.token); } catch { /* ignore */ } setToken(json.token); }
      setState(json);
      setText('');
    } catch {
      setError(t('sales.chat.error'));
    } finally {
      setBusy(false);
    }
  }
  async function erase() {
    if (!token) return;
    await fetch(`/api/v1/public/chat/${slug}/data?token=${encodeURIComponent(token)}`, { method: 'DELETE' }).catch(() => null);
    try { localStorage.removeItem(key); } catch { /* ignore */ }
    setToken(null);
    setState({ messages: [], aiMode: 'AI' });
  }

  async function askForPerson() {
    if (!token) return;
    setError(null);
    const r = await fetch(`/api/v1/public/chat/${slug}/handoff`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) }).catch(() => null);
    if (r?.ok) setState(await r.json()); else setError(t('sales.chat.error'));
  }
  async function setFollowUp(granted: boolean) {
    if (!token) return;
    const r = await fetch(`/api/v1/public/chat/${slug}/follow-up-consent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, granted }) }).catch(() => null);
    if (r?.ok) setState((s) => ({ ...s, assist: { handoffOffered: s.assist?.handoffOffered ?? false, followUpConsent: granted } })); else setError(t('sales.chat.error'));
  }

  if (missing) return <main className="grid min-h-screen place-items-center p-6 text-center" data-testid="chat-unavailable"><div><h1 className="text-xl font-semibold">{t('sales.chat.unavailableTitle')}</h1><p className="mt-2 text-muted-foreground">{t('sales.chat.unavailableText')}</p></div></main>;
  if (!info) return <main className="grid min-h-screen place-items-center" aria-busy="true"><Loader2 className="h-6 w-6 animate-spin" aria-label={t('common.loading')} /></main>;
  const disclosure = info.disclosure[locale] ?? info.disclosure[info.defaultLanguage] ?? Object.values(info.disclosure)[0];
  const privacy = info.privacy.notice[locale] ?? info.privacy.notice[info.defaultLanguage] ?? Object.values(info.privacy.notice)[0];
  const money = (v: string | null | undefined, c: string | null | undefined) => (v ? new Intl.NumberFormat(locale, { style: 'currency', currency: c ?? 'USD' }).format(Number(v)) : null);
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col" data-testid="chat-page">
      <header className="border-b px-4 py-3">
        <h1 className="flex items-center gap-2 text-lg font-semibold"><Bot className="h-5 w-5 text-primary" aria-hidden />{info.businessName}</h1>
        <p className="mt-1 flex items-start gap-1.5 text-xs text-muted-foreground" data-testid="chat-disclosure"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />{disclosure}</p>
        <details className="mt-1 text-xs text-muted-foreground" data-testid="chat-privacy"><summary className="cursor-pointer">{t('sales.chat.privacyTitle')}</summary><p className="mt-1" dir="auto">{privacy}</p>{info.privacy.url && <a className="mt-1 inline-block text-primary underline" href={info.privacy.url} target="_blank" rel="noopener noreferrer" data-testid="chat-privacy-link">{t('sales.chat.privacyLink')}</a>}</details>
      </header>
      <ol className="flex-1 space-y-3 overflow-y-auto px-4 py-4" aria-live="polite" aria-label={t('sales.thread')} data-testid="chat-thread">
        <li className="flex justify-start"><div className="max-w-[85%] rounded-2xl border bg-background px-3 py-2 text-sm" data-testid="chat-greeting"><p className="mb-1 text-[11px] font-medium text-muted-foreground">{info.agentName}</p><p dir="auto">{info.greeting}</p></div></li>
        {state.messages.map((m) => (
          <li key={m.id} className={cn('flex', m.role === 'customer' ? 'justify-end' : 'justify-start')} data-testid="chat-message" data-role={m.role}>
            <div className={cn('max-w-[85%] rounded-2xl px-3 py-2 text-sm', m.role === 'customer' ? 'bg-primary text-primary-foreground' : m.role === 'system' ? 'bg-muted italic text-muted-foreground' : 'border bg-background')}>
              {m.role === 'team' && <p className="mb-1 flex items-center gap-1 text-[11px] font-medium text-muted-foreground"><User className="h-3 w-3" aria-hidden />{t('sales.chat.team')}</p>}
              <p className="whitespace-pre-wrap break-words" dir="auto">{m.text}</p>
              {m.cards.length > 0 && <div className="mt-2 grid gap-1.5">{m.cards.map((c, i) => <div key={i} className="rounded-md border bg-muted/40 px-2 py-1 text-xs" data-testid="chat-card"><p className="font-medium">{c.name}</p><p className="text-muted-foreground">{money(c.discountPrice ?? c.price, c.currency) ?? t('sales.priceOnRequest')}{c.url && <> · <a className="text-primary underline" href={c.url} target="_blank" rel="noopener noreferrer">{t('sales.chat.view')}</a></>}</p></div>)}</div>}
            </div>
          </li>
        ))}
        {state.aiMode === 'WAITING_FOR_TEAM' && <li className="text-center text-xs text-muted-foreground" data-testid="chat-waiting">{t('sales.chat.waiting')}</li>}
        <div ref={end} />
      </ol>
      <footer className="border-t px-4 py-3">
        {error && <p role="alert" className="mb-2 text-sm text-destructive" data-testid="chat-error">{error}</p>}
        <details className="mb-2 text-sm" data-testid="chat-contact"><summary className="cursor-pointer text-muted-foreground">{t('sales.chat.contactTitle')}</summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-3"><Input value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} placeholder={t('sales.chat.name')} aria-label={t('sales.chat.name')} maxLength={120} data-testid="chat-name" /><Input type="email" value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} placeholder={t('sales.fields.email')} aria-label={t('sales.fields.email')} data-testid="chat-email" /><Input type="tel" value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} placeholder={t('sales.fields.phone')} aria-label={t('sales.fields.phone')} data-testid="chat-phone" /></div>
          <label className="mt-2 flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5" checked={contact.consent} onChange={(e) => setContact({ ...contact, consent: e.target.checked })} data-testid="chat-consent" />{t('sales.chat.consent')}</label>
        </details>
        {info.captcha && !token && <div ref={captchaBox} className="mb-2" data-testid="chat-captcha" />}
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <input type="text" name="website" value={trap} onChange={(e) => setTrap(e.target.value)} tabIndex={-1} autoComplete="off" aria-hidden="true" className="absolute -start-[9999px] h-0 w-0 opacity-0" data-testid="chat-trap" />
          <Input value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} placeholder={t('sales.chat.placeholder')} aria-label={t('sales.chat.placeholder')} data-testid="chat-input" autoComplete="off" />
          <Button type="submit" disabled={busy || !text.trim() || Boolean(info.captcha && !token && !captchaToken)} data-testid="chat-send">{busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}<span className="sr-only">{t('sales.reply.send')}</span></Button>
        </form>
        {token && state.assist && (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" data-testid="chat-assist">
            {state.assist.handoffOffered && <Button type="button" size="sm" variant="outline" onClick={() => void askForPerson()} data-testid="chat-talk-to-person">{t('sales.chat.talkToPerson')}</Button>}
            <label className="flex items-center gap-2"><input type="checkbox" checked={state.assist.followUpConsent} onChange={(e) => void setFollowUp(e.target.checked)} data-testid="chat-followup-consent" />{t('sales.chat.followUpConsent')}</label>
          </div>
        )}
        {token && <button type="button" className="mt-2 text-xs text-muted-foreground underline" onClick={() => void erase()} data-testid="chat-erase">{t('sales.chat.erase')}</button>}
      </footer>
    </main>
  );
}
