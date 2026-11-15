-- CreateEnum
CREATE TYPE "PreferenceOrigin" AS ENUM ('DECLARED', 'INFERRED', 'HYPOTHESIS');

-- CreateTable
CREATE TABLE "LearningProfile" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "consentVersion" TEXT,
    "consentGrantedAt" TIMESTAMPTZ(3),
    "consentGrantedById" TEXT,
    "consentRevokedAt" TIMESTAMPTZ(3),
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "autoPlan" BOOLEAN NOT NULL DEFAULT false,
    "maxRunsPerDay" INTEGER NOT NULL DEFAULT 2,
    "lastRunAt" TIMESTAMPTZ(3),
    "updatedById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LearningProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientPreference" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "origin" "PreferenceOrigin" NOT NULL,
    "value" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "evidence" JSONB,
    "confidence" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ClientPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PreferenceRevision" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "origin" "PreferenceOrigin" NOT NULL,
    "version" INTEGER NOT NULL,
    "value" JSONB,
    "action" TEXT NOT NULL,
    "actorId" TEXT,
    "reason" TEXT,
    "runId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PreferenceRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecommendationFeedback" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "recommendationId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT,
    "actorId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecommendationFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LearningRun" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "steps" JSONB NOT NULL,
    "counts" JSONB,
    "blockedReason" TEXT,
    "costEstimate" JSONB,
    "configBefore" JSONB,
    "configAfter" JSONB,
    "baseline" JSONB,
    "outcome" JSONB,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "LearningRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LearningProfile_businessId_key" ON "LearningProfile"("businessId");

-- CreateIndex
CREATE INDEX "ClientPreference_businessId_origin_idx" ON "ClientPreference"("businessId", "origin");

-- CreateIndex
CREATE UNIQUE INDEX "ClientPreference_businessId_key_origin_key" ON "ClientPreference"("businessId", "key", "origin");

-- CreateIndex
CREATE INDEX "PreferenceRevision_businessId_key_createdAt_idx" ON "PreferenceRevision"("businessId", "key", "createdAt");

-- CreateIndex
CREATE INDEX "PreferenceRevision_runId_idx" ON "PreferenceRevision"("runId");

-- CreateIndex
CREATE INDEX "RecommendationFeedback_businessId_recommendationId_idx" ON "RecommendationFeedback"("businessId", "recommendationId");

-- CreateIndex
CREATE INDEX "RecommendationFeedback_businessId_createdAt_idx" ON "RecommendationFeedback"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "LearningRun_businessId_startedAt_idx" ON "LearningRun"("businessId", "startedAt");

-- AddForeignKey
ALTER TABLE "LearningProfile" ADD CONSTRAINT "LearningProfile_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientPreference" ADD CONSTRAINT "ClientPreference_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningRun" ADD CONSTRAINT "LearningRun_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

