# Phase 5 – Smart Content Calendar and Scheduling Engine

Status: implemented and tested. **Nothing is published**: no social publisher exists yet (Phase 6). The calendar prepares, approves and schedules content and hands due entries to a publishing interface; the default implementation publishes nothing and the UI says so. The AI planner was tested only with the test-only deterministic provider (no OpenAI key was available), so real-model plan quality is unverified.

## 1. Implemented features
- **Calendars:** overview, month, week, day (hour by hour), 30-day planner, approvals queue; platform filter; status colors and legend; drag and drop to reschedule (day cells; hour rows in the day view); compact month and day agenda on phones. English and French.
- **Business timezone:** UTC storage with a per-entry IANA timezone; local-to-UTC conversion with daylight-saving gaps (moved forward, flagged) and overlaps (first occurrence); recurring schedules keep their local time across clock changes.
- **AI 30-day plan** (`CONTENT_PLAN`, agent `contentPlanner@1`) through the existing TOUMA AI pipeline (background job, usage limits, token/cost tracking). Uses business data, products and services, objectives, audience, location, timezone, language, brand kit and connected platforms. Output validation rejects invented holidays and occasions, invented promotions, unknown products, unbalanced mixes and wrong counts. A person reviews and applies the plan (once); entries are drafts.
- **Smart scheduling:** recommended dates and times per platform (from your own measured engagement once at least 10 published posts exist, otherwise labelled estimates), conflict detection (too close, daily limit, past, duplicate placement, no connected account), rescheduling, recurring schedules (daily or weekly), platform-specific scheduling.
- **Approval workflow:** Draft → Pending approval → Approved → Scheduled → Published / Failed, plus Rejected and Cancelled. Approval and scheduling are separate permissions; scheduling is the explicit, confirmed authorization bound to the approved version, time and person; any text edit withdraws both. Approval records and audit entries for every decision.
- **Notifications (in-app):** content awaiting approval, upcoming publications, failed scheduled jobs, calendar conflicts, due-but-not-published; bell with unread count.
- **Background jobs (BullMQ `touma.calendar`):** tick-based scheduler with atomic claims, dispatch-key idempotency, duplicate prevention across workers, retries with backoff, failure handling, crash recovery, reminders. **Publishing interface** (`PUBLISHING_GATEWAY`) with a documented contract for Phase 6.

## 2. Database migration
`20261111120000_smart_calendar`: `CalendarEvent` extended (platform, pillar, brief, occasion, time source, placement key, authorization, hand-off state and key, reminders, plan and recurrence links); new `ContentPlan`, `RecurrenceRule`, `ApprovalRecord`; `Notification.dedupeKey`; enums `ContentPillar`, `TimeSource`, `DispatchState`, `ApprovalDecision`, `RecurrenceFrequency`; `AITask.CONTENT_PLAN`. Applied to dev and test databases; no drift.

## 3. API endpoints
`/api/v1/calendar`: `overview`, `entries` (list, create, get, patch, delete, `history`, `reschedule`, `use-content`, `submit`, `approve`, `reject`, `authorize`, `unschedule`, `retry`, `cancel`), `conflicts`, `recommendations`, `approvals`, `plans` (queue, list, applied, preview, apply), `recurrences` (list, create, delete). `/api/v1/notifications` (list, read, read-all). Details and permissions: [../CALENDAR.md](../CALENDAR.md).

## 4. Frontend pages
`/dashboard/calendar`, `/month`, `/week`, `/day`, `/planner`, `/approvals`; notification bell in the header; calendar enabled in the navigation.

## 5. Test results (this session)
| Suite | Result |
|---|---|
| Lint, typecheck, production build | pass |
| Unit tests | 252 pass (shared 38, config 17, ai-engine 98, storage 11, worker 5, api 37, creative 38, web 8) |
| API e2e (real PostgreSQL, Redis, BullMQ, ClamAV; test-only AI provider) | 339 pass, 5 skipped (real-storage suite needs MinIO); 51 new: calendar 30, plan 8, scheduler 13 |
| Browser e2e (Playwright, real API and Next.js) | 48 of 48 pass: 34 earlier + 14 new calendar, 3 of them at 390×844 |
| Prisma migrations | up to date, no drift |

Coverage of the requested areas:
- **30-day planning:** balanced pillars, occasions only as supplied and on their exact day, no seasonal posts without occasions, rejection of invented holidays, promotions and products, times in the business timezone labelled as estimates, applied once (also under concurrent requests), draft-only result, tenant privacy.
- **Timezone conversions:** unit tests for offsets, half-hour zones, daylight-saving gap and overlap, 23 h and 25 h days; API tests for local/UTC round trips across midnight and a weekly recurrence across a real daylight-saving change.
- **Scheduling conflicts:** too close, daily limit, past, duplicate placement, confirmation flow, range conflict report, notifications.
- **Concurrent requests:** six simultaneous creates for one slot (one wins), simultaneous approve and authorize (one wins each), simultaneous plan applications, simultaneous scheduler ticks from two workers (one hand-off).
- **Approval permissions:** viewer, editor, admin and owner matrix; approval and authorization withdrawn by edits; AI text re-grounded at approval; rejection with reason.
- **Duplicate prevention:** unique placement, dispatch key, plan generation, recurrence occurrence and rule.
- **Failed jobs:** transient errors retried with the same key, permanent failure, exhausted retries, demoted authorizer, no publisher (blocked, notified once, released), stale-claim recovery, retry by an authorized person.
- **Tenant isolation:** 404 across businesses on every entry action, plans, notifications, recommendations and analytics; spoofed tenant header.
- **Mobile responsiveness:** all six pages without horizontal overflow at 390×844; compact month, day agenda, dialogs and forms usable.

## 6. Remaining limitations (honest list)
1. **Nothing is published.** There is no publisher; due entries become BLOCKED and notify once. The hand-off, retry, failure and recovery logic is tested with a scripted publisher only; Phase 6 must implement `PUBLISHING_GATEWAY` idempotently on the dispatch key and report outcomes through `recordPublished` / `recordFailed`. The PUBLISHING and PUBLISHED states are therefore exercised only through that scripted publisher.
2. **All recommended times are estimates today.** Analytics-based times need published posts with measured engagement, which cannot exist before Phases 6-7; that path is tested with seeded data only. The estimates are static, general per-platform rules, not adjusted by industry, country or season.
3. **The AI plan has not run on a real model.** Only the deterministic test provider was used. Validation is rule-based: the holiday and promotion vocabularies are finite (strongest in English and French, partial elsewhere), so an invented occasion with an unlisted name could pass; a person still reviews and approves everything.
4. **Plan entries are ideas, not finished posts.** Captions are written in the entry editor or taken from an existing content (`use-content` API); the editor has no media picker, so image, video and carousel entries cannot be completed (and therefore submitted) from the UI yet. The API accepts `mediaIds`.
5. **Drag and drop is mouse-only** (HTML5 drag events); on touch screens use the Move control in the entry dialog. Both rows must be on screen to drag in the day view.
6. **Recurrence** is daily or weekly only; occurrences are materialised when the schedule is created (at most 60 entries over 180 days) and are not extended automatically; a schedule cannot be edited (stop and recreate).
7. **Notifications are in-app only** and refreshed every minute; there is no email or push delivery.
8. One entry is one platform; there is no cross-posting shortcut. Changing the business timezone does not move existing entries (they keep the timezone they were planned in).
9. Tests host the worker inside the API process (a second worker object stands in for another process); the two-process topology, the new CI steps and the Docker images were not run here. No independent security review was done.

Phase 6 has not been started.
