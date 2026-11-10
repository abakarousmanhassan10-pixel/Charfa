-- CreateEnum
CREATE TYPE "AITask" AS ENUM ('BUSINESS_ANALYSIS', 'PRODUCT_ANALYSIS', 'MARKETING_STRATEGY', 'CONTENT');

-- CreateEnum
CREATE TYPE "AIGenerationStatus" AS ENUM ('SUCCEEDED', 'FAILED', 'BLOCKED');

-- AlterTable
ALTER TABLE "AIUsage" ADD COLUMN     "attemptKind" TEXT,
ADD COLUMN     "generationId" TEXT;

-- CreateTable
CREATE TABLE "AIGeneration" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "userId" TEXT,
    "task" "AITask" NOT NULL,
    "status" "AIGenerationStatus" NOT NULL,
    "itemType" TEXT,
    "itemId" TEXT,
    "platform" TEXT,
    "format" TEXT,
    "language" TEXT NOT NULL,
    "tone" TEXT,
    "purpose" TEXT,
    "params" JSONB NOT NULL,
    "instructions" TEXT,
    "output" JSONB,
    "editedOutput" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "contextHash" TEXT NOT NULL,
    "injectionFlags" TEXT[],
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "parentId" TEXT,
    "contentId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIGeneration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AIGeneration_contentId_key" ON "AIGeneration"("contentId");

-- CreateIndex
CREATE INDEX "AIGeneration_businessId_createdAt_idx" ON "AIGeneration"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "AIGeneration_businessId_task_status_createdAt_idx" ON "AIGeneration"("businessId", "task", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AIGeneration_businessId_task_itemId_contextHash_idx" ON "AIGeneration"("businessId", "task", "itemId", "contextHash");

-- CreateIndex
CREATE INDEX "AIUsage_generationId_idx" ON "AIUsage"("generationId");

-- AddForeignKey
ALTER TABLE "AIUsage" ADD CONSTRAINT "AIUsage_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "AIGeneration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIGeneration" ADD CONSTRAINT "AIGeneration_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIGeneration" ADD CONSTRAINT "AIGeneration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIGeneration" ADD CONSTRAINT "AIGeneration_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "AIGeneration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIGeneration" ADD CONSTRAINT "AIGeneration_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "Content"("id") ON DELETE SET NULL ON UPDATE CASCADE;
