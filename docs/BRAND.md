# Brand identity

| | |
|---|---|
| Official SaaS brand name | **TOUMA** |
| Product name | **TOUMA AI** |
| Internal project name | **TOUMA** (package scope `@touma/*`) |
| Slogan (EN) | *Your Business. Your AI Marketing Team.* |
| Slogan (FR) | *Votre entreprise. Votre équipe marketing IA.* |

## Source of truth
`packages/shared/src/brand.ts` exports `BRAND` and `brandSlogan(locale)`. Use them everywhere (web metadata, logo, API docs, emails) instead of hard-coding the names. UI copy lives in `apps/web/messages/*.json` (`common.appName`, `common.productName`, `common.slogan`).

## Logo
`apps/web/components/logo.tsx` is a placeholder: a "T" monogram on the primary colour, the **TOUMA** wordmark, and an optional **AI** suffix (product mark). Replace the monogram with the final SVG when brand assets are ready, and keep `aria-label="TOUMA AI"`.

## Colours
Primary indigo (`--primary`, `#4f46e5` in email-safe hex). Light and dark tokens are in `apps/web/app/globals.css`.

## Email templates
`packages/shared/src/email-layout.ts` → `renderEmail()` produces the branded HTML and plain-text layout (monogram header, TOUMA AI, slogan footer, RTL-aware, all values escaped). Transactional templates (verification, invitations, password reset, billing) build on it once an email provider is configured.

## Technical identifiers
| Identifier | Value |
|---|---|
| Refresh cookie | `touma_rt` |
| Locale cookie | `touma_locale` |
| CSRF header | `x-touma-csrf` |
| JWT issuer / audience | `touma-api` / `touma-web` |
| Queue prefix | `touma.*` |
| Local DB / user | `touma`, `touma_test` / `touma` |
