ALTER TABLE "PasswordResetOtp"
  ADD COLUMN "deliveryProvider" TEXT,
  ADD COLUMN "deliveryMessageId" TEXT,
  ADD COLUMN "deliveryAttemptedAt" TIMESTAMP(3),
  ADD COLUMN "deliveryError" TEXT;
