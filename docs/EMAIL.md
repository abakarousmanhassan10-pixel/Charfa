# Email (SMTP) — architecture, provider choice and domain authentication

Status: prepared for staging, **not tested against any real provider** (no account was created). Facts about providers come from search results of their own pages and blogs, not from reading the pricing pages directly: marked **[verify]** where a price, limit or port must be confirmed before you rely on it.

## 1. What the application sends today
All mail goes through one service, `apps/api/src/email/email.service.ts` (nodemailer, SMTP only: there is no HTTPS-API transport). Messages are built from `packages/shared/src/email-layout.ts` (HTML + plain-text parts, English or French; any other locale falls back to English; the action URL must be http(s)).

| Email | Trigger | Link lifetime | Failure behaviour |
|---|---|---|---|
| Account verification | Sign-up, and "resend" (60 s cooldown) | 24 h, single use | Logged, never blocks sign-up |
| Password reset | "Forgot password" | 30 min, single use | Logged; the response is identical whether the account exists or not |
| Password changed notice | After a reset | none | Logged |
| Team invitation | Owner/admin invites someone (verified inviter only) | 7 days | The invitation is created; resend is possible |

- Tokens travel in the URL fragment (`#token=`), so they never reach server logs or `Referer` headers.
- There are **no e-mail notifications**: in-app notifications are not mailed. There is no marketing or bulk mail, so unsubscribe headers are not needed for these transactional messages.
- Every message carries an `X-Touma-Tag` header. **[not verified]** that each provider passes custom headers through over SMTP; if one rejects it, remove it in `email.service.ts`.
- `EMAIL_TRANSPORT=log` (development) writes the message, links included, to the server log; staging and production validation refuse it.

Covered by tests: `apps/api/test/hardening.e2e-spec.ts` (18 tests; verification, reset, invitations against a real local SMTP server, 18/18 passing in this session) and `apps/api/src/email/email.service.spec.ts` (transport options and timeouts, sender, both body parts, token placement, English/French templates and fallback).

## 2. Problems found and fixed
1. **Stalled provider could hold a request.** Sending happens inside the HTTP request. Nodemailer 7.0.13 defaults to a 1-hour idle-socket timeout, so a provider that accepted the connection and then stalled would keep sign-up or "forgot password" waiting. Fixed: connection, greeting and DNS timeouts of 10 s and a socket timeout of 20 s.
2. **Wrong TLS mode failed obscurely.** Port 465/2465 without `SMTP_SECURE=true`, or 587/2525/2587/25 with it, makes the connection hang or fail. Startup now refuses these combinations, and `SMTP_USER` without `SMTP_PASSWORD` (or the reverse).

Remaining, not changed (behaviour change, needs your decision):
- **Timing side channel on "forgot password".** The e-mail is awaited only when the account exists, so the response is slower for known addresses (by the SMTP round trip). The body is identical, the timing is not. Fix: send in the background (queue) for both cases. Not measured.
- Delivery is synchronous and not retried: a failed send is only logged. A queue with retries (the BullMQ infrastructure exists) would make delivery more reliable.

## 3. Environment variables
| Variable | Value | Notes |
|---|---|---|
| `EMAIL_TRANSPORT` | `smtp` | Set by the Blueprint |
| `SMTP_HOST` | provider host | Per service, `sync: false` |
| `SMTP_PORT` | `587` (STARTTLS) or `465` (implicit TLS) | Blueprint sets 587 |
| `SMTP_SECURE` | `false` with 587/2525/2587; `true` with 465/2465 | Checked at startup |
| `SMTP_USER`, `SMTP_PASSWORD` | provider credentials | Secrets, dashboard only; set together |
| `EMAIL_FROM` | `TOUMA AI <no-reply@mail.yourdomain.com>` | Must use the verified sending domain; `localhost` is refused |
| `WEB_URL` | https URL of the web app | Used to build the links in the messages |

In staging and production TLS is required (`requireTLS`) and certificates are validated.

## 4. Render and ports
Official Render documentation: outbound **port 25 is blocked for every service**, and free web services also block **465 and 587**. The staging services are on paid plans, so **587 (STARTTLS) or 465 (implicit TLS)** work. Other submission ports (2525, 2587, 2465) are not mentioned by Render: **[not verified]**.

## 5. Provider comparison (SMTP is what the code supports)
| | **Resend** | **Brevo** | **Amazon SES** |
|---|---|---|---|
| SMTP host | `smtp.resend.com` | `smtp-relay.brevo.com` | regional `email-smtp.<region>.amazonaws.com` |
| SMTP ports | 25, 465, 587, 2465, 2587 | 587 (recommended), 465, 2525 | 465, 587, 2465, 2587 (25 also exists) |
| SMTP login | user `resend`, password = an API key | user = account login, password = a **SMTP key** (not the API key) | separate SMTP credentials generated in the console, not your IAM keys |
| HTTPS API | yes | yes | yes |
| Free allowance | 3,000/month, 100/day, no overage on free **[verify]** | 300/day (about 9,000/month) **[verify]** | free tier is time-limited **[verify]** |
| First paid step | about $20/month for 50,000 **[verify]** | about $9/month for 5,000 **[verify]** | about $0.10 per 1,000 **[verify]** |
| Setup friction | low: add a domain, copy DNS records | medium: new accounts may need approval before sending | highest: AWS account, sandbox (restricted to verified addresses) until production access is granted **[verify]** |
| Fit | Transactional-only, simple, good for a start | Highest free daily cap, EU company | Cheapest at volume, regional choice |

### Recommendation
**Start with Resend over SMTP (port 587).** It needs no code change, is transactional-only (so your verification and reset mails are not mixed with other senders' marketing traffic), has the simplest domain setup and a free tier far above pilot volume. Be aware of its free-plan cap of 100 e-mails per day with no overage: at the limit, verification mails stop (the sign-up still succeeds and "resend" works the next day), so move to a paid plan before real sign-up campaigns. **Brevo** is the alternative if you want a higher free daily cap (300) or an EU provider; **Amazon SES** is the migration target when volume makes cost matter, and moving to it only means changing the five SMTP variables. Deliverability cannot be compared here: test with your real domain and Gmail, Outlook and Yahoo inboxes.

## 6. SPF, DKIM and DMARC for the sending domain
Use a dedicated subdomain for sending, for example `mail.yourdomain.com`, and set `EMAIL_FROM` to an address on it. Never guess the records: the provider's dashboard shows the exact values for your domain.

1. **DKIM** (signature proving the mail was authorised by the domain): add the DKIM records the provider gives you (CNAME or TXT, usually under a selector like `selector._domainkey.mail.yourdomain.com`). Wait until the dashboard shows "verified".
2. **SPF** (which servers may send for the domain): one TXT record on the sending (sub)domain, for example `v=spf1 include:<provider's include value> ~all`. A domain may have **only one** SPF record: merge includes into it, and stay under 10 DNS lookups. Providers that use their own bounce (return-path) subdomain add their own SPF/MX records for it: copy them as given.
3. **DMARC** (policy and reports): a TXT record at `_dmarc.mail.yourdomain.com` (or `_dmarc.yourdomain.com` to cover everything), starting in monitoring mode: `v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com; adkim=s; aspf=s`. After a few weeks of clean reports (everything passing and aligned), move to `p=quarantine`, then `p=reject`. For DMARC to pass, SPF or DKIM must pass **and align** with the visible From domain, so the From domain must be the domain you verified.
4. **Verify:** `dig TXT mail.yourdomain.com`, `dig TXT _dmarc.mail.yourdomain.com`, then send a real message to a Gmail address and open "Show original": SPF, DKIM and DMARC must all say PASS. Also check the provider's domain status page.
5. Keep reverse DNS and the provider's shared IPs out of your hands: with a shared pool you do not manage IP reputation; a dedicated IP is only worth it at high volume.

## 7. Manual steps (you do these; no secret is ever shared with anyone)
1. Choose the sending domain (a subdomain such as `mail.yourdomain.com`) and confirm you control its DNS.
2. Create the provider account yourself and add the domain; copy the DKIM/SPF records into your DNS; wait for "verified".
3. Add the DMARC record in `p=none` mode with a mailbox you read.
4. Create the SMTP credential (Resend: an API key restricted to sending; Brevo: an SMTP key; SES: SMTP credentials).
5. Enter `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM` in Render (the API and the AI worker; the maintenance worker only needs `SMTP_HOST` and `EMAIL_FROM`). Never in git, chat or screenshots.
6. After the first staging deployment: register with an address you own, check that the verification mail arrives (inbox, not spam), the link works, then test "forgot password", the "password changed" notice and an invitation. Check SPF/DKIM/DMARC PASS in the message headers.
7. Do not send staging mail to real third parties.
