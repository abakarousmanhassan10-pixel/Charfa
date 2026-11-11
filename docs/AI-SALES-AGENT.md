# TOUMA AI sales and customer service agent (Phase 7)

The agent talks to a merchant's customers on a public chat page, in English, French, Turkish or Arabic. It helps visitors find products, answers questions, compares items and identifies purchase intent, **using only the merchant's own verified data**. Anything it cannot answer reliably, and anything sensitive, goes to a person.

> **What this is not.** The agent has no tools. It cannot place orders, take payments, send messages outside its conversation, publish, or look at orders and shipments (TOUMA has no order data). Only the simulated model has been exercised so far: **no real AI model, no real customer and no real channel (Instagram DM, Messenger, WhatsApp) has been tested.** See the limitations at the end.

## 1. Architecture

```
 visitor browser ──HTTPS──▶ /api/v1/public/chat/:slug/…   (public, throttled, token per conversation)
                                   │
                                   ▼
                      SalesPublicService ──▶ SalesAgentService.handleCustomerMessage
                                                 │ 1 person in charge? (AI paused / human)  → nothing generated
                                                 │ 2 deterministic escalation rules          → fixed message + handoff (no model call)
                                                 │ 3 limits (per conversation, per day)      → handoff
                                                 │ 4 KnowledgeService.buildAgentContext(tenant)  (verified, active, tenant-scoped)
                                                 │   selectRelevantItems → runAgent(salesAgent)  (@touma/ai-engine)
                                                 │   schema + grounding + sales validation, one repair
                                                 │ 5 uncertain / failed → handoff with a FIXED message
                                                 ▼
                            Message (AI_REPLY sent | AI_SUGGESTION draft), Customer, Conversation, AIUsage, Audit, Notification
 merchant dashboard ──▶ /api/v1/sales/…   (tenant guard + permissions)
```

Packages and where things live:

| Piece | Location |
|---|---|
| Language detection (en, fr, tr, ar), escalation rules, fixed multilingual messages | `packages/shared/src/sales.ts` |
| Sales agent (prompt, strict output schema, validation), product retrieval, fake model answers for tests | `packages/ai-engine/src/agents/sales-agent.ts`, `retrieval.ts`, `testing/fake-provider.ts` |
| Pipeline, dashboard operations, customers, insights, public chat | `apps/api/src/sales/` |
| Dashboard and public chat | `apps/web/components/sales/`, `apps/web/app/(app)/dashboard/sales/`, `apps/web/app/chat/[slug]/` |

The existing, previously unused `Conversation` and `Message` tables were extended (not replaced). Existing AI context (`KnowledgeService.buildAgentContext`), the agent engine (`runAgent`), grounding checks, usage records, notifications, audit log, roles and the tenant guard are reused.

## 2. Safety model

| Requirement | How it is enforced |
|---|---|
| Only the current business's verified data | The model receives `buildAgentContext(businessId)`: ACTIVE products and services, VERIFIED knowledge only (draft products and unverified entries are never included). `businessId` comes from the public slug or the signed-in membership, never from the message body. The prompt is built per request; only items relevant to the question are sent (`selectRelevantItems`) |
| Tenant isolation | Every query carries `businessId`; a public token resolves to one conversation of the shop in the URL (`publicTokenHash`, SHA-256); other shops' ids return 404; dashboard routes use the tenant guard (a foreign business id returns 404, not 403) |
| Never invent prices, stock, specifications | Prompt rules + validation: every amount must be a real price (grounding), **and** must belong to the item named in the same sentence (`misattributedPrices`); recommended items must exist and must not be OUT_OF_STOCK / DISCONTINUED / UNAVAILABLE; every cited source must exist. Product cards shown to customers are built from the database record, not from the model's text. Invalid output is repaired once, then becomes a handoff |
| Never fabricate order statuses | There is no order data. Order/tracking questions are detected by rules **before** the model and answered with a fixed message plus handoff; the validator also rejects a model answer to an order-status intent without handoff, and replies that confirm or promise orders/bookings/guarantees |
| Escalation | Rules (refund, legal, sensitive/complaint, order status, "I want a person") in 4 languages; plus model-reported handoff, low confidence, unanswerable, provider/model failure, per-conversation and daily limits. **Escalated cases never send model text**: the customer receives a fixed, human-written message in their language |
| No messages or purchases without authorization | The agent is OFF by default. Reply mode `REVIEW` (default): the AI only writes drafts, nothing is visible to the customer until a person approves (optionally edited). Mode `AUTO` needs `business.update`, an explicit confirmation, and records who and when (`autoReplyAuthorizedById/At`, audit `sales.auto_reply_authorized`). The agent only answers conversations the customer started. Fixed system notes ("a team member will reply") contain no business facts and are shown in both modes |
| Prompt injection | Customer text is sanitized and delimited as data (`‹ ›` for angle brackets), injection phrases are flagged and shown to the merchant, and a reply that follows an injected instruction fails validation (unrecorded discounts or prices) |
| Privacy | Contact details are stored only with explicit consent; internal notes and customer contact data are never given to the model; customers can erase their data from the chat, merchants with `business.update` can erase a customer (contact, notes, message texts); an AI disclosure and a "don't share passwords or card details" notice are shown in the chat |
| Abuse and cost | Per-IP throttle on public routes (`SALES_PUBLIC_RATE_LIMIT_PER_MINUTE`), message length 2,000, 60 customer messages per conversation (`SALES_MAX_CUSTOMER_MESSAGES_PER_CONVERSATION`), AI replies per conversation (configurable, default 30), AI replies per business per day (`SALES_AGENT_DAILY_REPLY_CAP`, default 500). Every model call (failed ones too) is recorded in `AIUsage` with agent `CUSTOMER_SUPPORT` |

Roles: `inbox.read` (every member) reads; `inbox.reply` (Editor and above) takes over, replies, approves drafts, edits customers and notes, reports inaccuracies; `ai.use` runs the test chat; `knowledge.write` adds FAQ answers; `business.update` (Admin, Owner) configures the agent (including AUTO) and erases customers.

## 3. Conversation engine

- **Language**: `detectLanguage` (script and stopword scoring; Arabic needs only a quarter of the letters so Latin product names do not hide it). Reply language = the customer's if the merchant enabled it, else the previous one, else the shop default. Merchants choose the languages (subset of en, fr, tr, ar) and the default.
- **Context**: the last 12 messages (customer, AI replies, approved drafts, human replies) go to the model with the items already discussed, so "I'll take it" refers to the right product.
- **Intent**: 14 intents (greeting, product, comparison, price, availability, purchase intent, order status, delivery, return/refund, policy, complaint, human request, small talk, other) and purchase intent NONE/LOW/MEDIUM/HIGH, stored per conversation and customer.
- **Next steps**: ask one clarifying question, share a product link (only if the record has a URL), suggest booking, collect contact details, hand off.
- **Lead status** (`NEW → ENGAGED → QUALIFIED → OPPORTUNITY`, `WON`/`LOST`) advances automatically from messages, product interest, purchase intent and shared contact details; it never moves backwards and never leaves WON/LOST (a person decides those).

## 4. Human handoff and control

Take over (AI stops, pending drafts rejected, customer sees "you are now talking with a team member"), pause, resume (agent must be on), mark resolved/reopen/archive, reply as a person (a reply takes the conversation over automatically so the AI and a person never answer at once), ask the AI for a draft during a takeover (never sent by itself), approve/edit/reject drafts, **report an inaccurate AI reply** (records what was wrong and the correct information; optionally creates an UNVERIFIED FAQ knowledge entry that the agent uses only after verification), internal notes. Every action is in the audit log.

## 5. Dashboard (Sales agent, EN/FR)

Conversations (two-pane on desktop, one pane at a time with a back button on phones; filters, search, AI details: confidence, sources, product cards, handoff reason, injection flags), Customers (profile, lead stage, follow-up date, notes, erase), Leads (board by stage), Opportunities and follow-up recommendations (rule-based: waiting handoffs, drafts to review, cold opportunities, due follow-ups, open corrections), FAQ (verified answers, questions the agent could not answer grouped by text, "write the answer" → unverified FAQ entry), Analytics (counted from stored conversations, no estimates), Agent (configuration, public link, test chat). The customer chat is `/chat/<business slug>`.

## 6. API

Dashboard (`Authorization` + `X-Business-Id`): `GET/PUT /sales/agent`; `GET /sales/conversations`, `GET /sales/conversations/:id`; `POST /sales/conversations/:id/{takeover,pause,resume,resolve,reopen,archive,reply,suggest}`; `POST /sales/messages/:id/{approve,reject,feedback}`; `POST /sales/feedback/:id/resolve`; `POST /sales/playground`; `GET /sales/customers[/:id]`, `PATCH /sales/customers/:id`, `POST /sales/customers/:id/notes`, `DELETE /sales/customers/:id/notes/:noteId`, `DELETE /sales/customers/:id` (erase); `GET /sales/{leads,opportunities,follow-ups,faq,analytics}`; `POST /sales/faq/drafts`.
Public: `GET /public/chat/:slug`, `POST /public/chat/:slug/messages` (no token = new conversation, token returned once), `GET /public/chat/:slug/messages?token=`, `DELETE /public/chat/:slug/data?token=`.

## 7. Database changes (migrations `20261115085900_sales_agent_enums`, `20261115090000_sales_agent`)

- Enums: `ConversationChannel + WEB_CHAT`, `MessageAuthorType + AI_REPLY`, new `AgentMode`, `LeadStatus`, `PurchaseIntent`, `AgentReplyMode`, `FeedbackStatus`.
- `Conversation`: `customerId`, `language`, `aiMode`, `isTest`, `publicTokenHash`, `intent`, `purchaseIntent`, `handoffReason`, `handoffRequestedAt`, `humanTakeoverById`, `aiRepliesCount`. `Message`: `language`, `intent` (and `aiMetadata` for confidence, sources, cards, handoff).
- New: `Customer`, `CustomerNote`, `SalesAgentConfig` (one per business, OFF by default; `handoffMessage` exists but is not used yet), `AgentFeedback`.

## 8. Tests

See `docs/phase-reports/PHASE-7-AI-SALES-AGENT.md` for the results. Coverage: language detection, escalation rules and fixed messages (unit); the sales agent against tampered/invented/unsafe model answers, repair, injection, retrieval (unit); 50 API integration tests (tenant isolation, context, recommendations and comparisons, 4 languages, verified-only data, handoff, human control, review mode, authorization, AI failures, privacy, API security); browser tests on desktop and a 390×844 phone, in English and French.

## 9. Limitations and remaining work

- **No real model has been tested.** Behavior was verified with a deterministic test model plus scripted bad answers. Real-model quality (tone, comparisons, multilingual fluency, how often it hands over) must be evaluated with real credentials and real catalogs before launch.
- **Web chat only.** Instagram DMs, Messenger, WhatsApp and email are not connected: that needs each platform's messaging API approval (see `docs/SOCIAL-PLATFORM-APPROVALS.md`) and webhooks.
- **No order, payment or delivery data**: order and delivery-status questions are always handed to a person; conversion to sales is not measured.
- Chat turns are cost-capped (per conversation/day) and recorded in `AIUsage`, but they do **not** consume the monthly generation quota of the plan.
- Public throttling is configured but not covered by an automated test; there is no CAPTCHA or bot detection.
- The chat polls every 5 seconds (no push/websocket); no typing indicator; no attachments or voice.
- Language detection is rule-based and can be wrong on very short or mixed messages (it then falls back to the previous or default language). Turkish and Arabic fixed messages were written by hand and should be reviewed by native speakers.
- Retrieval is keyword-based; very large catalogs may need embeddings. Product images are not shown in the chat.
- Notes, drafts and AI details are visible to every member with `inbox.read`.
- The conversation list refreshes by polling (10 s); no assignment queue or SLA timers.
