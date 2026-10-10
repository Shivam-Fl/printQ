-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "printOptionsVersion" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ShopUser" ADD COLUMN     "sessionVersion" INTEGER NOT NULL DEFAULT 0;
