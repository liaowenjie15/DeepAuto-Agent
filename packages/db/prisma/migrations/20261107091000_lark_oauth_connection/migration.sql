CREATE TABLE "LarkOAuthState" (
    "stateHash" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "tenantKey" TEXT NOT NULL,
    "scopes" TEXT[] NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LarkOAuthState_pkey" PRIMARY KEY ("stateHash")
);

CREATE TABLE "LarkUserConnection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "tenantKey" TEXT NOT NULL,
    "openId" TEXT NOT NULL,
    "accessTokenEncrypted" TEXT NOT NULL,
    "refreshTokenEncrypted" TEXT NOT NULL,
    "accessExpiresAt" TIMESTAMP(3) NOT NULL,
    "refreshExpiresAt" TIMESTAMP(3) NOT NULL,
    "refreshUncertainAt" TIMESTAMP(3),
    "scopes" TEXT[] NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LarkUserConnection_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LarkOAuthState_expiresAt_idx" ON "LarkOAuthState"("expiresAt");
CREATE UNIQUE INDEX "WorkspaceMember_id_workspaceId_key" ON "WorkspaceMember"("id", "workspaceId");
CREATE UNIQUE INDEX "LarkUserConnection_workspaceId_actorId_appId_tenantKey_key"
    ON "LarkUserConnection"("workspaceId", "actorId", "appId", "tenantKey");
CREATE INDEX "LarkUserConnection_workspaceId_tenantKey_idx"
    ON "LarkUserConnection"("workspaceId", "tenantKey");

ALTER TABLE "LarkUserConnection" ADD CONSTRAINT "LarkUserConnection_actorId_fkey"
    FOREIGN KEY ("actorId", "workspaceId") REFERENCES "WorkspaceMember"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LarkOAuthState" ADD CONSTRAINT "LarkOAuthState_actorId_workspaceId_fkey"
    FOREIGN KEY ("actorId", "workspaceId") REFERENCES "WorkspaceMember"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
