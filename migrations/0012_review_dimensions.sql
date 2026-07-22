-- Multi-dimension ratings: Communication / Experience / Speedy Response,
-- restoring categories the patient-feedback memo flagged as dropped from the
-- mockups. `rating` stays the overall score (now the rounded average of the
-- three), so /reviews/summary's distribution/average logic is unchanged.
-- Nullable — existing reviews predate this and have none. Idempotent.
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS communication_rating integer;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS experience_rating integer;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS speedy_response_rating integer;
