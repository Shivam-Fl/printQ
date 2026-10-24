-- AlterTable: additive and reversible (rollback: ALTER TABLE "Shop" DROP COLUMN "autoLive").
-- Existing shops get false, so their verification/publication state is untouched.
ALTER TABLE "Shop" ADD COLUMN     "autoLive" BOOLEAN NOT NULL DEFAULT false;
