-- CreateEnum
CREATE TYPE "InvocationSource" AS ENUM ('FEISHU', 'GITHUB');

-- CreateEnum
CREATE TYPE "InvocationAnchor" AS ENUM ('MESSAGE', 'ISSUE', 'PULL_REQUEST', 'COMMENT');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Invocation" (
    "id" TEXT NOT NULL,
    "source" "InvocationSource" NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "conversationKey" TEXT NOT NULL,
    "anchor" "InvocationAnchor" NOT NULL,
    "instruction" TEXT NOT NULL,
    "sourceEventId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "invocationId" TEXT NOT NULL,
    "conversationKey" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Invocation_workspaceId_conversationKey_idx" ON "Invocation"("workspaceId", "conversationKey");

-- CreateIndex
CREATE UNIQUE INDEX "invocations_source_event_id_key" ON "Invocation"("source", "sourceEventId");

-- CreateIndex
CREATE UNIQUE INDEX "Job_invocationId_key" ON "Job"("invocationId");

-- CreateIndex
CREATE UNIQUE INDEX "Job_idempotencyKey_key" ON "Job"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Job_conversationKey_status_idx" ON "Job"("conversationKey", "status");

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_invocationId_fkey" FOREIGN KEY ("invocationId") REFERENCES "Invocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
