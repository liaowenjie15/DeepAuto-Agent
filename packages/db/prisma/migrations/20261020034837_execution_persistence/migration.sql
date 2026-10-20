-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT');

-- CreateEnum
CREATE TYPE "ExecutionEventType" AS ENUM ('STARTED', 'PROGRESS', 'ARTIFACT', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ExecutionArtifactName" AS ENUM ('DIFF', 'TEST_RESULT', 'COMMIT_SHA', 'PULL_REQUEST', 'WORKSPACE');

-- CreateTable
CREATE TABLE "Execution" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'RUNNING',
    "reason" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Execution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionEvent" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" "ExecutionEventType" NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionArtifact" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "name" "ExecutionArtifactName" NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutionArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionCallbackClaim" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutionCallbackClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Execution_attemptId_key" ON "Execution"("attemptId");

-- CreateIndex
CREATE INDEX "Execution_status_startedAt_idx" ON "Execution"("status", "startedAt");

-- CreateIndex
CREATE INDEX "ExecutionEvent_executionId_createdAt_idx" ON "ExecutionEvent"("executionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionEvent_executionId_sequence_key" ON "ExecutionEvent"("executionId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionArtifact_executionId_name_key" ON "ExecutionArtifact"("executionId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionCallbackClaim_executionId_key" ON "ExecutionCallbackClaim"("executionId");

-- CreateIndex
CREATE INDEX "ExecutionCallbackClaim_expiresAt_idx" ON "ExecutionCallbackClaim"("expiresAt");

-- AddForeignKey
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "JobAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionEvent" ADD CONSTRAINT "ExecutionEvent_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "Execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionArtifact" ADD CONSTRAINT "ExecutionArtifact_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "Execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionCallbackClaim" ADD CONSTRAINT "ExecutionCallbackClaim_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "Execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
