-- Students have one checkout rail: payment directly to the shop at its counter.
-- Existing cash/online rows remain readable so a rolling deployment never loses
-- an in-progress legacy order.
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'counter_due';
CREATE TYPE "CounterPaymentMethod" AS ENUM ('cash', 'shop_upi');
CREATE TYPE "CommissionEntryType" AS ENUM ('print_commission', 'refund_credit', 'manual_credit', 'statement_settlement');

ALTER TABLE "Shop"
  ADD COLUMN "counterUpiVpa" TEXT,
  ADD COLUMN "counterUpiPayeeName" TEXT,
  ADD COLUMN "counterUpiVerifiedAt" TIMESTAMP(3);

ALTER TABLE "Job"
  ADD COLUMN "counterPaymentMethod" "CounterPaymentMethod",
  ADD COLUMN "counterPaymentConfirmedAt" TIMESTAMP(3),
  ADD COLUMN "counterPaymentConfirmedById" TEXT,
  ADD COLUMN "counterPaymentReference" TEXT,
  ADD COLUMN "counterPaymentAmountPaise" INTEGER;

CREATE TABLE "ShopCommissionEntry" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "jobId" TEXT,
  "type" "CommissionEntryType" NOT NULL,
  "amountPaise" INTEGER NOT NULL,
  "shopFundedDiscountPaise" INTEGER NOT NULL DEFAULT 0,
  "description" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ShopCommissionEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShopCommissionEntry_jobId_type_key" ON "ShopCommissionEntry"("jobId", "type");
CREATE INDEX "ShopCommissionEntry_shopId_createdAt_idx" ON "ShopCommissionEntry"("shopId", "createdAt");

ALTER TABLE "ShopCommissionEntry" ADD CONSTRAINT "ShopCommissionEntry_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShopCommissionEntry" ADD CONSTRAINT "ShopCommissionEntry_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;
