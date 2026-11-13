-- AlterTable
ALTER TABLE "ApprovalRecord" ADD COLUMN     "mediaIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "platform" "SocialPlatform",
ADD COLUMN     "scheduledAt" TIMESTAMPTZ(3),
ADD COLUMN     "snapshotHash" TEXT,
ADD COLUMN     "socialAccountId" TEXT,
ADD COLUMN     "timezone" TEXT;

-- AlterTable
ALTER TABLE "CalendarEvent" ADD COLUMN     "authorizedAccountId" TEXT,
ADD COLUMN     "authorizedHash" TEXT;

-- AlterTable
ALTER TABLE "Publication" ADD COLUMN     "simulated" BOOLEAN NOT NULL DEFAULT false;

