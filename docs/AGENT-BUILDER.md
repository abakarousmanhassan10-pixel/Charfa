# No-code AI agent builder (N23)

Status: **first slice only** (Phase 0 audit + the core of Phase 1). Off by default (`AGENT_BUILDER_ENABLED=false` → `/agent-builder/*` answers 404). The other phases are deliberately not started: they depend on this slice being validated.

## Phase 0 – audit (verified by running the suites in this repository, not by reading phase names)
| Step | Capability | State |
| --- | --- | --- |
| 19 | Billing engine, simulated provider, production gate, plan entitlements | **Operational** with the simulated provider (real provider: not verified, blocked by design) |
| 20 | Agent orchestration (5 fixed agent kinds on the run engine), billing guardian (atomic reservations, quotas, prices), approvals bound to content hashes, emergency stop | **Operational** with the mock model; real model never called |
| 21 | Publishing policy per account (MANUAL/HYBRID/AUTO), classifier, approvals, gate, planner | **Operational** with the simulated social platforms; real platforms not contacted |
| 22 | Analytics provenance, preferences, recommendations, comparison tests, learning loop | **Operational** with simulated metrics |
| existing | Workflow definitions/versions/executions + scheduler (JSON, no visual editor) | **Operational** (no node editor, no agent nodes yet) |
| existing | `Agent` rows of N20 are limited to 5 fixed kinds | **Partial**: not a free-form agent definition |
| not existing | Visual agent builder, template library, node-based workflow editor, per-agent memory, tool registry with OAuth scopes, agent versions, per-agent budgets/quotas | **Not implemented** before this step |
Known gaps that block later phases: no connector registry; no per-agent memory tables; workflow nodes cannot reference custom agents; the real AI provider is disabled.

## Implementation order (each step needs the previous one validated)
1. **Slice 1 (this commit)**: definition, validation, draft save, duplicate, archive, simulated test.
2. Templates (Phase 2) on top of the same definition format.
3. Versions + activation gate (Phase 8) – activation requires a passing test of the exact saved hash.
4. Tool registry with simulated connectors (Phase 5) and permission model (Phase 7).
5. Execution through the N20 run engine (Phase 6) + per-agent usage policy (Phase 9).
6. Memory (Phase 4), then the visual workflow builder (Phase 3) reusing the existing workflow definitions.

## What exists now
- **Shared** (`@touma/shared/agent-builder`): categories, tones, languages, the minimal tool registry, `normalizeConfig` (unknown keys dropped, safe defaults), `validateBuilderConfig`. Rules: name/mission/instructions bounds; no e-mail/phone/secret in the text; instructions that try to switch off approvals, limits or policies are refused (`RULE_OVERRIDE`); models only from the server's allow-list (+ the simulator model); tools must exist and be enabled (external tools are disabled entries: `TOOL_NOT_CONNECTED`); AUTO needs an explicit acknowledgement; ranges for calls/output/runs; hours and timezone valid; per-run budget ≤ monthly budget ≤ the plan's budget.
- **Data** (`20261208090000_agent_builder_slice`): `AgentDefinition` (unique per business+name, config JSON, `configHash`, `revision`, status DRAFT/ACTIVE/ARCHIVED – only DRAFT/ARCHIVED are reachable), `AgentTestRun` (simulated test history). Both tenant-keyed with cascade.
- **API** (`/agent-builder`): `GET options`, `POST validate`, `GET|POST agents`, `GET|PUT|DELETE agents/:id`, `POST agents/:id/duplicate|test`, `GET agents/:id/tests`. Permissions reuse `agents.read` / `agents.manage` / `agents.run`. A draft may be saved with errors (they are returned); it cannot be tested until the server reports none. The revision moves only when the configuration changes.
- **Plan gates** (existing guardian): active subscription, plan feature `agents`, `maxAgentInstances` (archived agents do not count), monthly budget ≤ plan budget, daily test quota (`AGENT_BUILDER_TESTS_PER_DAY`), emergency stop (GLOBAL/TENANT) refuses tests.
- **Simulator** (`agent-sandbox.ts`): deterministic; no model, tool, network or business data; cost 0 (shown as an estimate of 0, never as a payment). It reports the trace (input, injection scan, rules, prompt, model=SIMULATED, tool plan, mode effect, limits) and, per requested tool, REFUSED (not granted / not connected), WOULD_RUN (read-only), WOULD_WAIT_FOR_APPROVAL (HYBRID) or WOULD_FOLLOW_POLICY (AUTO). A message that tries to change the rules is flagged and changes nothing.
- **UI** `/dashboard/agent-builder` (EN/FR, responsive): form, tools list (external ones disabled), HYBRID/AUTO choice with acknowledgement, budget, hours display, issues from the server, save, duplicate, archive, simulated test with trace.

## Status of every requested element
| Element | Status |
| --- | --- |
| Visual agent builder (create, edit, save draft, duplicate, test) | **Operational** (hours are shown, not yet editable in the form; provider/model limited to the simulator) |
| Template library | Not implemented |
| Visual workflow editor + simulator | Not implemented (JSON workflows exist) |
| Agent memory | Not implemented |
| Connector registry | **Partial**: minimal tool list with disabled external entries; no scopes, limits or connectors |
| Execution engine for custom agents | Not implemented (only the simulator) |
| Security/permissions | **Partial**: least-privilege tool check in the simulator, tenant isolation, rule-override refusal; the per-run engine checks come with execution |
| Versions/activation | Not implemented (revision counter only) |
| Quotas/billing | **Partial**: agent count, budget ceiling, test quota, subscription, stop; per-run usage metering comes with execution |
| Tests | 6 unit + 9 e2e |

## Limits
The simulator's reply is a template, not model output; it shows structure and refusals, not quality. AUTO/HYBRID here describe the agent's own preference; the effective behaviour is never looser than the account's publishing policy (N21). Nothing was deployed, paid or published.
