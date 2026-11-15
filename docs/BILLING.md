# Billing preparation (N24)

Status: **architecture and simulation only. No real payment is possible.** `BILLING_ENABLED=false` by default (the endpoints answer 404), the only working provider is a test-only simulator, and production start-up refuses `BILLING_ENABLED=true` until a real adapter is verified.

## What exists in the repository (audit)

Before N24 only data tables existed: `Plan` (seeded Starter 19 / Pro 49 / Business 99 USD), `Subscription`, `Payment` (no card data by design), `WebhookEvent` (idempotent on provider + event id). There was **no billing code, no trial logic, no founder concept, no payment webhook and no entitlement check**; no feature is gated by a subscription today. N24 changes none of that for existing businesses: nothing is enforced, no existing subscription is modified, and `GET /billing/status` is read-only.

## Architecture

| Piece | File |
|---|---|
| Provider-independent rules: 72 h trial, grace period, entitlement (`resolveEntitlement`) | `packages/shared/src/billing.ts` |
| `PaymentProvider` interface, capability statuses, errors | `apps/api/src/billing/payment-provider.ts` |
| Simulated provider (test-only, signed webhooks, no network, no card) | `.../providers/simulated.provider.ts` |
| Payoneer adapter: **inert** (every operation refuses with `PROVIDER_NOT_VERIFIED`) | `.../providers/payoneer.provider.ts` |
| Subscription lifecycle, founder check | `.../billing.service.ts` |
| API (`billing.read` / `billing.manage` = owner) and verified webhooks | `.../billing.controller.ts`, `billing-webhooks.controller.ts` |

Flow: trial (72 h, once per business, no card) → provider-hosted card page (TOUMA gets a URL only; the card never touches TOUMA servers; only an opaque `paymentMethodRef` is stored) → monthly subscription scheduled with first charge at the end of the trial → state changes **only** from verified provider webhooks (HMAC over the raw body, 5-minute replay window, idempotent) → cancellation at period end (access kept until then).

### Rules kept
- **72-hour free trial**: `TRIAL_HOURS = 72`, one per business (second attempt → 409 `TRIAL_ALREADY_USED`).
- **Founder lifetime free access**: an OWNER whose *verified* account e-mail is in `FOUNDER_EMAILS` has state `FOUNDER_LIFETIME`, `chargeable: false`; trial, card and subscribe are refused with `FOUNDER_FREE_ACCESS`. An unverified account with the same e-mail gets no privilege.
- **No card data stored**: no card number, expiry or CVC column exists or is accepted.
- **No automatic charge without an explicit owner action** and no activation without a verified provider.

## Configuration
`BILLING_ENABLED` (false), `BILLING_PROVIDER` (`none` | `simulated` (APP_ENV=test only) | `payoneer`), `BILLING_WEBHOOK_SECRET`, `FOUNDER_EMAILS`. Migration `20261201090000_billing_preparation` is additive (two enum values, one nullable column) and has **not** been applied anywhere except local test databases.

## Payoneer: what is verified and what is not

**Honest status: nothing about Payoneer's recurring billing could be verified from official sources in this work.** The Payoneer websites (including its developer portal) were not reachable from the build environment, and web search returned no Payoneer developer documentation. Nothing in the code or this document is copied from Payoneer; no endpoint, field name or signature scheme was assumed.

| Capability needed by TOUMA | Status |
|---|---|
| Automatic monthly card charges (subscriptions / card-on-file) | **Unverified** — to be confirmed in writing by Payoneer |
| Provider-hosted card capture / tokenization | **Unverified** |
| Signed webhooks and the verification scheme | **Unverified** |
| Sandbox / test credentials | **Unverified** |
| A merchant (collecting) account for a business based in Türkiye | **Unverified** (see below) |

What is generally understood, and must be re-checked with Payoneer before relying on it: Payoneer is mainly known for cross-border payouts and receiving payments from clients and marketplaces. That is not the same as a subscription-billing product. Treat "Payoneer cannot charge a card every month by itself" as the working assumption until Payoneer states otherwise.

### Questions to put to Payoneer (before any integration work)
1. Is there an API or product to charge a customer's card monthly without the customer acting each time (card-on-file, tokenization, recurring/MIT)? Is it open to a business based in Türkiye?
2. Is card capture hosted by Payoneer (PCI scope stays with Payoneer)?
3. Which webhooks exist, how are they signed, and is there a sandbox?
4. Which countries/currencies can the *payers* be in? Which currencies are settled, and fees (FX, withdrawal)?
5. Onboarding for a Türkiye-based activity: legal entity type (sole proprietor vs company), required documents, review time, restricted activities (software/SaaS, AI services), reserve/hold policy.
6. Tax and regulatory duties (VAT/KDV, e-invoicing, foreign-exchange and reporting rules) for receiving foreign-currency revenue in Türkiye — to be confirmed with a Turkish accountant; this document is not legal or tax advice.

### Eligibility and limitations to document for a Türkiye-based activity (to confirm)
- Account type and verification (identity and business documents), possible additional review for online/SaaS activities.
- Which Payoneer products are open to Türkiye (collecting from clients vs. card payments vs. checkout) — may differ from other countries.
- Settlement to a Turkish bank account, currency conversion and fees.
- Turkish tax invoicing and foreign-currency regulations apply regardless of the processor.
- Payoneer may refuse or restrict activities at its discretion; plan for that.

## Alternative provider (if Payoneer cannot do automatic subscriptions)
The `PaymentProvider` interface is deliberately provider-neutral, so a second adapter replaces Payoneer without touching the lifecycle, entitlement or webhook code. Candidate types to evaluate (none verified here, availability for a Türkiye-based business to be confirmed for each):
- A **merchant of record** (e.g. Paddle, Lemon Squeezy): takes the subscription, card capture and sales-tax handling, then pays out to the merchant — often the simplest for a small non-EU/US business.
- A **card processor with subscription billing** (e.g. Stripe, 2Checkout/Verifone): needs the business to qualify in its supported countries.
- A **Turkish PSP with subscription support** (e.g. iyzico, PayTR): good for Turkish card holders and TRY.
Payoneer can still be the *payout/settlement* account behind one of these. Selection criteria: hosted card capture, documented recurring API, signed webhooks, sandbox, availability for the founder's entity, fees, payout options.

## Plan to go live (none of this is done)
1. Founder confirms provider eligibility in writing (questions above) and chooses Payoneer or an alternative.
2. Implement the real adapter behind `PaymentProvider` from the provider's *official* documentation; test in the provider's sandbox; flip `verifiedAgainstOfficialDocs` only then.
3. Apply the additive migration to production (with backup), set `FOUNDER_EMAILS`, `BILLING_WEBHOOK_SECRET` and provider secrets in the dashboard (never in chat or git).
4. Add the merchant UI (trial banner, card page, cancel) and enforce entitlement on selected features, with the founder exempt; decide what happens to existing businesses (grandfathering) — an explicit decision, not an automatic migration.
5. Legal pages (terms, refund, privacy), tax/invoicing setup, then enable `BILLING_ENABLED` for a pilot.

## N25 additions: personal account, failures, cancellation, provider migration

### The founder's personal Payoneer account is never connected
- `BILLING_PROVIDER=payoneer` is **refused at start-up** unless `PAYONEER_ACCOUNT_TYPE=business` (default `personal`). A personal account therefore cannot be wired to automatic customer payments, even by mistake.
- The Payoneer adapter is still inert (see N24). Until a business entity exists and Payoneer confirms the capabilities, the working provider is the simulator (tests) or none.
- Payoneer personal accounts are generally meant for the individual's own receipts; using one to collect customer subscriptions may breach its terms and complicates tax and liability. Confirm with Payoneer when the company is created.

### Failed payments (dunning)
Each failed renewal (verified webhook `payment.failed`) increments `failedPaymentCount` and sets `PAST_DUE`: access continues for the 3-day grace period after the paid period ends (`PAST_DUE_GRACE_DAYS`). After `BILLING_MAX_FAILED_PAYMENTS` consecutive failures (default 3) the subscription becomes `UNPAID` and access ends. A successful payment clears the counter and restores `ACTIVE`. Each failure notifies the owner in the app (`billing.payment_failed`, `billing.unpaid`); redelivered events count once. Retry timing of the card itself belongs to the provider.

### Cancellation and resumption
`POST /billing/cancel` cancels at the end of the paid period (access kept); `POST /billing/resume` undoes it while the period has not ended. A final `subscription.canceled` webhook notifies the owner (`billing.canceled`).

### Trial reminders
`BillingService.sweepTrials()` sends one notification 24 h before a trial ends and one when it has ended without a subscription. It changes no subscription and skips founders. **It is not scheduled yet**: a worker job calls it when billing goes live.

### Migrating to a professional provider without rebuilding
Plans, subscriptions, trial, entitlement, payments and webhook storage are provider-neutral; only the adapter changes (`BILLING_PROVIDER` + a new class implementing `PaymentProvider`). When the configured provider differs from a subscription's `provider`:
- `GET /billing/status` shows `providerMigration.required`;
- webhooks of the new provider can only match subscriptions of the new provider (no cross-provider confusion);
- while the old provider still holds a live subscription, `card-setup`, `subscribe` and `cancel` are refused (`PROVIDER_MIGRATION_BLOCKED`) so nobody is billed twice: end it at the old provider first;
- then the merchant captures a new card on the new provider's hosted page (card tokens cannot be copied between providers by TOUMA unless both providers offer an official token migration), TOUMA creates the new customer, records `providerMigratedFrom`, and the same subscription row continues with the same plan and history.
Recommended order: create the business entity → open the professional account → build and sandbox-test the adapter → enable for new customers → move existing ones in batches with advance notice.

---

## N26 – Hybrid billing engine (AUTO and MANUAL renewal)

Status: implemented and tested locally with a **mock provider only**. `BILLING_ENABLED=false` by default; no real payment, charge or provider activation exists. Production start-up refuses `BILLING_ENABLED=true` until a provider adapter is verified.

### Decisions (founder-approved)
1. **Extend, do not duplicate.** The requested entities map onto the existing ones: `SubscriptionPlan` = `Plan`; `CustomerSubscription` = `Subscription` (one per business); `PaymentTransaction` = `Payment`; `BillingEvent` = `WebhookEvent` (verified provider deliveries, unique on provider + event id) plus `SubscriptionAuditLog` (our own decisions); new tables `Invoice`, `SubscriptionAuditLog`, `PaymentProviderAccount`.
2. **State set replaced** by `PENDING, ACTIVE, PAST_DUE, GRACE_PERIOD, CANCELED, EXPIRED` (the old `TRIALING/INCOMPLETE/UNPAID` enum values stay in PostgreSQL, unused, because an enum value cannot be dropped safely). A 72-hour trial is an **ACTIVE** subscription whose current period is the trial (`trialEndsAt` = `currentPeriodEnd`).
3. `userId` is "who subscribed"; **one subscription per business** (`tenantId` = `businessId`).

### Data model (migrations `20261203090000_billing_engine_states`, `20261203090100_billing_engine`, additive)
`Subscription` gains `userId, billingMode (AUTO|MANUAL), billingInterval (MONTHLY|YEARLY), currency, amountMinor, autoRenewConsentAt, pendingPlanId, pendingBillingInterval`; `Plan` gains `priceAmountMinor, yearlyPriceAmountMinor` (yearly default = 10 monthly prices, editable); `Payment` gains `amountMinor, kind, idempotencyKey (unique), periodStart/End, failureCode, sessionUrl, simulated`. **All amounts are integers in minor units** (the legacy decimal columns are kept as copies; the code never computes with floats: `majorToMinor`, `minorToMajorString`, `formatMinor` in `@touma/shared`, with per-currency exponents). `Invoice` is unique per (subscription, period start) and numbered from a PostgreSQL sequence (`SIM-<year>-<n>` for simulated invoices, which are not tax documents). The local data migration converts rows: `TRIALING → ACTIVE` (period = trial), `INCOMPLETE → PENDING`, `UNPAID → EXPIRED`. Not applied anywhere but local test databases.

### State machine (`packages/shared/src/billing.ts`, validated on the server)
```
PENDING      -> ACTIVE | CANCELED | EXPIRED
ACTIVE       -> PAST_DUE | GRACE_PERIOD | CANCELED | EXPIRED
PAST_DUE     -> ACTIVE | GRACE_PERIOD | CANCELED | EXPIRED
GRACE_PERIOD -> ACTIVE | CANCELED | EXPIRED
CANCELED     -> ACTIVE | EXPIRED
EXPIRED      -> ACTIVE
```
Every status write goes through `setStatus` (validated transition, 409 `INVALID_TRANSITION` otherwise, one `SubscriptionAuditLog` row with from/to/reason). **A subscription becomes ACTIVE only when a payment is confirmed by a verified provider event** (`BillingEngine.applyEvent`); no customer endpoint, redirect or query parameter can do it. PAST_DUE = an automatic charge failed (provider retrying); GRACE_PERIOD = the period ended unpaid (manual) or retries ran out (`BILLING_MAX_FAILED_PAYMENTS`); both keep access for `BILLING_GRACE_DAYS` (default 3, configurable; trials get no grace); then EXPIRED.

### Flows (all simulated)
- **AUTO**: sign-up with explicit consent (`autoRenewConsentAt`) → hosted card page (URL only) → `subscribe` schedules the recurring charge at the provider → at the due date the provider charges and notifies → verified webhook → period extended by one interval (UTC calendar math with end-of-month clamping), invoice issued, access follows. A decline → PAST_DUE with retries, then GRACE_PERIOD, then the customer can pay by hand.
- **MANUAL**: expiry date shown, reminder `BILLING_REMINDER_DAYS` before the end (in-app notification, once), **Renew** opens a hosted payment session (a pending `Payment`, nothing changes), the provider's verified confirmation extends the period **once** (idempotency key = subscription + period boundary + attempt number; invoice unique per period). Renewal opens only within the reminder window or after expiry (no paying months ahead).
- **Switch mode**: AUTO needs consent; MANUAL stops the provider's recurring schedule and withdraws the consent. **Plan/interval change**: recorded now, applied at the next renewal (no proration, no refund); for a live recurring schedule the provider's own subscription would also need updating — not implemented, flagged as an integration task.
- **Cancel / resume**: at the end of the paid period; a provider cancellation event moves to CANCELED (access until the end), then EXPIRED.

### Security
Tenant isolation on every route (404 for another business's invoice/payment); `billing.read` for reads, `billing.manage` (owner) for changes; DTO validation (plans, modes, intervals, https-only `returnUrl`); a row lock per subscription serializes renewals, webhooks and the due sweep; unique keys make renewals, payments, invoices and webhook deliveries idempotent; amounts confirmed by the provider must equal the expected amount, otherwise nothing is extended and the case is flagged (`amount_mismatch`); a second charge for an already paid period is recorded and flagged, never extended; the webhook path verifies the signature on the raw body (HMAC + replay window in the mock; a real adapter must implement its provider's scheme) before storing anything; no card number, expiry or CVC is ever stored or accepted (only opaque provider references); the founder is exempt everywhere.

### Providers
`PaymentProvider` (capabilities explicit and `unverified` by default, including `hostedPaymentSession` and the verified `methods` list — Visa/Mastercard/wallets are shown only once a provider is verified for them). `MockPaymentProvider` (id `simulated`, test only), `PayoneerAdapter`, `IyzicoAdapter` and `FutureProviderAdapter` extend `UnverifiedPaymentProvider`: no HTTP, no endpoint, no assumed API; every operation refuses with `PROVIDER_NOT_VERIFIED`. `PaymentProviderAccount` records which providers exist, whether one is selected, and what is verified (nothing is). Add a provider: copy `future.provider.ts`, add its `ProviderId` and `WebhookProvider` value, implement only documented, sandbox-tested calls, register it in `billing-provider.ts`.

### Simulator (mock provider only; refused outside `APP_ENV=test`)
`POST /billing/simulator/{confirm,due,card-saved,rewind,process-due}`: the simulator plays the *provider*, sending correctly signed notifications through the **same webhook processor** as production, so the engine behaves exactly as it will with a real provider. UI buttons exist only when `simulation: true` and are labelled "Simulation — no real payment".

### Admin
`GET /admin/billing/overview` (SUPER_ADMIN/SUPPORT) and `/dashboard/operations/billing`: subscriptions by state, expired, failed payments, upcoming renewals (14 days), recent events, provider readiness, and revenue split into **simulated** (never presented as collected money) and **real** (empty until a verified provider is live).

### Needs a merchant account or further validation before any real use
- A provider that is verified for: recurring card charges (Visa/Mastercard), hosted card capture and payment pages, signed webhooks, a sandbox, and availability for the founder's company (Payoneer and iyzico are unverified; eligibility for a Türkiye-based company must be confirmed in writing).
- Real webhook signature verification per provider; refunds, disputes and tax invoicing (VAT/KDV, e-invoicing) — the simulated invoices are not tax documents.
- Provider-side subscription updates for plan changes in AUTO mode; a worker job calling `processDue` on a schedule; legal pages (terms, refund, privacy, automatic-renewal disclosure and cancellation rules of the customer's country).

---

## N27 – International billing engine, sandbox version (Paddle sandbox, Lemon Squeezy preparation)

Status: implemented and tested **locally**. Default provider: the in-process mock. **No real payment is possible**: `PAYMENT_ENVIRONMENT=live` is refused at start-up, only Paddle *sandbox* keys (`pdl_sdbx_…`) are accepted, and the production gate (below) is closed in this build.

### Compliance: Paddle is not approved for TOUMA
Paddle's policies restrict some product categories, including automated social-media marketing, which is part of what TOUMA does (AI agents that analyse, create content, handle customer interactions and *prepare* publications, with individual human validation before any publication). **Do not treat Paddle as approved.** TOUMA must describe its product accurately to any provider and must never hide, disable artificially or misdescribe features to obtain an approval. The database records, per provider, the provider's own decision (`NOT_SUBMITTED / PENDING_REVIEW / APPROVED / REJECTED`) with the reference of its written answer; it is set only by a SUPER_ADMIN, never automatically. The Paddle documentation and policy pages could not be reached while this was built, so none of Paddle's rules, API shapes or capabilities were verified (see "Unverified assumptions").

### Production gate (`evaluateProductionGate`, `@touma/shared`)
Real payments for a provider are allowed only if **all** hold, and the answer lists every reason when not: the build allows live payments (`BUILD_BLOCKS_LIVE_PAYMENTS` = true: lifting it is a reviewed code change that needs the founder's explicit authorization after the provider accepted TOUMA in writing); the environment is live (refused at boot); the provider is APPROVED with a written reference; the adapter has a live mode (the sandbox adapter never does); the adapter is verified against official documentation. Recording an approval never opens anything: with an approved, referenced Paddle sandbox the gate still reads `BUILD_BLOCKS_LIVE_PAYMENTS, ENVIRONMENT_NOT_LIVE, ADAPTER_NOT_LIVE_CAPABLE, ADAPTER_NOT_VERIFIED`. The admin screen (`/dashboard/operations/billing`) shows approval and reasons per provider.

### Providers (`PaymentProvider`)
- **MockPaymentProvider** (default, `BILLING_PROVIDER=simulated`, test only): complete, with failure injection for tests.
- **PaddleSandboxProvider** (`paddle-sandbox`): works only with administrator-supplied sandbox credentials (server environment: `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_PRICE_MAP`); reports capabilities as `sandbox`, never `supported`; `live` is always false; every payment/invoice it produces is flagged as test money and never counted as revenue. Customer, one-time checkout, recurring checkout, cancel, signed webhooks. Not offered (unverified or not part of Paddle's model): standalone card capture, creating a subscription through the API with a saved card, withdrawing a scheduled cancellation. Provider failures map to 503 `PROVIDER_UNAVAILABLE` / `CREDENTIALS_REJECTED` / `PROVIDER_NOT_CONFIGURED`; a creation is never retried blindly; no secret or provider detail is ever returned or logged.
- **LemonSqueezyProvider** (`lemonsqueezy`): preparation only, inert like Payoneer/iyzico. Add any future provider by copying `future.provider.ts`.
- Capability statuses: `supported` (verified/mock), `sandbox` (implemented from documentation, sandbox only, unverified), `unsupported`, `unverified` (treated as unavailable). `subscriptionModel`: `saved-card` (mock: card page, then API subscription) or `checkout` (Paddle: the customer completes a hosted checkout of the recurring price).

### AUTO and MANUAL with Paddle — and how this differs from Paddle's "manual collection" invoices
- **AUTO** = hosted checkout of a **recurring price**; Paddle creates the subscription when the customer completes it and charges each period; TOUMA turns ACTIVE only on Paddle's verified `transaction.completed` notification (the provider's own billing period is used when it reports one).
- **MANUAL** (TOUMA's voluntary renewal) = each renewal is a **new one-time purchase** by card: a hosted checkout of a **one-time price** (`PLAN:INTERVAL:ONCE` in the price map), `collection_mode: automatic` (the customer pays by card at that moment). It is **not** Paddle's *manual collection mode*, which creates an invoice with payment terms that is sent to the customer and is typically paid later by bank transfer or other means. Do not use manual-collection invoices to implement TOUMA's "Renew" button. Both a recurring and a one-time Paddle price per plan and interval must exist in the sandbox catalog (assumed model, to verify).
- The price/amount TOUMA expects must equal what the provider confirms (`amount_mismatch` otherwise: nothing is extended, flagged). With a merchant of record, tax may change the total: the adapter reads the pre-tax subtotal (field mapping unverified).

### Events: duplicates, disorder, failures
Per-subscription row lock; unique keys for webhook events, payment attempts, invoices per period; a duplicate or already confirmed payment changes nothing; **events in any order**: a payment can arrive before the subscription or card notification (the subscription id is adopted from whichever arrives); a failure or cancellation that happened **before** the last confirmed payment is recorded and flagged (`stale_event_ignored`), never undoing it; unknown-but-signed event types are acknowledged as ignored. Provider outages and rejected credentials during customer actions are recorded as incidents (`provider_unavailable`) for administrators.

### Plan entitlements (enforced on the server)
`Plan.limits` (JSON) carries `agents` (the AI agents included, i.e. the maximum number of agents), `features` (modules), `salesInteractionsPerMonth`, plus the existing generation/image/video quotas. With `BILLING_ENFORCEMENT_ENABLED=true`: paid actions need access (trial, paid period, grace, paid period of a canceled one; the founder always); the orchestrator, Creative Studio and the sales agent refuse agents outside the plan (402 `AGENT_NOT_IN_PLAN`); campaigns, intelligence, autopilot, market, workflows and creative refuse features outside the plan (402 `FEATURE_NOT_IN_PLAN`); the sales assistant is limited per month (429 `PLAN_QUOTA_REACHED`, the conversation falls back to a human). At expiry paid actions are suspended while history, usage and billing stay readable. AI generation quotas follow the plan whenever it is active, with or without enforcement. The founder gets the highest plan's entitlements. The customer sees plan, agents, features and this month's usage on the billing screen; consumption history is in the AI usage report.

### Local setup
1. `docker run` PostgreSQL 16 and Redis 7; `pnpm --filter @touma/database exec prisma migrate deploy`; `… tsx prisma/seed.ts`.
2. Mock (default): `BILLING_ENABLED=true`, `BILLING_PROVIDER=simulated` (only with `APP_ENV=test`), `BILLING_WEBHOOK_SECRET` ≥ 16 chars. The simulator buttons appear on `/dashboard/billing`.
3. Paddle sandbox (administrator, test credentials only, server side, never in git or the browser): `BILLING_PROVIDER=paddle-sandbox`, `PADDLE_API_KEY=pdl_sdbx_…`, `PADDLE_WEBHOOK_SECRET` (the sandbox notification destination's secret), `PADDLE_PRICE_MAP` (JSON, six recurring and/or six `:ONCE` price ids), and a public HTTPS notification URL `…/api/v1/billing/webhooks/paddle-sandbox` — none of this has been done. `PADDLE_API_BASE_URL` exists only for tests (`APP_ENV=test`).
4. `BILLING_ENFORCEMENT_ENABLED` stays `false` until the decision about existing businesses is made.

### Unverified assumptions (to confirm against Paddle's documentation and sandbox before relying on any of it)
Endpoints and bodies (`POST /customers`, `/transactions`, `/subscriptions/{id}/cancel`); sandbox base URL; key prefix `pdl_sdbx_`; one-time vs recurring price handling; `custom_data` round trip; event names and fields (`transaction.completed`, `transaction.payment_failed`, `subscription.created/activated/canceled`, `payment_method.saved`); notification signature (`Paddle-Signature: ts=…;h1=…`, HMAC-SHA256 of `ts:body`, several `h1` during rotation, 5-minute tolerance chosen here); totals field mapping; the customer-already-exists answer. The adapter was exercised only against a local fake of exactly these assumptions.

### Missing information / authorizations before any production use
- Paddle (and Lemon Squeezy) **written acceptance of TOUMA's real activities**; reference recorded via the admin approval; the founder's explicit authorization to lift `BUILD_BLOCKS_LIVE_PAYMENTS`.
- Sandbox account, sandbox API key, notification destination and secret, sandbox catalog (products and prices), the legal entity details the provider requires.
- Verification of the adapter against the official documentation and a real sandbox run; live credentials only after that, never before approval.
- Tax/invoicing treatment with a merchant of record; refund and dispute handling; terms, refund, privacy and automatic-renewal/cancellation disclosures for the customers' countries.
- Decision on existing businesses (enforcement), worker hosting for `processDue`, and a real run of every flow in the provider's sandbox.
