-- AlterTable
ALTER TABLE "Execution" ADD COLUMN     "externalRunId" BIGINT,
ADD COLUMN     "externalUrl" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Execution_externalRunId_key" ON "Execution"("externalRunId");
