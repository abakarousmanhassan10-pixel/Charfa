# Social connectors 2.0 (phase N19)

Everything here runs locally with the test-only simulator. No real platform was contacted, no developer account was created and nothing paid was enabled.
The matrix below lives in code (`packages/shared/src/social-capabilities.ts`) and is what the API and the Social Accounts page show.

## Capability matrix

Status words: **DOCUMENTED** (in an official source we read), **UNVERIFIED** (conflicting or third-party sources only), **UNSUPPORTED** (no official API found for TOUMA), **NOT_IMPLEMENTED** (exists officially, TOUMA does not build it).
Nothing was tested against a real platform, so "documented" is not "proven".

| Platform | Publish | Read comments | Reply to comments | Direct messages |
|---|---|---|---|---|
| Instagram (Business/Creator linked to a Page) | Implemented (N6) | DOCUMENTED: `instagram_manage_comments` + `pages_read_engagement` | DOCUMENTED: `POST /{comment-id}/replies` | NOT_IMPLEMENTED (24-hour window, app review) |
| Facebook Pages | Implemented | UNVERIFIED: sources disagree on the extra permission | UNVERIFIED: `pages_manage_engagement` | NOT_IMPLEMENTED (Messenger, 24-hour window) |
| TikTok | Implemented (Content Posting; unaudited apps post privately only) | UNSUPPORTED | UNSUPPORTED | UNSUPPORTED (not verified) |
| YouTube | Implemented (uploads of unaudited projects stay private) | UNVERIFIED: `commentThreads.list`, 1 unit | UNVERIFIED: `comments.insert`, 50 units, scope `youtube.force-ssl` per third parties | UNSUPPORTED (no API) |
| LinkedIn (extra) | Personal profile only | UNSUPPORTED (needs Community Management API approval) | UNSUPPORTED | UNSUPPORTED |

Quotas: YouTube defaults to 10,000 units/day per project (about 200 replies/day if nothing else is used). Meta limits are per application and not verified here.
TOUMA caps replies itself (`SOCIAL_MAX_REPLIES_PER_DAY`, default 100) and publications (`SOCIAL_MAX_PUBLICATIONS_PER_DAY`, default 50).
Development mode: only people with a role on the app (Meta) or listed test users (Google) can connect.

## State shown per account

`AVAILABLE`, `PERMISSION_MISSING` (with the missing scopes), `UNVERIFIED`, `UNSUPPORTED`, `NOT_IMPLEMENTED`. The state is derived from the scopes actually granted and from the adapter methods that really exist.
The scopes TOUMA requests at connection are **unchanged** (least privilege). Comment features therefore show `PERMISSION_MISSING` on real accounts until a later, explicitly authorized phase adds the scopes and the platform approves the app.

## Contract mapping (step 4)

| Requested name | Where it lives |
|---|---|
| `connect()` / `disconnect()` | OAuth start/callback/select and `POST /social/accounts/:id/disconnect` (`SocialAccountsService`) |
| `getCapabilities()` | `GET /social/accounts/:id/capabilities` |
| `validateConnection()` | `POST /social/accounts/:id/validate` (read-only token inspection; a rejected token marks the account "reconnect needed") |
| `publishApprovedContent()` | `PublicationGate` then `SocialPublisherService` (N18 gate rechecked immediately before dispatch) |
| `fetchAuthorizedComments()` | `POST /social/publications/:id/comments/sync` (`adapter.fetchComments`) |
| `replyToAuthorizedComment()` | `POST /social/comments/:id/reply` (`adapter.replyToComment`) |

Adapters without a method (TikTok, LinkedIn) fail safely: HTTP 501 `UNSUPPORTED_OPERATION`, nothing is called.

## Safety rules for replies

- Feature flags `SOCIAL_COMMENTS_ENABLED` and `SOCIAL_COMMENT_REPLIES_ENABLED` default to **false**.
- A person with `inbox.reply` may answer in any mode (explicit action). An automatic reply is accepted only when the merchant's agent is enabled, set to AUTO **and** an authorization date exists; it is rechecked right before sending. PAUSED or MANUAL: nothing is sent and the refusal is audited.
- A placeholder row is written before sending, so a repeated click or a duplicate callback cannot answer twice. An unknown outcome (timeout after sending) is marked and **never retried automatically**.
- Rate limit → 429, expired token → 409 and the account asks for reconnection, outage → 503, missing permission → 409.
- Tokens stay encrypted at rest and are never returned, logged or stored in the browser.

## What is needed for real access (not done, needs the owner's authorization)

1. Create developer apps yourself (Meta, TikTok, Google) and set the `*_CLIENT_ID/SECRET` variables; no account was created for you.
2. Meta: App Review for the comment permissions, Business Verification if you serve accounts you do not own; test with role holders first.
3. Google: OAuth consent-screen verification; a YouTube API compliance audit for public uploads; confirm the exact comment scopes on Google's reference page.
4. TikTok: app audit before public posting; comment APIs are not available to TOUMA.
5. Re-check every UNVERIFIED row against the official page before enabling the flags, then add the scopes in a reviewed change.
6. Run the live-verification tools with a real test account before any merchant uses it.
