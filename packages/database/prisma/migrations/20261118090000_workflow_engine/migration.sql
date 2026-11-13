-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AgentRunStatus" ADD VALUE 'PAUSED';
ALTER TYPE "AgentRunStatus" ADD VALUE 'CANCELLED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AgentRunStepStatus" ADD VALUE 'SKIPPED';
ALTER TYPE "AgentRunStepStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN     "deadLetteredAt" TIMESTAMPTZ(3),
ADD COLUMN     "triggerData" JSONB,
ADD COLUMN     "triggerType" TEXT,
ADD COLUMN     "workflowId" TEXT,
ADD COLUMN     "workflowVersion" INTEGER;

-- AlterTable
ALTER TABLE "AgentRunStep" ADD COLUMN     "backoffMs" INTEGER,
ADD COLUMN     "condition" JSONB;

-- CreateTable
CREATE TABLE "WorkflowDefinition" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "currentVersion" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "activatedById" TEXT,
    "nextRunAt" TIMESTAMPTZ(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WorkflowDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowVersion" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkflowDefinition_isActive_nextRunAt_idx" ON "WorkflowDefinition"("isActive", "nextRunAt");

-- CreateIndex
CREATE INDEX "WorkflowDefinition_businessId_isActive_idx" ON "WorkflowDefinition"("businessId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowDefinition_businessId_name_key" ON "WorkflowDefinition"("businessId", "name");

-- CreateIndex
CREATE INDEX "WorkflowVersion_businessId_idx" ON "WorkflowVersion"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowVersion_workflowId_version_key" ON "WorkflowVersion"("workflowId", "version");

-- CreateIndex
CREATE INDEX "AgentRun_businessId_workflowId_createdAt_idx" ON "AgentRun"("businessId", "workflowId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentRun_businessId_deadLetteredAt_idx" ON "AgentRun"("businessId", "deadLetteredAt");

-- AddForeignKey
ALTER TABLE "WorkflowDefinition" ADD CONSTRAINT "WorkflowDefinition_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowVersion" ADD CONSTRAINT "WorkflowVersion_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "WorkflowDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
