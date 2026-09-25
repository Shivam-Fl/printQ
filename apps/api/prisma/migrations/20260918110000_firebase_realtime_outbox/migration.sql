ALTER TABLE "Student" ADD COLUMN "firebaseUid" TEXT;

CREATE UNIQUE INDEX "Student_firebaseUid_key" ON "Student"("firebaseUid");

CREATE TABLE "RealtimeOutbox" (
    "id" TEXT NOT NULL,
    "jobEventId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "RealtimeOutbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RealtimeOutbox_jobEventId_key" ON "RealtimeOutbox"("jobEventId");
CREATE INDEX "RealtimeOutbox_publishedAt_createdAt_idx" ON "RealtimeOutbox"("publishedAt", "createdAt");
CREATE INDEX "RealtimeOutbox_jobId_createdAt_idx" ON "RealtimeOutbox"("jobId", "createdAt");

ALTER TABLE "RealtimeOutbox" ADD CONSTRAINT "RealtimeOutbox_jobEventId_fkey"
  FOREIGN KEY ("jobEventId") REFERENCES "JobEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RealtimeOutbox" ADD CONSTRAINT "RealtimeOutbox_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
