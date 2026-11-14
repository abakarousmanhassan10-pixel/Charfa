-- N25: additive only. Failed-payment tracking and provider-migration traceability.
ALTER TABLE "Subscription" ADD COLUMN "failedPaymentCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Subscription" ADD COLUMN "lastPaymentFailureAt" TIMESTAMPTZ(3);
ALTER TABLE "Subscription" ADD COLUMN "providerMigratedFrom" TEXT;
