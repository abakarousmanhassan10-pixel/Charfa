# Going from simulation to real operation (prepared, nothing enabled)

TOUMA AI runs today on simulators: no model is called, no money is spent, nothing is published or charged. This page describes the gates that stand between that state and real operation, and how to see what is missing. **No gate is opened by this document or by the code: each one needs your explicit authorization, verified prices and an approved budget.**

## See where you stand
`GET /api/v1/admin/go-live` (platform administrators: SUPER_ADMIN or SUPPORT) returns, per capability, whether it is `simulated`, `real` or `disabled`, what is missing (variable **names** only, never a value) and an overall verdict:
- `SIMULATION`: nothing with an external effect is real (the demo state);
- `REAL_BLOCKED`: something real is selected but items are missing (listed in `blockers`);
- `REAL_READY`: every real capability has what it needs, including durable storage, e-mail and `APP_ENV=production`.

Capabilities: AI text, creative images, creative videos, social publishing, customer payments, file storage, e-mail, environment. The logic is `packages/config/src/go-live.ts` (unit-tested; the endpoint is e2e-tested to never reveal a secret).

## The spending gates (creative generation)
A real image/video provider with an API key is refused at start-up unless **all** of these hold:
1. `PAID_GENERATION_ENABLED=true`: the explicit authorization to spend.
2. `CREATIVE_PLATFORM_MONTHLY_CAP_MICROS` > 0: a **platform-wide** monthly cap, all clients together. The per-business budget alone does not bound the platform. Enforced at every request (atomically across clients); when it is reached, requests are refused with `CREATIVE_PLATFORM_CAP_REACHED` (402) without revealing any total.
3. A price for every model in use in `CREATIVE_MODEL_PRICING`. An unknown cost is never treated as zero: with a cap in place, a generation whose cost cannot be estimated is refused.
On top of these, the existing limits keep applying: 5 images and 5 videos per client per day, per-business monthly units and budget.
The free test mode and the test simulators are not affected.

## Other gates already in place
| Capability | Gate |
|---|---|
| Social publishing | `SOCIAL_PROVIDER_MODE=live` **and** `SOCIAL_PUBLISHING_ENABLED=true` (off by default), per-account consent, publishing policy, platform app approvals ([SOCIAL-PLATFORM-APPROVALS.md](SOCIAL-PLATFORM-APPROVALS.md)) |
| Customer payments | `BILLING_PROVIDER` other than `none`/`simulated` with `BILLING_ENABLED=true`; a personal Payoneer account is refused |
| Higgsfield video | Disabled placeholder: selecting it is refused at start-up. The `VideoProvider` conformance check (`checkVideoProvider`) is ready for it ([CREATIVE-CAMPAIGNS.md](CREATIVE-CAMPAIGNS.md)) |
| Production | `APP_ENV=production` refuses every simulator and mock at start-up |

## Suggested order, each step needing your go-ahead
1. Durable storage and e-mail (Cloudflare R2, Brevo: [DEMO-HOSTING.md](DEMO-HOSTING.md)) and a paid database ([DEMO-DB-EXPIRY.md](DEMO-DB-EXPIRY.md)).
2. Text AI with a real key, with `AI_MODEL_PRICING` and the monthly limits you accept.
3. Real images: key, prices, a small platform cap (for example 10 USD), `PAID_GENERATION_ENABLED=true`; check `/admin/go-live`, then a few real generations and the spend report.
4. Real video: only after a verified provider contract and price; run `checkVideoProvider` with a capped budget.
5. Social publishing: one platform, one account, manual then hybrid mode, never automatic first.
6. Payments last, with a business account and a small test charge.
