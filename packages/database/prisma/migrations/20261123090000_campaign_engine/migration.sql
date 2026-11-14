-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'PLANNED', 'CONTENT_READY', 'AWAITING_APPROVAL', 'ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AgentExecutionStatus" AS ENUM ('SUCCEEDED', 'FAILED', 'TIMED_OUT', 'REFUSED');

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "goal" JSONB NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "executionLimit" INTEGER NOT NULL DEFAULT 20,
    "executionsUsed" INTEGER NOT NULL DEFAULT 0,
    "costLimitMicros" INTEGER NOT NULL DEFAULT 0,
    "costUsedMicros" INTEGER NOT NULL DEFAULT 0,
    "plan" JSONB,
    "planVersion" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignProduct" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignContent" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "calendarEventId" TEXT NOT NULL,
    "productId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'INITIAL',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignContent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentExecution" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "agent" TEXT NOT NULL,
    "status" "AgentExecutionStatus" NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "inputHash" TEXT NOT NULL,
    "output" JSONB,
    "errorCode" TEXT,
    "costMicros" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Campaign_businessId_status_createdAt_idx" ON "Campaign"("businessId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_businessId_idempotencyKey_key" ON "Campaign"("businessId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "CampaignProduct_businessId_productId_idx" ON "CampaignProduct"("businessId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignProduct_campaignId_productId_key" ON "CampaignProduct"("campaignId", "productId");

-- CreateIndex
CREATE INDEX "CampaignContent_businessId_campaignId_idx" ON "CampaignContent"("businessId", "campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignContent_campaignId_calendarEventId_key" ON "CampaignContent"("campaignId", "calendarEventId");

-- CreateIndex
CREATE INDEX "AgentExecution_businessId_createdAt_idx" ON "AgentExecution"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentExecution_campaignId_agent_idx" ON "AgentExecution"("campaignId", "agent");

-- CreateIndex
CREATE UNIQUE INDEX "AgentExecution_campaignId_idempotencyKey_key" ON "AgentExecution"("campaignId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignProduct" ADD CONSTRAINT "CampaignProduct_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignProduct" ADD CONSTRAINT "CampaignProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignContent" ADD CONSTRAINT "CampaignContent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignContent" ADD CONSTRAINT "CampaignContent_calendarEventId_fkey" FOREIGN KEY ("calendarEventId") REFERENCES "CalendarEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentExecution" ADD CONSTRAINT "AgentExecution_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

