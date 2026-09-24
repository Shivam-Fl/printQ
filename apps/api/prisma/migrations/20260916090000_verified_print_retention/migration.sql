-- A queue/spool acceptance is not proof that a physical print completed.
CREATE TYPE "PrintCompletionMethod" AS ENUM ('simulator', 'staff_confirmed');

ALTER TABLE "UploadedFile"
  ADD COLUMN "deletionScheduledAt" TIMESTAMP(3),
  ADD COLUMN "contentDeletedAt" TIMESTAMP(3),
  ADD COLUMN "deletionAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastDeletionError" TEXT;

ALTER TABLE "Job"
  ADD COLUMN "spoolAcceptedAt" TIMESTAMP(3),
  ADD COLUMN "printConfirmedAt" TIMESTAMP(3),
  ADD COLUMN "printConfirmedById" TEXT,
  ADD COLUMN "printCompletionMethod" "PrintCompletionMethod";

CREATE INDEX "UploadedFile_contentDeletedAt_idx" ON "UploadedFile"("contentDeletedAt");
