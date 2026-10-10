-- Queue bands, reveal grace and absent handling; check-in zone widened to 200 m.

-- Shop settings
ALTER TABLE "Shop"
  ADD COLUMN "counterCapacity" INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN "revealGraceSeconds" INTEGER NOT NULL DEFAULT 60,
  ALTER COLUMN "checkInRadiusM" SET DEFAULT 200;

ALTER TABLE "Shop"
  ADD CONSTRAINT "Shop_counterCapacity_range" CHECK ("counterCapacity" BETWEEN 1 AND 20),
  ADD CONSTRAINT "Shop_revealGraceSeconds_allowed" CHECK ("revealGraceSeconds" IN (30, 60, 120));

-- Every existing shop moves to the 200 m zone (students next door / across the road).
UPDATE "Shop" SET "checkInRadiusM" = 200;

-- Job reveal / absent tracking
ALTER TABLE "Job"
  ADD COLUMN "revealedAt" TIMESTAMP(3),
  ADD COLUMN "revealDeadlineAt" TIMESTAMP(3),
  ADD COLUMN "arrivingNotifiedAt" TIMESTAMP(3),
  ADD COLUMN "absentAt" TIMESTAMP(3),
  ADD COLUMN "absentReason" TEXT;

-- Jobs already showing their code under the old near-front rule stay revealed,
-- with no absent timer (nobody is surprised by a clock after deploy).
UPDATE "Job"
SET "revealedAt" = "nearFrontNotifiedAt"
WHERE "status" IN ('queued', 'notified') AND "nearFrontNotifiedAt" IS NOT NULL;

CREATE INDEX "Job_status_revealDeadlineAt_idx" ON "Job"("status", "revealDeadlineAt");
