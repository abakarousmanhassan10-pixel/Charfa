-- CreateEnum
CREATE TYPE "MarketplaceStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'PUBLISHED', 'SUSPENDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "MarketplacePricing" AS ENUM ('FREE', 'PREMIUM');

-- CreateTable
CREATE TABLE "CreatorProfile" (
    "id" TEXT NOT NULL,
    "businessId" TEXT,
    "displayName" TEXT NOT NULL,
    "bio" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "demo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CreatorProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceListing" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "tags" TEXT[],
    "status" "MarketplaceStatus" NOT NULL DEFAULT 'DRAFT',
    "pricing" "MarketplacePricing" NOT NULL DEFAULT 'FREE',
    "pricingSimulated" BOOLEAN NOT NULL DEFAULT false,
    "demo" BOOLEAN NOT NULL DEFAULT false,
    "suspendedReason" TEXT,
    "publishedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "MarketplaceListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceVersion" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "manifestHash" TEXT NOT NULL,
    "changelog" TEXT NOT NULL,
    "status" "MarketplaceStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketplaceVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceReview" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "versionId" TEXT,
    "businessId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketplaceReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreatorProfile_businessId_key" ON "CreatorProfile"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceListing_slug_key" ON "MarketplaceListing"("slug");

-- CreateIndex
CREATE INDEX "MarketplaceListing_status_category_idx" ON "MarketplaceListing"("status", "category");

-- CreateIndex
CREATE INDEX "MarketplaceListing_creatorId_idx" ON "MarketplaceListing"("creatorId");

-- CreateIndex
CREATE INDEX "MarketplaceVersion_listingId_status_idx" ON "MarketplaceVersion"("listingId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceVersion_listingId_version_key" ON "MarketplaceVersion"("listingId", "version");

-- CreateIndex
CREATE INDEX "MarketplaceReview_listingId_status_idx" ON "MarketplaceReview"("listingId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceReview_listingId_businessId_key" ON "MarketplaceReview"("listingId", "businessId");

-- AddForeignKey
ALTER TABLE "MarketplaceListing" ADD CONSTRAINT "MarketplaceListing_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceVersion" ADD CONSTRAINT "MarketplaceVersion_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "MarketplaceListing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceReview" ADD CONSTRAINT "MarketplaceReview_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "MarketplaceListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceReview" ADD CONSTRAINT "MarketplaceReview_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A review is a rating from 1 to 5.
ALTER TABLE "MarketplaceReview" ADD CONSTRAINT "MarketplaceReview_rating_check" CHECK ("rating" BETWEEN 1 AND 5);

-- Published package versions are immutable: the manifest, its hash, the version number and the owner listing can never change.
CREATE OR REPLACE FUNCTION marketplace_version_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."manifest" IS DISTINCT FROM OLD."manifest" OR NEW."manifestHash" <> OLD."manifestHash" OR NEW."version" <> OLD."version" OR NEW."listingId" <> OLD."listingId" OR NEW."changelog" <> OLD."changelog" THEN
    RAISE EXCEPTION 'MarketplaceVersion content is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MarketplaceVersion_immutable" BEFORE UPDATE ON "MarketplaceVersion" FOR EACH ROW EXECUTE FUNCTION marketplace_version_immutable();
