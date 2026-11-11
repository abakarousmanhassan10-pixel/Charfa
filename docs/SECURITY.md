# Security

## Implemented (Phase 1)

| Control | Implementation |
|---|---|
| Password storage | argon2id, OWASP parameters; strong-password policy (12+ chars, mixed case, digit) on both client and server |
| Brute force | Per-IP rate limit on auth endpoints, counted in Redis so the limit holds across API instances (atomic Lua fixed window; fails open with an error log if Redis is unreachable) + account lockout after 5 failures |
| User enumeration | Same error and similar timing for unknown email and wrong password |
| Sessions | Rotating refresh tokens, hashed at rest, family revocation on reuse (10 s re-issue grace for multi-tab/dropped responses, never after logout), server-side session check on each request, logout-all |
| Authorization (RBAC) | `@RequirePermission` → `BusinessAccessGuard` checks the ACTIVE membership and role permission on every tenant route; role hierarchy and last-owner rules in the service; deny by default when no permission is declared |
| Tenant isolation | `businessId` only from the verified `TenantContext`; non-members get 404; child ids scoped by `businessId`; platform admins have no implicit tenant access; covered by integration tests |
| Abuse limits | `MAX_OWNED_BUSINESSES` (default 5) until plan limits (Phase 10) |
| Token exposure | Access token in memory only; refresh cookie `httpOnly`, `Secure` in production, `SameSite=Strict`, path-scoped |
| CSRF | Cookie-authenticated endpoints need the `x-touma-csrf` header + an Origin allow-list, on top of SameSite=Strict |
| XSS | React escaping; strict CSP (`frame-ancestors 'none'`, `object-src 'none'`, `connect-src 'self'`); helmet on the API |
| Injection | Prisma parameterised queries only; no string-built SQL |
| Input validation | Global `ValidationPipe` with `whitelist` + `forbidNonWhitelisted` (blocks mass-assignment such as `platformRole`) |
| Error handling | Uniform error envelope with request id; no stack traces, SQL or provider payloads in responses |
| Secrets | Env validated at boot (min length, distinct JWT secrets in production); `.env` is git-ignored; secrets never logged |
| File uploads | Streamed to a 0600 temp file with a hard size cap; real type from magic bytes (JPEG/PNG/WebP/GIF/MP4/MOV/WebM only; SVG/HTML/PDF/executables rejected); declared type must match; per-type limits (`MEDIA_MAX_IMAGE_MB`, `MEDIA_MAX_VIDEO_MB`); image decoding and dimension limits; sanitised filenames; server-generated storage keys under the tenant prefix; rejected uploads are audited and never stored |
| Media delivery | Private bucket; HMAC-signed expiring same-origin URLs; `nosniff` + `sandbox` CSP on served files; no storage credentials or keys in any response |
| Resource ownership | Every catalog, media and knowledge query is scoped by `{ id, businessId }`; cross-tenant ids → 404; cross-tenant references in payloads (category, logo, product media) → 400 |
| AI data boundary | Agents only receive `buildAgentContext(tenant)`: verified facts and active items of that one business; edits reset verification; only ADMIN/OWNER can verify (`knowledge.verify`) |
| AI safety | Delimited untrusted data, neutralised delimiters, injection detection + audit, no tools/actions, schema + grounding + platform validation, drafts only on human request (see `docs/AI.md`) |
| AI cost control | Monthly generation and token limits per business enforced by **atomic reservations** (one conditional SQL `UPDATE`, so concurrent requests cannot exceed them), settled exactly once when the job ends, with unused quota released; self-healing reconciler for crashed jobs; per-client throttle; every provider call recorded with tokens and cost |
| AI background jobs | Job payload is ids only (no business data in Redis); the worker re-checks that the requesting user is still an active member with `ai.use`; duplicate or re-delivered jobs are ignored; failures are stored and never leak provider payloads or credentials |
| AI accuracy | Generated text is matched to the verified business data by type (prices, currency, percentages, contacts, dates, specifications, durations, audience figures, 12 families of risky claims, scarcity, item availability, source ids) and rejected otherwise; each generation stores a quality report. Rule-based: it cannot prove every sentence true |
| AI human approval | AI-written content cannot be published until a person with `content.approve` approves the exact text (`Content.approvedVersion`); editing withdraws the approval; approval re-checks the text against the facts as they are now; `assertPublishable()` is the publication gate; every step is audited |
| Encryption at rest | `TokenCipher` AES-256-GCM (random IV, auth tag, versioned format) for OAuth tokens (used from Phase 6) |
| Audit | `AuditLog` for register/login/failure/lockout/logout/reuse-detection/profile updates, business create/update/delete, membership role change/remove/leave, admin overview access; metadata is redacted automatically |
| Email verification | 24 h single-use token (SHA-256 hashed at rest, bound to the address it was sent to), delivered only in the URL fragment (`#token=`) so it never reaches server logs or `Referer`; resend cooldown 60 s; required before inviting people |
| Password reset | 30 min single-use hashed token; the response is identical whether the account exists or not (no enumeration); a successful reset revokes every session, clears lockout, sends a "password changed" notice and is audited |
| Invitations | Random 32-byte token, hashed, 7-day expiry, single use (atomic claim in a transaction); accepted only by a signed-in user whose email equals the invited address (mismatch → 403 + audit); role comes only from the invitation and must be ≤ the inviter's (`ROLE_HIERARCHY`), never OWNER; max 50 pending, resend max 5 with cooldown and token rotation, revocable |
| Media processing | Images are decoded and re-encoded with sharp (EXIF/GPS/ICC metadata stripped, orientation applied), so polyglot payloads and metadata don't survive; decoded-pixel limit (`MEDIA_MAX_IMAGE_PIXELS`) against decompression bombs; 480 px WebP thumbnails |
| Malware scanning | Every upload is streamed to clamd (INSTREAM) before storage; infected → 422 + audit with signature name, nothing stored; scanner down → 503 (fail closed); required in production |
| Storage quotas | Per-business quota (`MEDIA_STORAGE_QUOTA_MB` or `Business.storageQuotaBytes`) checked before and after processing → 413 |
| Storage cleanup | Object deletions go through a durable `StorageDeletion` queue retried by the worker, so failed deletes don't leave orphaned files |
| Production config | The API refuses to start in production/staging with insecure settings (http origins, example or shared secrets, dev DB password, unscanned uploads, no SMTP, in-memory rate limiting, test providers); see `docs/DEPLOYMENT.md` |
| Headers | HSTS, nosniff, Referrer-Policy, X-Frame-Options DENY, Permissions-Policy; `x-powered-by` removed |

## Planned controls (by phase)

- **Phase 4:** video transcoding and video metadata stripping (needs ffmpeg), per-plan (rather than per-business) storage quotas, moving image processing from the request into the worker.
- **Phase 6:** OAuth `state` + PKCE, encrypted token storage, webhook signature verification (HMAC, constant-time comparison), scope checks.
- **Phase 10:** payment webhook signature verification, GDPR export/deletion workflows, admin step-up auth, backup/restore drills.

## Secret management

- Local: `.env` (git-ignored), generated from `.env.example`.
- Production: platform secret manager (Vercel / Render / Fly / AWS Secrets Manager). Rotate JWT secrets by deploying a new value; all sessions then re-authenticate.
- `TOKEN_ENCRYPTION_KEY` rotation: the ciphertext format is versioned (`v1:`), so a dual-key decrypt path can be added for re-encryption.

## Backups

- Managed PostgreSQL with point-in-time recovery (7–30 days) and daily snapshots in another region.
- Redis only holds rebuildable state (queues, rate limits); jobs are re-derivable from `Publication` rows.
- Object storage: versioning + lifecycle rules.

## Reporting

Report vulnerabilities privately to the maintainers. Do not open public issues for security problems.

## Creative Studio controls (Phase 4)
- **Tenant isolation:** every generation, output, brand kit and generated file is scoped by `businessId`; storage keys are tenant-prefixed; cross-tenant access answers 404 (tested, including spoofed tenant headers).
- **Files:** uploaded product photos and every generated file go through content sniffing, malware scanning (fail-closed), re-encoding and quota checks. SVG is not accepted.
- **Credentials:** provider keys are server-side environment variables, redacted from provider errors and never returned to the browser.
- **Abuse and cost:** per-user rate limit, atomic monthly limits for images and video seconds, idempotency keys, no automatic resubmission of paid video jobs.
- **No fake media:** unconfigured providers return 503; `fake` providers are refused outside `APP_ENV=test` and flagged by production validation.
- **Truthfulness:** exact-product compositing, overlay text grounded against verified business data, illustrations labelled as such.
