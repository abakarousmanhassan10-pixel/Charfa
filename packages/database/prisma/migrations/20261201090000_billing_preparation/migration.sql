-- N24: additive only. New webhook provider values and an opaque payment-method reference (never card data).
ALTER TYPE "WebhookProvider" ADD VALUE 'PAYONEER';
ALTER TYPE "WebhookProvider" ADD VALUE 'SIMULATED_BILLING';
ALTER TABLE "Subscription" ADD COLUMN "paymentMethodRef" TEXT;
