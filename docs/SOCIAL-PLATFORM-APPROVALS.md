# TOUMA — Platform approvals and live verification runbook

This is the checklist of what must happen **outside the code** before TOUMA can publish for real, to customers' accounts, on each platform — and how to verify each integration with real, authorized accounts.

> **Honesty rule.** Everything below that is described as "required" comes from the platforms' public developer documentation as understood when this was written (2026-11). Platforms change review rules, scopes, quotas and product names without notice. **Before applying, read the linked platform pages again**; where this document and the platform disagree, the platform wins. Nothing here has been confirmed against a real TOUMA application, because TOUMA has not yet applied for or received any approval (see `docs/phase-reports/PHASE-6-FINAL-VERIFICATION.md`).

Official brand: **TOUMA**. All prerequisites below also need: a public HTTPS domain, a published **privacy policy** and **terms of service** that describe the social features, a **data deletion** page or callback, and an app icon and description under the TOUMA name.

---

## 0. Common prerequisites (all platforms)

| Item | Why |
|---|---|
| Public HTTPS API address (`PUBLIC_API_URL`, `WEB_ORIGIN`) | OAuth redirects land on the API; Meta, TikTok and LinkedIn **download media from our signed URLs**, so the address must be reachable from the internet |
| Redirect URI registered with every platform: `{PUBLIC_API_URL}/api/v1/social/oauth/callback/{platform}` | OAuth rejects unknown redirect URIs |
| `TOKEN_ENCRYPTION_KEY` (32-byte base64, AES-256-GCM), `SOCIAL_PROVIDER_MODE=live` | Tokens are stored encrypted; `fake` mode is refused outside `APP_ENV=test` |
| Privacy policy, terms, data-deletion instructions | Required by every review below |
| A screencast of the real TOUMA flow (connect → select account → approve → schedule → published) | Required by Meta, TikTok, YouTube and LinkedIn reviews |
| One authorized **development account per platform** owned by the TOUMA team | Real tests must never use a customer's account |

---

## 1. Meta (Instagram + Facebook Pages) — priority platform

### 1.1 What TOUMA uses
Facebook Login (Business) → Page access tokens → Facebook Pages API (`/{page}/feed`, `/photos`, `/videos`) and the Instagram Graph API with Facebook Login (`/{ig-user}/media`, `/media_publish`). Instagram video is published as a **Reel**. Instagram requires a **Professional (Business or Creator) account linked to a Facebook Page**.

Permissions requested (`FacebookPublisher` / `InstagramPublisher.requiredScopes`):
`pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `read_insights`, `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`.

### 1.2 Steps, in order
1. **Create a Meta developer account** and a **Meta app** of type *Business* (Meta for Developers → My Apps). Add the products *Facebook Login* and *Instagram* (Instagram API with Facebook Login). Set the privacy-policy URL, terms URL, data-deletion URL, category and icon (Settings → Basic).
2. **Development mode first.** While the app is in *Development* mode, only people with a role on the app (administrator, developer, tester) can authorize it, and the permissions above work for **their own Pages and linked Instagram accounts without App Review**. This is the mode for the live verification below. Add the TOUMA team's development Facebook users as app *Testers*/*Developers*; each must accept the role.
3. **Create the development assets**: a Facebook Page, and a separate Instagram **Professional** account linked to that Page (Page settings → Linked accounts). Posts made during testing are visible to anyone who can see that Page/account: use a Page that is unpublished/restricted, or delete test posts afterwards.
4. **Run the live verification** (section 6) in development mode. This is the only way to prove OAuth, account selection, publishing, post IDs and URLs against the real API.
5. **Business Verification** (Meta Business Suite → Security Center → Business verification). Required before Meta grants *Advanced Access* to permissions that read or write **other people's** assets — i.e. before TOUMA's customers (who do not have a role on the TOUMA app) can connect. You need legal business documents (registration, address, phone/website domain verification). Allow days to weeks. Because TOUMA serves businesses that are not its owner, Meta will also ask you to be identified as a **Tech Provider** (an *Access Verification* step) — follow the prompts in the app dashboard.
6. **App Review** — request **Advanced Access** for each permission, one by one, each with: a clear written use case, step-by-step test instructions, a test user/account reviewers can use, and a **screencast** showing the permission used end-to-end in TOUMA:
   - `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `read_insights` — show: connect, select a Page, publish a post, see the link and the statistics.
   - `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights` — show: select the Instagram account, publish an image and a Reel, see the permalink and insights.
   - `business_management` is **not** requested today; add it only if you decide to list Pages through a Business portfolio (it needs its own review).
7. **Switch the app to Live mode** after approval (required for non-role users).
8. **Annual Data Use Checkup** and keep the contact details current; Meta can revoke access if the checkup is missed.

### 1.3 Platform behavior TOUMA already accounts for
- Page tokens derived from a long-lived user token **do not expire**; the *user* token lasts ~60 days and **cannot be refreshed without the person** — TOUMA reports `TOKEN_EXPIRED`/reconnect rather than pretending to refresh (`supportsRefresh=false`).
- A permission declined at login is reported per account (`permissionsMissing`); reconnecting uses `auth_type=rerequest`.
- **Instagram:** JPEG images only, 4:5 to 1.91:1; media must be reachable by URL; publishing is a two step flow (container → `media_publish`); the API limits API-published posts per account per 24 hours (check the current number in Meta's *Content Publishing* docs — TOUMA does not hard-code it, and a limit error is reported as rate-limited, not retried blindly).
- **Facebook video** is accepted asynchronously; TOUMA polls `status` and only reports success when the video is `ready`.

### 1.4 Listing accounts: pagination
`GET /me/accounts` is **followed to its last page** using `paging.cursors.after` / `paging.next` (page size 50), a cursor-loop guard, and a hard safety cap of 200 requests (≈10,000 Pages). If the cap is ever hit, every returned account carries `metadata.listingTruncated = true` and the live verification prints `LISTING TRUNCATED` — the list is never silently cut at 100. Tested with a 230-Page manager (`verification.spec.ts`).

---

## 2. TikTok

### 2.1 What TOUMA uses
Login Kit (OAuth authorization code) + **Content Posting API — Direct Post**: `creator_info/query`, `video/init`, `content/init` with `source: PULL_FROM_URL`, then `status/fetch`. Scopes requested: `user.info.basic`, `video.publish`, `video.upload`, `video.list` (`video.list` is used by reconciliation and metrics; if the creator does not grant it, reconciliation reports UNAVAILABLE).

### 2.2 The audit, and what it means
- **Until TikTok audits the application, content posted through Direct Post is restricted to private visibility (`SELF_ONLY`) — and the creator account must be private/ the target user must be added as a sandbox target.** Posts are *not public*. TOUMA asks TikTok for the most public privacy level the creator and the app allow and **shows the resulting restriction**; it never reports a post as publicly published when TikTok limited it.
- **TOUMA must therefore treat TikTok public publishing as NOT WORKING until the audit is approved.** No document, test or report may claim otherwise.
- Audit requirements (from TikTok's *Content Sharing Guidelines* — re-read them before applying): the UX shown to the creator must display the creator's nickname, let them choose privacy level (no default that bypasses their choice), toggle comments/duet/stitch, disclose commercial content ("Your brand"/"Branded content"), show the right music-usage/branded-content consent text, and let them see the processing state; the app must not post without the creator's explicit action. A demo video of the whole flow, working privacy-policy and terms URLs, and a description of the use case are submitted with the audit request.
- **`PULL_FROM_URL` requires TikTok to verify ownership of the URL prefix/domain** that serves media (Developer portal → Manage apps → *URL properties*). Verify the media domain (`PUBLIC_API_URL` host) or TikTok rejects the pull.
- **Sandbox:** TikTok's sandbox lets named *target users* test Login Kit/Content Posting with the app unaudited. Use it for the live verification.
- Per-creator daily posting caps and file limits (size, 3 s–10 min, codecs H.264/H.265/VP8/VP9) apply; TOUMA validates size/duration/codec/dimensions before sending (§5).

### 2.3 Steps
1. Create an app at developers.tiktok.com; add *Login Kit* and *Content Posting API*; set redirect URI, terms, privacy policy. 2. Verify the media URL prefix. 3. Add development accounts as sandbox target users. 4. Live-verify (§6) → expect `SELF_ONLY`/private results. 5. Build/confirm the TikTok-mandated UI requirements in the TOUMA scheduling step (creator info, privacy choice, interaction toggles, disclosure) — **this UI does not exist yet** and is a blocker for the audit (see report). 6. Submit the app for audit with the demo video. 7. Only after approval, re-run the live verification and confirm a **public** post.

---

## 3. YouTube

### 3.1 What TOUMA uses
Google OAuth 2.0 (PKCE) with scopes `youtube.upload` and `youtube.readonly`; YouTube Data API v3 `videos.insert` (resumable upload), `channels.list`, `playlistItems.list` (reconciliation), `videos.list` (statistics). TOUMA sets title, description, tags, category and privacy at upload and records the platform's video id and watch URL.

### 3.2 Quota
- Default quota is **10,000 units per day per Google Cloud project**. `videos.insert` costs **1,600 units** → **about 6 uploads per day for the entire TOUMA project, across all customers**. Reads cost 1 unit. TOUMA maps `quotaExceeded` to a rate-limited error with a long retry delay and does not retry in a tight loop.
- A **quota extension** is requested with Google's *YouTube API Services — Audit and Quota Extension* form: describe the product, expected daily uploads, and attach compliance details. Plan for this before any real customer volume.

### 3.3 Audit and verification restrictions
- **Unverified / unaudited API projects: videos uploaded via `videos.insert` are locked to private** (a restriction Google applies to API projects created since 28 July 2020 until the project passes the *API compliance audit*). TOUMA must treat YouTube public publishing as NOT WORKING until the audit passes; the adapter records the `privacyStatus` YouTube returns, so a locked video is visible in the result rather than hidden.
- **OAuth consent screen:** while the app is in *Testing*, only listed test users (max 100) can authorize and **refresh tokens expire after 7 days**. To go to production, submit the app for **OAuth verification** (sensitive scope `youtube.upload`): verified domain, privacy policy, a demo video of the consent flow and the scope usage.
- Steps: Google Cloud project → enable *YouTube Data API v3* → OAuth consent screen (External) → add scopes and test users → create OAuth client (Web) with the TOUMA redirect URI → live-verify in Testing mode (expect private uploads) → OAuth verification → API compliance audit + quota extension → re-verify public upload.

---

## 4. LinkedIn

### 4.1 Personal profile vs organization — verified separately
| | Personal profile | Organization (Company Page) |
|---|---|---|
| Account type in TOUMA | `PROFILE` (`urn:li:person:…`) | `ORGANIZATION` (`urn:li:organization:…`) |
| Product / permission | *Sign In with LinkedIn using OpenID Connect* + **Share on LinkedIn** → `w_member_social` (self-serve, approved immediately) | **Community Management API** → `w_organization_social` (+ `r_organization_social`, `rw_organization_admin` to list and read) — **by application and approval only** |
| Who may post | The member themself | A member who is an **administrator** of the Page |
| Reading own posts (used by reconciliation) | Needs `r_member_social`, a **restricted** permission not granted by default | `r_organization_social` (inside Community Management) |
TOUMA lists the organization ACLs only when the authorization includes organization scopes; a refusal means "personal publishing only" and is displayed as such. The two account kinds are separate connectable accounts with separate `permissionsMissing`.

### 4.2 Approval for organization publishing
1. Create a LinkedIn developer app and **associate it with the TOUMA LinkedIn Page**; the Page's super-administrator must **verify** the association. 2. Request the **Community Management API** product (Products tab → request access; a form asks for the business use case, legal entity, website, screencast). Review is manual and can take weeks; it may be granted first as a *development tier* (limited members/calls) and later upgraded to the *standard tier* after a second review with proof of compliant use. 3. LinkedIn states that the Community Management API app is reviewed as a dedicated app; if LinkedIn requires it to be a separate app from the sign-in/share app, create two apps and use two client ids (not yet supported by TOUMA configuration — see report). 4. Add `LINKEDIN_ORG_SCOPES=true` only after approval.
Until then TOUMA publishes to **personal profiles only** and shows organization publishing as unavailable.

---

## 5. Media validation (all platforms)

Before any media is sent, TOUMA reads the **file's own bytes** (not its name, not the browser-declared type, not stored metadata): container (MP4/MOV, JPEG, PNG), pixel dimensions, duration, video codec and audio codec (`probeMedia`). A file whose content does not match its type, or a video with no readable video track, is rejected with a clear message. Rules (`MEDIA_RULES` + `PLATFORM_CAPABILITIES`), each producing a specific message that names the file, the measured value and the allowed range:

| Platform | Images | Video | Codecs |
|---|---|---|---|
| Instagram | JPEG, ≤ 8 MB, 4:5–1.91:1, ≥ 320 px short side | ≤ 300 MB, 3 s–15 min, 9:16–1.91:1, ≥ 540 px short side | H.264/H.265 + AAC |
| Facebook | JPEG/PNG, ≤ 10 MB, ≥ 200 px | ≤ 1 GB, ≤ 4 h | H.264/H.265 + AAC |
| TikTok | JPEG/WEBP | ≤ size cap, 2:1–1:2, 360–4096 px | H.264/H.265/VP8/VP9 |
| YouTube | — (video only) | Shorts: vertical/square, ≤ 180 s | H.264/H.265/VP8/VP9/AV1 |
| LinkedIn | ≤ 36.2 megapixels | ≤ 5 GB, 3 s–30 min, 1:2.4–2.4:1, 144–4096 px | H.264 + AAC |

The tables of limits are a *pre-flight* filter built from the platforms' published docs. The platform always has the last word: a rejection from the API is reported as `PLATFORM_REJECTED` with the platform's message. The live verification is what confirms the numbers against reality.

---

## 6. Live verification runbook

`packages/social-connectors/scripts/live-verify.ts` runs the **real** adapters against the **real** APIs. It never fabricates: a step that cannot run is `SKIPPED` with the reason; only a platform-issued response counts as `PASSED`.

### 6.1 Two levels of proof
- **Level A — CLI with supplied tokens** (fast; proves token validity, permissions, account listing & pagination, publishing, status, post id/URL, reconciliation lookup). It does **not** prove the browser consent flow.
- **Level B — the real OAuth round trip through TOUMA** (proves redirect URIs, state/PKCE, code exchange, account selection screen, encrypted storage, refresh). It needs the API deployed on a public HTTPS URL and a person clicking through the consent screens with the development account. Run it on a staging deployment: *Social → Connect → platform → consent → select account → Connected*, then check the account shows `CONNECTED` with the expected permissions, and run a scheduled publication from the calendar.

### 6.2 Inputs for Level A
```
META_APP_ID, META_APP_SECRET            LIVE_META_USER_TOKEN        (long-lived user token of an app tester, with the scopes of §1.1)
TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET LIVE_TIKTOK_ACCESS_TOKEN    LIVE_TIKTOK_SCOPES="user.info.basic video.publish video.upload video.list"
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET  LIVE_YOUTUBE_ACCESS_TOKEN   LIVE_YOUTUBE_SCOPES="https://www.googleapis.com/auth/youtube.upload ..."
LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET  LIVE_LINKEDIN_ACCESS_TOKEN  LIVE_LINKEDIN_SCOPES="openid profile w_member_social"
LIVE_ACCOUNT_ID (optional)   LIVE_MEDIA_IMAGE_URL (public https JPEG)   LIVE_MEDIA_VIDEO_URL (public https MP4, H.264/AAC)
LIVE_REPORT=/path/report.md (optional)
```
Never commit these values; pass them in the shell for one run. Obtain a Meta user token from *Graph API Explorer* (select the TOUMA app, the user, add the permissions, then exchange it for a long-lived token), or take it from a Level B connection.

### 6.3 Commands
```
pnpm --filter @touma/social-connectors live-verify              # read-only: config, token, permissions, listing
pnpm --filter @touma/social-connectors live-verify -- --publish # also publishes ONE REAL TEST POST per platform and looks it up again
```
### 6.4 What to record for the report (per platform)
OAuth consent worked (Level B) · accounts listed (count, types) · permissions missing · image published (post id, URL opens) · video published (post id, URL opens, processing time) · final status read back from the platform · reconciliation lookup finds the post · visibility actually obtained (public / private-restricted). Delete the test posts afterwards.

---

## 7. Status summary (as of this document)

| Platform | App created | Dev account tested | Review / audit submitted | Public publishing for customers |
|---|---|---|---|---|
| Meta (Instagram, Facebook) | not by TOUMA | **not tested** | no | **No** — needs Business Verification + App Review |
| TikTok | not by TOUMA | **not tested** | no | **No** — private only until audited |
| YouTube | not by TOUMA | **not tested** | no | **No** — private uploads until compliance audit; ~6 uploads/day quota |
| LinkedIn — personal | not by TOUMA | **not tested** | n/a (self-serve) | Possible after app creation + Share on LinkedIn product |
| LinkedIn — organization | not by TOUMA | **not tested** | no | **No** — needs Community Management API approval |
