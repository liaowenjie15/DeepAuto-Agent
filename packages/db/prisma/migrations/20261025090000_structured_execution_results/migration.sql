CREATE TYPE "ExecutionFailureCategory" AS ENUM (
    'VALIDATION_FAILED',
    'POLICY_REJECTED',
    'CANCELLED',
    'TIMEOUT',
    'INFRASTRUCTURE_FAILED',
    'CALLBACK_REJECTED'
);

CREATE TYPE "ExecutionLogProvider" AS ENUM ('GITHUB_ACTIONS', 'LOCAL_SANDBOX');

ALTER TABLE "Execution"
    ADD COLUMN "failureCategory" "ExecutionFailureCategory",
    ADD COLUMN "retryable" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "logProvider" "ExecutionLogProvider",
    ADD COLUMN "logReference" TEXT,
    ADD COLUMN "logExpiresAt" TIMESTAMP(3),
    ADD COLUMN "testSummary" JSONB,
    ADD COLUMN "reportedAt" TIMESTAMP(3);

ALTER TABLE "OutboxEvent"
    ADD COLUMN "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "OutboxEvent_availableAt_publishedAt_idx"
    ON "OutboxEvent"("availableAt", "publishedAt");
