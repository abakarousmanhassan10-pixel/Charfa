# Security

## Implemented (Phase 1)

| Control | Implementation |
|---|---|
| Password storage | argon2id, OWASP parameters; strong-password policy (12+ chars, mixed case, digit) on both client and server |
| Brute force | Per-IP rate limit on auth endpoints (Redis-ready throttler) + account lockout after 5 failures |
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
| AI cost control | Monthly generation/token limits per business checked before provider calls; per-client throttle; every provider call recorded |
| Encryption at rest | `TokenCipher` AES-256-GCM (random IV, auth tag, versioned format) for OAuth tokens (used from Phase 6) |
| Audit | `AuditLog` for register/login/failure/lockout/logout/reuse-detection/profile updates, business create/update/delete, membership role change/remove/leave, admin overview access; metadata is redacted automatically |
| Headers | HSTS, nosniff, Referrer-Policy, X-Frame-Options DENY, Permissions-Policy; `x-powered-by` removed |

## Planned controls (by phase)

- **Phase 2:** invitation tokens (hashed, expiring, single-use) with email verification, tenant isolation tests for every new resource (catalog), Redis-backed rate-limit storage for multi-instance deployments.
- **Phase 4:** image re-encoding/EXIF stripping and thumbnails in the worker, malware scanning hook, video transcoding, orphaned-object cleanup job, per-plan storage quotas.
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
