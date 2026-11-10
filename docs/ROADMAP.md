# Roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 | Monorepo, Docker, PostgreSQL, Redis, Prisma (full schema), authentication, RBAC, business management, tenant isolation, onboarding, dashboard, EN/FR | ✅ Done |
| 2 | Business management (logo, contacts), products, services, categories, media library (S3), business knowledge base | ✅ Done |
| 3 | ✅ Done. AI engine: provider abstraction, orchestrator, Business/Product analyst, Content creator, knowledge base, usage metering, prompt-injection defences | Planned |
| 4 | ⏭ Next. Image generation provider, media library, secure uploads to S3 | Planned |
| 5 | Content calendar (day/week/month, 30-day plan), approval workflow, previews, video briefs | Planned |
| 6 | OAuth + official connectors: Instagram, Facebook, TikTok, YouTube; encrypted tokens; webhooks | Planned |
| 7 | Scheduled publishing worker: idempotency, leasing, retries, provider confirmation, manual fallback | Planned |
| 8 | Unified inbox, AI reply suggestions, escalation & human approval | Planned |
| 9 | Analytics sync, reports, platform comparison, AI recommendations (estimates labelled) | Planned |
| 10 | Email provider (verification, password reset, invitations), Redis rate-limit store, subscriptions & billing, plan limits, admin dashboard, data deletion, production deployment | Planned |

Each phase ends with: tests run and green, docs updated, migrations verified, security review, and a report in `docs/phase-reports/`.
