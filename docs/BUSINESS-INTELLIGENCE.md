# Business intelligence layer (phase N21)

Local, deterministic, no model, no network. Flag `INTELLIGENCE_ENABLED` (default **false**). It reads and proposes. It never publishes, sends a customer message, spends money, changes code or deploys.

## 1. Audit (evidence, not phase labels)
The repository has no commit or document named N15 to N17, so those were checked by capability. N18 to N20 were verified by their own suites in this session.

| Capability | Status | Evidence |
|---|---|---|
| Individual publication approval (N18) | VERIFIED | `publication-approval.e2e-spec.ts` (12), `n18-approval.e2e.ts` |
| Social connectors, comments, replies (N19) | VERIFIED with simulator; real platforms MOCK/BLOCKED | `social-interactions.e2e-spec.ts` (8) |
| Marketing Director, agent contracts (N20) | VERIFIED (mock agents) | `campaigns.e2e-spec.ts` (10), `n20-campaigns.e2e.ts` |
| Customer service AUTO / MANUAL / PAUSED | VERIFIED | `SalesAgentConfig`, `sales-agent` suite, N20 triage test |
| Analytics snapshots | PARTIAL | schema and collector exist; no real metrics without platform permissions |
| Platform-level ops alerts | VERIFIED but not per merchant | `OpsAlert` has no business id: a tenant table was added |
| Real AI, real publishing, real replies, real metrics | BLOCKED | need credentials and platform approval; not enabled |
| Tenant memory, evaluation history, experiments, recommendations | MISSING before N21 | added here |

## 2. Data model (additive migration `20261124090000_business_intelligence`)
`MerchantMemory` (kind, key, value, **provenance**, retention, expiry), `Experiment`, `Recommendation` (evidence, cost, priority, unique dedupe key), `EvaluationRun`, `BusinessAlert` (unique dedupe key while open). Every row has a business id; nothing is shared between merchants.

## 3. Memory
Kinds: BRAND, PRODUCT_FACT, CAMPAIGN_HISTORY, AUDIENCE, METRIC, PREFERENCE, DECISION, EVALUATION.
- **Provenance is enforced per kind.** A METRIC can only come from `PLATFORM_REAL` or `PLATFORM_SIMULATED`: neither a person nor an agent can write one. PREFERENCE only from the merchant.
- **Minimization.** Values are small objects; e-mail addresses and phone numbers are refused; customer message text is never stored. Campaign history only covers posts that were approved or published.
- **Retention.** Per-kind maximum (90 to 730 days); expired entries are hidden at once and purged by `purgeExpired()`.
- **Deletion.** One entry, one kind or everything, by an administrator, scoped to the business; audited.

## 4. Evaluation engine (`evaluators.ts`)
Deterministic pass/fail: factual accuracy, claim verification (reusing `assessGrounding` and `checkFactPreservation`), content quality (length, hashtags, shouting, punctuation), approval compliance (every publication individually authorized), response safety (AUTO / MANUAL / PAUSED), execution cost, tool authorization, duplicate prevention. Two suites are stored: `golden` (a fixed corpus with expected verdicts: it proves the evaluators still discriminate) and `tenant-health` (the merchant's own drafts, publications and budgets). A **regression** is a case that passed before and fails now, or a score drop.

## 5. Experiments (`experiment-stats.ts`)
Two variants are ordinary posts that each need their own approval. Result: engagement rate per variant, difference, 95% interval, the audience size that would be needed, and caveats. The verdict is `INSUFFICIENT_DATA`, `INCONCLUSIVE_SMALL_SAMPLE`, `NO_DETECTABLE_DIFFERENCE`, `DIFFERENCE_DETECTED`, or `SIMULATED_NOT_EVIDENCE` (simulated data never yields a winner). No improvement is estimated beyond what the data shows, and no sales effect is ever claimed.

## 6. Recommendations
Rules over authorized data: incomplete product data, expired connections, missing real measurements, follow-up posts. Each has evidence, a cost estimate (0 USD, review time), a deterministic priority and a dedupe key (a rejected proposal is not proposed again). There is **no advertising or budget kind**; a forged kind is refused. Approving needs `content.approve`. A follow-up only creates drafts that still need individual approval.

## 7. Safe self-improvement
An agent or the merchant may propose a change to **one whitelisted preference** (`creative.maxCaptionChars`, 100 to 900). Prompts, code and tools cannot be changed. The change is evaluated offline on a fixed corpus; any previously passing case that fails, or a lower score, blocks approval (`EVALUATION_REQUIRED`). Approval stores a preference that the Director reads; nothing else changes and nothing is deployed.

## 8. Alerts
Failed publishing, expired connections, unusual usage (80% / 100% of the daily caps), budget thresholds, unknown-outcome replies, missing product data, workflow and agent errors (every failed attempt counts). One alert per condition (`dedupeKey`), severity CRITICAL / WARNING / INFO, resolved automatically when the condition clears.

## 9. Control center (`/dashboard/intelligence`)
Campaigns, pending approvals, agent activity, experiments, recommendations, alerts, cost and quotas. A banner says whether platforms are simulated and counts simulated versus real published posts.

## 10. Costs
Development and tests: 0 USD. Every evaluation, recommendation and alert is a database query or a pure function: no AI call. A real model for any agent would add per-call cost (rates not verified here); campaign cost limits stay at 0 until raised.

## 11. Limitations
- Statistics are for single posts: with a few posts almost every experiment is inconclusive, by design.
- Recommendations come from four rules; there is no learning from history yet (memory is stored and shown, not yet used to rank).
- `tenant-health` has no scheduled run; scans and evaluations are triggered by a person.
- Alerts are polled, not pushed (no e-mail or notification yet).
- Real metrics, real replies and real publication remain unverified until platform access exists.

## 12. Next milestone
Schedule the scan, evaluation and memory purge in the existing worker, and send alert notifications through the existing notification service, still without any external action.
