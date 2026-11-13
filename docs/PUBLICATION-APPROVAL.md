# Individual publication approval (Phase N18)

**Rule: nothing is published without an explicit merchant decision on that exact content, account and time.** External publishing is OFF by default (`SOCIAL_PUBLISHING_ENABLED=false`); no real platform is contacted by the tests (test-only simulator).

## Lifecycle (existing `ContentStatus`, server-enforced by conditional updates)
`DRAFT → IN_REVIEW (pending approval) → APPROVED → SCHEDULED → PUBLISHING → PUBLISHED | FAILED`, plus `REJECTED` (back to `IN_REVIEW` through a new submission) and `CANCELLED`. A client never sends a status: each step is its own endpoint with its own permission.
| Step | Endpoint | Permission |
| --- | --- | --- |
| Submit for approval | `POST /calendar/entries/:id/submit` | `content.write` |
| Approve / reject (reason required) | `…/approve`, `…/reject` | `content.approve` |
| Schedule = authorize this exact publication | `…/authorize` | `publication.schedule` |
| Edit draft | `PATCH …/entries/:id` | `content.write` (`publication.schedule` once scheduled) |
| Cancel / unschedule | `…/cancel`, `…/unschedule` | as above |
| Pending list, details, history | `GET /calendar/approvals`, `…/entries/:id`, `…/history` | read |

## What an approval records
Every decision is a row in `ApprovalRecord` (business, content, version, actor, time, note). Approving and authorizing also store the **snapshot**: SHA-256 of content version, text, media (ordered), platform options, platform, **target account**, schedule and timezone (`approval-snapshot.ts`), the account, media ids, time and zone. Authorization stores the hash on the entry (`authorizedHash`, `authorizedAccountId`).

## Integrity
- Editing text, media or TikTok settings of an approved/scheduled post: approval and authorization are withdrawn and the post returns to **pending approval** (`IN_REVIEW`); a new explicit approval is required.
- Changing the target account or moving an authorized entry: the authorization is withdrawn (content stays approved) and a person must authorize again.
- The target account is the one bound at authorization (the chosen one, else the only connected account). An account connected later is never used silently.

## One gate before every attempt (`publication-gate.ts`)
Called by the scheduler before hand-off and again by the publisher immediately before the platform request. It checks: master switch on, entry belongs to the business and is not cancelled/deleted, content `SCHEDULED` with approved and authorized version equal to the current one, recomputed snapshot hash equal to the authorized hash, approved account exists in the business and is connected (not expired/revoked), the authorizer is still allowed, the daily limit (`SOCIAL_MAX_PUBLICATIONS_PER_DAY`, default 50). Any failure stops the attempt with a code and publishes nothing. Hand-off is idempotent (dispatch key), a duplicate job creates no second publication.

## Simulation
When the platform is the test simulator (`SOCIAL_PROVIDER_MODE=fake`, refused outside tests) the publication is flagged `simulated` and the interface says so. A simulated result is never a real publication.

## Interface
Approval Center (`/dashboard/calendar/approvals`): pending list with caption preview, platform and planned time (business timezone), approve (accessible confirmation dialog), reject (reason), open/edit, ready list, decisions list; entry history shows the approved snapshot version. Checked on a phone-size viewport.

## Limits
Approval is per publication, not per batch (batch approval is not implemented). Product images shown in the list are the entry's own media only when present. Real platforms were not contacted; their review status (see SOCIAL-PLATFORM-APPROVALS.md) is unchanged.
