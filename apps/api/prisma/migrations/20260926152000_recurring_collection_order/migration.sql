ALTER TABLE "ShopCommissionCollectionAttempt" ADD COLUMN "providerOrderId" TEXT;

CREATE UNIQUE INDEX "ShopCommissionCollectionAttempt_providerOrderId_key"
ON "ShopCommissionCollectionAttempt"("providerOrderId");
