-- New shops default to a tighter campus arrival zone. Existing shops retain
-- their configured radius until the owner chooses 20 m, 50 m, or 100 m.
ALTER TABLE "Shop"
ALTER COLUMN "checkInRadiusM" SET DEFAULT 50;
