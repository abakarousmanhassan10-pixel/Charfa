-- AlterEnum
ALTER TYPE "SocialPlatform" ADD VALUE 'LINKEDIN';

-- AlterTable
ALTER TABLE "Publication" ADD COLUMN     "confirmedByProvider" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "errorCode" TEXT,
ADD COLUMN     "manualCompletedById" TEXT,
ADD COLUMN     "nextCheckAt" TIMESTAMPTZ(3),
ADD COLUMN     "outcomeUnknown" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "payload" JSONB,
ADD COLUMN     "providerRef" TEXT,
ADD COLUMN     "providerStage" TEXT,
ADD COLUMN     "submitStartedAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "SocialAccount" ADD COLUMN     "accountType" TEXT,
ADD COLUMN     "connectedAt" TIMESTAMPTZ(3),
ADD COLUMN     "expiryWarnedFor" TIMESTAMPTZ(3),
ADD COLUMN     "lastRefreshError" TEXT,
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "parentExternalId" TEXT,
ADD COLUMN     "refreshFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "tokenRefreshedAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "SocialConnectionSession" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "stateHash" TEXT NOT NULL,
    "codeVerifierEnc" TEXT,
    "reconnectAccountId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING_AUTH',
    "candidates" JSONB,
    "error" TEXT,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "SocialConnectionSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SocialConnectionSession_stateHash_key" ON "SocialConnectionSession"("stateHash");

-- CreateIndex
CREATE INDEX "SocialConnectionSession_businessId_status_idx" ON "SocialConnectionSession"("businessId", "status");

-- CreateIndex
CREATE INDEX "SocialConnectionSession_expiresAt_idx" ON "SocialConnectionSession"("expiresAt");

-- CreateIndex
CREATE INDEX "Publication_status_nextCheckAt_idx" ON "Publication"("status", "nextCheckAt");

-- AddForeignKey
ALTER TABLE "SocialConnectionSession" ADD CONSTRAINT "SocialConnectionSession_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

