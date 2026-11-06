ALTER TABLE "Invocation"
    ADD COLUMN "repositoryId" TEXT;

ALTER TABLE "Job"
    ADD COLUMN "capabilityId" TEXT,
    ADD COLUMN "capabilityPolicyHash" TEXT,
    ADD COLUMN "capabilityPolicy" JSONB;

CREATE INDEX "Job_capabilityId_idx"
    ON "Job"("capabilityId");
