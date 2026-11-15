-- N26 (2/2): billing engine. Additive: new columns/tables, then a data conversion of the local subscription rows to the new state set.
-- CreateEnum
CREATE TYPE "BillingMode" AS ENUM ('AUTO', 'MANUAL');

-- CreateEnum
CREATE TYPE "SubscriptionInterval" AS ENUM ('MONTHLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('OPEN', 'PAID', 'VOID');

-- CreateEnum
CREATE TYPE "PaymentKind" AS ENUM ('INITIAL', 'RENEWAL_AUTO', 'RENEWAL_MANUAL');

-- CreateEnum
CREATE TYPE "ProviderAccountEnvironment" AS ENUM ('SANDBOX', 'LIVE');


-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "amountMinor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "failureCode" TEXT,
ADD COLUMN     "sessionUrl" TEXT,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "kind" "PaymentKind",
ADD COLUMN     "periodEnd" TIMESTAMPTZ(3),
ADD COLUMN     "periodStart" TIMESTAMPTZ(3),
ADD COLUMN     "simulated" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Plan" ADD COLUMN     "priceAmountMinor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "yearlyPriceAmountMinor" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "amountMinor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "autoRenewConsentAt" TIMESTAMPTZ(3),
ADD COLUMN     "billingInterval" "SubscriptionInterval" NOT NULL DEFAULT 'MONTHLY',
ADD COLUMN     "billingMode" "BillingMode" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'USD',
ADD COLUMN     "pendingBillingInterval" "SubscriptionInterval",
ADD COLUMN     "pendingPlanId" TEXT,
ADD COLUMN     "userId" TEXT,
ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'OPEN',
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "planCode" TEXT NOT NULL,
    "description" TEXT,
    "periodStart" TIMESTAMPTZ(3) NOT NULL,
    "periodEnd" TIMESTAMPTZ(3) NOT NULL,
    "issuedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMPTZ(3),
    "paymentId" TEXT,
    "simulated" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionAuditLog" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "reason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentProviderAccount" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "environment" "ProviderAccountEnvironment" NOT NULL DEFAULT 'SANDBOX',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "capabilities" JSONB NOT NULL,
    "verifiedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PaymentProviderAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_number_key" ON "Invoice"("number");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_paymentId_key" ON "Invoice"("paymentId");

-- CreateIndex
CREATE INDEX "Invoice_businessId_issuedAt_idx" ON "Invoice"("businessId", "issuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_subscriptionId_periodStart_key" ON "Invoice"("subscriptionId", "periodStart");

-- CreateIndex
CREATE INDEX "SubscriptionAuditLog_subscriptionId_createdAt_idx" ON "SubscriptionAuditLog"("subscriptionId", "createdAt");

-- CreateIndex
CREATE INDEX "SubscriptionAuditLog_businessId_createdAt_idx" ON "SubscriptionAuditLog"("businessId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentProviderAccount_provider_key" ON "PaymentProviderAccount"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_idempotencyKey_key" ON "Payment"("idempotencyKey");

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_pendingPlanId_fkey" FOREIGN KEY ("pendingPlanId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- FK constraints (see schema)

-- Invoice numbers: one gapless-enough sequence for all invoices (SIM-<year>-<number> for simulated ones).
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq START 1;

-- Money to integer minor units (2-decimal currencies for existing plans; the seeded plans are USD). Yearly = 10 monthly prices (two months free), editable.
UPDATE "Plan" SET "priceAmountMinor" = ROUND("priceAmount" * 100)::int, "yearlyPriceAmountMinor" = ROUND("priceAmount" * 100)::int * 10 WHERE "priceAmountMinor" = 0;
UPDATE "Payment" SET "amountMinor" = ROUND("amount" * 100)::int WHERE "amountMinor" = 0;
UPDATE "Subscription" s SET "amountMinor" = p."priceAmountMinor", "currency" = p."currency" FROM "Plan" p WHERE p.id = s."planId" AND s."amountMinor" = 0;

-- State conversion: a trial becomes an ACTIVE subscription whose current period is the trial; INCOMPLETE -> PENDING; UNPAID -> EXPIRED.
UPDATE "Subscription" SET "status" = 'ACTIVE', "currentPeriodStart" = COALESCE("currentPeriodStart", "createdAt"), "currentPeriodEnd" = COALESCE("currentPeriodEnd", "trialEndsAt") WHERE "status" = 'TRIALING';
UPDATE "Subscription" SET "status" = 'PENDING' WHERE "status" = 'INCOMPLETE';
UPDATE "Subscription" SET "status" = 'EXPIRED' WHERE "status" = 'UNPAID';
