# Adaptive intelligence & marketing learning (N22)

Off by default (`LEARNING_ENABLED=false` → `/learning/*` answers 404). The test/demo analytics provider (`ANALYTICS_PROVIDER=mock`) is refused outside `APP_ENV=test`. No real platform, payment, AI model or publication is involved in tests or the demo.

## Audit: what already existed and was reused
`AnalyticsSnapshot` + `SocialAnalyticsService` + each adapter's `fetchMetrics` (a metric a platform omits is stored as null, never 0); `Experiment` and `interpretExperiment` (honest statistics); `Recommendation`, `EvaluationRun`, `MerchantMemory`; the publishing engine of N21 (policy, classifier, approvals, gate), the calendar, `AgentControl` (emergency stop), billing `assertAccess`. They were extended, not rebuilt.
New: provenance columns on snapshots, `LearningProfile`, `ClientPreference`, `PreferenceRevision`, `RecommendationFeedback`, `LearningRun`, `Experiment.design/conditions/biasFlags` (additive migrations `20261207090000`–`20261207090200`). `ContentPerformance`/`PerformanceSnapshot` = `AnalyticsSnapshot` + the post; `ContentExperiment`/`ExperimentVariant`/`ExperimentResult` = `Experiment` (variants, conditions, result).

## Phase A – performance engine
- Providers: the official platform path (existing adapters) or `MockAnalyticsProvider` (deterministic, SIMULATED, test-only). Each snapshot records `provider`, `simulated`, measurement period, collection time; reads add a freshness level (FRESH ≤24 h, RECENT ≤7 d, STALE).
- Maturity window (`ANALYTICS_MATURITY_HOURS`, 48): a younger post is not measured. A platform delay is stored as "unavailable + reason", not zeros. An unreachable source is recorded per post and counted; the next collection repairs it.
- Averages are null-aware (only posts that have the metric, with their n). Reports label the evidence REAL / SIMULATED / MIXED.
- Capability matrix (`PLATFORM_ANALYTICS`, `GET /learning/analytics-capabilities`): per platform and metric IMPLEMENTED / DOCUMENTED_NOT_IMPLEMENTED / UNVERIFIED / UNSUPPORTED, scopes and limits. Clicks and conversions are UNSUPPORTED (no authorized source); watch time needs the YouTube Analytics API (not used yet). Nothing was verified against a real account.

## Phase B – preferences and recommendations
- Preferences in three layers: DECLARED (the client; validated, no personal data or secrets), INFERRED (system observations with evidence) and HYPOTHESIS (to confirm, never used until confirmed). Declared beats inferred; a contradiction supersedes the inference and dismisses open proposals. A rejected inference/proposal is never made again. Every change is a revision; export, per-key and total erasure (history included); withdrawing the learning consent erases inferences and hypotheses (declared values stay).
- Engine (`@touma/shared/learning-engine`, pure): compares groups of the client's posts on engagement for slot, format, caption length, hook, topic and weekly frequency. Rules: at least 12 measured posts (else only a reason is returned), groups of at least 4, effect ≥10% and an interval that excludes zero for a proposal (large but noisy gaps become hypotheses), frequency needs a ≥15% gap and real variation; simulated data never above LOW; slots must fall inside the publishing hours and respect the daily limit; frequency ≤7/week.
- Each proposal carries justification, data used (n, groups, period, origin, interval), confidence, limits (association not cause; small uncontrolled sample) and effects to verify; a compliance check drops anything that promises results, implies causation, or conflicts with the client's declared types/restrictions. No ad/budget kind exists.
- Title variants differ in one element and are template-based (no AI call, no cost).

## Phase C – experiments, loop, quality
- Comparison tests: hypothesis, primary metric, delivery conditions and **bias flags** (not randomized, different days/hours/weekend, order effect, different formats/accounts, several changes, small audience, simulated data). The design is always `NON_RANDOMIZED_SEQUENTIAL`; the conclusion is "anecdotal" and a leader is only "observed", never with simulated or missing data. Variants prepared by TOUMA are calendar drafts under the normal policy; no paid promotion.
- Loop `COLLECT → ANALYZE → RECOMMEND → VALIDATE POLICY → EXECUTE IF AUTHORIZED → MEASURE` (`POST /learning/runs`, scheduled by `LearningWorkerService`). Refused (and recorded) without a current consent, with an emergency stop, without an active subscription, over the daily run quota, or while another run is in progress; a failed collection stops before analysis. EXECUTE only prepares next week's drafts through the N21 planner and pipeline when `autoPlan` is on and the account has a publishing consent: MANUAL sends drafts to a person, HYBRID/AUTO decide by classification; the loop never publishes by itself and never exceeds the publishing policy. AI cost: 0 (deterministic).
- MEASURE compares posts published after a run to its baseline (correlational, with n); too few posts concludes nothing. Each run stores the preferences before/after; `POST /learning/runs/:id/rollback` restores them (declared values untouched).
- Quality: a fixed corpus (`runLearningSuite`: noise, small samples, planted effects, simulated cap, client constraints, hours, rejections, compliance, determinism) stored as `EvaluationRun`, with regressions; `GET /learning/quality` shows acceptance/usefulness feedback and before/after outcomes without assuming any proposal is better. (The suite already caught an overconfident frequency rule during development.)

## Dashboard `/dashboard/learning`
Real vs simulated banner, consent and loop controls, performance per network and post with freshness, weekly evolution, proposals with limits, suggested slots, the three preference layers (edit tone, confirm/reject, export, erase), comparison tests with bias flags, run history with revert, estimated AI cost.

## Technical cost of real operation (estimates, not measured)
Analytics reads use the platforms' free APIs but consume their quotas (YouTube: 10,000 units/day per project shared with uploads; Meta/TikTok limits not verified). The loop itself is database queries and arithmetic. A real language model for variants would add per-call cost (rates not verified here) and must go through the existing AI cost guardian. Storage grows by one snapshot row per post per week.

## Limits
Small samples dominate social data; most real accounts will get few or no strong proposals, by design. Effects are associations. Simulated numbers prove only that the workflow works. No sales effect is claimed anywhere. Tests: `learning-performance`, `learning-preferences`, `learning-loop` e2e (6 + 9 + 10), `learning-engine` and `experiment-design` unit specs.
