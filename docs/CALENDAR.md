# TOUMA Smart Content Calendar (Phase 5)

Plans, approves and schedules marketing content. **It never publishes.** Due entries are handed to a publishing interface that Phase 6 implements; until then they wait, and the UI and API say so.

## Concepts
- **Entry** = one post on one platform (`CalendarEvent`) with its own content (`Content`, one per entry). The entry status is the content status: `DRAFT`, `IN_REVIEW` (shown as *Pending approval*), `REJECTED`, `APPROVED`, `SCHEDULED`, `PUBLISHING`, `PUBLISHED`, `FAILED`, `CANCELLED`.
- **Business timezone.** Every instant is stored in UTC; entries show and are edited in the business timezone (set on the business, default taken from the browser at onboarding). Local dates and times are converted with `zonedToUtc` (`packages/shared/src/timezone.ts`): a nonexistent local time (clock change) moves forward and is flagged, an ambiguous one uses the first occurrence. Recurring schedules are computed from local wall-clock time, so 09:00 stays 09:00 across daylight-saving changes.
- **Time source.** Every time is labelled `MANUAL` (you chose it), `ANALYTICS` (best hours of *your own* published posts with measured engagement, only when at least 10 such posts exist for the platform) or `ESTIMATE` (general guidance for the platform, never audience data). With fewer than 10 samples the note says how many exist.

## Approval workflow
```
DRAFT ─submit─► IN_REVIEW ─approve─► APPROVED ─authorize─► SCHEDULED ─► (Phase 6) PUBLISHED | FAILED
  ▲                  └─reject─► REJECTED                       └─unschedule─► APPROVED
  └── any edit of the text withdraws the approval AND the authorization (version + 1)
```
| Action | Permission |
|---|---|
| create, edit, move (not scheduled), submit, cancel (not scheduled), delete | `content.write` (Editor and above) |
| approve, reject | `content.approve` (Admin, Owner) |
| authorize (schedule), unschedule, retry, move or cancel a SCHEDULED entry, edit authorized content | `publication.schedule` (Admin, Owner) |

*Scheduling is the explicit authorization to publish*: it binds the approved content version, the time and the person. The UI requires an explicit confirmation box. AI-written or AI-assisted text is re-checked against the verified business data when it is approved (`APPROVAL_BLOCKED` lists what is not in the data). Every decision is an `ApprovalRecord` (who, which version, when, note) and an audit log entry (`calendar.*`).

## Conflicts and duplicates
Checked on create, move, authorize, recurrence and plan application, under a per-business-per-platform PostgreSQL advisory lock so concurrent requests see each other.
- **Hard** (always blocked, `409 CALENDAR_CONFLICT`): time in the past; the same content already placed on the same platform (also enforced by a unique `placementKey`).
- **Soft** (`409 CONFLICT_CONFIRMATION_REQUIRED`, repeat with `acknowledgeConflicts: true`): another post too close on the platform (Instagram/Facebook 3 h, TikTok 2 h, YouTube 6 h), more than the daily limit (2/2/3/1), no connected account for the platform. Acknowledged conflicts notify the people who schedule.
`GET /calendar/conflicts` lists the soft conflicts inside a range.

## AI 30-day plan
`POST /calendar/plans` queues the plan on the TOUMA AI pipeline (task `CONTENT_PLAN`, agent `contentPlanner@1`, role SCHEDULER), with the same background job, usage limits, token and cost tracking as other AI tasks. It receives the business data, products and services, objectives, audience, location, timezone, language, brand kit and the connected platforms. The result is validated before it is stored (`checkContentPlan`):
- balanced pillars (at least 3, none above half), requested number of posts, days and platforms, at most 2 posts per platform per day, no duplicate titles;
- **no invented occasions:** SEASONAL posts exist only for the occasions the merchant supplies in the request, on exactly that day; any other holiday name in a title or brief is rejected. With no occasions there are no seasonal posts;
- **no invented promotions:** discount, sale, free-offer and percentage claims are rejected unless the business data says the same; promotional and showcase posts must reference a real product or service.
A plan enters the calendar only when a person applies it (`POST /calendar/plans/:generationId/apply`, once per plan; concurrent applies yield one winner). Applied entries are `DRAFT` and `AI_ASSISTED`, with times proposed per the rules above and no two on one platform too close. The model chooses *what* and *which day*; TOUMA chooses the time of day.

## Scheduler (BullMQ queue `touma.calendar`)
Runs in the same process as the AI and creative workers (`node dist/ai-worker.js`). Every `CALENDAR_TICK_MS` the database is the source of truth:
1. due `SCHEDULED` entries are claimed with one conditional update and queued with the **dispatch key** `<entry>-<approved version>-<time>` as job id (same hand-off can never be claimed or queued twice, even with several workers);
2. no publisher available → entries become `BLOCKED` (once-only notification) and are released when one appears;
3. upcoming-publication reminders (`CALENDAR_REMINDER_MINUTES` before), once per entry and time;
4. recovery: claims whose job or worker is gone are released; a claim that died mid-call is re-queued with the *same* key.
The job re-checks that the entry is still scheduled, still the approved version and the authorizer may still schedule publications, then calls the **publishing interface** (`PUBLISHING_GATEWAY`, `apps/api/src/calendar/publishing.ts`): `submit(request)` must be idempotent on `request.idempotencyKey`; `ACCEPTED` hands the entry over (content `PUBLISHING`), `REJECTED` is retried with exponential backoff when `retryable`, otherwise the entry becomes `FAILED` and people are notified. Phase 6 reports results through `CalendarWorkerService.recordPublished` (only from a provider response) and `recordFailed`. The Phase 5 default gateway (`UnavailablePublishingGateway`) publishes nothing.

## Notifications
In-app (`GET /notifications`, bell in the header, per person and business): content awaiting approval (to approvers), upcoming publications, failed scheduled jobs, calendar conflicts, due-but-not-published (no publisher). Each is delivered once (`dedupeKey`), and only to people whose role has the relevant permission. Email delivery of these notifications is not implemented.

## API (`/api/v1/calendar`, `/api/v1/notifications`)
`GET overview`; `GET|POST entries`, `GET|PATCH|DELETE entries/:id`, `GET entries/:id/history`; `POST entries/:id/{reschedule,use-content,submit,approve,reject,authorize,unschedule,retry,cancel}`; `GET conflicts`, `GET recommendations`, `GET approvals`; `POST plans` (202), `GET plans`, `GET plans/applied`, `GET plans/:generationId`, `POST plans/:generationId/apply`; `GET|POST recurrences`, `DELETE recurrences/:id`; `GET notifications`, `POST notifications/:id/read`, `POST notifications/read-all`. Ranges are limited to 45 days; dates are `YYYY-MM-DD` in the business timezone.

## Configuration
`CALENDAR_TICK_MS` (15000), `CALENDAR_DISPATCH_ATTEMPTS` (3), `CALENDAR_DISPATCH_BACKOFF_MS` (5000), `CALENDAR_REMINDER_MINUTES` (60), `CALENDAR_LOCK_SECONDS` (120), `CALENDAR_RATE_LIMIT_PER_MINUTE` (60, plan generation). `/health/ready` reports the calendar worker heartbeat.

## Web pages
`/dashboard/calendar` (overview), `/month`, `/week`, `/day` (drag and drop, platform filter, status colors), `/planner` (30-day planner and recurring schedules), `/approvals`. English and French; phones get a compact month with a day agenda.
