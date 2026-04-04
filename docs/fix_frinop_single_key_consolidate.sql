-- =============================================================================
-- Consolidate Frinop to a single key (char_id 21990375) so dkp_summary has one row.
-- Run in Supabase SQL Editor. Ensures characters.name = 'Frinop' has char_id 21990375.
--
-- 1) raid_event_attendance: delete name-only 'Frinop' where same (raid_id, event_id)
--    already has char_id 21990375; then set char_id = 21990375 on remaining name-only.
-- 2) raid_attendance: same for raid-level attendance.
-- 3) raid_loot: set char_id = 21990375 where character_name = Frinop and char_id empty.
-- 4) Refresh caches so dkp_summary is recomputed with one row per character.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1) raid_event_attendance: remove name-only duplicates, then backfill char_id
-- -----------------------------------------------------------------------------

-- Match Frinop by name (case-insensitive). Also fix rows where char_id = 'Frinop' (name in char_id column).
-- 1a) Delete name-only Frinop when same (raid_id, event_id) already has 21990375
DELETE FROM raid_event_attendance rea1
WHERE (rea1.char_id IS NULL OR trim(rea1.char_id::text) = '')
  AND trim(COALESCE(rea1.character_name,'')) ILIKE 'Frinop'
  AND EXISTS (
    SELECT 1 FROM raid_event_attendance rea2
    WHERE rea2.raid_id = rea1.raid_id AND rea2.event_id = rea1.event_id
      AND rea2.char_id = '21990375'
      AND rea2.id <> rea1.id
  );

-- 1a2) Delete rows where char_id = 'Frinop' (name stored in char_id) when same (raid_id, event_id) already has 21990375
DELETE FROM raid_event_attendance rea1
WHERE trim(rea1.char_id::text) = 'Frinop'
  AND EXISTS (
    SELECT 1 FROM raid_event_attendance rea2
    WHERE rea2.raid_id = rea1.raid_id AND rea2.event_id = rea1.event_id
      AND rea2.char_id = '21990375'
      AND rea2.id <> rea1.id
  );

-- 1b) Backfill: set char_id on name-only Frinop rows (char_id NULL or empty)
UPDATE raid_event_attendance
SET char_id = '21990375'
WHERE trim(COALESCE(character_name,'')) ILIKE 'Frinop'
  AND (char_id IS NULL OR trim(char_id::text) = '');

-- 1b2) Fix rows where char_id = 'Frinop' (name was stored in char_id column)
UPDATE raid_event_attendance
SET char_id = '21990375'
WHERE trim(char_id::text) = 'Frinop';

-- 1c) If any (raid_id, event_id) had two name-only Frinop rows, we now have duplicate char_id rows; keep one
DELETE FROM raid_event_attendance rea1
WHERE rea1.char_id = '21990375'
  AND EXISTS (
    SELECT 1 FROM raid_event_attendance rea2
    WHERE rea2.raid_id = rea1.raid_id AND rea2.event_id = rea1.event_id
      AND rea2.char_id = '21990375'
      AND rea2.id < rea1.id
  );

-- -----------------------------------------------------------------------------
-- 2) raid_attendance: same (raid-level; no event_id)
-- -----------------------------------------------------------------------------

DELETE FROM raid_attendance ra1
WHERE (ra1.char_id IS NULL OR trim(ra1.char_id::text) = '')
  AND trim(COALESCE(ra1.character_name,'')) ILIKE 'Frinop'
  AND EXISTS (
    SELECT 1 FROM raid_attendance ra2
    WHERE ra2.raid_id = ra1.raid_id
      AND ra2.char_id = '21990375'
      AND ra2.id <> ra1.id
  );

-- 2a2) Delete raid_attendance where char_id = 'Frinop' when same raid already has 21990375
DELETE FROM raid_attendance ra1
WHERE trim(ra1.char_id::text) = 'Frinop'
  AND EXISTS (
    SELECT 1 FROM raid_attendance ra2
    WHERE ra2.raid_id = ra1.raid_id AND ra2.char_id = '21990375'
      AND ra2.id <> ra1.id
  );

UPDATE raid_attendance
SET char_id = '21990375'
WHERE trim(COALESCE(character_name,'')) ILIKE 'Frinop'
  AND (char_id IS NULL OR trim(char_id::text) = '');

UPDATE raid_attendance
SET char_id = '21990375'
WHERE trim(char_id::text) = 'Frinop';

-- 2b) Dedupe raid_attendance (same raid_id, char_id; keep one)
DELETE FROM raid_attendance ra1
WHERE ra1.char_id = '21990375'
  AND EXISTS (
    SELECT 1 FROM raid_attendance ra2
    WHERE ra2.raid_id = ra1.raid_id AND ra2.char_id = '21990375'
      AND ra2.id < ra1.id
  );

-- -----------------------------------------------------------------------------
-- 3) raid_loot: backfill char_id so spent is under one key
-- -----------------------------------------------------------------------------
UPDATE raid_loot
SET char_id = '21990375'
WHERE trim(COALESCE(character_name,'')) ILIKE 'Frinop'
  AND (char_id IS NULL OR trim(char_id::text) = '');

UPDATE raid_loot
SET char_id = '21990375'
WHERE trim(char_id::text) = 'Frinop';

COMMIT;

-- Refresh so dkp_summary and raid_attendance_dkp have one row for Frinop (key 21990375)
SELECT refresh_all_raid_attendance_totals();
SELECT refresh_dkp_summary();
