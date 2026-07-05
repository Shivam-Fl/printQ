-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('pending_payment', 'queued', 'notified', 'otp_verified', 'printing', 'ready_for_pickup', 'completed', 'no_show', 'requeued', 'expired', 'cancelled');

-- CreateEnum
CREATE TYPE "PrinterStatus" AS ENUM ('online', 'offline', 'jammed');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('online', 'offline');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('pending', 'paid', 'refunded', 'failed');

-- CreateEnum
CREATE TYPE "JobMode" AS ENUM ('instant', 'scheduled');

-- CreateEnum
CREATE TYPE "ShopUserRole" AS ENUM ('owner', 'staff');

-- CreateEnum
CREATE TYPE "FileStatus" AS ENUM ('uploaded', 'converting', 'ready', 'failed', 'deleted');

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "campusName" TEXT,
    "autoAssignEnabled" BOOLEAN NOT NULL DEFAULT true,
    "rateCard" JSONB NOT NULL,
    "otpWindowMinutes" INTEGER NOT NULL DEFAULT 10,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopUser" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "ShopUserRole" NOT NULL DEFAULT 'staff',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Student" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Student_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginOtp" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "otpHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginOtp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Printer" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "paperSizesLoaded" TEXT[],
    "colorSupport" BOOLEAN NOT NULL DEFAULT false,
    "currentlyLoadedPaper" TEXT,
    "finishingOptions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "avgPagesPerMinute" INTEGER NOT NULL DEFAULT 15,
    "status" "PrinterStatus" NOT NULL DEFAULT 'online',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Printer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "machineLabel" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "connectedPrinterIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastHeartbeatAt" TIMESTAMP(3),
    "status" "AgentStatus" NOT NULL DEFAULT 'offline',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UploadedFile" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "originalKey" TEXT NOT NULL,
    "convertedKey" TEXT,
    "previewKey" TEXT,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "pages" INTEGER,
    "status" "FileStatus" NOT NULL DEFAULT 'uploaded',
    "error" TEXT,
    "deleteAfter" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UploadedFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "assignedPrinterId" TEXT,
    "specs" JSONB NOT NULL,
    "pagesPerCopy" INTEGER NOT NULL,
    "priceBreakdown" JSONB NOT NULL,
    "totalPaise" INTEGER NOT NULL,
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'pending',
    "paymentProvider" TEXT,
    "paymentOrderId" TEXT,
    "paymentId" TEXT,
    "mode" "JobMode" NOT NULL DEFAULT 'instant',
    "scheduledTime" TIMESTAMP(3),
    "status" "JobStatus" NOT NULL DEFAULT 'pending_payment',
    "otpHash" TEXT,
    "otpGeneratedAt" TIMESTAMP(3),
    "otpExpiresAt" TIMESTAMP(3),
    "otpAttempts" INTEGER NOT NULL DEFAULT 0,
    "noShowCount" INTEGER NOT NULL DEFAULT 0,
    "noShowAt" TIMESTAMP(3),
    "queuedAt" TIMESTAMP(3),
    "claimedByAgentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobEvent" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "fromStatus" TEXT NOT NULL,
    "toStatus" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "jobId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_slug_key" ON "Shop"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "ShopUser_email_key" ON "ShopUser"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Student_phone_key" ON "Student"("phone");

-- CreateIndex
CREATE INDEX "LoginOtp_phone_createdAt_idx" ON "LoginOtp"("phone", "createdAt");

-- CreateIndex
CREATE INDEX "Printer_shopId_idx" ON "Printer"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_tokenHash_key" ON "Agent"("tokenHash");

-- CreateIndex
CREATE INDEX "Agent_shopId_idx" ON "Agent"("shopId");

-- CreateIndex
CREATE INDEX "UploadedFile_studentId_createdAt_idx" ON "UploadedFile"("studentId", "createdAt");

-- CreateIndex
CREATE INDEX "UploadedFile_status_deleteAfter_idx" ON "UploadedFile"("status", "deleteAfter");

-- CreateIndex
CREATE UNIQUE INDEX "Job_paymentOrderId_key" ON "Job"("paymentOrderId");

-- CreateIndex
CREATE INDEX "Job_shopId_status_idx" ON "Job"("shopId", "status");

-- CreateIndex
CREATE INDEX "Job_assignedPrinterId_status_queuedAt_idx" ON "Job"("assignedPrinterId", "status", "queuedAt");

-- CreateIndex
CREATE INDEX "Job_studentId_createdAt_idx" ON "Job"("studentId", "createdAt");

-- CreateIndex
CREATE INDEX "Job_status_otpExpiresAt_idx" ON "Job"("status", "otpExpiresAt");

-- CreateIndex
CREATE INDEX "JobEvent_jobId_createdAt_idx" ON "JobEvent"("jobId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentEvent_providerEventId_key" ON "PaymentEvent"("providerEventId");

-- AddForeignKey
ALTER TABLE "ShopUser" ADD CONSTRAINT "ShopUser_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Printer" ADD CONSTRAINT "Printer_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadedFile" ADD CONSTRAINT "UploadedFile_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadedFile" ADD CONSTRAINT "UploadedFile_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "UploadedFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_assignedPrinterId_fkey" FOREIGN KEY ("assignedPrinterId") REFERENCES "Printer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobEvent" ADD CONSTRAINT "JobEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
