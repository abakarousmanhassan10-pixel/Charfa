-- CreateEnum
CREATE TYPE "SalesHandoffStatus" AS ENUM ('REQUESTED', 'ACCEPTED', 'RESOLVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SalesFollowUpStatus" AS ENUM ('SUGGESTED', 'APPROVED', 'REJECTED', 'BLOCKED');

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "conversionVerifiedAt" TIMESTAMPTZ(3),
ADD COLUMN     "conversionVerifiedById" TEXT,
ADD COLUMN     "followUpConsentAt" TIMESTAMPTZ(3),
ADD COLUMN     "optedOutAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "LeadQualification" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "customerId" TEXT,
    "score" INTEGER NOT NULL,
    "level" TEXT NOT NULL,
    "signals" JSONB NOT NULL,
    "reasons" JSONB NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "evaluatedMessages" INTEGER NOT NULL,
    "computedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LeadQualification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesHandoff" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "customerId" TEXT,
    "status" "SalesHandoffStatus" NOT NULL DEFAULT 'REQUESTED',
    "reason" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "summary" JSONB,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedById" TEXT,
    "acceptedAt" TIMESTAMPTZ(3),
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMPTZ(3),
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SalesHandoff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesFollowUp" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "status" "SalesFollowUpStatus" NOT NULL DEFAULT 'SUGGESTED',
    "language" TEXT NOT NULL,
    "suggestedText" TEXT NOT NULL,
    "basis" JSONB NOT NULL,
    "blockedReason" TEXT,
    "source" TEXT NOT NULL,
    "createdById" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SalesFollowUp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LeadQualification_conversationId_key" ON "LeadQualification"("conversationId");

-- CreateIndex
CREATE INDEX "LeadQualification_businessId_level_idx" ON "LeadQualification"("businessId", "level");

-- CreateIndex
CREATE INDEX "SalesHandoff_businessId_status_requestedAt_idx" ON "SalesHandoff"("businessId", "status", "requestedAt");

-- CreateIndex
CREATE INDEX "SalesHandoff_conversationId_status_idx" ON "SalesHandoff"("conversationId", "status");

-- CreateIndex
CREATE INDEX "SalesFollowUp_businessId_status_createdAt_idx" ON "SalesFollowUp"("businessId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "SalesFollowUp_conversationId_idx" ON "SalesFollowUp"("conversationId");

-- AddForeignKey
ALTER TABLE "LeadQualification" ADD CONSTRAINT "LeadQualification_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesHandoff" ADD CONSTRAINT "SalesHandoff_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesFollowUp" ADD CONSTRAINT "SalesFollowUp_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
