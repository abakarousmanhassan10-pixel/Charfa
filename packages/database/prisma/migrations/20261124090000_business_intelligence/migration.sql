-- CreateEnum
CREATE TYPE "MemoryKind" AS ENUM ('BRAND', 'PRODUCT_FACT', 'CAMPAIGN_HISTORY', 'AUDIENCE', 'METRIC', 'PREFERENCE', 'DECISION', 'EVALUATION');

-- CreateEnum
CREATE TYPE "ExperimentStatus" AS ENUM ('DRAFT', 'RUNNING', 'CONCLUDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RecommendationStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateTable
CREATE TABLE "MerchantMemory" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "kind" "MemoryKind" NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "provenance" TEXT NOT NULL,
    "sourceRef" TEXT,
    "retentionDays" INTEGER NOT NULL DEFAULT 365,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "MerchantMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Experiment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "campaignId" TEXT,
    "hypothesis" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "status" "ExperimentStatus" NOT NULL DEFAULT 'DRAFT',
    "variants" JSONB NOT NULL,
    "minSamplePerArm" INTEGER NOT NULL DEFAULT 100,
    "result" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "concludedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Experiment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Recommendation" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "campaignId" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "costEstimate" JSONB NOT NULL,
    "priority" INTEGER NOT NULL,
    "status" "RecommendationStatus" NOT NULL DEFAULT 'PROPOSED',
    "dedupeKey" TEXT,
    "change" JSONB,
    "offlineEval" JSONB,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Recommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvaluationRun" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "suite" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "score" INTEGER NOT NULL,
    "results" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvaluationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessAlert" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "title" TEXT NOT NULL,
    "detail" JSONB,
    "dedupeKey" TEXT,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(3),

    CONSTRAINT "BusinessAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MerchantMemory_businessId_kind_idx" ON "MerchantMemory"("businessId", "kind");

-- CreateIndex
CREATE INDEX "MerchantMemory_expiresAt_idx" ON "MerchantMemory"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantMemory_businessId_kind_key_key" ON "MerchantMemory"("businessId", "kind", "key");

-- CreateIndex
CREATE INDEX "Experiment_businessId_status_createdAt_idx" ON "Experiment"("businessId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Recommendation_businessId_status_priority_idx" ON "Recommendation"("businessId", "status", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "Recommendation_businessId_dedupeKey_key" ON "Recommendation"("businessId", "dedupeKey");

-- CreateIndex
CREATE INDEX "EvaluationRun_businessId_suite_createdAt_idx" ON "EvaluationRun"("businessId", "suite", "createdAt");

-- CreateIndex
CREATE INDEX "BusinessAlert_businessId_resolvedAt_severity_idx" ON "BusinessAlert"("businessId", "resolvedAt", "severity");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessAlert_businessId_dedupeKey_key" ON "BusinessAlert"("businessId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "MerchantMemory" ADD CONSTRAINT "MerchantMemory_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Experiment" ADD CONSTRAINT "Experiment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessAlert" ADD CONSTRAINT "BusinessAlert_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

