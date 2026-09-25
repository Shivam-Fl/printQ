ALTER TABLE "ShopCommissionEntry" ADD COLUMN "settlementStatementId" TEXT;

CREATE UNIQUE INDEX "ShopCommissionEntry_settlementStatementId_key"
  ON "ShopCommissionEntry"("settlementStatementId");

ALTER TABLE "ShopCommissionEntry" ADD CONSTRAINT "ShopCommissionEntry_settlementStatementId_fkey"
  FOREIGN KEY ("settlementStatementId") REFERENCES "ShopCommissionStatement"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
