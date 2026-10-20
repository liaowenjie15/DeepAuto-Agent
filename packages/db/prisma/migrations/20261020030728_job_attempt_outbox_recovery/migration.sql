-- CreateEnum
CREATE TYPE "AttemptStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OutboxEventKind" AS ENUM ('JOB_ENQUEUE');

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "currentAttemptNumber" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "JobAttempt" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "status" "AttemptStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "JobAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "kind" "OutboxEventKind" NOT NULL,
    "queueSequence" INTEGER NOT NULL DEFAULT 0,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JobAttempt_jobId_status_idx" ON "JobAttempt"("jobId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "JobAttempt_jobId_number_key" ON "JobAttempt"("jobId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_dedupeKey_key" ON "OutboxEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "OutboxEvent_publishedAt_createdAt_idx" ON "OutboxEvent"("publishedAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_jobId_queueSequence_key" ON "OutboxEvent"("jobId", "queueSequence");

-- AddForeignKey
ALTER TABLE "JobAttempt" ADD CONSTRAINT "JobAttempt_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
