-- CreateEnum
CREATE TYPE "CreativeKind" AS ENUM ('IMAGE', 'VIDEO');

-- CreateEnum
CREATE TYPE "CreativeStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- AlterEnum
ALTER TYPE "AITask" ADD VALUE 'STORYBOARD';

-- AlterTable
ALTER TABLE "AIUsagePeriod" ADD COLUMN     "completedImages" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "completedVideoSeconds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reservedImages" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reservedVideoSeconds" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "BrandKit" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "colors" JSONB NOT NULL DEFAULT '[]',
    "headingFont" TEXT,
    "bodyFont" TEXT,
    "visualStyle" TEXT,
    "guidelines" TEXT,
    "preferredTone" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BrandKit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreativeGeneration" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "userId" TEXT,
    "kind" "CreativeKind" NOT NULL,
    "status" "CreativeStatus" NOT NULL DEFAULT 'QUEUED',
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "idempotencyKey" TEXT,
    "requestHash" TEXT,
    "itemType" TEXT,
    "itemId" TEXT,
    "sourceMediaId" TEXT,
    "parentId" TEXT,
    "brandSnapshot" JSONB,
    "providerRef" TEXT,
    "providerStatus" TEXT,
    "requestedUnits" INTEGER NOT NULL,
    "producedUnits" INTEGER NOT NULL DEFAULT 0,
    "reservedUnits" INTEGER NOT NULL,
    "unitKind" TEXT NOT NULL,
    "periodStart" TIMESTAMPTZ(3) NOT NULL,
    "settledAt" TIMESTAMPTZ(3),
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "processingMs" INTEGER NOT NULL DEFAULT 0,
    "jobAttempts" INTEGER NOT NULL DEFAULT 0,
    "pollCount" INTEGER NOT NULL DEFAULT 0,
    "queuedAt" TIMESTAMPTZ(3),
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreativeGeneration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreativeOutput" (
    "id" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "preservation" TEXT,
    "upscaled" BOOLEAN NOT NULL DEFAULT false,
    "revisedPrompt" TEXT,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreativeOutput_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BrandKit_businessId_key" ON "BrandKit"("businessId");

-- CreateIndex
CREATE INDEX "CreativeGeneration_businessId_kind_createdAt_idx" ON "CreativeGeneration"("businessId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "CreativeGeneration_status_queuedAt_idx" ON "CreativeGeneration"("status", "queuedAt");

-- CreateIndex
CREATE INDEX "CreativeGeneration_settledAt_status_idx" ON "CreativeGeneration"("settledAt", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CreativeGeneration_businessId_idempotencyKey_key" ON "CreativeGeneration"("businessId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "CreativeOutput_businessId_mediaId_idx" ON "CreativeOutput"("businessId", "mediaId");

-- CreateIndex
CREATE UNIQUE INDEX "CreativeOutput_generationId_index_key" ON "CreativeOutput"("generationId", "index");

-- AddForeignKey
ALTER TABLE "BrandKit" ADD CONSTRAINT "BrandKit_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeGeneration" ADD CONSTRAINT "CreativeGeneration_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeOutput" ADD CONSTRAINT "CreativeOutput_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "CreativeGeneration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeOutput" ADD CONSTRAINT "CreativeOutput_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "MediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
