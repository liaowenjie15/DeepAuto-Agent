-- CreateEnum
CREATE TYPE "ExecutionCancellationRequestStatus" AS ENUM ('REQUESTED', 'DISPATCHED', 'FAILED', 'COMPLETED', 'SUPERSEDED');

-- AlterEnum
ALTER TYPE "OutboxEventKind" ADD VALUE 'EXECUTION_CANCEL';

-- CreateTable
CREATE TABLE "ExecutionCancellationRequest" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestedByActorId" TEXT NOT NULL,
    "status" "ExecutionCancellationRequestStatus" NOT NULL DEFAULT 'REQUESTED',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastAttemptAt" TIMESTAMP(3),

    CONSTRAINT "ExecutionCancellationRequest_pkey" PRIMARY KEY ("id")
);

-- DropIndex
DROP INDEX "OutboxEvent_jobId_queueSequence_key";

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionCancellationRequest_executionId_key" ON "ExecutionCancellationRequest"("executionId");

-- CreateIndex
CREATE INDEX "ExecutionCancellationRequest_status_requestedAt_idx" ON "ExecutionCancellationRequest"("status", "requestedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_jobId_kind_queueSequence_key" ON "OutboxEvent"("jobId", "kind", "queueSequence");

-- AddForeignKey
ALTER TABLE "ExecutionCancellationRequest" ADD CONSTRAINT "ExecutionCancellationRequest_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "Execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
