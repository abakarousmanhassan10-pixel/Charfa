-- N28 (2/2): additive only. AgentRun.priority (queue priority). Agents, conversations, single-use approvals, versioned prices, usage events, budgets, period quotas, reservations, stop switches.
-- CreateEnum
CREATE TYPE "AgentType" AS ENUM ('RESEARCH', 'CONTENT', 'SUPPORT', 'ANALYTICS', 'SUPERVISOR');

-- CreateEnum
CREATE TYPE "UsageOperationStatus" AS ENUM ('SUCCEEDED', 'FAILED', 'REFUSED');

-- CreateEnum
CREATE TYPE "QuotaReservationStatus" AS ENUM ('RESERVED', 'SETTLED', 'RELEASED');

-- CreateEnum
CREATE TYPE "AgentApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CONSUMED', 'SUPERSEDED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ControlScope" AS ENUM ('GLOBAL', 'TENANT', 'AGENT');

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "type" "AgentType" NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentConversation" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "runId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AgentConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentMessage" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "tokens" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentApproval" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stepKey" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "status" "AgentApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMPTZ(3),
    "consumedAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelPrice" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "inputPerMillionMicros" INTEGER NOT NULL,
    "cachedInputPerMillionMicros" INTEGER,
    "outputPerMillionMicros" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMPTZ(3) NOT NULL,
    "source" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageEvent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "agentId" TEXT,
    "runId" TEXT NOT NULL,
    "stepKey" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "modelId" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedTokens" INTEGER,
    "estimatedCostMicros" BIGINT NOT NULL DEFAULT 0,
    "actualCostMicros" BIGINT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "priceVersion" INTEGER,
    "priced" BOOLEAN NOT NULL DEFAULT true,
    "status" "UsageOperationStatus" NOT NULL,
    "errorCode" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetPolicy" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "dailyCapMicros" BIGINT,
    "monthlyCapMicros" BIGINT,
    "perRunCapMicros" BIGINT,
    "alertPercent" INTEGER NOT NULL DEFAULT 80,
    "enforce" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BudgetPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantEntitlement" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "periodStart" TIMESTAMPTZ(3) NOT NULL,
    "periodEnd" TIMESTAMPTZ(3) NOT NULL,
    "source" TEXT NOT NULL,
    "planCode" TEXT,
    "callsLimit" INTEGER,
    "callsReserved" INTEGER NOT NULL DEFAULT 0,
    "callsUsed" INTEGER NOT NULL DEFAULT 0,
    "budgetLimitMicros" BIGINT,
    "budgetReservedMicros" BIGINT NOT NULL DEFAULT 0,
    "budgetUsedMicros" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantEntitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageReservation" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "agentId" TEXT,
    "entitlementId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stepKey" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "calls" INTEGER NOT NULL DEFAULT 1,
    "costMicros" BIGINT NOT NULL,
    "dayKey" TEXT NOT NULL,
    "status" "QuotaReservationStatus" NOT NULL DEFAULT 'RESERVED',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMPTZ(3),

    CONSTRAINT "UsageReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentControl" (
    "id" TEXT NOT NULL,
    "scope" "ControlScope" NOT NULL,
    "scopeId" TEXT NOT NULL,
    "stopped" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "changedById" TEXT,
    "changedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentControl_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Agent_businessId_type_enabled_idx" ON "Agent"("businessId", "type", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_businessId_name_key" ON "Agent"("businessId", "name");

-- CreateIndex
CREATE INDEX "AgentConversation_businessId_agentId_createdAt_idx" ON "AgentConversation"("businessId", "agentId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentConversation_expiresAt_idx" ON "AgentConversation"("expiresAt");

-- CreateIndex
CREATE INDEX "AgentMessage_conversationId_createdAt_idx" ON "AgentMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentMessage_businessId_createdAt_idx" ON "AgentMessage"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentApproval_businessId_status_createdAt_idx" ON "AgentApproval"("businessId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentApproval_runId_stepKey_contentHash_key" ON "AgentApproval"("runId", "stepKey", "contentHash");

-- CreateIndex
CREATE INDEX "AgentApproval_runId_stepKey_status_idx" ON "AgentApproval"("runId", "stepKey", "status");

-- CreateIndex
CREATE INDEX "ModelPrice_modelId_effectiveFrom_idx" ON "ModelPrice"("modelId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "ModelPrice_modelId_version_key" ON "ModelPrice"("modelId", "version");

-- CreateIndex
CREATE INDEX "UsageEvent_businessId_createdAt_idx" ON "UsageEvent"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "UsageEvent_agentId_createdAt_idx" ON "UsageEvent"("agentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "UsageEvent_runId_stepKey_attempt_key" ON "UsageEvent"("runId", "stepKey", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetPolicy_businessId_key" ON "BudgetPolicy"("businessId");

-- CreateIndex
CREATE INDEX "TenantEntitlement_businessId_periodEnd_idx" ON "TenantEntitlement"("businessId", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "TenantEntitlement_businessId_periodStart_key" ON "TenantEntitlement"("businessId", "periodStart");

-- CreateIndex
CREATE INDEX "UsageReservation_businessId_status_dayKey_idx" ON "UsageReservation"("businessId", "status", "dayKey");

-- CreateIndex
CREATE INDEX "UsageReservation_status_createdAt_idx" ON "UsageReservation"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "UsageReservation_runId_stepKey_attempt_key" ON "UsageReservation"("runId", "stepKey", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentControl_scope_scopeId_key" ON "AgentControl"("scope", "scopeId");

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentConversation" ADD CONSTRAINT "AgentConversation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentMessage" ADD CONSTRAINT "AgentMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AgentConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentApproval" ADD CONSTRAINT "AgentApproval_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetPolicy" ADD CONSTRAINT "BudgetPolicy_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantEntitlement" ADD CONSTRAINT "TenantEntitlement_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Plan entitlements for agents (merged only where absent, never overwriting an edited plan): instances, calls and budget per billing period, and the 'agents' feature on Pro and Business.
UPDATE "Plan" SET "limits" = "limits" || '{"maxAgentInstances":2,"agentCallsPerMonth":100,"agentBudgetMicrosPerMonth":5000000}'::jsonb WHERE "code" = 'STARTER' AND NOT ("limits" ? 'maxAgentInstances');
UPDATE "Plan" SET "limits" = "limits" || '{"maxAgentInstances":5,"agentCallsPerMonth":1000,"agentBudgetMicrosPerMonth":25000000}'::jsonb WHERE "code" = 'PRO' AND NOT ("limits" ? 'maxAgentInstances');
UPDATE "Plan" SET "limits" = "limits" || '{"maxAgentInstances":20,"agentCallsPerMonth":10000,"agentBudgetMicrosPerMonth":100000000}'::jsonb WHERE "code" = 'BUSINESS' AND NOT ("limits" ? 'maxAgentInstances');
UPDATE "Plan" SET "limits" = jsonb_set("limits", '{features}', ("limits"->'features') || '["agents"]'::jsonb) WHERE "code" IN ('PRO', 'BUSINESS') AND "limits" ? 'features' AND NOT ("limits"->'features' ? 'agents');

ALTER TABLE "AgentRun" ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 5;
