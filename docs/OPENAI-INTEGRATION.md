# OpenAI engine integration (phase N23)

OpenAI is the main AI provider of the agents inside TOUMA. Merchants use the agents from TOUMA's own screens. Claude Code is only the development tool.
Nothing here was run against the real OpenAI API: every test uses a built-in mock of the OpenAI HTTP API, so nothing was sent or billed.

## 1. Audit (what existed, what was missing)
| Area | Before N23 | After N23 |
|---|---|---|
| Provider | `OpenAIProvider` existed, using Chat Completions through `fetch` | Official OpenAI SDK + **Responses API**, Structured Outputs (strict), `store: false` |
| Models | one `AI_MODEL` (and `SALES_AGENT_MODEL`) | per task through `AI_TASK_MODELS`, default `AI_MODEL`; no model name in the code |
| Orchestrator, quotas, token reservation, timeouts, bounded retries, audit | present | unchanged, reused by every new capability |
| Prompt-injection defense, grounding on verified data | present (`safety.ts`, `grounding.ts`) | reused; the campaign analyst adds its own checks |
| Product analysis, descriptions, copy, strategy, storyboard, plan, sales chat | present | now run on the Responses API |
| Audience suggestion | a section of product analysis | named entry point `suggestAudience()` |
| Campaign analysis | missing | new agent `CAMPAIGN_ANALYSIS` (explains platform figures only) |
| Mock for tests | a fake that skips the SDK | `MockOpenAIProvider`: the real SDK against a mock OpenAI server |
| Exhausted OpenAI credit | treated like a rate limit (retried) | its own non-retried error `AI_PROVIDER_QUOTA` |

Why analysis and descriptions "did not work" on the demo: see `AI-DIAGNOSTIC.md` (sleeping free API, draft products, a hashtag bug, simulated provider).

## 2. Architecture
```
Browser (TOUMA screens)  ->  NestJS API  ->  AiOrchestratorService  ->  OpenAIProvider (official SDK)  ->  OpenAI Responses API
                                  |                  |
                       roles, tenant scope     verified data only, quotas, token reservation, retries, audit
```
The browser never talks to OpenAI and never receives a key. `OpenAIProviderService` is the single entry point with six methods; each validates its input and goes through the orchestrator:

| Method | Runs | Result |
|---|---|---|
| `generateProductDescription()` | content job, format PRODUCT_DESCRIPTION | description from verified catalog data |
| `analyzeProduct()` | product analysis job | benefits, problems, segments, angles, objections, FAQ |
| `generateMarketingCopy()` | content job, any format | caption, ad copy or script (a draft) |
| `suggestAudience()` | product analysis job | `customerSegments`, read with `OpenAIProviderService.audienceOf()` |
| `analyzeCampaign()` | `CAMPAIGN_ANALYSIS` job | plain-language reading of the campaign's measured results |
| `answerCustomerQuestion()` | sales agent draft | a draft for a person; never sends |

## 3. Security
- **Key:** `OPENAI_API_KEY` is read from the server environment only. It is never returned by any endpoint, stored, or logged; error messages are written by TOUMA and never copy the SDK's or the API's text (which can echo a partial key). Tested with a canary key.
- **Isolation:** every job is scoped to one business; another business gets 404 on its items, generations and campaigns. The provider only receives a hashed, opaque `safety_identifier`.
- **Inputs:** language, format, tone, purpose, item and instructions are validated (instructions: 500 characters, treated as untrusted data).
- **Cost control:** monthly generations and tokens per business, token reservation before the call, per-request output limit, timeout, bounded retries, in-flight limit, rate limit. A spent quota stops the request before any provider call.
- **Grounding:** answers may only state verified data; an invented price is repaired once then refused. The campaign analyst may only quote the supplied figures, never writes percentages, sales claims, ROI or advice to spend more.
- **Rules kept:** nothing publishes (drafts need individual approval); customer replies are sent automatically only in AUTO with the merchant's authorization; no price, refund or advertising decision is automatic.

## 4. Configuration needed for the real API
| Variable | Purpose |
|---|---|
| `AI_PROVIDER=openai` | use OpenAI (the default) |
| `OPENAI_API_KEY` | your key, set on the server only (Render environment page) |
| `AI_MODEL` | default model (must support Structured Outputs) |
| `AI_TASK_MODELS` | optional JSON, one model per task: `BUSINESS_ANALYSIS, PRODUCT_ANALYSIS, MARKETING_STRATEGY, CONTENT, STORYBOARD, CONTENT_PLAN, CAMPAIGN_ANALYSIS, CUSTOMER_SUPPORT` |
| `AI_MODEL_PRICING` | price of each model used, JSON; without it costs show as unknown |
| `AI_TEMPERATURE` | leave empty for agent defaults; some models reject a temperature |
| `AI_MONTHLY_GENERATIONS_PER_BUSINESS`, `AI_MONTHLY_TOKENS_PER_BUSINESS` | quotas (defaults 300 and 3,000,000) |
| `AI_TIMEOUT_MS`, `AI_MAX_PROVIDER_RETRIES`, `AI_MAX_OUTPUT_TOKENS` | limits |

Also set a spending limit in your OpenAI account. Test providers (`fake`, `mock-openai`) are refused outside `APP_ENV=test`.

## 5. Cost estimate
Prices were not verified here; configure them in `AI_MODEL_PRICING`.
- Cost of a request = input tokens x input price + output tokens x output price.
- Ceiling per business per month at the defaults: 3,000,000 tokens (and 300 generations). With a price pair p_in and p_out per million tokens, the worst case is 3 x (the higher of the two prices) per business per month.
- A product description or analysis is 1 to 3 model calls (the business and product analyses are reused while the data does not change). The mock reported about 700 to 1,100 input tokens and 200 to 1,100 output tokens per call; real counts will differ.
- Development and tests: 0 USD.

## 6. Limitations
Never run against the real API in this phase: real model behavior (schema acceptance, latency, refusals, price) is unverified. Market Intelligence is a deterministic manual-entry tool and uses no model. Images and video use their own providers (`IMAGE_PROVIDER`, `VIDEO_PROVIDER`), unchanged. Real Facebook, Instagram, TikTok and YouTube publication is still not enabled.
