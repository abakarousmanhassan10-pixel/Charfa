-- CreateEnum
CREATE TYPE "AgentDefinitionStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateTable
CREATE TABLE "AgentDefinition" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" "AgentDefinitionStatus" NOT NULL DEFAULT 'DRAFT',
    "config" JSONB NOT NULL,
    "configHash" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "duplicatedFromId" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AgentDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentTestRun" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "configHash" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "input" TEXT NOT NULL,
    "output" JSONB,
    "trace" JSONB NOT NULL,
    "simulated" BOOLEAN NOT NULL DEFAULT true,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentTestRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentDefinition_businessId_status_idx" ON "AgentDefinition"("businessId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AgentDefinition_businessId_name_key" ON "AgentDefinition"("businessId", "name");

-- CreateIndex
CREATE INDEX "AgentTestRun_businessId_createdAt_idx" ON "AgentTestRun"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentTestRun_definitionId_createdAt_idx" ON "AgentTestRun"("definitionId", "createdAt");

-- AddForeignKey
ALTER TABLE "AgentDefinition" ADD CONSTRAINT "AgentDefinition_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTestRun" ADD CONSTRAINT "AgentTestRun_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "AgentDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

