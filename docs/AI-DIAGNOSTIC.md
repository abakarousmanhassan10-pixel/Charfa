# Diagnostic: "AI analysis and description generation do not work"

Checked on the live demo (`touma-web.onrender.com`) with a fresh test account, in Chromium, plus the API logs. Nothing was deployed by this diagnostic.

## Causes found
| # | Cause | Evidence | Fix |
|---|---|---|---|
| 1 | **The free API sleeps.** The first request after idle waited 72 s; meanwhile the site returns a 502 and the screen said "The generation failed". | `curl` timings (000 after 70 s, 200 after 72 s); four cold starts in the logs on 14 Nov (07:02, 10:27, 15:20, 17:40) | Message: a gateway error is now reported as "server starting up", with its own code (`SERVER_UNAVAILABLE`). The real cure is an instance that never sleeps (paid plan): not changed here |
| 2 | **New products start as Draft, and the AI only lists Active ones.** A merchant with only drafts saw nothing to select and no explanation. | Live: with one draft product the item list had only "Whole business" | Notice with a link when nothing is active; status hint in the product and service forms |
| 3 | **A business with no active product or service failed with "duplicate hashtags".** The test provider produced `#Touma` and `#TOUMA`; validation compares case-insensitively. | Live and reproduced in `content-creator.spec.ts` (failed before the fix) | Provider fixed; generation now removes repeated hashtags before validation (`normalize` hook). Real problems (too many hashtags) are still rejected |
| 4 | **"Product description" is hidden under the channel "Any channel".** | Live: formats for "Any channel" are Product description, Advertising copy, Promotional message | Option renamed "Any channel (product description, ad copy…)" |
| 5 | **The AI is simulated on the demo** (`fake:gpt-4o-mini`, `fake:gpt-image-1`): generic placeholder text and illustrations, not real AI. | AI status shows provider `fake`; outputs say "Discover X by Y. We prepare it with care…" | A banner on every AI page says so. Real AI needs a provider key and a non-test environment (paid, not enabled) |

## Checked and working (live, API awake)
Business analysis, product analysis, marketing strategy, content and product-description generation, image generation (2 illustrations), storyboard, Creative Studio pages, Market page and its API (200). Quotas (0 of 300 used) and roles were fine; a verified e-mail is **not** required for AI.

## Not verifiable here
The user's own business data (the database refuses outside connections, which is a good protection). Market Intelligence's save/analysis flow was not exercised on the live site; it is covered by the local market suite. Market Intelligence is a manual-entry tool by design: nothing is looked up or scraped.

## Tests added
`packages/ai-engine/src/content-creator.spec.ts` (4), `apps/web/lib/api-client.spec.ts` (2), `apps/api/test/ai-diagnostic.e2e-spec.ts` (7, two of which fail without the fix), `tests/e2e/ai-diagnostic.e2e.ts` (2 browser tests).

## Still needed for production
A paid, non-sleeping API instance; a real AI provider key (`AI_PROVIDER=openai`, `OPENAI_API_KEY`) in a non-test environment; real e-mail for verification; persistent file storage. See `render.real.yaml`.
