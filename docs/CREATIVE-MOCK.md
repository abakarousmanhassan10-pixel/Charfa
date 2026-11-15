# Creative Studio — free test mode (N28)

A complete, free version of the Studio for demos and development **before any real provider is connected**.
Every image and video it produces is a **labelled local demo file**. It is never presented as real AI. No API is called, nothing is billed, nothing is published.

## 1. Audit (what already existed, what N28 added)

| Area | Before N28 | Added by N28 |
|---|---|---|
| Image / video jobs, BullMQ queue, resumable video states, idempotency | yes (phases 4, N25) | — |
| Daily quotas 5 images + 5 videos, atomic reservation, delivered-only counting, reset, cancel, business-wide sharing | yes (N26, `creative-daily-quota.e2e-spec.ts`) | re-verified in mock mode |
| Mock image provider (marked “SIMULATED”) | partial | `simulate-failure` trigger |
| Mock video provider | a fake clip | **real playable 8 s MP4 demo clips** (9:16, 16:9, 1:1, 4:5) |
| Script / caption provider | storyboards only (needs an AI model) | `MockScriptProvider` (template, deterministic, reuses only the client's words) |
| Projects, history, “go back to a previous creation” | no | `CreativeProject`, restore |
| Media library (filters by type and project, delete) | history page | `GET /creative/library` + Studio library |
| Workflow brief → script → visuals → caption → permission check → fictitious scheduling | no | `POST /creative/projects/:id/schedule-simulation` |
| Video format 4:5 | no | `PORTRAIT` |
| Disabled Higgsfield provider | no | `HiggsfieldProvider` (refuses every call) |

## 2. Run it locally

```bash
# .env (never in production: the API refuses to start)
CREATIVE_STUDIO_MODE=mock
```
`CREATIVE_STUDIO_MODE=mock` forces `IMAGE_PROVIDER=mock` and `VIDEO_PROVIDER=mock` whatever else is configured. Start the API, the worker and the web app as usual, open **Creative Studio → Studio** (`/dashboard/creative/studio`). A banner states that results are simulated.

In this mode you can: choose Image or Video, describe the ad, attach a reference photo (rights declaration required), pick 1:1 / 4:5 / 9:16 / 16:9 and a style, generate, preview, download, save as a project, prepare a script and caption, go back to a previous creation, browse/filter/delete in the library, and run a fictitious schedule (Hybrid or Auto).

To see a provider failure, put `simulate-failure` in the description: the job fails, no credit is consumed.

Regenerate the demo clips (FFmpeg, 8 seconds each; replace the size for each format):
```bash
ffmpeg -f lavfi -i "gradients=s=360x640:d=8:r=24" -vf "drawtext=text='SIMULATED DEMO VIDEO':fontcolor=white:fontsize=28:x=(w-tw)/2:y=(h-th)/2" \
  -c:v libx264 -pix_fmt yuv420p -movflags +faststart packages/creative/assets/demo-video-9x16.mp4
```
(sizes: 9x16 = 360x640, 16x9 = 640x360, 1x1 = 480x480, 4x5 = 432x540).

## 3. What is operational vs simulated

**Operational (real code, real database, real queue):** job queue and polling, daily quotas (5/5, atomic, shared by all agents of a business, delivered-only, daily reset, cancellation of queued jobs), projects, history and restore, media storage and signed download URLs, library with filters and deletion, tenant isolation, role checks, audit log, the publishing classifier used by the fictitious schedule.

**Simulated:** the images (generated locally and stamped “SIMULATED - NOT A REAL GENERATION”), the videos (pre-recorded demo clips, always 8 s), the script and caption (templates), and the scheduling (a *decision record* only: no calendar entry, no publication; a simulated media can never be published). Simulated generations cost `0` whatever prices are configured.

## 4. Safety rules
- The mock mode is refused when `APP_ENV=production`.
- `CREATIVE_STUDIO_MODE=mock` makes zero outbound calls (asserted by a test that fails on any `https.request`/`fetch`).
- Higgsfield is **disabled**: selecting `VIDEO_PROVIDER=higgsfield` is rejected at start-up, and `HiggsfieldProvider` refuses every call. No Higgsfield key or account exists in this repository.

## 5. Connecting Higgsfield (or any real video provider) later — not done, needs your authorization
1. Verify the provider's API contract: endpoints, models, parameters (length, ratios, image-to-video), rate limits, terms of use.
2. Verify the **prices** and add them to `CREATIVE_MODEL_PRICING`; fix an approved monthly budget (`CREATIVE_MONTHLY_BUDGET_MICROS`).
3. Obtain API access and store the key **server-side only** (secret manager / environment), never in the web app or the repository.
4. Implement `HiggsfieldProvider` against the `VideoProvider` interface (`submit`, `status`, `download`, `thumbnail`, `capabilities`) and remove the “disabled in this build” guard in `packages/config/src/env.ts`.
5. Run the live verification (the existing live-verification tool) on a few real jobs with a capped budget, and check the quota and cost reports.
6. Switch `CREATIVE_STUDIO_MODE` back to `live`, then roll out progressively.

## 6. Tests
- `packages/creative/src/mock-studio.spec.ts` — demo files, 8 s provider, failure trigger, script provider, disabled Higgsfield.
- `packages/config/src/env.spec.ts` — mode forcing, production refusal, Higgsfield refusal.
- `apps/api/test/creative-mock-mode.e2e-spec.ts` — image, video (4 formats), download, projects, script, library, restore, daily quotas and reset, cancellation, simulated failure, cross-client isolation, fictitious scheduling, zero outbound calls.
- `tests/e2e/creative.e2e.ts` — browser flow (generate, save, library, download, no horizontal scroll on a phone).

See also [CREATIVE-CAMPAIGNS.md](CREATIVE-CAMPAIGNS.md) (automated campaigns in simulation, N29).
