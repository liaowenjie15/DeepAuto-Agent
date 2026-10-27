ALTER TABLE "Execution"
    ADD COLUMN "capabilityId" TEXT,
    ADD COLUMN "capabilityPolicyHash" TEXT,
    ADD COLUMN "capabilityPolicy" JSONB;

CREATE INDEX "Execution_capabilityId_idx"
    ON "Execution"("capabilityId");
