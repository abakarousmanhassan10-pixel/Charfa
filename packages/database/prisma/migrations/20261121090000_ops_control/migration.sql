-- CreateEnum
CREATE TYPE "OpsAlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateTable
CREATE TABLE "OpsQueueSample" (
    "id" TEXT NOT NULL,
    "queue" TEXT NOT NULL,
    "capturedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "waiting" INTEGER NOT NULL,
    "active" INTEGER NOT NULL,
    "delayed" INTEGER NOT NULL,
    "failed" INTEGER NOT NULL,
    "completed" INTEGER NOT NULL,

    CONSTRAINT "OpsQueueSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsAlertRule" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'QUEUE_FAILED',
    "queue" TEXT,
    "threshold" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OpsAlertRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsAlert" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "queue" TEXT NOT NULL,
    "status" "OpsAlertStatus" NOT NULL DEFAULT 'OPEN',
    "dedupeKey" TEXT,
    "observed" INTEGER NOT NULL,
    "threshold" INTEGER NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMPTZ(3),
    "acknowledgedBy" TEXT,
    "resolvedAt" TIMESTAMPTZ(3),
    "resolvedBy" TEXT,
    "resolution" TEXT,

    CONSTRAINT "OpsAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OpsQueueSample_queue_capturedAt_idx" ON "OpsQueueSample"("queue", "capturedAt");

-- CreateIndex
CREATE INDEX "OpsQueueSample_capturedAt_idx" ON "OpsQueueSample"("capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OpsAlertRule_kind_queue_key" ON "OpsAlertRule"("kind", "queue");

-- CreateIndex
CREATE UNIQUE INDEX "OpsAlert_dedupeKey_key" ON "OpsAlert"("dedupeKey");

-- CreateIndex
CREATE INDEX "OpsAlert_status_lastSeenAt_idx" ON "OpsAlert"("status", "lastSeenAt");

-- AddForeignKey
ALTER TABLE "OpsAlert" ADD CONSTRAINT "OpsAlert_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "OpsAlertRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

