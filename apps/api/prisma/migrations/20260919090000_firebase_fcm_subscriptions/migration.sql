CREATE TABLE "FcmSubscription" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FcmSubscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FcmSubscription_token_key" ON "FcmSubscription"("token");
CREATE INDEX "FcmSubscription_studentId_idx" ON "FcmSubscription"("studentId");

ALTER TABLE "FcmSubscription" ADD CONSTRAINT "FcmSubscription_studentId_fkey"
  FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;
