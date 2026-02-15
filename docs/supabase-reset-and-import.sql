-- =============================================================================
-- Supabase: Truncate all DKP data tables, then re-create schema and apply
-- one-off DKP adjustments. Run this in Supabase SQL Editor.
-- After running: import CSVs in the order listed at the bottom of this file.
-- =============================================================================

-- 1) TRUNCATE all data tables (do not touch profiles or auth.users)
-- Order: child tables first, then parent. RESTART IDENTITY resets serials.
TRUNCATE TABLE raid_attendance_dkp;
TRUNCATE TABLE raid_dkp_totals;
TRUNCATE TABLE raid_event_attendance RESTART IDENTITY CASCADE;
TRUNCATE TABLE raid_loot RESTART IDENTITY CASCADE;
TRUNCATE TABLE raid_attendance RESTART IDENTITY CASCADE;
TRUNCATE TABLE raid_events RESTART IDENTITY CASCADE;
TRUNCATE TABLE raid_classifications CASCADE;
TRUNCATE TABLE raids RESTART IDENTITY CASCADE;
TRUNCATE TABLE character_account CASCADE;
TRUNCATE TABLE characters CASCADE;
TRUNCATE TABLE accounts CASCADE;
TRUNCATE TABLE dkp_summary;

-- 2) dkp_adjustments: create if not exists (schema may already have it), clear and repopulate
CREATE TABLE IF NOT EXISTS dkp_adjustments (
  character_name TEXT PRIMARY KEY,
  earned_delta NUMERIC NOT NULL DEFAULT 0,
  spent_delta INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_dkp_adjustments_name ON dkp_adjustments(character_name);
ALTER TABLE dkp_adjustments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated read dkp_adjustments" ON dkp_adjustments;
CREATE POLICY "Authenticated read dkp_adjustments" ON dkp_adjustments FOR SELECT TO authenticated USING (true);

DELETE FROM dkp_adjustments;

-- 3) Insert the one-off adjustments (from compare_dkp_ground_truth.py vs ground truth). Omit any character whose base totals now match GT (e.g. Elrontaur was removed: base spent already 310).
INSERT INTO dkp_adjustments (character_name, earned_delta, spent_delta) VALUES
  ('Bhodi', 2, 2),
  ('Gheff', 10, 10),
  ('Pursuit', 2, 2),
  ('Pugnacious', 1, 0),
  ('Barndog', 2, 0),
  ('Handolur', 2, 0),
  ('Hamorf', 1, 0)
ON CONFLICT (character_name) DO UPDATE SET
  earned_delta = EXCLUDED.earned_delta,
  spent_delta = EXCLUDED.spent_delta;

-- =============================================================================
-- After this script: Import CSVs in Table Editor in this order:
--   1. characters       <- data/characters.csv
--   2. accounts         <- data/accounts.csv
--   (Optional) Run docs/supabase-account-display-names.sql to set display_name from ground_truth.txt (first char per account)
--   3. character_account<- data/character_account.csv
--   4. raids            <- data/raids.csv
--   5. raid_events      <- data/raid_events.csv
--   6. raid_loot        <- data/raid_loot.csv
--   7. raid_attendance  <- data/raid_attendance.csv
--   8. raid_event_attendance <- data/raid_event_attendance.csv
--   9. raid_classifications  <- data/raid_classifications_import.csv (or data/raid_classifications.csv)
--   10. dkp_adjustments  <- already filled by INSERT above; or use data/dkp_adjustments.csv
--
-- Then refresh the DKP cache (fast leaderboard): run in SQL Editor:
--   SELECT refresh_dkp_summary();
--   SELECT refresh_all_raid_attendance_totals();  -- populates raid_dkp_totals and raid_attendance_dkp for activity page
-- Or use the "Refresh DKP totals" button on the DKP page (officers only).
-- =============================================================================
