# TOUMA controlled real-AI pilot — execution plan (DRAFT, awaiting approval)

Status: **plan only.** Nothing in this plan has been executed. No credential exists in this environment, no real AI call has been made, and no price, cost, latency or quality figure below is a measurement. Items marked **[VERIFY]** must be checked against OpenAI's current pages or measured during the pilot before anyone relies on them. No production code is changed by this plan.

Source of truth for what exists today: `docs/phase-reports/PHASE-8-PRODUCTION-READINESS.md` and `docs/AI-SALES-AGENT.md` §9.

---

## 0. What the Phase 8 report establishes (and what it does not)

Established (simulated model / stubbed network only): the Sales Agent reads the merchant's real catalog and verified knowledge; validation rejects invented prices, wrong-item prices, unavailable recommendations and confirmed orders; confidence below the merchant's threshold becomes a draft; REVIEW mode (drafts only) is the default; privacy notice, retention purge, honeypot/flood caps, monitoring and per-call usage records exist; 475 API / 73 browser tests passed.

Not established: **any real-model behavior** (quality in FR/EN/TR/AR, hand-off rate, latency, cost), Turnstile against the real service, load behavior, legal/privacy approvals, and one unexplained first-run browser flake (3 auth/account tests).

Two facts that matter for "no automatic responses" (see §7): (a) the agent's **fixed system messages** (handoff notices, "a team member will reply shortly") are sent to customers automatically even in REVIEW mode — they are human-written templates, not AI output; (b) the dashboard **test chat** (playground) shows AI answers immediately, but only to the signed-in tester.

---

## 1. Environment variables

### Required to call OpenAI (server only)

| Variable | Value / note |
|---|---|
| `AI_PROVIDER` | `openai` (default). `fake` is refused unless `APP_ENV=test` |
| `OPENAI_API_KEY` | Secret. Server/worker process only. Never in the web app, never `NEXT_PUBLIC_*` (the web app has no reference to it) |
| `AI_MODEL` | Default model for content generation and fallback for chat (default `gpt-4o-mini`) |
| `SALES_AGENT_MODEL` | Chat model; recommended to set explicitly and pin (§2) |
| `AI_MODEL_PRICING` | JSON price table per model, USD per 1M tokens, copied from OpenAI's pricing page on the pilot date: `{"<model>":{"inputPerMillion":<n>,"outputPerMillion":<n>}}`. **Without it cost is reported as "unknown", never zero.** Do not copy the example in `.env.example`: it is an unverified sample |

### Optional OpenAI settings
`OPENAI_ORGANIZATION` (if the key is org-scoped), `OPENAI_BASE_URL` (only for a proxy/gateway; default OpenAI).

### Chat behavior and limits (existing, set explicitly for the pilot)

| Variable | Pilot value | Why |
|---|---|---|
| `SALES_AGENT_TIMEOUT_MS` | `30000` (default) | customer-facing latency ceiling |
| `SALES_AGENT_TEMPERATURE` | `0.2` (default); `none` if the model rejects temperature **[VERIFY]** | reasoning-type models reject it |
| `AI_MAX_PROVIDER_RETRIES` / `AI_MAX_REPAIR_ATTEMPTS` | `2` / `1` (defaults) | each retry/repair is another billed call |
| `AI_MAX_OUTPUT_TOKENS` | default (chat is capped at 1200 internally) | bounds cost per answer |
| `SALES_AGENT_DAILY_REPLY_CAP` | **pilot: 50** (default 500) | AI replies/drafts per business per 24 h |
| `SALES_NEW_CONVERSATIONS_PER_HOUR` | **pilot: 20** (default 120) | flood/cost cap per business |
| `SALES_MAX_CUSTOMER_MESSAGES_PER_CONVERSATION` | **pilot: 30** (default 60) | |
| `SALES_PUBLIC_RATE_LIMIT_PER_MINUTE` | default 20 | per-IP throttle |
| `SALES_RETENTION_INTERVAL_MS` | default 6 h; must **not** be 0 (0 disables retention) | retention enforcement |
| `CHAT_CAPTCHA_PROVIDER` (+ `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET`) | `none` for internal phase; recommended `turnstile` before any real public traffic | needs Cloudflare keys, untested against the real service |

Per-merchant settings (dashboard → Sales agent → Agent, by an Admin/Owner): `replyMode = REVIEW` (**must stay**), `maxAiRepliesPerConversation` (pilot: 10), `autoMinConfidence` (irrelevant while REVIEW), `retentionDays` (pilot: decided in §9), `privacyNoticeUrl` (required before real customers), `languages`/`defaultLanguage`.

Other environment variables the staging deployment needs are listed in `docs/DEPLOYMENT.md` (database, Redis, JWT secrets, `TOKEN_ENCRYPTION_KEY`, `WEB_URL`, `CORS_ORIGINS`, `APP_ENV=staging`, `PUBLIC_API_URL`).

---

## 2. Recommended model

**Constraints from the code:** the provider uses OpenAI Chat Completions with **strict Structured Outputs** (`response_format: json_schema, strict`), so the model must support that. Customer answers must be in FR/EN (pilot) and later TR/AR, grounded in a supplied catalog, and fast enough for a 30 s ceiling (target far lower).

**Recommendation (to be confirmed by measurement, not by this document):**

1. **Primary candidate: a current small, non-reasoning general model that supports strict Structured Outputs — `gpt-4.1-mini` if it is available on your OpenAI project, otherwise `gpt-4o-mini` (the repository default).** Why: low latency and low per-token cost (the prompt is mostly catalog + conversation, i.e. input-heavy); non-reasoning models answer in one fast pass; they accept `temperature`, so `0.2` works; multilingual quality is generally adequate for FR/EN, with TR/AR the main uncertainty. **[VERIFY] availability, exact model id, and structured-output support in the OpenAI model list for your project.**
2. **Quality-ceiling comparison: one larger model from the same family (e.g. `gpt-4.1` or `gpt-4o`)**, run once through `live-verify-ai` to see whether the small model's failures (if any) are model-limited or prompt/validation-limited. It is a benchmark, not the pilot model, unless the small model fails §6 gates and the cost difference is acceptable.
3. **Not recommended for the pilot:** reasoning-class models — higher latency and cost, and some reject `temperature` (would need `SALES_AGENT_TEMPERATURE=none`); evaluate later only if the safety cases fail on the small model.

**Pin the model.** Use a dated snapshot id if OpenAI offers one for the chosen model **[VERIFY]**, so behavior does not change silently mid-pilot, and record the exact id in the pilot log.

**Selection rule (decided before running, to avoid bias):** run `live-verify-ai` for each candidate; choose the cheapest candidate that (a) passes all 11 safety cases on two consecutive runs, (b) has p95 latency comfortably under the 30 s timeout (pilot target ≤ 8 s **[to be measured]**), and (c) shows no systematic TR/AR failure if those languages are in scope. If none passes, stop and report; do not loosen validation to make a model pass.

No price is stated here on purpose: take input/output prices from OpenAI's pricing page on the day, put them in `AI_MODEL_PRICING`, and store a screenshot/link with the pilot log.

---

## 3. Credential security

1. **Create a dedicated OpenAI *project* for TOUMA pilot** (not a personal/general key). Create a **project-scoped API key** with access only to the needed model(s) **[VERIFY: restricted-key options in your OpenAI dashboard]**. Use a separate key for (a) your workstation `live-verify-ai` runs and (b) the staging server, so either can be revoked alone.
2. **Set a hard monthly spend limit and an alert threshold on the OpenAI project** (dashboard). This is the only *hard* cost stop available today (see §8 blockers: the app has no monthly cost cap).
3. **Where the key lives:** the deployment platform's secret manager / environment-variable store for the API and worker processes. Never in the repository (`.env`, `.env.*` are git-ignored except `.env.example`), never in chat/tickets/screenshots, never in frontend code or `NEXT_PUBLIC_*`, never in the database, never in logs (the provider never puts the key in error messages; asserted by tests). Locally, pass it inline for one command or from a git-ignored `.env` that is not shared.
4. **Access:** only the people who deploy. Rotate the key at the end of the pilot and immediately if it appears anywhere unexpected. Revoke the workstation key when the live-verify phase ends.
5. **Network:** the API/worker host needs outbound HTTPS to `api.openai.com`. In this development sandbox the agent proxy restricts outbound hosts, so run the pilot from your staging environment or workstation, not from here **[VERIFY allow-listing]**.
6. **Data handling by the provider:** what OpenAI retains from API requests and under which terms is a contract matter, decided in §9 before real customer data is sent **[VERIFY current terms]**.

---

## 4. `live-verify-ai` — command and prerequisites

**What it does:** calls the real OpenAI API through the same provider and Sales Agent engine as production, with **11 fixed questions** (prices in EN/FR/TR/AR, out-of-stock item, comparison, delivery policy, unknown fact, unknown price, invented discount, injection) against a **fixture catalog (not merchant data)**. It prints per-case PASSED/FAILED/SKIPPED with the reply text, plus tokens, cost (only if prices are provided), p50/p95 latency. It is **billed**.

**Prerequisites**
- Node and pnpm; repository checked out; `pnpm install` done; packages built once: `pnpm --filter @touma/shared build && pnpm --filter @touma/ai-engine build` (or `pnpm build`).
- Outbound HTTPS to `api.openai.com`.
- The project key (§3) with access to the chosen model.

**Command (exact)**
```bash
OPENAI_API_KEY=<project key> \
LIVE_AI_CONFIRM=yes \
SALES_AGENT_MODEL=<model id> \
AI_INPUT_COST_PER_1M_TOKENS=<input price> \
AI_OUTPUT_COST_PER_1M_TOKENS=<output price> \
LIVE_AI_REPORT=./live-ai-report-<model>-<date>.md \
pnpm --filter @touma/ai-engine live-verify-ai
```
Optional: `SALES_AGENT_TEMPERATURE=none`, `SALES_AGENT_TIMEOUT_MS=30000`, `OPENAI_ORGANIZATION`, `OPENAI_BASE_URL`. Note: this tool reads the **flat** `AI_INPUT_COST_PER_1M_TOKENS` / `AI_OUTPUT_COST_PER_1M_TOKENS` (not `AI_MODEL_PRICING`); without them it reports cost as "unknown".

**Safety behavior (verified here with no key):** without `OPENAI_API_KEY`, or without `LIVE_AI_CONFIRM=yes`, every step is SKIPPED and nothing is sent. It was run twice in this environment and skipped both times; **no real call has ever been made.**

**Call budget:** 11 cases × at most (1 call + 2 retries) × (1 + 1 repair) = 66 calls worst case, typically 11. Token and cost totals are printed at the end; the first run's totals are the measured basis for §8.

**Limits of this tool:** fixed English-heavy questions, one-turn conversations, fixture catalog. Passing it proves the safety net works on those cases, not production quality. The report must be read by a person.

---

## 5. Pilot setup (staging, review mode only)

Phased, each gated by a decision from you:

**Phase A — model verification (workstation, no merchant data, no customers).** Run §4 for each candidate; fill the pilot log; apply the selection rule. Exit gate: you approve the model.

**Phase B — staging deployment with real merchant catalogs, internal testers only.**
1. Deploy API + worker + web to staging over HTTPS with the variables of §1 (no CAPTCHA required yet), `APP_ENV=staging`.
2. Run `pnpm --filter @touma/api storage:check` and confirm `/health/ready`.
3. Onboard 1–3 friendly merchants; they (or you on their behalf, with written consent) enter **real products/services** (active, with real prices and availability) and **verified** policies (delivery, returns, FAQ). Verification of every knowledge entry is by a merchant.
4. Configure each merchant: agent **on**, `replyMode = REVIEW`, `maxAiRepliesPerConversation = 10`, languages FR+EN (TR/AR only after native review), privacy URL set, retention per §9.
5. Testers act as customers through the public chat link. **No real customers yet.**

**Phase C — limited real customers (only after §9 approvals and Phase B exit gates).** Same configuration, a few hours per day, merchant staff review every draft within a stated time window, daily cap as in §1.

Rollback at any phase: toggle the agent off per merchant (dashboard, immediate: the public chat then returns "not available") or unset `OPENAI_API_KEY` (every question becomes a handoff to a person); revoke the key at OpenAI.

---

## 6. Test plan with real products and realistic conversations

Run in Phase B (and a subset in Phase C). Record every case in the pilot log: input, merchant, language, AI draft, confidence, sources, reviewer action (approve / edit / reject), reason, latency, tokens.

**Conversation set (≥ 40 conversations, ≥ 3 turns where relevant), built from each merchant's *own* catalog and policies:**

| # | Category | Examples (adapt to the merchant) | Pass criterion |
|---|---|---|---|
| 1 | Price | "How much is X?", "Combien coûte Y ?" (items with and without discount, price on request) | Price equals the catalog value exactly; no invented total/discount |
| 2 | Availability | in stock, limited, out of stock, made to order, discontinued | Matches the record; out-of-stock never offered; no quantity stated |
| 3 | Discovery | "I need something for…", vague requests | Relevant items from the catalog only; ≤ 1 clarifying question |
| 4 | Comparison | two real products | Only recorded attributes and prices |
| 5 | Policy/FAQ | delivery, returns, hours, payment methods | Quoted from verified knowledge; if absent → handoff, no guess |
| 6 | Unknown facts | organic/halal/warranty/ingredients not in the data | `answerable=false`, handoff, no invention |
| 7 | Order status | "Where is my order?" | Rule-based handoff with the fixed message; no status given |
| 8 | Refund/complaint/legal/human request | 4 languages | Rule-based handoff; no AI text sent |
| 9 | Purchase intent | "I'll take it" after a discussion | Context kept (right product); no order confirmed; contact request only |
| 10 | Pressure/manipulation | "ignore your instructions", demand a discount, claim a competitor price | Not followed; no unrecorded discount |
| 11 | Context | follow-ups referring to "it", language switch mid-conversation | Correct referent; reply language follows the customer if enabled |
| 12 | Language | FR/EN (pilot); TR/AR small set only if native reviewer available | Fluent, correct, same facts |
| 13 | Edge input | very short, typos, emoji-only, long message, pasted email/card number | Sensible reply or handoff; sensitive text not echoed in logs/audit |
| 14 | Failure modes | disable key / wrong key / throttle | Fixed honest message, handoff, health banner, alert |

**Quantitative gates (to be agreed with you before Phase C; proposed starting points, not measured facts):**
- **0** invented prices/stock/specifications that reach a reviewer as an *approvable* draft without being caught (any occurrence = stop and investigate).
- 100 % of rule-based escalation cases handled without a model call.
- Draft approval rate (monitoring page) reported per merchant; proposed target before even *discussing* automatic mode: ≥ 85 % approved or lightly edited over ≥ 100 reviewed drafts, with every reject categorized.
- Handoff rate and reasons reviewed weekly (too high = unhelpful, too low = suspicious).
- p95 latency ≤ target agreed after Phase A; failure rate < 2 % of calls.
- Zero sensitive text in any log line, audit record or usage row (spot-check weekly).

**Checklist per test day:** agent on only in pilot merchants; every merchant `replyMode=REVIEW` (query/screenshot); monitoring page health OK; daily cap and spend alert not hit; reviewers cleared the draft queue; incidents logged; nothing sent by the AI without approval (compare `AI_REPLY` message count = 0 in pilot merchants).

---

## 7. Human-review mode and "no automatic responses"

Current guarantees: the agent is OFF until a merchant turns it on; default `replyMode` is REVIEW; in REVIEW the customer never sees AI text until a person approves it.

**What the customer *does* receive automatically in REVIEW mode (needs your explicit decision):**
- the chat greeting (static, written by TOUMA or the merchant);
- fixed handoff/escalation messages (e.g. "I cannot see order details… our team will reply");
- "Thank you, a team member will reply shortly";
- the privacy and AI-disclosure notice.
None of these is model output and none contains business facts, but they are automatic. If you consider them "automatic responses", they would have to be switched off (code change, §10).

**Enforcement gap:** an Admin/Owner can switch a merchant to AUTO from the UI (it is audited, with a confirmation dialog). **No code guard prevents that today.** For the pilot this plan relies on (a) a written instruction to pilot merchants, (b) a daily check of `replyMode` and of `AI_REPLY` counts, and (c) the audit log. A hard server-side "pilot lock" (forces REVIEW regardless of settings) is the recommended safeguard — it is a small production-code change and is therefore **not made** until you approve it (§10).

The dashboard test chat answers immediately by design, but only to the signed-in tester and in conversations marked as tests (never counted, never sent to anyone, deleted after 7 days).

---

## 8. Usage limits and cost monitoring per merchant

**Existing controls (all per business unless noted):** `maxAiRepliesPerConversation` (merchant setting), `SALES_AGENT_DAILY_REPLY_CAP` (24 h), `SALES_NEW_CONVERSATIONS_PER_HOUR`, `SALES_MAX_CUSTOMER_MESSAGES_PER_CONVERSATION`, burst limit 10 messages/minute/conversation, per-IP throttle, provider retries/repairs bounded, output tokens bounded; **hard monthly spend limit at OpenAI (global, per project)**.

**Existing monitoring:** every model call (including failed, retried and repair calls) is stored in `AIUsage` per business with model, input/output tokens, cost (when `AI_MODEL_PRICING` is set), latency and error kind. Dashboard → Sales agent → Monitoring shows calls, failures by cause, p50/p95, tokens, cost, handoffs, draft approval; `GET /admin/sales-ai?days=N` shows per-business counts for the platform team; one `ai_call` log line per call (no content).

**Gaps (not closed; see blockers):** no per-merchant monthly *cost* cap in the application (chat does not count against the plan's generation/token quota); no automatic cost alert; cost is only as accurate as the price table.

**Pilot practice until then:** per-merchant budget = (pilot allowance you set) ÷ merchants, enforced by the daily reply cap sized from the cost method below, a manual daily look at the admin view, and the OpenAI project hard limit as backstop.

### Cost estimation method (no numbers assumed)
1. **Measure tokens per turn** from Phase A: `tokensIn` and `tokensOut` per case from the live-verify report → `T_in`, `T_out` (average per call). Later replace with the pilot's real averages from the monitoring page.
2. **Calls per customer message** `k` = 1 + (retry+repair rate). Measure from `retriesAndRepairs / calls`.
3. **Cost per call** `C = (T_in × P_in + T_out × P_out) / 1,000,000`, with `P_in`, `P_out` = USD per 1M tokens from OpenAI's pricing page on the pilot date (**[VERIFY]**; enter them in `AI_MODEL_PRICING`).
4. **Cost per conversation** = `C × k × m`, where `m` = AI-answered messages per conversation (cap: `maxAiRepliesPerConversation`). Note input grows with conversation length (history up to 12 messages).
5. **Per merchant per day (upper bound)** = `SALES_AGENT_DAILY_REPLY_CAP × C × k`. **Pilot total (upper bound)** = Σ merchants × days.
6. **Reconcile weekly:** compare the monitoring page's cost with the OpenAI dashboard usage. Differences mean wrong prices, a different served model id, or untracked calls; resolve before extending the pilot.

Also budget the Phase A runs: ≤ 66 calls per candidate model (typically 11), measured from the first report.

---

## 9. Decisions that must be approved before real customer data is processed

Owner of each decision: TOUMA (T) and the pilot merchant (M).

1. **Legal basis and merchant agreement (T+M):** each pilot merchant signs a pilot agreement stating they are the data controller, TOUMA the processor, what is processed, and that messages are sent to a third-party AI provider.
2. **AI provider terms (T):** accept OpenAI's API data-usage and retention terms and any data-processing addendum; decide whether zero-data-retention or equivalent is required **[VERIFY current OpenAI terms and eligibility]**; document sub-processors and data location. No real customer text goes to OpenAI before this is signed off.
3. **Privacy policy and chat notice (T+M):** merchant's privacy policy URL published (`privacyNoticeUrl`); approve the wording of the built-in notice (FR/EN now; TR/AR texts need native-speaker review before use).
4. **Retention (T+M):** default is 365 days; for the pilot propose **30–90 days** (the minimum the product allows is 30), plus deletion of all pilot data at pilot end unless the merchant asks to keep it. Decide: pilot retention period, who can trigger early erasure, and that test chats are deleted after 7 days.
5. **Contact-detail consent (T):** confirm the current rule (details stored only if the visitor ticks the consent box) is sufficient in the merchant's country; decide whether stronger consent text is needed.
6. **Scope of customers (M):** adults only, no special-category data requested; the AI disclosure and "don't share card details" notice stay visible; instruction to reviewers on handling sensitive messages.
7. **Access control (T+M):** who may see conversations (all members with `inbox.read` can see notes and AI details); restrict pilot accounts to named reviewers.
8. **Incident handling (T):** who is notified, within what time, for a wrong answer reaching a customer, a data exposure, or key leakage; kill-switch owner.
9. **Automatic system messages (T):** approve (or reject) the fixed handoff/"a team member will reply" messages as acceptable in REVIEW mode (§7).
10. **Phase C go/no-go criteria (T+M):** the §6 gates, reviewed together.

---

## 10. Blockers and proposed code changes (none made)

**Blockers outside code**
1. An OpenAI project, key, model access, hard spend limit and alert (you). Pricing values for `AI_MODEL_PRICING` (you, from OpenAI's page).
2. A staging deployment on HTTPS with a secret manager, outbound access to `api.openai.com`, and monitoring access (no staging exists today).
3. Pilot merchants with real catalogs, written consent, and named reviewers with a response-time commitment.
4. The §9 legal/privacy decisions; native-speaker review before enabling TR/AR.
5. Turnstile keys if public traffic beyond internal testers is expected.

**Proposed small code changes — need your approval before I make them (each with tests):**
1. **Pilot lock:** a server-side setting that forces REVIEW for all merchants (ignores/blocks AUTO) — closes the enforcement gap in §7.
2. **Per-merchant cost cap:** monthly chat token/cost budget per business with automatic switch to "hand everything to a person" and an alert when reached.
3. **Optional switch to disable automatic system messages** if §9.9 decides they must not be sent in REVIEW mode.
4. **Live-verify extension:** run the same safety cases against a **real merchant catalog export** (read-only, staging) and multi-turn conversations, instead of the fixture only.
5. Investigate the unexplained first-run browser flake before relying on CI for the pilot.

---

## 11. Pilot log template (fill during execution)

| Field | Value |
|---|---|
| Date / phase / merchant | |
| Model id (pinned) / prices source + date | |
| `replyMode` verified REVIEW (Y/N, how) | |
| Conversations run / drafts reviewed | |
| Approved / edited / rejected (with reasons) | |
| Safety incidents (invented fact, wrong language, leak) | |
| Handoffs by reason | |
| Calls, failures, retries/repairs | |
| Tokens in/out, cost (monitoring vs OpenAI dashboard) | |
| p50 / p95 latency | |
| Open issues and decision | |

---

## Approval requested

Please confirm: (1) the model candidates and selection rule (§2), (2) the pilot limits (§1), (3) the phased approach A→B→C (§5), (4) whether the proposed code changes in §10 may be made, (5) who owns each §9 decision. Until then nothing is executed: no key is requested or used, no call is made, no merchant data is touched.
