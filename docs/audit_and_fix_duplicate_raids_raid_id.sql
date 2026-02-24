-- =============================================================================
-- Raids must have unique raid_id (no reuse, no duplicates).
-- Duplicate raid_id rows cause "Cannot coerce the result to a single JSON object"
-- on the raid detail page (e.g. /raids/manual-1771909377481).
--
-- Run in Supabase SQL Editor.
-- 1) Run AUDIT to see duplicate raid_ids.
-- 2) Run FIX (inside transaction) to remove duplicate raids rows (keep one per raid_id).
-- 3) Run PREVENT to add UNIQUE on raids(raid_id).
-- =============================================================================

-- =============================================================================
-- AUDIT: raid_ids that appear more than once in raids
-- =============================================================================
SELECT
  raid_id,
  COUNT(*) AS row_count
FROM raids
GROUP BY raid_id
HAVING COUNT(*) > 1
ORDER BY raid_id;

-- =============================================================================
-- FIX: Remove duplicate raids rows (keep one per raid_id using ctid; no dependency on id column)
-- Child tables (raid_events, raid_attendance, raid_loot, etc.) reference raid_id
-- only, so deleting extra raids rows does not orphan any child rows.
-- =============================================================================
BEGIN;

DELETE FROM raids r1
WHERE EXISTS (
  SELECT 1 FROM raids r2
  WHERE r2.raid_id = r1.raid_id
    AND r2.ctid < r1.ctid
);

-- Optional: after dedupe, refresh materialized/cached data if you use it
-- SELECT refresh_all_raid_attendance_totals();
-- SELECT refresh_dkp_summary();

COMMIT;

-- =============================================================================
-- PREVENT: Enforce unique raid_id (run after FIX; will fail if duplicates remain)
-- =============================================================================
-- If raids.raid_id already has a unique constraint, drop it first, e.g.:
--   ALTER TABLE raids DROP CONSTRAINT IF EXISTS uq_raids_raid_id;
CREATE UNIQUE INDEX IF NOT EXISTS uq_raids_raid_id ON raids (raid_id);
