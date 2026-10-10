-- CreateEnum
CREATE TYPE "FeePaymentStatus" AS ENUM ('created', 'attempted', 'failed', 'paid', 'expired');

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "feeBlockOverrideUntil" TIMESTAMP(3),
ADD COLUMN     "feeBlockReason" TEXT,
ADD COLUMN     "feeBlockedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ShopCommissionEntry" ADD COLUMN     "feePaymentId" TEXT;

-- AlterTable
ALTER TABLE "ShopCommissionStatement" ADD COLUMN     "dueAt" TIMESTAMP(3),
ADD COLUMN     "paidPaise" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "settledAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ShopPushSubscription" (
    "id" TEXT NOT NULL,
    "shopUserId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopPushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopFeePayment" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerOrderId" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "FeePaymentStatus" NOT NULL DEFAULT 'created',
    "providerPaymentId" TEXT,
    "requestedById" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "unallocatedPaise" INTEGER NOT NULL DEFAULT 0,
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopFeePayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopFeeAllocation" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopFeeAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopFeeNotice" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "statementId" TEXT,
    "kind" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "emailStatus" TEXT NOT NULL DEFAULT 'pending',
    "pushStatus" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopFeeNotice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopFeeEvent" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopFeeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopPushSubscription_endpoint_key" ON "ShopPushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "ShopPushSubscription_shopUserId_idx" ON "ShopPushSubscription"("shopUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopFeePayment_providerOrderId_key" ON "ShopFeePayment"("providerOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopFeePayment_providerPaymentId_key" ON "ShopFeePayment"("providerPaymentId");

-- CreateIndex
CREATE INDEX "ShopFeePayment_shopId_status_createdAt_idx" ON "ShopFeePayment"("shopId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ShopFeePayment_status_createdAt_idx" ON "ShopFeePayment"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ShopFeeAllocation_statementId_idx" ON "ShopFeeAllocation"("statementId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopFeeAllocation_paymentId_statementId_key" ON "ShopFeeAllocation"("paymentId", "statementId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopFeeNotice_dedupeKey_key" ON "ShopFeeNotice"("dedupeKey");

-- CreateIndex
CREATE INDEX "ShopFeeNotice_shopId_createdAt_idx" ON "ShopFeeNotice"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "ShopFeeEvent_shopId_createdAt_idx" ON "ShopFeeEvent"("shopId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShopCommissionEntry_feePaymentId_key" ON "ShopCommissionEntry"("feePaymentId");

-- AddForeignKey
ALTER TABLE "ShopPushSubscription" ADD CONSTRAINT "ShopPushSubscription_shopUserId_fkey" FOREIGN KEY ("shopUserId") REFERENCES "ShopUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopCommissionEntry" ADD CONSTRAINT "ShopCommissionEntry_feePaymentId_fkey" FOREIGN KEY ("feePaymentId") REFERENCES "ShopFeePayment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopFeePayment" ADD CONSTRAINT "ShopFeePayment_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopFeeAllocation" ADD CONSTRAINT "ShopFeeAllocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "ShopFeePayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopFeeAllocation" ADD CONSTRAINT "ShopFeeAllocation_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "ShopCommissionStatement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopFeeNotice" ADD CONSTRAINT "ShopFeeNotice_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopFeeNotice" ADD CONSTRAINT "ShopFeeNotice_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "ShopCommissionStatement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopFeeEvent" ADD CONSTRAINT "ShopFeeEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "ShopCommissionCollectionAttempt_statementId_status_createdAt_id" RENAME TO "ShopCommissionCollectionAttempt_statementId_status_createdA_idx";


-- Statements frozen before this migration keep dueAt NULL: they were never
-- billable, so enforcement adopts them (dueAt = adoption time + terms) only when
-- fee payments are switched on. Statements the old model already settled are
-- recorded as fully paid.
UPDATE "ShopCommissionStatement"
SET "paidPaise" = "amountDuePaise", "settledAt" = "updatedAt"
WHERE "status" = 'settled' AND "amountDuePaise" > 0;
