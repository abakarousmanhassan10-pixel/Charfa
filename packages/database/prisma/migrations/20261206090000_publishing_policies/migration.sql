-- CreateEnum
CREATE TYPE "PublishingMode" AS ENUM ('MANUAL', 'HYBRID', 'AUTO');

-- CreateEnum
CREATE TYPE "PublishingRisk" AS ENUM ('LOW_RISK', 'REVIEW_REQUIRED', 'BLOCKED');

-- CreateTable
CREATE TABLE "PublishingPolicy" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "socialAccountId" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "mode" "PublishingMode" NOT NULL DEFAULT 'MANUAL',
    "consentVersion" TEXT,
    "consentGrantedAt" TIMESTAMPTZ(3),
    "consentGrantedById" TEXT,
    "consentRevokedAt" TIMESTAMPTZ(3),
    "authorizedScopes" TEXT[],
    "allowedContentTypes" TEXT[],
    "maximumPostsPerDay" INTEGER NOT NULL DEFAULT 2,
    "timezone" TEXT NOT NULL,
    "allowedPublishingHours" JSONB NOT NULL,
    "requiresPlatformConfirmation" BOOLEAN NOT NULL DEFAULT false,
    "automationEnabled" BOOLEAN NOT NULL DEFAULT false,
    "pausedAt" TIMESTAMPTZ(3),
    "pausedById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PublishingPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublishingDecision" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "calendarEventId" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "contentVersion" INTEGER NOT NULL,
    "socialAccountId" TEXT,
    "platform" "SocialPlatform",
    "policyId" TEXT,
    "mode" "PublishingMode" NOT NULL,
    "risk" "PublishingRisk" NOT NULL,
    "reasons" JSONB NOT NULL,
    "action" TEXT NOT NULL,
    "automated" BOOLEAN NOT NULL DEFAULT false,
    "snapshotHash" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMPTZ(3),
    "validUntil" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PublishingDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublishingEvent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "socialAccountId" TEXT,
    "calendarEventId" TEXT,
    "type" TEXT NOT NULL,
    "actorId" TEXT,
    "data" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PublishingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PublishingPolicy_socialAccountId_key" ON "PublishingPolicy"("socialAccountId");

-- CreateIndex
CREATE INDEX "PublishingPolicy_businessId_mode_idx" ON "PublishingPolicy"("businessId", "mode");

-- CreateIndex
CREATE INDEX "PublishingDecision_businessId_createdAt_idx" ON "PublishingDecision"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "PublishingDecision_businessId_action_idx" ON "PublishingDecision"("businessId", "action");

-- CreateIndex
CREATE UNIQUE INDEX "PublishingDecision_calendarEventId_contentVersion_key" ON "PublishingDecision"("calendarEventId", "contentVersion");

-- CreateIndex
CREATE INDEX "PublishingEvent_businessId_createdAt_idx" ON "PublishingEvent"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "PublishingEvent_socialAccountId_createdAt_idx" ON "PublishingEvent"("socialAccountId", "createdAt");

-- AddForeignKey
ALTER TABLE "PublishingPolicy" ADD CONSTRAINT "PublishingPolicy_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishingPolicy" ADD CONSTRAINT "PublishingPolicy_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishingDecision" ADD CONSTRAINT "PublishingDecision_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishingEvent" ADD CONSTRAINT "PublishingEvent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

