ALTER TABLE "ShopCollectionMandate"
ADD COLUMN "providerTokenId" TEXT,
ADD COLUMN "ownerDebitEmail" TEXT,
ADD COLUMN "ownerDebitContactE164" TEXT;

CREATE UNIQUE INDEX "ShopCollectionMandate_providerTokenId_key"
ON "ShopCollectionMandate"("providerTokenId");
