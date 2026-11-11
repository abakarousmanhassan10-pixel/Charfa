-- Reconciliation of publications whose outcome is unknown (the platform is asked what exists before anyone retries).
ALTER TABLE "Publication" ADD COLUMN "reconcileResult" TEXT,
ADD COLUMN "reconcileNote" TEXT,
ADD COLUMN "reconcileAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "reconciledAt" TIMESTAMPTZ(3),
ADD COLUMN "reconciledFound" BOOLEAN NOT NULL DEFAULT false;
