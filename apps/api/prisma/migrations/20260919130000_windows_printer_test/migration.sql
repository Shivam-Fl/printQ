-- Printer setup diagnostics are deliberately separate from customer jobs and
-- never imply that a customer's printed output was physically completed.
CREATE TYPE "PrinterTestStatus" AS ENUM ('requested', 'spool_accepted', 'failed');

ALTER TABLE "Printer"
  ADD COLUMN "lastTestRequestId" TEXT,
  ADD COLUMN "lastTestRequestedAt" TIMESTAMP(3),
  ADD COLUMN "lastTestedAt" TIMESTAMP(3),
  ADD COLUMN "lastTestStatus" "PrinterTestStatus",
  ADD COLUMN "lastTestError" TEXT,
  ADD COLUMN "lastTestAgentId" TEXT;
