-- AlterTable
ALTER TABLE "AnalyticsSnapshot" ADD COLUMN     "avgWatchSeconds" DECIMAL(10,2),
ADD COLUMN     "provider" TEXT,
ADD COLUMN     "simulated" BOOLEAN NOT NULL DEFAULT false;

