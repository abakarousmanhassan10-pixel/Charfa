-- CreateEnum
CREATE TYPE "AgentMode" AS ENUM ('AI_ACTIVE', 'AI_PAUSED', 'HUMAN');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'ENGAGED', 'QUALIFIED', 'OPPORTUNITY', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "PurchaseIntent" AS ENUM ('NONE', 'LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "AgentReplyMode" AS ENUM ('REVIEW', 'AUTO');

-- CreateEnum
CREATE TYPE "FeedbackStatus" AS ENUM ('OPEN', 'RESOLVED');

-- AlterEnum

-- AlterEnum

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "aiMode" "AgentMode" NOT NULL DEFAULT 'AI_ACTIVE',
ADD COLUMN     "aiRepliesCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "customerId" TEXT,
ADD COLUMN     "handoffReason" TEXT,
ADD COLUMN     "handoffRequestedAt" TIMESTAMPTZ(3),
ADD COLUMN     "humanTakeoverById" TEXT,
ADD COLUMN     "intent" TEXT,
ADD COLUMN     "isTest" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "language" TEXT,
ADD COLUMN     "publicTokenHash" TEXT,
ADD COLUMN     "purchaseIntent" "PurchaseIntent" NOT NULL DEFAULT 'NONE';

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "intent" TEXT,
ADD COLUMN     "language" TEXT;

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "language" TEXT,
    "source" "ConversationChannel" NOT NULL DEFAULT 'WEB_CHAT',
    "leadStatus" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "purchaseIntent" "PurchaseIntent" NOT NULL DEFAULT 'NONE',
    "lastIntent" TEXT,
    "interests" TEXT[],
    "consentAt" TIMESTAMPTZ(3),
    "assignedToId" TEXT,
    "followUpAt" TIMESTAMPTZ(3),
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "anonymizedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerNote" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "conversationId" TEXT,
    "authorId" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesAgentConfig" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL DEFAULT 'TOUMA Assistant',
    "languages" TEXT[] DEFAULT ARRAY['en', 'fr']::TEXT[],
    "defaultLanguage" TEXT NOT NULL DEFAULT 'en',
    "tone" TEXT,
    "greeting" TEXT,
    "handoffMessage" TEXT,
    "replyMode" "AgentReplyMode" NOT NULL DEFAULT 'REVIEW',
    "autoReplyAuthorizedById" TEXT,
    "autoReplyAuthorizedAt" TIMESTAMPTZ(3),
    "maxAiRepliesPerConversation" INTEGER NOT NULL DEFAULT 30,
    "updatedById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SalesAgentConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentFeedback" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "reporterId" TEXT,
    "note" TEXT NOT NULL,
    "correction" TEXT,
    "status" "FeedbackStatus" NOT NULL DEFAULT 'OPEN',
    "knowledgeEntryId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(3),

    CONSTRAINT "AgentFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Customer_businessId_leadStatus_idx" ON "Customer"("businessId", "leadStatus");

-- CreateIndex
CREATE INDEX "Customer_businessId_lastSeenAt_idx" ON "Customer"("businessId", "lastSeenAt");

-- CreateIndex
CREATE INDEX "Customer_businessId_email_idx" ON "Customer"("businessId", "email");

-- CreateIndex
CREATE INDEX "Customer_businessId_phone_idx" ON "Customer"("businessId", "phone");

-- CreateIndex
CREATE INDEX "CustomerNote_businessId_customerId_idx" ON "CustomerNote"("businessId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesAgentConfig_businessId_key" ON "SalesAgentConfig"("businessId");

-- CreateIndex
CREATE INDEX "AgentFeedback_businessId_status_idx" ON "AgentFeedback"("businessId", "status");

-- CreateIndex
CREATE INDEX "AgentFeedback_conversationId_idx" ON "AgentFeedback"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_publicTokenHash_key" ON "Conversation"("publicTokenHash");

-- CreateIndex
CREATE INDEX "Conversation_businessId_customerId_idx" ON "Conversation"("businessId", "customerId");

-- CreateIndex
CREATE INDEX "Conversation_businessId_aiMode_idx" ON "Conversation"("businessId", "aiMode");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerNote" ADD CONSTRAINT "CustomerNote_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerNote" ADD CONSTRAINT "CustomerNote_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerNote" ADD CONSTRAINT "CustomerNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesAgentConfig" ADD CONSTRAINT "SalesAgentConfig_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentFeedback" ADD CONSTRAINT "AgentFeedback_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentFeedback" ADD CONSTRAINT "AgentFeedback_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

