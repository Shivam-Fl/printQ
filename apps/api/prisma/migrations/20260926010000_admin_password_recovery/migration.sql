ALTER TABLE "AdminUser" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "AdminPasswordResetOtp" (
  "id" TEXT NOT NULL,
  "adminId" TEXT NOT NULL,
  "otpHash" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "deliveryProvider" TEXT,
  "deliveryMessageId" TEXT,
  "deliveryAttemptedAt" TIMESTAMP(3),
  "deliveryError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminPasswordResetOtp_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminPasswordResetOtp_adminId_createdAt_idx"
  ON "AdminPasswordResetOtp"("adminId", "createdAt");

ALTER TABLE "AdminPasswordResetOtp"
  ADD CONSTRAINT "AdminPasswordResetOtp_adminId_fkey"
  FOREIGN KEY ("adminId") REFERENCES "AdminUser"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
