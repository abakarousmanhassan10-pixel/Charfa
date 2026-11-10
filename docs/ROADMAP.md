# Roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 | Monorepo, Docker, PostgreSQL, Redis, Prisma (full schema), authentication, RBAC, business management, tenant isolation, onboarding, dashboard, EN/FR | ✅ Done |
| 2 | Email provider, email verification, password reset, team invitations, product & service catalog, knowledge base, Redis rate-limit store | ⏭ Next |
| 3 | AI engine: provider abstraction, orchestrator, Business/Product analyst, Content creator, knowledge base, usage metering, prompt-injection defences | Planned |
| 4 | Image generation provider, media library, secure uploads to S3 | Planned |
| 5 | Content calendar (day/week/month, 30-day plan), approval workflow, previews, video briefs | Planned |
| 6 | OAuth + official connectors: Instagram, Facebook, TikTok, YouTube; encrypted tokens; webhooks | Planned |
| 7 | Scheduled publishing worker: idempotency, leasing, retries, provider confirmation, manual fallback | Planned |
| 8 | Unified inbox, AI reply suggestions, escalation & human approval | Planned |
| 9 | Analytics sync, reports, platform comparison, AI recommendations (estimates labelled) | Planned |
| 10 | Subscriptions & billing, plan limits, admin dashboard, data deletion, production deployment | Planned |

Each phase ends with: tests run and green, docs updated, migrations verified, security review, and a report in `docs/phase-reports/`.
