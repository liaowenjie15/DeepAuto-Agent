CREATE TABLE "LarkWriteConfirmation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "tenantKey" TEXT NOT NULL,
    "conversationKey" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetHash" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "invalidatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LarkWriteConfirmation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LarkWriteConfirmation_workspaceId_actorId_conversationKey_expiresAt_idx"
ON "LarkWriteConfirmation"("workspaceId", "actorId", "conversationKey", "expiresAt");

CREATE INDEX "LarkWriteConfirmation_expiresAt_idx"
ON "LarkWriteConfirmation"("expiresAt");

CREATE UNIQUE INDEX "LarkWriteConfirmation_active_key"
ON "LarkWriteConfirmation"(
    "workspaceId",
    "actorId",
    "appId",
    "tenantKey",
    "conversationKey",
    "action",
    "targetHash",
    "payloadHash"
)
WHERE "consumedAt" IS NULL AND "invalidatedAt" IS NULL;

ALTER TABLE "LarkWriteConfirmation"
ADD CONSTRAINT "LarkWriteConfirmation_actorId_workspaceId_fkey"
FOREIGN KEY ("actorId", "workspaceId") REFERENCES "WorkspaceMember"("id", "workspaceId")
ON DELETE CASCADE ON UPDATE CASCADE;
