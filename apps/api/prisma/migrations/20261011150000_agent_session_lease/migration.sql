-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "sessionId" TEXT;

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "claimedBySessionId" TEXT;

