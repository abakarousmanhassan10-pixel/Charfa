-- CreateTable
CREATE TABLE "CreativeCampaign" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "brand" JSONB NOT NULL,
    "photoCount" INTEGER NOT NULL,
    "videoCount" INTEGER NOT NULL,
    "startAt" TIMESTAMPTZ(3) NOT NULL,
    "intervalHours" INTEGER NOT NULL DEFAULT 24,
    "publishMode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "stoppedAt" TIMESTAMPTZ(3),
    "stoppedById" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CreativeCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreativeCampaignTask" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "agent" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "itemIndex" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "generationId" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "output" JSONB,
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreativeCampaignTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreativeCampaignPost" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "outputId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "caption" TEXT NOT NULL,
    "hashtags" TEXT[],
    "scheduledAt" TIMESTAMPTZ(3) NOT NULL,
    "contentHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "requestedMode" TEXT NOT NULL,
    "effectiveMode" TEXT NOT NULL,
    "risk" TEXT NOT NULL,
    "reasons" JSONB NOT NULL,
    "approvedHash" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMPTZ(3),
    "publishedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CreativeCampaignPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreativeCampaignEvent" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreativeCampaignEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreativeCampaign_businessId_status_createdAt_idx" ON "CreativeCampaign"("businessId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreativeCampaign_businessId_idempotencyKey_key" ON "CreativeCampaign"("businessId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "CreativeCampaignTask_businessId_status_idx" ON "CreativeCampaignTask"("businessId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CreativeCampaignTask_campaignId_seq_key" ON "CreativeCampaignTask"("campaignId", "seq");

-- CreateIndex
CREATE INDEX "CreativeCampaignPost_businessId_status_scheduledAt_idx" ON "CreativeCampaignPost"("businessId", "status", "scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreativeCampaignPost_campaignId_outputId_key" ON "CreativeCampaignPost"("campaignId", "outputId");

-- CreateIndex
CREATE INDEX "CreativeCampaignEvent_businessId_level_createdAt_idx" ON "CreativeCampaignEvent"("businessId", "level", "createdAt");

-- CreateIndex
CREATE INDEX "CreativeCampaignEvent_campaignId_createdAt_idx" ON "CreativeCampaignEvent"("campaignId", "createdAt");

-- AddForeignKey
ALTER TABLE "CreativeCampaign" ADD CONSTRAINT "CreativeCampaign_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeCampaignTask" ADD CONSTRAINT "CreativeCampaignTask_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CreativeCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeCampaignPost" ADD CONSTRAINT "CreativeCampaignPost_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CreativeCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeCampaignEvent" ADD CONSTRAINT "CreativeCampaignEvent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CreativeCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

