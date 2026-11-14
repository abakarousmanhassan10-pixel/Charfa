-- AlterTable
ALTER TABLE "Recommendation" ADD COLUMN     "confidence" TEXT,
ADD COLUMN     "expectedBenefit" JSONB,
ADD COLUMN     "problem" TEXT,
ADD COLUMN     "proposedAction" JSONB,
ADD COLUMN     "requiredApproval" TEXT,
ADD COLUMN     "risk" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'INTELLIGENCE';

-- CreateTable
CREATE TABLE "ProductEconomics" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "unitCost" DECIMAL(12,2),
    "shippingCost" DECIMAL(12,2),
    "paymentFeePercent" DECIMAL(5,2),
    "paymentFixedFee" DECIMAL(12,2),
    "returnsAllowancePercent" DECIMAL(5,2),
    "updatedById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ProductEconomics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingExpense" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "campaignId" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "spentOn" TIMESTAMPTZ(3) NOT NULL,
    "orders" INTEGER,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketingExpense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutiveRun" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "summary" JSONB NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutiveRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutiveSettings" (
    "businessId" TEXT NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "dailyRunLimit" INTEGER NOT NULL DEFAULT 10,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ExecutiveSettings_pkey" PRIMARY KEY ("businessId")
);

-- CreateIndex
CREATE INDEX "ProductEconomics_businessId_idx" ON "ProductEconomics"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductEconomics_businessId_productId_key" ON "ProductEconomics"("businessId", "productId");

-- CreateIndex
CREATE INDEX "MarketingExpense_businessId_spentOn_idx" ON "MarketingExpense"("businessId", "spentOn");

-- CreateIndex
CREATE INDEX "ExecutiveRun_businessId_createdAt_idx" ON "ExecutiveRun"("businessId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutiveRun_businessId_idempotencyKey_key" ON "ExecutiveRun"("businessId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "ProductEconomics" ADD CONSTRAINT "ProductEconomics_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductEconomics" ADD CONSTRAINT "ProductEconomics_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingExpense" ADD CONSTRAINT "MarketingExpense_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutiveRun" ADD CONSTRAINT "ExecutiveRun_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutiveSettings" ADD CONSTRAINT "ExecutiveSettings_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

