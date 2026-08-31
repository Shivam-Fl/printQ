ALTER TYPE "JobStatus" ADD VALUE IF NOT EXISTS 'awaiting_arrival';

ALTER TABLE "Job"
  ADD COLUMN "releaseCodeDigest" TEXT,
  ADD COLUMN "releaseCodeEncrypted" TEXT,
  ADD COLUMN "releaseCodeGeneratedAt" TIMESTAMP(3),
  ADD COLUMN "arrivedAt" TIMESTAMP(3),
  ADD COLUMN "queueLeftAt" TIMESTAMP(3),
  ADD COLUMN "checkInCount" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "Job_shopId_releaseCodeDigest_idx" ON "Job"("shopId", "releaseCodeDigest");
