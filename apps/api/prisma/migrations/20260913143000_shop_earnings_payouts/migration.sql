CREATE TYPE "PayoutSchedule" AS ENUM ('daily', 'on_demand');
CREATE TYPE "ShopPayoutStatus" AS ENUM ('requested', 'processing', 'paid', 'failed', 'cancelled');
CREATE TYPE "ShopLedgerType" AS ENUM ('print_earning', 'payout_reserved', 'payout_released', 'adjustment');

ALTER TABLE "Shop"
ADD COLUMN "payoutSchedule" "PayoutSchedule" NOT NULL DEFAULT 'daily',
ADD COLUMN "razorpayLinkedAccountId" TEXT;

ALTER TABLE "Job"
ADD COLUMN "shopBasePaise" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "platformMarkupPaise" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "platformDiscountPaise" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "gatewayFeePaise" INTEGER,
ADD COLUMN "gatewayTaxPaise" INTEGER;

-- Orders created before the marketplace split charged the shop's base total.
UPDATE "Job" SET "shopBasePaise" = "totalPaise";

CREATE TABLE "ShopPayout" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "amountPaise" INTEGER NOT NULL,
  "status" "ShopPayoutStatus" NOT NULL DEFAULT 'requested',
  "provider" TEXT NOT NULL,
  "providerTransferId" TEXT,
  "requestedById" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastAttemptAt" TIMESTAMP(3),
  "lastError" TEXT,
  "paidAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ShopPayout_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ShopLedgerEntry" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "jobId" TEXT,
  "payoutId" TEXT,
  "type" "ShopLedgerType" NOT NULL,
  "amountPaise" INTEGER NOT NULL,
  "description" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ShopLedgerEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Shop_razorpayLinkedAccountId_key" ON "Shop"("razorpayLinkedAccountId");
CREATE UNIQUE INDEX "ShopPayout_providerTransferId_key" ON "ShopPayout"("providerTransferId");
CREATE INDEX "ShopPayout_shopId_createdAt_idx" ON "ShopPayout"("shopId", "createdAt");
CREATE INDEX "ShopPayout_status_lastAttemptAt_idx" ON "ShopPayout"("status", "lastAttemptAt");
CREATE UNIQUE INDEX "ShopLedgerEntry_jobId_type_key" ON "ShopLedgerEntry"("jobId", "type");
CREATE UNIQUE INDEX "ShopLedgerEntry_payoutId_type_key" ON "ShopLedgerEntry"("payoutId", "type");
CREATE INDEX "ShopLedgerEntry_shopId_createdAt_idx" ON "ShopLedgerEntry"("shopId", "createdAt");

ALTER TABLE "ShopPayout" ADD CONSTRAINT "ShopPayout_shopId_fkey"
FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShopLedgerEntry" ADD CONSTRAINT "ShopLedgerEntry_shopId_fkey"
FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShopLedgerEntry" ADD CONSTRAINT "ShopLedgerEntry_jobId_fkey"
FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ShopLedgerEntry" ADD CONSTRAINT "ShopLedgerEntry_payoutId_fkey"
FOREIGN KEY ("payoutId") REFERENCES "ShopPayout"("id") ON DELETE SET NULL ON UPDATE CASCADE;
