ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'cash_due';
ALTER TYPE "ShopLedgerType" ADD VALUE IF NOT EXISTS 'cash_settlement';
ALTER TYPE "ShopLedgerType" ADD VALUE IF NOT EXISTS 'balance_payment';

CREATE TYPE "ShopBalancePaymentStatus" AS ENUM ('pending', 'paid', 'failed');

ALTER TABLE "Shop"
ADD COLUMN "cashPaymentsEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Job"
ADD COLUMN "cashCollectedAt" TIMESTAMP(3);

CREATE TABLE "ShopBalancePayment" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "amountPaise" INTEGER NOT NULL,
  "status" "ShopBalancePaymentStatus" NOT NULL DEFAULT 'pending',
  "provider" TEXT NOT NULL,
  "providerOrderId" TEXT NOT NULL,
  "paymentId" TEXT,
  "requestedById" TEXT,
  "paidAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ShopBalancePayment_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ShopBalancePayment"
ADD CONSTRAINT "ShopBalancePayment_shopId_fkey"
FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "ShopBalancePayment_providerOrderId_key" ON "ShopBalancePayment"("providerOrderId");
CREATE UNIQUE INDEX "ShopBalancePayment_paymentId_key" ON "ShopBalancePayment"("paymentId");
CREATE INDEX "ShopBalancePayment_shopId_createdAt_idx" ON "ShopBalancePayment"("shopId", "createdAt");

ALTER TABLE "ShopLedgerEntry"
ADD COLUMN "balancePaymentId" TEXT;

ALTER TABLE "ShopLedgerEntry"
ADD CONSTRAINT "ShopLedgerEntry_balancePaymentId_fkey"
FOREIGN KEY ("balancePaymentId") REFERENCES "ShopBalancePayment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "ShopLedgerEntry_balancePaymentId_type_key"
ON "ShopLedgerEntry"("balancePaymentId", "type");
