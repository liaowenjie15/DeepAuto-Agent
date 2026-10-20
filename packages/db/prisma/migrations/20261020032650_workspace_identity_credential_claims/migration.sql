-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('MEMBER', 'OPERATOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "CredentialProvider" AS ENUM ('LARK_USER', 'GITHUB_INSTALLATION');

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceMember" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "role" "MemberRole" NOT NULL DEFAULT 'MEMBER',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "larkOpenId" TEXT,
    "githubUserId" TEXT,
    "githubLogin" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceRepository" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "providerRepositoryId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceRepository_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CredentialClaim" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "provider" "CredentialProvider" NOT NULL,
    "credentialReference" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CredentialClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "actorId" TEXT,
    "jobId" TEXT,
    "attemptId" TEXT,
    "action" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceMember_workspaceId_larkOpenId_key" ON "WorkspaceMember"("workspaceId", "larkOpenId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceMember_workspaceId_githubUserId_key" ON "WorkspaceMember"("workspaceId", "githubUserId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceRepository_workspaceId_providerRepositoryId_key" ON "WorkspaceRepository"("workspaceId", "providerRepositoryId");

-- CreateIndex
CREATE INDEX "CredentialClaim_workspaceId_actorId_attemptId_idx" ON "CredentialClaim"("workspaceId", "actorId", "attemptId");

-- CreateIndex
CREATE INDEX "CredentialClaim_expiresAt_idx" ON "CredentialClaim"("expiresAt");

-- CreateIndex
CREATE INDEX "AuditEvent_workspaceId_createdAt_idx" ON "AuditEvent"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_jobId_createdAt_idx" ON "AuditEvent"("jobId", "createdAt");

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceRepository" ADD CONSTRAINT "WorkspaceRepository_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
