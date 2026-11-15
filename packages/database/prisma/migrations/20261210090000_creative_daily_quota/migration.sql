-- AlterTable
ALTER TABLE "CreativeGeneration" ADD COLUMN     "dailyKey" TEXT,
ADD COLUMN     "dailyKind" TEXT,
ADD COLUMN     "dailyReserved" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "estimatedCostMicros" BIGINT;

-- CreateTable
CREATE TABLE "CreativeDailyUsage" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "dayKey" TEXT NOT NULL,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "completed" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CreativeDailyUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreativeQuotaClock" (
    "businessId" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "changedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pendingTimezone" TEXT,
    "pendingFrom" TIMESTAMPTZ(3),

    CONSTRAINT "CreativeQuotaClock_pkey" PRIMARY KEY ("businessId")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreativeDailyUsage_businessId_kind_dayKey_key" ON "CreativeDailyUsage"("businessId", "kind", "dayKey");

-- AddForeignKey
ALTER TABLE "CreativeDailyUsage" ADD CONSTRAINT "CreativeDailyUsage_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeQuotaClock" ADD CONSTRAINT "CreativeQuotaClock_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

