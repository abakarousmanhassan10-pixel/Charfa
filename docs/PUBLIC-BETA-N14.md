# Public beta: readiness, security gate and GO / NO-GO (Phase N14)

Evidence: repository code, migrations, documents and local runs on disposable PostgreSQL 16 / Redis 7 (release gate with tests, API e2e, 80 browser tests in Chromium). Nothing was deployed or paid for. Prices come from third-party summaries found by search (Render, Vercel and Cloudflare pages were not reachable from this session): **verify on the providers' pages before buying**.

## 1. Feature classification
| Feature | Class | Evidence |
| --- | --- | --- |
| Registration, e-mail verification, login/logout, password reset, sessions | VERIFIED AND READY | `account.e2e`, `auth.e2e`, API `auth` 26/26 (gate); real SMTP capture in the browser test |
| Businesses, members and roles, tenant isolation | VERIFIED AND READY | `businesses`, `hardening`, `tenant-security`, browser isolation test |
| Catalog (products, services, categories), knowledge base | VERIFIED AND READY | `catalog.e2e`, API suites |
| Media library (upload, scan, signed URLs) | IMPLEMENTED BUT UNTESTED on the real stack | works with memory/MinIO/ClamAV test signatures; R2 and checksum behaviour never run (`storage:check` pending) |
| Content calendar (manual planning, approvals) | VERIFIED AND READY | `calendar`, browser `calendar.e2e`; **publishing unavailable**: no connected platform |
| Notifications, team invitations | VERIFIED AND READY | `account.e2e` (invitation) |
| Workflows (simulated steps + real internal calendar entry) | SIMULATED (steps) / VERIFIED (calendar step) | `calendar-workflow`, `n12-staging`; only the demo workflow is creatable in the UI |
| Market intelligence (manual import, deterministic score) | IMPLEMENTED BUT UNTESTED in the browser (import form) | `market` 15/15 API; browser covers empty state only; no data provider |
| AI sales agent and assistant | IMPLEMENTED BUT UNTESTED with a real model | all tests use the deterministic test provider; needs OpenAI (never validated) |
| AI text/creative generation | BLOCKED | needs `OPENAI_API_KEY` and image/video providers: none validated, pricing table is test data |
| Social publishing | SIMULATED / BLOCKED | fake platform only; no platform approval |
| Operations center (admin) | VERIFIED AND READY for platform admins | `ops` 11/11, browser test |
| Account deletion / data export by the user | INCOMPLETE | none (only business deletion and customer erasure) |
| Terms of service, privacy policy pages | INCOMPLETE | no pages in the web app |
| Error monitoring (Sentry-like) | INCOMPLETE | structured logs only; Operations page covers queues |
| Registration abuse prevention | INCOMPLETE | per-IP throttle only (10/min); no captcha, no allowlist |

## 2. Public security audit
| Area | Result | Evidence |
| --- | --- | --- |
| Auth, lockout, refresh rotation + reuse detection | OK | `auth` suite; `AUTH_THROTTLE_LIMIT` 10/min on register, login, reset, verify |
| Cookies | OK | refresh cookie `httpOnly`, `secure` (production), `sameSite=strict`; tokens never in web storage (browser test) |
| CSRF | OK | `x-touma-csrf` required on refresh/logout; first-party proxy through Next.js |
| CORS, headers | OK | origin allowlist with credentials, `helmet()`, strict CSP |
| XSS | OK | no `dangerouslySetInnerHTML`/`innerHTML` in the web app; React escaping |
| Injection | OK | Prisma only; request validation (class-validator, strict zod); 1 MB JSON body limit |
| Upload validation | OK | magic-byte sniffing (JPEG, PNG, GIF, WebP, MP4), size caps, ClamAV mandatory in production config |
| Tenant isolation, admin restriction | OK | 404 for foreign ids; `/admin/*` needs `SUPER_ADMIN`/`SUPPORT`, role re-read per request; public endpoints frozen by the release gate allowlist |
| Chat token | OK | header only, idle expiry, revocation, never logged (N10, gate rule) |
| Quotas, worker concurrency | OK | atomic per-tenant limits for runs, AI, creative (N10); bounded load check (N13) |
| Secrets | OK | none tracked (gate); production config refuses insecure values |
| Prompt injection, unexpected external actions | OK | agents receive only the tenant's verified context; outward steps always need a human approval; AI never sets a sale; nothing is sent outside TOUMA |
| Dependencies | **FAIL** | 11 high-severity advisories (`pnpm audit --prod`): **sharp** (libvips/libheif/librsvg, RCE class; reachable through uploaded images decoded by sharp: JPEG/PNG/GIF/WebP only, HEIF and SVG are rejected by the sniffer, but libvips advisories also cover the common decoders): upgrade to ≥ 0.35.5; **nodemailer** (4): not reachable as used (no `raw` option, no OAuth2, recipients are validated e-mails, fixed sender) but upgrade to ≥ 10.0.6; **zod** (memory exhaustion on unbounded arrays): bounded by the 1 MB body limit and max-length arrays, upgrade to ≥ 4.6.6; **postcss** (via Next, build time) and **deepmerge-ts** (Prisma CLI) are tooling |
| Account abuse | **GAP** | open registration without captcha or allowlist; e-mail verification is not enforced (no guard checks `emailVerifiedAt`), only a banner |

## 3. Safe public beta scope
**Offer (flags / UI):** accounts and verification, businesses and teams, catalog, media library (only after the real-storage check), knowledge base, content calendar for manual planning and internal approval (publishing shown as unavailable), notifications. Everything else is hidden or off.
| Module | Beta setting |
| --- | --- |
| Workflows, Market | `WORKFLOWS_ENABLED=false`, `ORCHESTRATOR_ENABLED=false`, `MARKET_INTELLIGENCE_ENABLED=false` (default): the navigation now hides them through `GET /features` (N14) |
| AI generation, creative, sales agent | leave `OPENAI_API_KEY` empty: the app reports "not configured" (enable only after approval and a spend cap) |
| Social | no platform credentials: connection stays "not configured" |
| Operations | platform admins only |
Still shown although unavailable: AI, Creative and Social entries (their pages say "not configured"). Hiding them needs the same `features` call (`ai` is already exposed): small follow-up, listed below.

## 4. Reliability
| Item | Status |
| --- | --- |
| Backup + isolated restore | local drill passes (gate); **no managed backup exists yet** |
| Migrations | apply from empty, no drift, forward-recovery tested (N11); destructive-statement rule in the gate |
| Redis/worker recovery | tested: kill -9 with runs in flight, all recovered in about 60 s with no duplicate step (N13); BullMQ on Render Key Value **not verified** |
| Object storage permissions | private bucket + signed URLs by design; R2 **not verified** (`storage:check`) |
| SMTP | startup validation; real send **not verified** (Render allows 587 only on paid services) |
| Health/readiness | tested; the gate probes them when `API_URL` is set |
| Error monitoring | **missing**: rely on logs + Operations page + provider alerts |
| Rollback | redeploy previous image (autodeploy off); forward-only migrations |
| Retention, deletion | sales chat retention automatic; **no user account deletion**: handle by support request within 30 days with a documented SQL procedure (to write and test) |

## 5. Browser E2E (Chromium, local full stack, simulated providers)
Full Playwright run after the N14 build: **80 passed, 0 failed** (2.1 min). Targeted items: registration and e-mail verification (`account.e2e` real SMTP capture), login/logout and protected routes (`auth.e2e`, `n12-staging`), dashboard, workflow with approval and a real calendar entry, tenant isolation including 8 direct requests, mobile navigation at 390 px, error handling (network failure, 500, loading, empty, invalid input, double click), and the new feature-flag navigation test. Not run: Firefox/WebKit, real AI/R2/SMTP.

## 6. Operations package
**Release checklist:** (1) `release-gate.sh --with-tests` green; (2) dependencies upgraded; (3) `storage:check` against R2; (4) backups enabled and a restore drill on a copy; (5) Terms and Privacy published after legal review; (6) support address configured; (7) registration gate decided; (8) smoke tests of `docs/RELEASE-READINESS-N13.md` section 8; (9) cost alerts set; (10) rollback rehearsed.
**Incident response (minimal):** detect (Operations page, `/health/ready`, provider alerts, user reports) → classify (data exposure, outage, bad release, abuse) → contain (disable flag, scale a service to 0, revoke sessions: `logout-all`/DB) → communicate (status message to users within 1 h; regulator/user notification if personal data was exposed, per legal advice) → recover (DISASTER-RECOVERY runbook) → review within 5 days. Never retry an outward action with an unknown outcome.
**Support contact:** add `SUPPORT_EMAIL` (shown in the app footer and in verification/reset e-mails) and a monitored mailbox: **not implemented**.
**Privacy and terms checklist (human/legal review required):** data inventory (accounts, business data, customer chat data, media), legal basis and consent wording for the chat (exists), retention periods (chat: configurable; accounts: to define), processors list (Render, Vercel, Cloudflare, SMTP provider, OpenAI if enabled) with locations, cross-border transfers, user rights (access, export, deletion: deletion/export missing), cookies (one first-party refresh cookie), children, AI disclosure (exists in chat), merchant responsibility for end-customer data, liability and acceptable use, contact and DPO, breach procedure.
**Feature-flag strategy:** every optional module is default-off and enabled per deployment by environment variable on API **and** worker where noted; a flag is turned on only with its tests green and its UI visible via `GET /features`; to roll back a module, switch the flag off (data and code stay).
**Update and rollback:** gate in CI → deploy to staging → smoke tests → production in the order worker, API, web; migrations expand-then-contract and applied from a trusted machine after a dump; rollback = previous image; if a migration misbehaves, forward-fix, restore only for data damage.
**Monitoring thresholds (to configure):** readiness failing 2 consecutive minutes; 5xx rate above 2 % for 5 minutes; worker heartbeat stale above 90 s; any failed-jobs alert from the Operations page (default threshold 10); queue backlog above 100 for 10 minutes; Postgres connections above 70 % of the plan; disk above 80 %; AI spend above 50 %/80 % of the cap; SMTP bounce rate above 5 %.

## 7. Cost (USD/month, third-party summaries, to verify)
| Item | Minimum beta | Notes |
| --- | --- | --- |
| Render API Starter (0.5 CPU, 512 MB) | 7 | web service Starter $7 (several sources agree) |
| Maintenance worker + AI worker | 14 | needed for queues, retention, calendar scheduler |
| ClamAV `1c-2g` + 2 GB disk | 25.5 | mandatory for uploads; Standard $25 |
| PostgreSQL | 6 (Basic-256mb) or 19 (Basic-1gb) | sources disagree ($6–7, $19–20); 1 GB recommended for real users |
| Key Value 256 MB | 10 | Starter $10 (sources agree) |
| Render workspace | 0 (Hobby) or 25 (Pro) | PITR 3 days Hobby / 7 days Pro (from earlier documentation) |
| Vercel | 20 (Pro, one seat) | Hobby is for personal, non-commercial use: a public beta with real users needs Pro |
| Cloudflare R2 | 0–2 | $0.015/GB-month, free tier 10 GB, 1 M writes, 10 M reads, free egress (consistent across sources) |
| SMTP | 0–9 | free tiers (Brevo 300/day), paid from about $9 |
| Domain | about 1–2 | registrar |
| AI (optional) | 0 until approved | cap at 20; token/image prices in the app are **test values** |
| **Total, lean** | **about 105–135** | Postgres 19, Pro workspace optional |
Bandwidth overage on Render is reported at $0.15/GB (unverified). **Caps and safeguards:** monthly budget ceiling 150 including AI; provider-side spend limit on the AI account before the key is created; Render/Cloudflare billing alerts at 50/80/100 %; per-tenant quotas already in the app; stop ClamAV and workers outside test windows only on staging (not on a public beta); no service is created without your approval.

## 8. GO / NO-GO
**Decision: NO-GO for a public beta today. GO for a private, invitation-only staging once blocker 1 is fixed.**
| # | Blocker | Severity | Evidence | Required fix | Validation | Disable instead? |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 11 high dependency advisories (sharp, nodemailer, zod, tooling) | High | `pnpm audit --prod`, release gate FAIL | upgrade sharp ≥ 0.35.5, nodemailer ≥ 10.0.6, zod ≥ 4.6.6 (and Next/Prisma tooling) | gate audit green + full regression (unit, e2e, Playwright, storage check) | Uploads and image processing could be disabled but there is no flag: no |
| 2 | No managed backup or real restore | High | docs only; local drill | enable PITR + daily dump, restore on a copy, measure time | `restore-drill.sh` on a copy of the managed dump | no |
| 3 | No terms/privacy, no account deletion/export | High (legal) | no routes, no endpoint | legal-reviewed pages; deletion/export endpoints or a tested support procedure | page and deletion test | no (required for real users) |
| 4 | Open registration, e-mail not enforced | Medium | auth controller, no guard | invite-only or allowlist for the beta; require verification before invitations, uploads and external actions | e2e: unverified account refused | yes: invite-only |
| 5 | R2, SMTP, Render, Key Value never exercised for real | Medium | docs "not verified" | staging run of `storage:check`, one real e-mail, BullMQ restart test | smoke tests | no |
| 6 | No error monitoring, no support address | Medium | none | log drain or alert on 5xx + `SUPPORT_EMAIL` | induced error reaches the channel | partly |
| 7 | AI/Social/Creative entries visible but unavailable | Low | nav | hide via `GET /features` (`ai` already exposed) | browser test like the workflows one | yes (done for Workflows, Market) |
