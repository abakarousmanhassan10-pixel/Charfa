/*
  Warnings:

  - You are about to drop the column `productId` on the `MediaAsset` table. All the data in the column will be lost.
  - You are about to drop the column `category` on the `Product` table. All the data in the column will be lost.
  - You are about to drop the column `category` on the `Service` table. All the data in the column will be lost.
  - Added the required column `originalFilename` to the `MediaAsset` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "ProductAvailability" AS ENUM ('IN_STOCK', 'OUT_OF_STOCK', 'PREORDER', 'MADE_TO_ORDER', 'DISCONTINUED');

-- CreateEnum
CREATE TYPE "ServiceAvailability" AS ENUM ('AVAILABLE', 'BY_APPOINTMENT', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "CategoryKind" AS ENUM ('PRODUCT', 'SERVICE');

-- CreateEnum
CREATE TYPE "KnowledgeCategory" AS ENUM ('COMPANY', 'PRODUCT', 'SERVICE', 'PRICING', 'DELIVERY_POLICY', 'RETURN_POLICY', 'FAQ', 'CUSTOMER_SUPPORT', 'OTHER');

-- DropForeignKey
ALTER TABLE "MediaAsset" DROP CONSTRAINT "MediaAsset_productId_fkey";

-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "address" TEXT,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "contactEmail" TEXT,
ADD COLUMN     "contactPhone" TEXT;

-- AlterTable
ALTER TABLE "KnowledgeEntry" ADD COLUMN     "category" "KnowledgeCategory" NOT NULL DEFAULT 'OTHER',
ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "verifiedAt" TIMESTAMPTZ(3),
ADD COLUMN     "verifiedById" TEXT;

-- AlterTable
ALTER TABLE "MediaAsset" DROP COLUMN "productId",
ADD COLUMN     "folder" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "originalFilename" TEXT NOT NULL,
ADD COLUMN     "rejectionReason" TEXT,
ADD COLUMN     "tags" TEXT[];

-- AlterTable
ALTER TABLE "Product" DROP COLUMN "category",
ADD COLUMN     "availability" "ProductAvailability" NOT NULL DEFAULT 'IN_STOCK',
ADD COLUMN     "categoryId" TEXT,
ADD COLUMN     "discountPrice" DECIMAL(12,2),
ADD COLUMN     "targetAudience" TEXT;

-- AlterTable
ALTER TABLE "Service" DROP COLUMN "category",
ADD COLUMN     "availability" "ServiceAvailability" NOT NULL DEFAULT 'AVAILABLE',
ADD COLUMN     "availabilityNotes" TEXT,
ADD COLUMN     "bookingInfo" TEXT,
ADD COLUMN     "bookingUrl" TEXT,
ADD COLUMN     "categoryId" TEXT,
ADD COLUMN     "targetAudience" TEXT;

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "kind" "CategoryKind" NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductMedia" (
    "productId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProductMedia_pkey" PRIMARY KEY ("productId","mediaId")
);

-- CreateIndex
CREATE INDEX "Category_businessId_kind_sortOrder_idx" ON "Category"("businessId", "kind", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "Category_businessId_kind_slug_key" ON "Category"("businessId", "kind", "slug");

-- CreateIndex
CREATE INDEX "ProductMedia_mediaId_idx" ON "ProductMedia"("mediaId");

-- CreateIndex
CREATE INDEX "KnowledgeEntry_businessId_category_idx" ON "KnowledgeEntry"("businessId", "category");

-- CreateIndex
CREATE INDEX "MediaAsset_businessId_folder_idx" ON "MediaAsset"("businessId", "folder");

-- CreateIndex
CREATE INDEX "MediaAsset_status_createdAt_idx" ON "MediaAsset"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Product_businessId_categoryId_idx" ON "Product"("businessId", "categoryId");

-- CreateIndex
CREATE INDEX "Service_businessId_categoryId_idx" ON "Service"("businessId", "categoryId");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMedia" ADD CONSTRAINT "ProductMedia_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMedia" ADD CONSTRAINT "ProductMedia_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "MediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeEntry" ADD CONSTRAINT "KnowledgeEntry_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
