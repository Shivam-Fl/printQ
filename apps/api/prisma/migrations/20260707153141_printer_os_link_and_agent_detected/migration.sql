-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "detectedAt" TIMESTAMP(3),
ADD COLUMN     "detectedPrinters" JSONB;

-- AlterTable
ALTER TABLE "Printer" ADD COLUMN     "osPrinterName" TEXT;
