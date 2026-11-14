# Business autopilot (phase N22)

Decision support from the merchant's own numbers. Deterministic, local, no model, no network, no payment. Flag `AUTOPILOT_ENABLED` (default **false**).
It **proposes**. It cannot change a price, issue a refund, charge a payment, spend on advertising, publish a post or message a customer.

## 1. Audit (evidence, not phase labels)
The repository has no commit or document named N15 to N17; those were checked by capability. The preconditions were re-run at the start of N22: tenant isolation (`tenant-security`), approval security (`publication-approval`), N19 replies, N20 campaigns, N21 intelligence, the sales agent and `hardening`: **7 suites, 123 tests, all passing**.

| Capability | Status |
|---|---|
| Tenant isolation, RBAC | VERIFIED (`tenant-security`, `hardening`) |
| Individual publication approval (N18) | VERIFIED |
| Social connectors, comment replies, AUTO / MANUAL / PAUSED (N19) | VERIFIED with simulator; real platforms BLOCKED |
| Marketing Director, contracts (N20) | VERIFIED (mock agents) |
| Memory, evaluation, experiments, recommendations, alerts (N21) | VERIFIED (deterministic) |
| Unit-economics calculation | VERIFIED (N4 `computeProfitability`, reused) |
| Product costs, shipping, marketing expenses | MISSING before N22: merchant-entered tables added |
| Sales data (orders, revenue) | MISSING: TOUMA does not collect it; reported as missing, never estimated |
| Market data | MOCK/UNAVAILABLE: reported as unavailable |
| Real AI, payments, publication, real metrics | BLOCKED |

## 2. Architecture
`ExecutiveService` runs six agents in a fixed order (Marketing, Sales, Market Analyst, Finance Analyst, Customer Intelligence, Optimization). Contracts live in `@touma/shared/executive.ts`: read-only tools, data scope, 5 s timeout, cost 0. A contract holding `pricing.write`, `refund.issue`, `payments.charge`, `ads.budget.write`, `social.publish`, `messages.send` or `agents.invoke` is rejected. Each step is bounded, recorded and audited; a failing or hanging agent gives a `PARTIAL` run.

## 3. Reused modules
`computeProfitability` (market-calc), `RecommendationsService` (extended with decision fields and kinds, no second pipeline), `CampaignsService` (draft creation), `IntelligenceService` (alerts, quotas, origins), N18 approval, audit, RBAC.

## 4. What was added (additive migration `20261125090000_business_autopilot`)
`ProductEconomics`, `MarketingExpense`, `ExecutiveRun`, `ExecutiveSettings`, and optional columns on `Recommendation` (problem, proposed action, expected benefit, confidence, risk, required approval, source).

- **Profit intelligence.** Per order, before advertising: revenue (promotional price when set), cost of goods, shipping, payment fees, returns allowance, contribution, break-even ad cost and break-even price. Each line is rounded half-up before summing. A missing input leaves the contribution **unknown** and names what is missing.
- **Scenario simulator.** Price, shipping, ad budget, cost per click, conversion rate. Orders are rounded down. Assumptions are labelled `SCENARIO_ASSUMPTION`. A negative unit margin or net loss is flagged. "Best" is only the highest simulated profit under the stated assumptions.
- **Business diagnosis.** Eight sections each marked VERIFIED, PARTIAL, MISSING, SIMULATED or UNAVAILABLE, plus a data-coverage figure. That figure measures how much TOUMA can analyze, not how well the business performs.
- **Customer intelligence.** Theme and objection counts, information gaps and bottlenecks. Themes asked fewer than 3 times are suppressed. No message text, name or identifier leaves it.
- **Decision engine.** Problem, evidence, proposed action, an estimate with assumptions or "not estimated", confidence, cost, risk, required approval. Kinds: economics gap, negative-margin review, advertising-cost review, campaign proposal, customer-information gap. No price, refund, payment or advertising kind exists.
- **Command center** `/dashboard/autopilot`: health, profitability, decisions, campaigns and approvals, risk alerts, scenarios, agent activity, cost entry form, emergency stop.

## 5. Governance
- Finance data needs `billing.read` (administrators and owner); entering it needs `business.update`; deciding needs `content.approve`. Editors and viewers see none of it.
- Executive decisions are listed and decided only through `/executive/decisions`, never through the N21 recommendation endpoints.
- Approving a decision records the merchant's choice. The only automatic consequence is a **campaign draft** (campaign proposal), and every post still needs its own approval (N18).
- Emergency stop: no run and no approval while it is on. Daily run limit per business. Idempotency key: a repeated key returns the same run. Every action is audited.
- Customer replies are untouched: the executive layer never sends one, in any mode.

## 6. Costs
Development and tests 0 USD. Every figure in this layer is a database query or a pure calculation: no AI call, no payment, no ad spend. A future model-backed agent would add per-call cost (rates not verified here).

## 7. Limitations
- Profitability is per order. Without orders and revenue data, no total profit exists; scenario volumes are assumptions.
- Costs are only as good as what the merchant enters. Currencies are not converted without a supplied rate, so a mismatch leaves the margin unknown.
- Advertising cost per order uses the merchant's own spend and attributed orders; TOUMA cannot verify attribution.
- Customer intelligence reads comments on the business's own posts, with keyword rules (English and French). Direct messages are not read.
- Decisions come from five fixed rules. No learning from history yet.
- No scheduled run: a person starts it.

## 8. Next milestone
Let the merchant import orders (CSV) so that real volumes replace scenario assumptions, with the same missing-data rules and no external action.
