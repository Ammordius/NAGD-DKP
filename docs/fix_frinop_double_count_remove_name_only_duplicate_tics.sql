-- Fix: Remove name-only attendance rows when the same raid (and event) already has a row for
-- that character WITH char_id set. Stops the same tic from counting twice (character_key=char_id + character_key=name).
-- Run in Supabase SQL Editor.

BEGIN;

-- 1) raid_event_attendance: delete name-only where same raid/event/character has a char_id row
DELETE FROM raid_event_attendance rea1
WHERE (rea1.char_id IS NULL OR trim(rea1.char_id::text) = '')
  AND trim(COALESCE(rea1.character_name,'')) <> ''
  AND EXISTS (
    SELECT 1 FROM raid_event_attendance rea2
    WHERE rea2.raid_id = rea1.raid_id
      AND rea2.event_id = rea1.event_id
      AND trim(COALESCE(rea2.character_name,'')) = trim(rea1.character_name)
      AND rea2.char_id IS NOT NULL
      AND trim(rea2.char_id::text) <> ''
      AND rea2.id <> rea1.id
  );

-- 2) raid_attendance: delete name-only where same raid has that character with char_id (raid-level, no event_id)
DELETE FROM raid_attendance ra1
WHERE (ra1.char_id IS NULL OR trim(ra1.char_id::text) = '')
  AND trim(COALESCE(ra1.character_name,'')) <> ''
  AND EXISTS (
    SELECT 1 FROM raid_attendance ra2
    WHERE ra2.raid_id = ra1.raid_id
      AND trim(COALESCE(ra2.character_name,'')) = trim(ra1.character_name)
      AND ra2.char_id IS NOT NULL
      AND trim(ra2.char_id::text) <> ''
      AND ra2.id <> ra1.id
  );

COMMIT;

-- Refresh caches so totals and activity update (run these after the DELETE):
SELECT refresh_all_raid_attendance_totals();
SELECT refresh_dkp_summary();
