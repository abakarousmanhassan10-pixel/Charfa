-- N26 (1/2): additive only. New subscription states; they are used by the next migration (PostgreSQL requires a separate transaction).
ALTER TYPE "SubscriptionStatus" ADD VALUE 'PENDING';
ALTER TYPE "SubscriptionStatus" ADD VALUE 'GRACE_PERIOD';
ALTER TYPE "SubscriptionStatus" ADD VALUE 'EXPIRED';
ALTER TYPE "WebhookProvider" ADD VALUE 'IYZICO';
