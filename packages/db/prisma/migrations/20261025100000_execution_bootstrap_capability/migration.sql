ALTER TABLE "Execution"
    ADD COLUMN "bootstrapCapabilityHash" TEXT,
    ADD COLUMN "bootstrapExpiresAt" TIMESTAMP(3),
    ADD COLUMN "bootstrapUsedAt" TIMESTAMP(3);

CREATE INDEX "Execution_bootstrapExpiresAt_idx"
    ON "Execution"("bootstrapExpiresAt");
