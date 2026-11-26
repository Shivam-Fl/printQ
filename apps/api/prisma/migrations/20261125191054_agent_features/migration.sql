-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "features" TEXT[] DEFAULT ARRAY[]::TEXT[];
