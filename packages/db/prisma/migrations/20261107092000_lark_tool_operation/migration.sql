CREATE TYPE "LarkToolOperationState" AS ENUM ('CLAIMED', 'SUCCEEDED', 'UNKNOWN');
ALTER TABLE "LarkMessage" ADD COLUMN "finalText" TEXT;

CREATE TABLE "LarkToolOperation" (
    "id" TEXT NOT NULL,
    "invocationId" TEXT NOT NULL,
    "operationKey" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetHash" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "snapshotEncrypted" TEXT NOT NULL,
    "providerResultEncrypted" TEXT,
    "state" "LarkToolOperationState" NOT NULL DEFAULT 'CLAIMED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "LarkToolOperation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LarkToolOperation_operationKey_key" ON "LarkToolOperation"("operationKey");
CREATE INDEX "LarkToolOperation_invocationId_createdAt_idx" ON "LarkToolOperation"("invocationId", "createdAt");
ALTER TABLE "LarkToolOperation" ADD CONSTRAINT "LarkToolOperation_invocationId_fkey"
    FOREIGN KEY ("invocationId") REFERENCES "Invocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
