# Creative automation — campaigns in simulation (N29)

Automated advertising campaigns on top of the free Creative Studio (N28). **Everything is simulated**: media are labelled demo files, scheduling and publication are fictitious, no social network is contacted, nothing is billed.
Available only with `CREATIVE_STUDIO_MODE=mock` (otherwise `POST /creative/campaigns` answers 503 `SIMULATION_ONLY`).

## Audit of N28 (verified before building)
Run on 2026-11-15, all green: `creative-mock-mode.e2e-spec.ts` (12), `creative-daily-quota.e2e-spec.ts` (13), `mock-studio.spec.ts`, browser studio flow. It covers the Studio, Mock image/video/script providers, daily quotas, library, authentication and tenant isolation.

## Campaign Builder
`/dashboard/creative/campaigns` (form) → `POST /api/v1/creative/campaigns`. Fields: name, product or service, objective, audience, platform (Instagram, TikTok, YouTube), language (en/fr), brand identity (tone, style, main colour, tagline), number of photos (0–5), number of videos (0–5, 8 s each), first post time, hours between posts, mode **AUTO** or **HYBRID**. Stored in `CreativeCampaign` (+ `CreativeCampaignTask`, `CreativeCampaignPost`, `CreativeCampaignEvent`). `Idempotency-Key` makes a repeated creation return the same campaign.

## Multi-agent workflow
Fixed order, one resumable task row per step (`PENDING → RUNNING → SUCCEEDED | FAILED | CANCELLED`):

| # | Agent | What it does (simulated) |
|---|---|---|
| 1 | Campaign Agent | validates and records the plan |
| 2 | Script Agent | template script, caption and hashtags (`MockScriptProvider`, only the client's words) |
| 3 | Image Agent | one task per photo → `CreativeService.submitImage` (mock provider) |
| 4 | Video Agent | one task per video → `submitVideo` (8 s demo clip, format per platform) |
| 5 | Quality Agent | format orientation, 8 s length, caption length, forbidden wording (blocked wording stops scheduling) |
| 6 | Schedule Agent | fictitious posts, classified with the real publishing classifier |

Campaign status: `DRAFT → RUNNING → AWAITING_APPROVAL / COMPLETED / NEEDS_ATTENTION`, plus `CANCELLED` and `STOPPED`.

## Quotas and budget
Agents create media through the same `CreativeService` as manual use, so **5 images + 5 videos per client per local day are shared** by manual creations and campaigns (and by all users/agents of the business). The reservation is atomic and server-side; each task has its own idempotency key and counts only when delivered, so a retry never counts twice. A campaign asking for more than what is left delivers what fits; the rest fails with `CREATIVE_DAILY_LIMIT` and is reported (it can be retried after the reset). Simulated media cost 0.

## AUTO and HYBRID (no real publication)
- The effective mode is **never looser than** the request, the creator's role (`autopublish.manage` is needed for AUTO) or a connected account's publishing policy (manual, paused, consent revoked → stricter).
- Every post is classified (`LOW_RISK / REVIEW_REQUIRED / BLOCKED`). BLOCKED posts are never created. In HYBRID any flag (outside allowed hours, daily limit, sensitive wording…) means a person must approve; in AUTO only hard flags do.
- **Approvals are bound to the exact version**: the approval request carries the `contentHash` of caption + hashtags + media + platform + time. If anything changed since the person looked at it, the answer is 409 `APPROVAL_STALE`. Editing an approved post creates a new version and voids the approval. A stop also voids approvals.
- `POST …/simulate-due` marks due posts `SIMULATED_PUBLISHED` (nothing is sent anywhere; a post needing approval is refused if its approval does not match the current version).
- **Emergency stop**: per campaign (`POST /campaigns/:id/emergency-stop`) or for the whole business (`POST /campaigns/emergency-stop`), needs `autopublish.manage`. Pending tasks are cancelled, running work stops at its next checkpoint, posts become `STOPPED`, nothing is published. `resume` (same permission) puts stopped posts back to “awaiting approval”.
- **Cancel** (`POST /campaigns/:id/cancel`): cancels pending tasks and posts; media already delivered stays in the library and stays counted.

## Campaign Control Center
`/dashboard/creative/campaigns`: SIMULATION banner, daily quotas, counters (campaigns, photos and videos available, tasks in progress / completed, fictitious schedules, awaiting approval), builder, campaign list, detail (agents with status, posts with media preview, approve / reject / edit / stop / resume / cancel / retry), approval queue and error history.

## Run the demo locally
```bash
# .env
CREATIVE_STUDIO_MODE=mock
# start PostgreSQL + Redis, apply migrations, start the API and the web app as usual, then
# open http://localhost:3000/dashboard/creative/campaigns
```
Client A: AUTO, 3 photos, 2 videos, first post tomorrow 10:00 → completes, 5 posts “Scheduled (fictitious)”.
Client B: HYBRID, 2 photos, 2 videos, first post tomorrow 03:00 → “Awaiting approval” (outside allowed hours); approve each version, then “Simulate publication”.
Browser tests: `pnpm build` (web with `API_URL=http://localhost:4100`), then `E2E_CREATIVE_MODE=mock pnpm test:web-e2e`.

## Tests
- `apps/api/test/creative-campaigns.e2e-spec.ts` (11): validation, Client A AUTO, Client B HYBRID with version-bound approvals, shared quotas, quota exhaustion + retry, concurrency (two campaigns, exactly 5), resume after an error, tenant isolation, cancellation, emergency stop/resume, first-request race regression, zero external calls.
- `tests/e2e/campaigns.e2e.ts` (browser, mock mode): both clients end to end, stop/resume, phone layout.
- `packages/creative/src/mock-studio.spec.ts`: the `VideoProvider` contract check.

## Preparing Higgsfield (not connected)
`VideoProvider` stays the single seam. `checkVideoProvider()` (`packages/creative/src/video-contract.ts`) is the conformance check every provider must pass; the simulators pass it today and the disabled `HiggsfieldProvider` is reported as not ready. To connect Higgsfield later (needs your authorization): verify the API contract, models, prices and access; approve a budget; keep the key server-side (secret manager, never in the repository or the web app); implement `HiggsfieldProvider`; run `checkVideoProvider` with a capped budget; then follow [CREATIVE-MOCK.md](CREATIVE-MOCK.md) §5. No key, account or call exists today.

## Limits
Campaigns run inside the API process (a restart interrupts a run; `retry` resumes it). Simulated media do not reflect the brief (fixed demo files). The script is a template. A single platform per campaign. Real publication is out of scope and impossible in this mode.
