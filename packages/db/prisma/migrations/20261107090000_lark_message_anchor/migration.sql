CREATE TYPE "LarkDeliveryState" AS ENUM ('PENDING', 'CLAIMED', 'SENT', 'UNKNOWN');
CREATE TYPE "LarkProcessingState" AS ENUM ('QUEUED', 'CLAIMED', 'WAITING_PR', 'COMPLETED', 'FAILED', 'UNKNOWN');
CREATE TYPE "LarkChatType" AS ENUM ('P2P', 'GROUP');

CREATE TABLE "LarkMessage" (
    "id" TEXT NOT NULL,
    "invocationId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "tenantKey" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "senderOpenId" TEXT NOT NULL,
    "chatType" "LarkChatType" NOT NULL,
    "acknowledgement" "LarkDeliveryState" NOT NULL DEFAULT 'PENDING',
    "acknowledgementAt" TIMESTAMP(3),
    "finalReply" "LarkDeliveryState" NOT NULL DEFAULT 'PENDING',
    "finalReplyAt" TIMESTAMP(3),
    "finalReplyMessageId" TEXT,
    "processingState" "LarkProcessingState" NOT NULL DEFAULT 'QUEUED',
    "processingStartedAt" TIMESTAMP(3),
    "processingFinishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LarkMessage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LarkMessage_invocationId_key" ON "LarkMessage"("invocationId");
CREATE UNIQUE INDEX "LarkMessage_appId_tenantKey_messageId_key" ON "LarkMessage"("appId", "tenantKey", "messageId");
CREATE INDEX "LarkMessage_appId_tenantKey_chatId_idx" ON "LarkMessage"("appId", "tenantKey", "chatId");
CREATE INDEX "LarkMessage_processingState_processingStartedAt_idx"
    ON "LarkMessage"("processingState", "processingStartedAt");
CREATE INDEX "LarkMessage_processingState_createdAt_idx"
    ON "LarkMessage"("processingState", "createdAt");

ALTER TABLE "LarkMessage" ADD CONSTRAINT "LarkMessage_invocationId_fkey"
    FOREIGN KEY ("invocationId") REFERENCES "Invocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
