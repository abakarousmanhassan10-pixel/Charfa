-- CreateEnum
CREATE TYPE "ContentPillar" AS ENUM ('PROMOTIONAL', 'EDUCATIONAL', 'PRODUCT_SHOWCASE', 'ENGAGEMENT', 'BRAND_AWARENESS', 'SEASONAL');

-- CreateEnum
CREATE TYPE "TimeSource" AS ENUM ('MANUAL', 'ANALYTICS', 'ESTIMATE');

-- CreateEnum
CREATE TYPE "DispatchState" AS ENUM ('NONE', 'QUEUED', 'DISPATCHING', 'DISPATCHED', 'BLOCKED', 'FAILED');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('SUBMITTED', 'APPROVED', 'REJECTED', 'AUTHORIZED', 'REVOKED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RecurrenceFrequency" AS ENUM ('DAILY', 'WEEKLY');

-- AlterEnum
ALTER TYPE "AITask" ADD VALUE 'CONTENT_PLAN';

-- AlterTable
ALTER TABLE "CalendarEvent" ADD COLUMN     "authorizedAt" TIMESTAMPTZ(3),
ADD COLUMN     "authorizedById" TEXT,
ADD COLUMN     "authorizedVersion" INTEGER,
ADD COLUMN     "brief" TEXT,
ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "dispatchAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "dispatchKey" TEXT,
ADD COLUMN     "dispatchState" "DispatchState" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "dispatchedAt" TIMESTAMPTZ(3),
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "lockedUntil" TIMESTAMPTZ(3),
ADD COLUMN     "occasion" TEXT,
ADD COLUMN     "occurrenceDate" TEXT,
ADD COLUMN     "pillar" "ContentPillar",
ADD COLUMN     "placementKey" TEXT,
ADD COLUMN     "planId" TEXT,
ADD COLUMN     "platform" "SocialPlatform",
ADD COLUMN     "recurrenceId" TEXT,
ADD COLUMN     "reminderSentAt" TIMESTAMPTZ(3),
ADD COLUMN     "timeNote" TEXT,
ADD COLUMN     "timeSource" "TimeSource" NOT NULL DEFAULT 'MANUAL';

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "dedupeKey" TEXT;

-- CreateTable
CREATE TABLE "ContentPlan" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "generationId" TEXT,
    "name" TEXT NOT NULL,
    "startDate" TEXT NOT NULL,
    "days" INTEGER NOT NULL,
    "timezone" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "summary" TEXT,
    "itemCount" INTEGER NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurrenceRule" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "title" TEXT NOT NULL,
    "brief" TEXT,
    "pillar" "ContentPillar",
    "frequency" "RecurrenceFrequency" NOT NULL,
    "weekdays" INTEGER[],
    "localTime" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RecurrenceRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalRecord" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "calendarEventId" TEXT,
    "version" INTEGER NOT NULL,
    "decision" "ApprovalDecision" NOT NULL,
    "actorId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ContentPlan_generationId_key" ON "ContentPlan"("generationId");

-- CreateIndex
CREATE INDEX "ContentPlan_businessId_createdAt_idx" ON "ContentPlan"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "RecurrenceRule_businessId_active_idx" ON "RecurrenceRule"("businessId", "active");

-- CreateIndex
CREATE INDEX "ApprovalRecord_businessId_createdAt_idx" ON "ApprovalRecord"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "ApprovalRecord_calendarEventId_createdAt_idx" ON "ApprovalRecord"("calendarEventId", "createdAt");

-- CreateIndex
CREATE INDEX "ApprovalRecord_contentId_idx" ON "ApprovalRecord"("contentId");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarEvent_placementKey_key" ON "CalendarEvent"("placementKey");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarEvent_dispatchKey_key" ON "CalendarEvent"("dispatchKey");

-- CreateIndex
CREATE INDEX "CalendarEvent_dispatchState_scheduledAt_idx" ON "CalendarEvent"("dispatchState", "scheduledAt");

-- CreateIndex
CREATE INDEX "CalendarEvent_planId_idx" ON "CalendarEvent"("planId");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarEvent_recurrenceId_occurrenceDate_key" ON "CalendarEvent"("recurrenceId", "occurrenceDate");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_userId_dedupeKey_key" ON "Notification"("userId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "CalendarEvent" ADD CONSTRAINT "CalendarEvent_planId_fkey" FOREIGN KEY ("planId") REFERENCES "ContentPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarEvent" ADD CONSTRAINT "CalendarEvent_recurrenceId_fkey" FOREIGN KEY ("recurrenceId") REFERENCES "RecurrenceRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentPlan" ADD CONSTRAINT "ContentPlan_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurrenceRule" ADD CONSTRAINT "RecurrenceRule_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRecord" ADD CONSTRAINT "ApprovalRecord_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRecord" ADD CONSTRAINT "ApprovalRecord_calendarEventId_fkey" FOREIGN KEY ("calendarEventId") REFERENCES "CalendarEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

