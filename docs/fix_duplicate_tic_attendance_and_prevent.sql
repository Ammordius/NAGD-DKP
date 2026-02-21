-- =============================================================================
-- Fix duplicate TIC attendance and prevent future duplicates.
-- Run the ENTIRE file in Supabase SQL Editor in one go. The DELETEs must run
-- before the CREATE UNIQUE INDEX or you get: Key (raid_id, event_id, char_id)=...
-- is duplicated.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- FIX: Remove duplicate attendance rows (keep one per raid/event/character)
-- -----------------------------------------------------------------------------

-- 1a) Same (raid_id, event_id, char_id): keep row with smallest id, delete the rest
DELETE FROM raid_event_attendance rea1
WHERE rea1.char_id IS NOT NULL AND trim(rea1.char_id::text) <> ''
  AND EXISTS (
    SELECT 1 FROM raid_event_attendance rea2
    WHERE rea2.raid_id = rea1.raid_id AND rea2.event_id = rea1.event_id
      AND trim(rea2.char_id::text) = trim(rea1.char_id::text)
      AND rea2.id < rea1.id
  );

-- 1b) Name-only duplicate when same (raid_id, event_id) already has that character with char_id set (Frinop-style)
DELETE FROM raid_event_attendance rea1
WHERE (rea1.char_id IS NULL OR trim(rea1.char_id::text) = '')
  AND trim(COALESCE(rea1.character_name,'')) <> ''
  AND EXISTS (
    SELECT 1 FROM raid_event_attendance rea2
    WHERE rea2.raid_id = rea1.raid_id AND rea2.event_id = rea1.event_id
      AND trim(COALESCE(rea2.character_name,'')) = trim(rea1.character_name)
      AND rea2.char_id IS NOT NULL AND trim(rea2.char_id::text) <> ''
      AND rea2.id <> rea1.id
  );

-- 1c) Same (raid_id, event_id, character_name): keep one row (smallest id), delete the rest (handles duplicate name-only rows)
DELETE FROM raid_event_attendance rea1
WHERE trim(COALESCE(rea1.character_name,'')) <> ''
  AND EXISTS (
    SELECT 1 FROM raid_event_attendance rea2
    WHERE rea2.raid_id = rea1.raid_id AND rea2.event_id = rea1.event_id
      AND trim(COALESCE(rea2.character_name,'')) = trim(rea1.character_name)
      AND rea2.id < rea1.id
  );

-- Refresh caches after deletes
SELECT refresh_all_raid_attendance_totals();
SELECT refresh_dkp_summary();

-- -----------------------------------------------------------------------------
-- PREVENT: Unique constraints (must run after deletes above, same transaction)
-- -----------------------------------------------------------------------------
DROP INDEX IF EXISTS uq_raid_event_attendance_raid_event_char_id;
DROP INDEX IF EXISTS uq_raid_event_attendance_raid_event_character_name;

CREATE UNIQUE INDEX uq_raid_event_attendance_raid_event_char_id
ON raid_event_attendance (raid_id, event_id, char_id)
WHERE char_id IS NOT NULL AND trim(char_id::text) <> '';

CREATE UNIQUE INDEX uq_raid_event_attendance_raid_event_character_name
ON raid_event_attendance (raid_id, event_id, character_name)
WHERE character_name IS NOT NULL AND trim(character_name) <> '';

COMMENT ON INDEX uq_raid_event_attendance_raid_event_char_id IS 'Prevent same character (by char_id) being added to the same tic twice';
COMMENT ON INDEX uq_raid_event_attendance_raid_event_character_name IS 'Prevent same character (by name) being added to the same tic twice';

COMMIT;
