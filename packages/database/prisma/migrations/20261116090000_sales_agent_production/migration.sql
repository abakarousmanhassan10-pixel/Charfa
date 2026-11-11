-- AlterTable
ALTER TABLE "SalesAgentConfig" ADD COLUMN     "autoMinConfidence" TEXT NOT NULL DEFAULT 'HIGH',
ADD COLUMN     "privacyNoticeUrl" TEXT,
ADD COLUMN     "retentionDays" INTEGER NOT NULL DEFAULT 365;

