-- Remove attendance and loot for every character who has BOTH a char_id row and a name-key row
-- in dkp_summary (so we keep only the name-only row; you can re-upload from inactive raiders later).
-- Run dedupe_all_name_key_char_ids_diagnostic.sql first to see who will be affected.
-- Then run this in Supabase SQL Editor.

-- Uses same definition of "duplicate" as dedupe_all_name_key_char_ids_diagnostic.sql
BEGIN;

WITH name_key_rows AS (
  SELECT trim(COALESCE(character_key,'')) AS name_key
  FROM dkp_summary
  WHERE trim(COALESCE(character_key,'')) = trim(COALESCE(character_name,''))
    AND trim(COALESCE(character_key,'')) <> ''
),
char_id_rows AS (
  SELECT character_key AS cid, trim(COALESCE(character_name,'')) AS cname
  FROM dkp_summary
  WHERE character_key ~ '^[0-9]+$'
    AND character_name IS NOT NULL
    AND trim(character_name) <> ''
),
duplicate_char_ids AS (
  SELECT c.cid
  FROM char_id_rows c
  WHERE EXISTS (SELECT 1 FROM name_key_rows n WHERE n.name_key = c.cname)
)
DELETE FROM raid_event_attendance
WHERE char_id IN (SELECT cid FROM duplicate_char_ids);

WITH name_key_rows AS (
  SELECT trim(COALESCE(character_key,'')) AS name_key
  FROM dkp_summary
  WHERE trim(COALESCE(character_key,'')) = trim(COALESCE(character_name,''))
    AND trim(COALESCE(character_key,'')) <> ''
),
char_id_rows AS (
  SELECT character_key AS cid, trim(COALESCE(character_name,'')) AS cname
  FROM dkp_summary
  WHERE character_key ~ '^[0-9]+$'
    AND character_name IS NOT NULL
    AND trim(character_name) <> ''
),
duplicate_char_ids AS (
  SELECT c.cid
  FROM char_id_rows c
  WHERE EXISTS (SELECT 1 FROM name_key_rows n WHERE n.name_key = c.cname)
)
DELETE FROM raid_attendance
WHERE char_id IN (SELECT cid FROM duplicate_char_ids);

WITH name_key_rows AS (
  SELECT trim(COALESCE(character_key,'')) AS name_key
  FROM dkp_summary
  WHERE trim(COALESCE(character_key,'')) = trim(COALESCE(character_name,''))
    AND trim(COALESCE(character_key,'')) <> ''
),
char_id_rows AS (
  SELECT character_key AS cid, trim(COALESCE(character_name,'')) AS cname
  FROM dkp_summary
  WHERE character_key ~ '^[0-9]+$'
    AND character_name IS NOT NULL
    AND trim(character_name) <> ''
),
duplicate_char_ids AS (
  SELECT c.cid
  FROM char_id_rows c
  WHERE EXISTS (SELECT 1 FROM name_key_rows n WHERE n.name_key = c.cname)
)
DELETE FROM raid_loot
WHERE char_id IN (SELECT cid FROM duplicate_char_ids);

COMMIT;

-- Then run:
SELECT refresh_all_raid_attendance_totals();
SELECT refresh_dkp_summary();
