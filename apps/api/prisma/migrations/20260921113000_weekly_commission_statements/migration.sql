CREATE TYPE "CollectionMandateMethod" AS ENUM ('upi_autopay', 'bank_emandate', 'card_recurring');
CREATE TYPE "CollectionMandateStatus" AS ENUM ('pending', 'active', 'revoked', 'expired', 'failed');
CREATE TYPE "CollectionEnvironment" AS ENUM ('test', 'live');
CREATE TYPE "CommissionStatementStatus" AS ENUM ('draft', 'frozen', 'notice_sent', 'debit_pending', 'settled', 'failed', 'paused');
CREATE TYPE "CommissionCollectionAttemptStatus" AS ENUM ('pending', 'submitted', 'settled', 'failed');

CREATE TABLE "ShopCollectionMandate" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "environment" "CollectionEnvironment" NOT NULL,
  "method" "CollectionMandateMethod" NOT NULL,
  "status" "CollectionMandateStatus" NOT NULL DEFAULT 'pending',
  "maxAmountPaise" INTEGER NOT NULL,
  "frequency" TEXT NOT NULL DEFAULT 'weekly',
  "validFrom" TIMESTAMP(3) NOT NULL,
  "validUntil" TIMESTAMP(3) NOT NULL,
  "cancellationTermsAcceptedAt" TIMESTAMP(3),
  "providerCustomerId" TEXT,
  "providerMandateId" TEXT,
  "activatedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ShopCollectionMandate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ShopCommissionStatement" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "mandateId" TEXT,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  "grossCommissionPaise" INTEGER NOT NULL,
  "creditPaise" INTEGER NOT NULL,
  "amountDuePaise" INTEGER NOT NULL,
  "status" "CommissionStatementStatus" NOT NULL DEFAULT 'draft',
  "frozenAt" TIMESTAMP(3),
  "preDebitNoticeSentAt" TIMESTAMP(3),
  "debitNotBefore" TIMESTAMP(3),
  "pausedReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ShopCommissionStatement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ShopCommissionStatementLine" (
  "id" TEXT NOT NULL,
  "statementId" TEXT NOT NULL,
  "entryId" TEXT NOT NULL,
  "amountPaise" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ShopCommissionStatementLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ShopCommissionCollectionAttempt" (
  "id" TEXT NOT NULL,
  "statementId" TEXT NOT NULL,
  "amountPaise" INTEGER NOT NULL,
  "status" "CommissionCollectionAttemptStatus" NOT NULL DEFAULT 'pending',
  "provider" TEXT NOT NULL,
  "providerCollectionId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "failureReason" TEXT,
  "submittedAt" TIMESTAMP(3),
  "settledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ShopCommissionCollectionAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShopCollectionMandate_providerMandateId_key" ON "ShopCollectionMandate"("providerMandateId");
CREATE INDEX "ShopCollectionMandate_shopId_status_environment_idx" ON "ShopCollectionMandate"("shopId", "status", "environment");
CREATE UNIQUE INDEX "ShopCommissionStatement_shopId_periodStart_periodEnd_key" ON "ShopCommissionStatement"("shopId", "periodStart", "periodEnd");
CREATE INDEX "ShopCommissionStatement_shopId_status_periodEnd_idx" ON "ShopCommissionStatement"("shopId", "status", "periodEnd");
CREATE UNIQUE INDEX "ShopCommissionStatementLine_statementId_entryId_key" ON "ShopCommissionStatementLine"("statementId", "entryId");
CREATE UNIQUE INDEX "ShopCommissionStatementLine_entryId_key" ON "ShopCommissionStatementLine"("entryId");
CREATE UNIQUE INDEX "ShopCommissionCollectionAttempt_providerCollectionId_key" ON "ShopCommissionCollectionAttempt"("providerCollectionId");
CREATE UNIQUE INDEX "ShopCommissionCollectionAttempt_idempotencyKey_key" ON "ShopCommissionCollectionAttempt"("idempotencyKey");
CREATE INDEX "ShopCommissionCollectionAttempt_statementId_status_createdAt_idx" ON "ShopCommissionCollectionAttempt"("statementId", "status", "createdAt");

ALTER TABLE "ShopCollectionMandate" ADD CONSTRAINT "ShopCollectionMandate_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShopCommissionStatement" ADD CONSTRAINT "ShopCommissionStatement_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShopCommissionStatement" ADD CONSTRAINT "ShopCommissionStatement_mandateId_fkey"
  FOREIGN KEY ("mandateId") REFERENCES "ShopCollectionMandate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ShopCommissionStatementLine" ADD CONSTRAINT "ShopCommissionStatementLine_statementId_fkey"
  FOREIGN KEY ("statementId") REFERENCES "ShopCommissionStatement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShopCommissionStatementLine" ADD CONSTRAINT "ShopCommissionStatementLine_entryId_fkey"
  FOREIGN KEY ("entryId") REFERENCES "ShopCommissionEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShopCommissionCollectionAttempt" ADD CONSTRAINT "ShopCommissionCollectionAttempt_statementId_fkey"
  FOREIGN KEY ("statementId") REFERENCES "ShopCommissionStatement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
