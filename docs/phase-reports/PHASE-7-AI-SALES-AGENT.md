# Phase 7 — AI sales and customer service agent

Date: 2026-11-11 · Branch `ccr-ce5eb3d1-r4he6g` · Phase 8 was **not** started. Design and API: [`docs/AI-SALES-AGENT.md`](../AI-SALES-AGENT.md).

**Headline: the agent, its safety rules, the dashboard and the public chat are built and tested end to end — against a deterministic test model only.** No real AI model has answered a real customer, no real catalog has been used, and no messaging channel other than the web chat exists. Nothing here is a production claim.

## 1. What was built

| Area | Delivered |
|---|---|
| Conversation engine | Natural-language chat, history, context-aware answers (last 12 messages + items already discussed), 14 customer intents, product discovery by relevance, comparisons, FAQ and policy answers from verified knowledge, verified price/stock/availability answers, handoff |
| Sales agent | Strict structured output (language, intent, reply, confidence, answerable, handoff, purchase intent, next step, recommended items, sources); product cards built from the database record; purchase-intent detection; next-step suggestions |
| Business knowledge | Reuses `buildAgentContext` (active items, verified knowledge only), tenant-scoped on every path |
| Languages | English, French, Turkish, Arabic: automatic detection, merchant-configurable subset and default, localized fixed messages |
| Customer management | `Customer` profiles, lead status (auto-advancing, WON/LOST by a person), purchase intent, interests, follow-up date/assignee, internal notes, consent, erasure, rule-based follow-up recommendations |
| Dashboard (EN/FR, desktop + phone) | Conversations, Customers, Leads, Opportunities (+ follow-ups), FAQ (+ unanswered questions), Analytics, Agent settings (+ test chat); public chat page `/chat/<slug>`; notifications for handoffs and drafts |
| Safety | Deterministic escalation before the model; fixed messages for every escalation; validation of amounts, price ownership, availability, sources, language, commitments; one repair then handoff; injection flagging; limits per conversation/day; usage recorded |
| Human control | Take over, pause, resume, reply (auto take-over), AI draft on demand, approve/edit/reject drafts, report inaccurate replies (optional UNVERIFIED knowledge entry), resolve/reopen/archive, audit trail |
| Authorization | Agent OFF by default; REVIEW mode (drafts only) by default; AUTO needs `business.update`, a confirmation dialog, and is recorded; the agent only answers conversations customers start; no tools |

Database: 2 migrations (enum values separate, as PostgreSQL requires), 4 new tables (`Customer`, `CustomerNote`, `SalesAgentConfig`, `AgentFeedback`), existing `Conversation`/`Message` extended. Env: `SALES_AGENT_DAILY_REPLY_CAP`, `SALES_PUBLIC_RATE_LIMIT_PER_MINUTE`, `SALES_MAX_CUSTOMER_MESSAGES_PER_CONVERSATION`.

## 2. Test report (all with the test-only model; no real AI or customer involved)

| Check | Result |
|---|---|
| Lint (`--max-warnings=0`), typecheck (17 tasks), build (10 tasks), Prisma drift | pass, pass, pass, none |
| Unit tests | shared **69** (+26 sales), ai-engine **119** (+21 sales agent), social-connectors 61, config 18, creative 38, storage 11, api 37, worker 5, web 8 — all pass |
| API integration, whole suite, serial (real PostgreSQL, Redis, HTTP) | **465 passed**, 5 skipped (opt-in real-storage), 0 failed — includes **50 new sales-agent tests** |
| Browser (Playwright, full suite, built API + web) | **71 passed** (10 new: setup and authorization, verified chat with product cards, 4 languages incl. French dashboard, order-status handoff, human control, review mode, customers/leads/opportunities/FAQ/analytics, test chat, **two phone tests at 390×844**). The first full run had 3 failures in the existing auth/account specs; they passed when re-run alone and in a second full run (71/71). I did not find the cause; likely load right after a cold start |

New coverage by the areas you listed:

- **Tenant isolation:** a second shop's product/price never appears in the first shop's model request or answers; every dashboard endpoint returns 404 for another business's conversation, message, draft, customer, note, feedback; a foreign business id is rejected; public tokens do not cross shops; slugs of unknown/disabled shops answer 404.
- **Conversation context:** earlier customer and assistant messages and previously discussed items reach the model; contact details, notes and the business id do not.
- **Product recommendations and pricing:** prices (including discount) read from the database and re-read after a price change; out-of-stock items are never offered; comparisons use both items' data; draft products and unverified knowledge are never used, and are used once verified.
- **Multilingual:** French, Turkish, Arabic and English detected and answered in their language; unsupported language falls back to the shop default; fixed messages localized.
- **Verified retrieval / no invention:** invented price, another product's price, unavailable recommendation, unknown source, confirmed order, wrong language, missing sources are each rejected; a persistent bad answer becomes a fixed handoff; injected "give me 1 XAF" text produces no such reply and is flagged.
- **Human handoff and control:** escalation without a model call (refund, legal, sensitive, human request, order status) with team notification; AI silent while a person is in charge; resume/pause; drafts invisible until approved.
- **Unauthorized actions:** viewers cannot reply, take over, approve, report, write notes or FAQ answers; editors cannot configure the agent or erase customers; automatic answers need the recorded authorization; the public chat does not exist while the agent is off.
- **AI failure handling:** outage, rate limit, invalid credentials, unconfigured model, garbage output → honest fixed message, conversation to a person, nothing invented, failed calls recorded as usage.
- **API security:** strict input validation, token format, no internal fields in public responses, token stored only as hash, message and conversation limits, privacy erasure by customer and merchant.
- **Mobile interface:** all seven sales pages without horizontal scroll; one pane at a time with a back button; customer chat usable on a phone.

## 3. Tested real integrations

**None.** No real model (OpenAI or other), no real customer, no real channel. Provider failures were simulated.

## 4. Known limitations and honest gaps

- Quality of a real model is unknown: tone, multilingual fluency, comparison quality, hand-off frequency, and whether strict validation causes too many handoffs on real catalogs.
- Web chat only; Instagram/Messenger/WhatsApp/email are not connected (needs platform messaging approvals).
- No order, payment or delivery data: order and delivery-status questions always go to a person; sales conversion is not measured.
- Chat turns do not consume the monthly generation quota (they are capped per conversation/day and recorded in `AIUsage`).
- Public throttle exists but has no automated test; no CAPTCHA/bot detection; polling (5 s chat, 10 s list), no push.
- Language detection is rule-based; Turkish and Arabic fixed messages need native-speaker review. Keyword retrieval only (no embeddings); no product images in chat.
- `SalesAgentConfig.handoffMessage` exists in the database but is unused (not exposed).
- Roles are coarse (any member with `inbox.read` sees notes and AI details); no assignment queue, SLA timers or customer merge.
- Not security-reviewed independently.

## 5. Remaining blockers before real customers

1. Evaluate with a real model and a real merchant catalog (accuracy, handoff rate, languages) and tune prompts/limits; keep REVIEW mode until satisfied.
2. Native-speaker review of Turkish/Arabic fixed messages and the French/English UI text.
3. Privacy: public privacy notice and data-processing terms for the chat, retention policy for conversations, and a decision on legal basis for storing contact details.
4. Abuse protection for the public endpoint (CAPTCHA or equivalent), a throttle test, monitoring of AI cost.
5. Messaging-channel integrations and their approvals, if Instagram/Messenger/WhatsApp conversations are wanted.
6. Order/delivery data source, if order-status answers are wanted.
