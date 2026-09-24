CREATE TABLE "NotificationDelivery" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "url" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationDelivery_studentId_eventKey_key"
  ON "NotificationDelivery"("studentId", "eventKey");
CREATE INDEX "NotificationDelivery_deliveredAt_leaseExpiresAt_createdAt_idx"
  ON "NotificationDelivery"("deliveredAt", "leaseExpiresAt", "createdAt");
CREATE INDEX "NotificationDelivery_studentId_createdAt_idx"
  ON "NotificationDelivery"("studentId", "createdAt");

ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_studentId_fkey"
  FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;
