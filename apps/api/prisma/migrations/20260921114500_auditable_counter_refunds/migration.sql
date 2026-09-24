ALTER TABLE "Job"
  ADD COLUMN "refundConfirmedAt" TIMESTAMP(3),
  ADD COLUMN "refundConfirmedByAdminId" TEXT,
  ADD COLUMN "refundAmountPaise" INTEGER,
  ADD COLUMN "refundReason" TEXT,
  ADD COLUMN "refundReference" TEXT;
