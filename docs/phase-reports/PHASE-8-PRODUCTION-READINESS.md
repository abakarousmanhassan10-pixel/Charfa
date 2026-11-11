# Phase 8 — Production readiness and real AI integration

Date: 2026-11-11 · Branch `ccr-ce5eb3d1-r4he6g` · Design: [`docs/AI-SALES-AGENT.md`](../AI-SALES-AGENT.md) §9.

**Headline: TOUMA is closer to production, but it is NOT production-ready, and real AI integration is NOT verified.** `OPENAI_API_KEY` is not set in this environment, so no real model has answered anything. Everything below was tested with the deterministic test model or with stubbed networks. TOUMA must keep review mode until a real model has been evaluated on real catalogs.

## 1. Audit findings (before any change)

| Area | Found | Gap |
|---|---|---|
| Real AI | A real `OpenAIProvider` (strict structured outputs, abort timeout, error mapping, no key in errors), engine retries with backoff and one repair, token usage + pricing in `AIUsage` already existed | The Sales Agent reused the content-generation model, a 90 s timeout and a fixed temperature (some models reject it); no way to verify the real provider or measure answer safety |
| Catalog | Sales Agent already read the merchant's active products/services and verified knowledge, validated prices | All verified knowledge (up to 300 entries) in every prompt; raw stock quantities reached the model |
| Accuracy / handoff | LOW confidence → handoff | MEDIUM-confidence answers went out automatically in AUTO mode |
| Security / privacy | Tenant guard, strict DTOs, per-IP throttle, erasure existed; no sensitive text in logs (reviewed) | No honeypot / flood control / CAPTCHA hook; no privacy notice; no retention (conversations kept forever) |
| Monitoring | Calls recorded in `AIUsage` | No latency, failure, handoff, health view; no per-call structured log; no alert |

## 2. What was implemented

- **Real AI configuration:** `SALES_AGENT_MODEL`, `SALES_AGENT_TIMEOUT_MS` (30 s), `SALES_AGENT_TEMPERATURE` (`none` omits it); engine supports "no temperature". Credential-gated, billed-call tool `live-verify-ai` (11 questions: prices in EN/FR/TR/AR, out-of-stock, comparison, policy, unknown fact, unknown price, invented discount, injection). It skips with the reason unless `OPENAI_API_KEY` **and** `LIVE_AI_CONFIRM=yes` are set. The simulated provider is untouched and still the only provider in tests.
- **Catalog accuracy:** relevance selection of verified knowledge (max 10, policies as fallback); stock as a status, never a quantity.
- **Confidence-based handoff:** `autoMinConfidence` (HIGH default / MEDIUM); below it a draft is held for review and the team is notified; LOW always goes to a person; REVIEW mode stays the default.
- **Security and privacy:** honeypot; flood cap per business per hour; 10 messages/minute per conversation; optional server-side Cloudflare Turnstile (off by default, fails closed); privacy notice in 4 languages with retention and the merchant's policy link; configurable retention with an automatic, idempotent purge (message texts, AI details, notes, tokens erased, customers anonymized, test chats deleted after 7 days); settings validated (https only, 30–1825 days).
- **Monitoring:** structured `ai_call` log line per model call (no content); `GET /sales/monitoring`; health states with a dashboard banner and a once-per-hour alert to people who can act when the last three calls fail; `GET /admin/sales-ai` (per-business counts, platform roles only); dashboard tab "Monitoring" (EN/FR); cost shown as unknown, never zero, when no price is configured; failed and retried calls and validation failures recorded in usage.
- **Reviewed, no change needed:** authentication/authorization of all sales routes (covered by the existing 50 tests plus new ones), tenant isolation, exception filter (logs message and stack, not bodies), public input validation (strict DTOs).

## 3. Database migrations

`20261116090000_sales_agent_production`: `SalesAgentConfig` gains `autoMinConfidence` (default `HIGH`), `privacyNoticeUrl`, `retentionDays` (default 365). Drift check against the migrated database: none. (Earlier Phase 7 migrations unchanged.)

## 4. Files changed (summary)

- Config/env: `packages/config/src/env.ts` (+ spec), `.env.example`
- AI engine: `engine.ts` (nullable temperature), `agents/sales-agent.ts`, `retrieval.ts`, `scripts/live-verify-ai.ts`, `package.json`; specs `sales-agent.spec.ts`, `openai.spec.ts`
- Shared: `sales.ts` (privacy notice in 4 languages)
- Database: `schema.prisma`, migration above
- API: `sales/` — `sales-agent.service.ts` (model settings, confidence threshold, usage/logging/alert), `sales-public.service.ts` + controller (honeypot, flood, captcha, privacy), new `sales-captcha.service.ts`, `sales-retention.service.ts`, `sales-monitoring.service.ts`, `sales.controller.ts`, DTO/config service, module; `admin/admin.controller.ts` + module
- Web: chat page (privacy notice, trap, Turnstile), agent settings, new monitoring view/page, sales section banner, notifications, `messages/en.json`/`fr.json`
- Tests: `apps/api/test/sales-agent.e2e-spec.ts` (+10), `tests/e2e/sales.e2e.ts` (+2), playwright config
- Docs: this report, `docs/AI-SALES-AGENT.md`

## 5. Tests executed and results

### Tests using simulated AI or stubbed networks
| Check | Result |
|---|---|
| Lint, typecheck (17), production build (10), Prisma drift | pass, pass, pass, none |
| Unit tests | ai-engine **127**, shared 69, config 19, social-connectors 61, api 37, storage 11, worker 5, web 8, creative 38 — all pass. In the full `pnpm test` run the existing `@touma/creative` compose test timed out under load (known flake, passes alone: 13/13) |
| API integration (real PostgreSQL/Redis/HTTP; test model), serial | **475 passed**, 5 skipped (opt-in real-storage), 0 failed — 10 new Phase 8 tests: confidence handoff, settings validation, stock wording, honeypot and flood caps, Turnstile (spy and stubbed verifier, fail-closed), privacy notice, retention purge, **no sensitive data in logs/audit/usage**, monitoring and health/alert |
| Browser (Playwright, built API + web), full suite | **73 passed** on the second full run; 2 new tests (privacy/retention/confidence UI and hidden trap; monitoring without content); phone layout test covers the new page. **The first full run after a fresh build failed 3 existing auth/account tests (`auth.e2e` ×2, `account.e2e` ×1) in both Phase 7 and Phase 8; they pass when re-run. I have not found the cause (likely cold-start timing); treat it as an unresolved flake** |
| OpenAI provider with stubbed network (not a real call) | request shape, temperature omission, error mapping without key leakage, retry with backoff then success (3 recorded attempts), no retry on bad credentials, give-up after configured retries, timeout abort |

### Tests using real AI
**None executed.** `live-verify-ai` was run twice here: both runs SKIPPED (no key; key without `LIVE_AI_CONFIRM=yes`). No real answer, token count, latency or cost has been observed.

### Tests requiring external credentials (not run)
Real OpenAI calls (`live-verify-ai`); Cloudflare Turnstile verification against the real service; real latency/cost per model.

### Not executed
Load or soak testing; real-browser Turnstile widget; throttle decorator behavior (no automated test); a multi-instance retention run; any penetration test.

## 6. Real AI integration status

Code path complete and unit-tested with stubs; **unverified against the real service**. Not claimed: answer quality, multilingual fluency, real latency, real cost, real failure behavior. Add the model's price to `AI_MODEL_PRICING` or cost is reported as unknown.

## 7. Security improvements (summary)

Bot controls on the public chat (honeypot, flood and burst caps, optional CAPTCHA); privacy notice and enforced retention; no sensitive text in logs/audit/usage (tested); stricter settings validation; monitoring that never includes message content; per-business and platform views restricted by permission/role; alert when the AI fails.

## 8. Remaining blockers

1. **Real-model evaluation** with a real key (`live-verify-ai`), then on a real merchant catalog in review mode; decide the model and set `AI_MODEL_PRICING`.
2. **Business/legal decisions:** TOUMA's privacy policy and DPA for the chat, the default retention period, whether contact details need a stronger consent flow; native-speaker review of Turkish/Arabic fixed messages and the privacy notice.
3. Turnstile (or equivalent) site key/secret and a real-service test if bot pressure is expected; test of the per-IP throttle; CDN/WAF in front of the public endpoint.
4. The unexplained first-run browser flake; a load test of the chat and the retention job.
5. Chat turns still do not consume the plan's monthly AI quota (only per-conversation/day caps).
6. Still not built: other channels (Instagram/Messenger/WhatsApp), order data, push updates, assignment/SLA, independent security review.

## 9. External credentials or approvals required

`OPENAI_API_KEY` (and optionally `OPENAI_ORGANIZATION`), model choice and prices; Cloudflare Turnstile keys (optional); a published privacy policy URL per merchant; for other channels, the platform approvals in `docs/SOCIAL-PLATFORM-APPROVALS.md`.

## 10. Recommended next phase

Phase 9 = **pilot with real AI**: provide a key, run `live-verify-ai`, onboard 1–3 friendly merchants in review mode, collect draft approval rates and handoff reasons from the monitoring page, fix what they show (prompt, retrieval, thresholds), then decide on automatic answers per merchant. Only after that: messaging channels and billing/quota for chat usage.
