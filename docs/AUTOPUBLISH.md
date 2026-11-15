# Autonomous & hybrid publishing (N21)

Off by default (`AUTOPUBLISH_ENABLED=false` → `/publishing/*` answers 404). Nothing here contacts a real social network in development or tests: the platforms are the test-only simulator.
Real posting additionally needs `SOCIAL_PUBLISHING_ENABLED=true`, real developer apps and each platform's own approval (see `SOCIAL-PLATFORM-APPROVALS.md`). Billing stays provider-independent (no dependence on Paddle).

## What it adds to the existing engine (nothing was replaced)
The calendar approval flow, the snapshot hash, the **publication gate**, the calendar worker, the idempotent hand-off and the social publisher are unchanged and still decide every post.
The policy layer only takes, as the consenting person, the same steps a person would take (submit → approve → authorize), and adds checks to the gate.

## Modes (per connected account, never global)
| Mode | Behaviour |
| --- | --- |
| MANUAL (default, fallback) | A person approves and schedules every post. Used whenever consent is missing/revoked, the account is not connected, automation is off or paused. |
| HYBRID | Routine posts (LOW_RISK) are scheduled by the policy. Anything with a risk reason goes to a person (REVIEW_REQUIRED). |
| AUTO | LOW_RISK and *soft* reasons (unusual promotion, brand-change wording) are scheduled by the policy. *Hard* reasons (sensitive claims, personal data, misleading wording, outside hours, daily limit, platform confirmation) still wait for a person. |
BLOCKED (empty text, a secret/key in the text, unverified facts, a format the platform cannot publish, a type not allowed by the policy) is never published by any mode and an approval cannot lift it (the post is classified again at approval time).

## Policy fields (`PublishingPolicy`, one per account)
tenant (`businessId`), `socialAccountId`, `platform`, `mode`, `consentVersion`, `consentGrantedAt`/`ById`, `consentRevokedAt`, `authorizedScopes` (copy of the permissions held at consent time), `allowedContentTypes`, `maximumPostsPerDay` (1–10), `timezone`, `allowedPublishingHours` (`[{days,from,to}]` in that timezone), `requiresPlatformConfirmation`, `automationEnabled`, `pausedAt`.
Changing the mode needs a **current** consent (`CONSENT_VERSION`), a connected account without missing critical permissions and an active subscription. Consent can be revoked and automation paused at any time; revoking withdraws automatic schedules that were not handed to the publisher yet.

## Pipeline for one post (`PublishingAutomationService.process`)
1. Claim the decision row (unique per entry + content version) – a second run, a second worker or a restart finds it and does nothing; a crashed claim is recovered after 5 minutes (and resumes without repeating steps).
2. Classify (`classifyPublication`, pure, in `@touma/shared`): grounding against the verified business data, platform formats, allowed types, hours, daily limit, platform confirmation, sensitive/personal/misleading/promotion/brand wording.
3. BLOCKED → recorded, nothing happens. REVIEW_REQUIRED → submitted for approval (approvers notified). LOW_RISK under an active policy → approved and authorized as the consenting person (who must still hold `content.approve` + `publication.schedule`).
4. A decision records risk, reasons, mode, policy, snapshot hash, approver, `validUntil` (planned time + `AUTOPUBLISH_APPROVAL_GRACE_MINUTES`).
5. A person's approval (`POST /publishing/entries/:id/approve`) records the user, platform/account, exact content version, action (PUBLISH), time and validity, and the policy applied (history event). Any significant edit withdraws it through the calendar rules.

## Checks added to the publication gate (before the hand-off and again before the platform request)
Subscription active (when billing enforcement is on); for automated posts: no emergency stop (`AgentControl` GLOBAL/TENANT), policy exists in this business, consent current and not revoked, mode not MANUAL and enabled, not paused; approval validity window; daily limit of the policy counted in its timezone. A failure stops the post with a code and publishes nothing.

## Platform capability matrix (`PLATFORM_AUTOMATION`, `GET /publishing/capabilities`)
| Platform | Adapter | Per-post confirmation | Formats | Notes |
| --- | --- | --- | --- | --- |
| Instagram | implemented (official Graph API) | no | image, carousel, video | needs Meta app review; development mode limits who can connect |
| TikTok | implemented (Content Posting API) | **yes** (privacy, interactions, commercial disclosure, declarations) – automation stops and asks | video | unaudited apps post privately only |
| YouTube | implemented (Data API upload) | no | video | unaudited projects stay private; quota 10,000 units/day; sensitive scope verification |
| MockSocialProvider | test-only simulator | – | all | refused outside `APP_ENV=test` |
Nothing was tested against a real account, so "implemented" means code against the documented API, not proven. No browser automation, no scraping, no workaround of any restriction.

## API (`autopublish.read` / `autopublish.manage`; approving needs `content.approve` + `publication.schedule`)
`GET /publishing/accounts|capabilities|reviews|schedule|results|history`, `POST /publishing/accounts/:id/consent|consent/revoke|pause|resume`, `PUT /publishing/accounts/:id/policy`, `POST /publishing/plan`, `POST /publishing/entries/:id/process|approve|reject`.
UI: `/dashboard/publishing` (mode and consent per account, hours, daily limit, pause, approval queue, planned posts, results, estimated AI usage).
Emergency stop: the admin stop of the agents control center (`/admin/agents/stop`, GLOBAL or tenant) also stops automated publishing.

## Limits
Wording lists of the classifier are examples, not a guarantee; the human review and the platforms' rules remain the safety net. The planner places one post per day inside the allowed hours and prepares drafts from catalog facts (no AI call) unless posts are supplied; media must be attached by the caller. No batch approval. Real prices of platform quotas and the real behavior of the three platforms are unverified. Tests: `apps/api/test/autopublish.e2e-spec.ts` (18), `packages/shared/src/publishing-policy.spec.ts` (9).
