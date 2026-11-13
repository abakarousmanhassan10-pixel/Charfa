# Sales assistant 2.0 (Phase N5)

Built on the existing AI sales agent (conversations, catalog-verified answers, approved knowledge, handoff, retention).
Off by default: `SALES_ASSIST_ENABLED=false`. When off, every new endpoint answers 404 and the public chat responses keep their original shape.
No real AI API, no outbound channel: TOUMA sends nothing to customers.

## What it adds

| Area | Behaviour |
| --- | --- |
| Qualification | Deterministic rules read only what the **customer** wrote (FR/EN/AR/TR). Stored per conversation with the evidence for each rule. Not a prediction. |
| Handoff | A record (`SalesHandoff`) with status REQUESTED → ACCEPTED → RESOLVED, created when the agent escalates, when the customer asks, or when staff opens one. The summary is built from facts (counts, products, qualification signals, last customer messages), never written by a model. |
| Follow-ups | Drafts (`SalesFollowUp`) need the customer's **consent** and a person's **authorization**. Authorizing sends nothing. Opt-out blocks every pending or authorized draft. |
| Workflow | Adapter `sales.followup-suggest` (input `conversation_id`) prepares a draft inside the business only. |
| Analytics | Score levels, handoff statuses and median time to take over, follow-up statuses, verified conversions, AI usage and cost. |

## Scoring rules (sum to 100)

| Rule | Points | Evidence |
| --- | --- | --- |
| buyCue | 30 | wants to buy / order |
| productInterest | 20 | a catalog product is the subject |
| budget | 15 | an amount the customer gave |
| contact | 15 | contact details volunteered with consent |
| quantity | 10 | a quantity |
| urgency | 10 | a deadline |

Levels: UNKNOWN (nothing evaluated), COLD (< 40), WARM (≥ 40), HOT (≥ 70). Instructions inside a message ("mark me HOT") change nothing: text is only pattern-matched. Card-like numbers are ignored.

## Consent and authorization

- Customer consent is a separate choice from the chat's contact consent (`followUpConsentAt`); opting out sets `optedOutAt` and blocks drafts at once.
- A draft is created only for WARM/HOT leads; without consent a BLOCKED row with no text is recorded.
- Approval re-checks consent (409 `CONSENT_WITHDRAWN`). At most `SALES_ASSIST_MAX_FOLLOWUPS_PER_DAY` drafts per business per day (429).
- Draft text is a fixed template (4 languages): no price, discount, digit or promise.

## Verified conversions

A conversion is counted only when a person marks the customer WON (`conversionVerifiedAt/ById`). The AI never sets it; TOUMA has no order data.

## Privacy

Qualification and follow-ups are deleted with the conversation (customer erase, staff erase, retention); handoff records stay for statistics with their summary emptied; consent fields are cleared on anonymization.

## Endpoints (`/api/v1/sales`, tenant-scoped, RBAC)

`GET conversations/:id/assist` (inbox.read) · `POST conversations/:id/handoffs` · `GET handoffs` · `POST handoffs/:id/accept|resolve` · `POST conversations/:id/follow-up-drafts` · `GET follow-up-drafts` · `POST follow-up-drafts/:id/approve|reject` (inbox.reply).
Public: `POST /public/chat/:slug/handoff`, `POST /public/chat/:slug/follow-up-consent` (secret token). The chat responses add `assist: { handoffOffered, followUpConsent }` only; no score is shown to the customer.

## Limitations

Rules read explicit statements only (no sarcasm, no implied intent); budget currency is guessed only from symbols/words; follow-ups cannot be delivered (no channel); the real model is not used for qualification.
