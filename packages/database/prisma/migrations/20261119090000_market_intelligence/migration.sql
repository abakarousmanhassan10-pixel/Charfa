-- CreateTable
CREATE TABLE "MarketProduct" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "createdById" TEXT,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "category" TEXT,
    "country" TEXT NOT NULL,
    "supplierName" TEXT,
    "sourceType" TEXT NOT NULL DEFAULT 'MANUAL',
    "sourceName" TEXT,
    "sourceUrl" TEXT NOT NULL,
    "sourceUrlKey" TEXT NOT NULL,
    "observedAt" TIMESTAMPTZ(3) NOT NULL,
    "costCurrency" TEXT NOT NULL,
    "unitCost" DECIMAL(14,2),
    "shippingCost" DECIMAL(14,2),
    "sellingCurrency" TEXT NOT NULL,
    "sellingPrice" DECIMAL(14,2),
    "estimatedDeliveryDays" INTEGER,
    "supplierRating" DECIMAL(3,2),
    "supplierRatingSource" TEXT,
    "monthlySearches" INTEGER,
    "demandSource" TEXT,
    "competitorCount" INTEGER,
    "competitorSource" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "MarketProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketAnalysis" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "createdById" TEXT,
    "modelVersion" TEXT NOT NULL,
    "asOf" TIMESTAMPTZ(3) NOT NULL,
    "assumptions" JSONB NOT NULL,
    "profitability" JSONB NOT NULL,
    "score" JSONB NOT NULL,
    "quality" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarketProduct_businessId_country_createdAt_idx" ON "MarketProduct"("businessId", "country", "createdAt");

-- CreateIndex
CREATE INDEX "MarketProduct_businessId_sourceUrlKey_idx" ON "MarketProduct"("businessId", "sourceUrlKey");

-- CreateIndex
CREATE UNIQUE INDEX "MarketProduct_businessId_dedupeKey_key" ON "MarketProduct"("businessId", "dedupeKey");

-- CreateIndex
CREATE INDEX "MarketAnalysis_productId_createdAt_idx" ON "MarketAnalysis"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "MarketAnalysis_businessId_createdAt_idx" ON "MarketAnalysis"("businessId", "createdAt");

-- AddForeignKey
ALTER TABLE "MarketProduct" ADD CONSTRAINT "MarketProduct_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketAnalysis" ADD CONSTRAINT "MarketAnalysis_productId_fkey" FOREIGN KEY ("productId") REFERENCES "MarketProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;
