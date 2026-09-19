CREATE TYPE "ShopVerificationStatus" AS ENUM ('draft', 'submitted', 'verified', 'rejected');
CREATE TYPE "AdminRole" AS ENUM ('platform_admin');

ALTER TABLE "Shop"
  ADD COLUMN "campusId" TEXT,
  ADD COLUMN "verificationStatus" "ShopVerificationStatus" NOT NULL DEFAULT 'draft',
  ADD COLUMN "verificationSubmittedAt" TIMESTAMP(3),
  ADD COLUMN "verifiedAt" TIMESTAMP(3),
  ADD COLUMN "publishedAt" TIMESTAMP(3),
  ADD COLUMN "verificationNotes" TEXT;

CREATE TABLE "Campus" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "address" TEXT NOT NULL,
  "latitude" DOUBLE PRECISION,
  "longitude" DOUBLE PRECISION,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Campus_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AdminUser" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "role" "AdminRole" NOT NULL DEFAULT 'platform_admin',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AdminAuditEvent" (
  "id" TEXT NOT NULL,
  "adminId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "subjectType" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminAuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Campus_slug_key" ON "Campus"("slug");
CREATE INDEX "Campus_isActive_name_idx" ON "Campus"("isActive", "name");
CREATE UNIQUE INDEX "AdminUser_email_key" ON "AdminUser"("email");
CREATE INDEX "AdminAuditEvent_subjectType_subjectId_createdAt_idx"
  ON "AdminAuditEvent"("subjectType", "subjectId", "createdAt");
CREATE INDEX "AdminAuditEvent_adminId_createdAt_idx" ON "AdminAuditEvent"("adminId", "createdAt");
CREATE INDEX "Shop_campusId_idx" ON "Shop"("campusId");
CREATE INDEX "Shop_verificationStatus_publishedAt_idx" ON "Shop"("verificationStatus", "publishedAt");

ALTER TABLE "Shop"
  ADD CONSTRAINT "Shop_campusId_fkey"
  FOREIGN KEY ("campusId") REFERENCES "Campus"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AdminAuditEvent"
  ADD CONSTRAINT "AdminAuditEvent_adminId_fkey"
  FOREIGN KEY ("adminId") REFERENCES "AdminUser"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
