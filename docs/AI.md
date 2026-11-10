# TOUMA AI engine

*Your Business. Your AI Marketing Team.*

## Agents
| Agent | Task | Output (strict JSON schema) | Prompt version |
|---|---|---|---|
| Business Analyst | `BUSINESS_ANALYSIS` | industry, positioning, geographic market, brand identity, communication style, target segments, customer needs, **sourced** strengths, objectives, priority platforms, missing information, assumptions | `business-analyst@1` |
| Product Analyst | `PRODUCT_ANALYSIS` | **sourced** characteristics and verified benefits, customer problems, segments, positioning, marketing angles, differentiation, objections (with `needsBusinessInput`), FAQ (answer `null` when not in the data) | `product-analyst@1` |
| Marketing Strategist | `MARKETING_STRATEGY` | per platform: objective, audience, content pillars, valid formats, posting frequency, weekly plan, KPIs; campaigns, 4-week monthly plan, promotional ideas, CTAs | `marketing-strategist@1` |
| Content Creator | `CONTENT` | title, hook, caption, description, slides, scenes, story frames, hashtags, CTA, visual suggestions, **claims with sources**, warnings | `content-creator@1` |

Code: `packages/ai-engine/src/agents/*`. Schemas: `packages/ai-engine/src/schemas.ts`.

## Orchestration (`apps/api/src/ai/orchestrator.service.ts`)
1. **Retrieve authorised data**: `KnowledgeService.buildAgentContext(tenant)`. This is one business only, verified knowledge plus ACTIVE products and services. Drafts are never used.
2. **Analyse the business**: reuses the latest business analysis whose context hash matches the current facts; otherwise runs the Business Analyst.
3. **Analyse the product** (when content is about an item): same reuse rule, per item.
4. **Select the strategy angle**: rotates through the product analysis's marketing angles; otherwise uses a content pillar of the latest strategy for that platform; otherwise relies on the business profile.
5. **Generate**: Content Creator with platform rules in the prompt.
6. **Validate**:
   - the Zod schema;
   - grounding (prices, percentages, risky claims, URLs and source ids must exist in the data);
   - platform rules (lengths, hashtags, slides, frames, video duration, required sections);
   - output language;
   - leak checks.
7. **Save**: one `AIGeneration` row, plus one `AIUsage` row per provider call (initial call, provider retries, repairs).
8. **Return**: the validated output, the token usage and the pipeline steps (`done` / `reused` / `skipped`).

**Retries.**
- Transient provider errors (429, 5xx, timeout, network) are retried with exponential backoff and jitter (`AI_MAX_PROVIDER_RETRIES`).
- An invalid answer triggers a *repair* call that contains the validation feedback (`AI_MAX_REPAIR_ATTEMPTS`).
- Auth errors, refusals and truncation are never retried.
- Every call is billed and recorded, including failed ones.

## Platform adaptation (`packages/shared/src/ai.ts → FORMAT_RULES`)
| Platform | Formats | Key limits enforced |
|---|---|---|
| Instagram | Caption, Reel script, Story, Carousel | caption ≤ 2,200 chars, ≤ 30 hashtags, carousel 2–10 slides, story 1–10 frames, Reel 7–90 s |
| Facebook | Promotional post, Educational post, Product announcement | ≤ 5,000 chars (practical), ≤ 5 hashtags, announcement title ≤ 120 |
| TikTok | Short video script (hook, scenes, on-screen text, CTA) | 7–60 s, caption ≤ 2,200, ≤ 8 hashtags |
| YouTube | Video title + description, Shorts script | title ≤ 100, description ≤ 5,000, ≤ 15 hashtags, Shorts 7–60 s |
| Any | Product description, Ad copy, Promotional message | no hashtags; short headline/body limits |

Languages: English, French, Turkish, Arabic (output). Arabic content is edited right-to-left in the UI.

## Safety and quality
- **Data isolation**: the context is built from the verified `TenantContext`, and product analysis receives only the analysed item. Tests assert that other tenants' names never appear in prompts.
- **Prompt injection**:
  - System prompts contain only TOUMA-authored text.
  - Business data and user guidance are sent as JSON inside `<business_data>` / `<user_instructions>` blocks, with angle brackets neutralised so data can't close a block.
  - Control and bidi characters are stripped and lengths capped (guidance ≤ 500 chars).
  - Known injection phrasings are flagged on the generation (`injectionFlags`) and audited (`ai.injection_flagged`).
- **No actions**: agents have no tools or function calling. Output is stored, and becomes a **DRAFT** only when a human clicks "Save draft". Nothing is ever published.
- **No fabricated claims**: prices, discounts and percentages, "free delivery", guarantees, refunds, certifications or organic claims, rankings, awards and URLs are rejected unless present in the business data. Facts must cite a valid source id, and missing facts are reported in `missingInformation`.
- **Human edits** to drafts are validated against the same schema and platform limits. The original AI output is kept.

## Configuration (environment only; no credentials in code)
| Variable | Default | Purpose |
|---|---|---|
| `AI_PROVIDER` | `openai` | provider (`fake` = deterministic test-only provider, refused unless `APP_ENV=test`) |
| `OPENAI_API_KEY` | — | required for real generations; without it every AI endpoint returns `503 AI_NOT_CONFIGURED` |
| `OPENAI_BASE_URL`, `OPENAI_ORGANIZATION` | — | optional (proxy/Azure-compatible gateway, org header) |
| `AI_MODEL` | `gpt-4o-mini` | any model supporting Structured Outputs (`json_schema`, `strict`) |
| `AI_TEMPERATURE` | per agent (0.3 / 0.3 / 0.6 / 0.8) | global override, 0–2 |
| `AI_MAX_OUTPUT_TOKENS` | 4000 | per call |
| `AI_TIMEOUT_MS` | 90000 | per call |
| `AI_MAX_PROVIDER_RETRIES` / `AI_MAX_REPAIR_ATTEMPTS` | 2 / 1 | resilience |
| `AI_MONTHLY_GENERATIONS_PER_BUSINESS` / `AI_MONTHLY_TOKENS_PER_BUSINESS` | 300 / 3,000,000 | generation limits (checked before every provider call) |
| `AI_RATE_LIMIT_PER_MINUTE` | 10 | per-client throttle on generation endpoints |
| `AI_INPUT_COST_PER_1M_TOKENS` / `AI_OUTPUT_COST_PER_1M_TOKENS` | 0 | cost tracking. Set them from your provider's price list; 0 shows "price not configured" |

Adding a provider means implementing `TextModelProvider` (`generate()` returning raw JSON text and token counts; errors mapped to `ProviderError` kinds) and registering it in `createTextProvider`.

## Token consumption reports
- `GET /api/v1/ai/usage?days=30`: provider calls, input and output tokens, estimated cost, generations succeeded/failed, breakdowns by task, agent, model and day, and month-to-date usage against the limits.
- Every generation also reports its own `usage` (tokens, cost, latency, attempts).
- Token counts are **measured** values returned by the provider. Costs are **estimates**: tokens × the prices you configure.

## API
| Endpoint | Permission |
|---|---|
| `GET /ai/status` | `content.read` |
| `POST /ai/business-analysis` · `/ai/product-analysis` · `/ai/marketing-strategy` · `/ai/content` | `ai.use` (EDITOR+) |
| `GET /ai/generations` · `/ai/generations/:id` · `/ai/generations/latest/:task` | `content.read` |
| `POST /ai/generations/:id/regenerate` | `ai.use` |
| `POST /ai/generations/:id/draft` | `content.write` |
| `GET /ai/usage` | `content.read` |

All require `X-Business-Id` (membership verified).

Error codes:
- `AI_NOT_CONFIGURED` 503
- `AI_LIMIT_REACHED` / `AI_TOKEN_LIMIT_REACHED` 429
- `AI_INVALID_OUTPUT` 422
- `AI_PROVIDER_AUTH` 502
- `AI_PROVIDER_RATE_LIMIT` 503
- `AI_PROVIDER_TIMEOUT` 504
- `AI_PROVIDER_ERROR` 502
- `ITEM_NOT_ACTIVE` 400
- `ITEM_NOT_FOUND` 404

Failed generations return their `generationId`.
