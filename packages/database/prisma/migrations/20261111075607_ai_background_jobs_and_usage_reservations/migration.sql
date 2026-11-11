-- CreateEnum
CREATE TYPE "AIReservationStatus" AS ENUM ('RESERVED', 'COMMITTED', 'RELEASED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AIGenerationStatus" ADD VALUE 'QUEUED';
ALTER TYPE "AIGenerationStatus" ADD VALUE 'RUNNING';

-- AlterTable
ALTER TABLE "AIGeneration" ADD COLUMN     "completedAt" TIMESTAMPTZ(3),
ADD COLUMN     "jobAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "quality" JSONB,
ADD COLUMN     "queuedAt" TIMESTAMPTZ(3),
ADD COLUMN     "rootId" TEXT,
ADD COLUMN     "startedAt" TIMESTAMPTZ(3),
ADD COLUMN     "steps" JSONB;

-- AlterTable
ALTER TABLE "Content" ADD COLUMN     "approvedVersion" INTEGER;

-- CreateTable
CREATE TABLE "AIUsagePeriod" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "periodStart" TIMESTAMPTZ(3) NOT NULL,
    "reservedGenerations" INTEGER NOT NULL DEFAULT 0,
    "completedGenerations" INTEGER NOT NULL DEFAULT 0,
    "failedGenerations" INTEGER NOT NULL DEFAULT 0,
    "releasedGenerations" INTEGER NOT NULL DEFAULT 0,
    "reservedTokens" INTEGER NOT NULL DEFAULT 0,
    "usedTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AIUsagePeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIReservation" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "periodStart" TIMESTAMPTZ(3) NOT NULL,
    "units" INTEGER NOT NULL,
    "tokens" INTEGER NOT NULL,
    "status" "AIReservationStatus" NOT NULL DEFAULT 'RESERVED',
    "consumedUnits" INTEGER NOT NULL DEFAULT 0,
    "consumedTokens" INTEGER NOT NULL DEFAULT 0,
    "outcome" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMPTZ(3),

    CONSTRAINT "AIReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AIUsagePeriod_businessId_periodStart_key" ON "AIUsagePeriod"("businessId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "AIReservation_generationId_key" ON "AIReservation"("generationId");

-- CreateIndex
CREATE INDEX "AIReservation_status_createdAt_idx" ON "AIReservation"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AIReservation_businessId_periodStart_idx" ON "AIReservation"("businessId", "periodStart");

-- CreateIndex
CREATE INDEX "AIGeneration_rootId_idx" ON "AIGeneration"("rootId");

-- CreateIndex
CREATE INDEX "AIGeneration_status_queuedAt_idx" ON "AIGeneration"("status", "queuedAt");

-- AddForeignKey
ALTER TABLE "AIUsagePeriod" ADD CONSTRAINT "AIUsagePeriod_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIReservation" ADD CONSTRAINT "AIReservation_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "AIGeneration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: rows created before background jobs were completed synchronously.
UPDATE "AIGeneration" SET "rootId" = "id", "completedAt" = "createdAt", "startedAt" = "createdAt", "queuedAt" = "createdAt" WHERE "rootId" IS NULL;

-- Backfill the monthly counters from existing history so limits and reports stay consistent.
-- completed/failed = generations that consumed tokens; tokens = measured provider usage.
INSERT INTO "AIUsagePeriod" ("id", "businessId", "periodStart", "completedGenerations", "failedGenerations", "usedTokens", "updatedAt")
SELECT
  'bf' || md5(g."businessId" || g."period"::text),
  g."businessId",
  g."period",
  COALESCE(SUM(CASE WHEN g."status" = 'SUCCEEDED' THEN 1 ELSE 0 END), 0),
  COALESCE(SUM(CASE WHEN g."status" = 'FAILED' THEN 1 ELSE 0 END), 0),
  COALESCE(SUM(g."inputTokens" + g."outputTokens"), 0),
  CURRENT_TIMESTAMP
FROM (
  SELECT "businessId", "status", "inputTokens", "outputTokens",
         date_trunc('month', "createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS "period"
  FROM "AIGeneration"
  WHERE "status" IN ('SUCCEEDED', 'FAILED')
) g
GROUP BY g."businessId", g."period";
