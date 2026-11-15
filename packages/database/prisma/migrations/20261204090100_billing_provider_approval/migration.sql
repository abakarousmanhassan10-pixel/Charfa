-- N27 (2/2): additive only. Provider approval record (blocks live payments), out-of-order event guard, plan entitlements.
CREATE TYPE "ProviderApprovalStatus" AS ENUM ('NOT_SUBMITTED', 'PENDING_REVIEW', 'APPROVED', 'REJECTED');

ALTER TABLE "PaymentProviderAccount"
  ADD COLUMN "approvalStatus" "ProviderApprovalStatus" NOT NULL DEFAULT 'NOT_SUBMITTED',
  ADD COLUMN "approvalReference" TEXT,
  ADD COLUMN "approvalNote" TEXT,
  ADD COLUMN "approvedAt" TIMESTAMPTZ(3),
  ADD COLUMN "approvalUpdatedById" TEXT,
  ADD COLUMN "approvalUpdatedAt" TIMESTAMPTZ(3);

ALTER TABLE "Subscription" ADD COLUMN "lastPaymentConfirmedAt" TIMESTAMPTZ(3);

-- Plan entitlements live in Plan.limits (JSON): agents, features, sales interactions. Merged only where absent, never overwriting an edited plan.
UPDATE "Plan" SET "limits" = "limits" || '{"agents":["BUSINESS_ANALYST","PRODUCT_ANALYST","CONTENT_CREATOR","CUSTOMER_SUPPORT","SCHEDULER"],"features":["ai","calendar","sales"],"salesInteractionsPerMonth":100}'::jsonb WHERE "code" = 'STARTER' AND NOT ("limits" ? 'agents');
UPDATE "Plan" SET "limits" = "limits" || '{"agents":["BUSINESS_ANALYST","PRODUCT_ANALYST","MARKETING_STRATEGIST","CONTENT_CREATOR","VISUAL_CREATOR","SCHEDULER","CUSTOMER_SUPPORT","PERFORMANCE_ANALYST"],"features":["ai","calendar","sales","creative","market","campaigns","workflows"],"salesInteractionsPerMonth":500}'::jsonb WHERE "code" = 'PRO' AND NOT ("limits" ? 'agents');
UPDATE "Plan" SET "limits" = "limits" || '{"agents":["BUSINESS_ANALYST","PRODUCT_ANALYST","MARKETING_STRATEGIST","CONTENT_CREATOR","VISUAL_CREATOR","VIDEO_CREATOR","SCHEDULER","CUSTOMER_SUPPORT","PERFORMANCE_ANALYST"],"features":["ai","calendar","sales","creative","market","campaigns","workflows","intelligence","autopilot"],"salesInteractionsPerMonth":2000}'::jsonb WHERE "code" = 'BUSINESS' AND NOT ("limits" ? 'agents');
