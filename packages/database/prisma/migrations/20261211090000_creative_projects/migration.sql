-- AlterTable
ALTER TABLE "CreativeGeneration" ADD COLUMN     "projectId" TEXT;

-- CreateTable
CREATE TABLE "CreativeProject" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brief" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "script" JSONB,
    "caption" TEXT,
    "activeGenerationId" TEXT,
    "scheduleSim" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "CreativeProject_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreativeProject_businessId_deletedAt_updatedAt_idx" ON "CreativeProject"("businessId", "deletedAt", "updatedAt");

-- CreateIndex
CREATE INDEX "CreativeGeneration_businessId_projectId_idx" ON "CreativeGeneration"("businessId", "projectId");

-- AddForeignKey
ALTER TABLE "CreativeProject" ADD CONSTRAINT "CreativeProject_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

