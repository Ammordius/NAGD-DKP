-- Run in Supabase SQL Editor to see why Frinop's total might be too high.
-- If Frinop appears TWICE in dkp_summary (once by char_id, once by name), the UI sums both = double count.

-- 1) All dkp_summary rows for Frinop (by name or by char_id if character name is Frinop)
-- If you see 2 rows, note the character_key values: one may be numeric (char_id), one may be 'Frinop' (name) = double count
SELECT 'dkp_summary' AS step, character_key, character_name, earned, spent
FROM dkp_summary
WHERE character_name ILIKE '%Frinop%' OR character_key IN (SELECT char_id::text FROM characters WHERE name ILIKE '%Frinop%');

-- 2) Count raid_event_attendance: rows with character_name = Frinop (no char_id) vs rows with Frinop's char_id
SELECT 'raid_event_attendance: by name (no char_id)' AS source, COUNT(*) AS cnt
FROM raid_event_attendance
WHERE trim(COALESCE(character_name,'')) = 'Frinop'
  AND (char_id IS NULL OR trim(char_id::text) = '')
UNION ALL
SELECT 'raid_event_attendance: by char_id' AS source, COUNT(*) AS cnt
FROM raid_event_attendance rea
WHERE rea.char_id IN (SELECT char_id::text FROM characters WHERE name ILIKE '%Frinop%');

-- 2b) Same for raid_attendance (raid-level; can also create character_key = 'Frinop' if name-only rows exist)
SELECT 'raid_attendance: by name (no char_id)' AS source, COUNT(*) AS cnt
FROM raid_attendance
WHERE trim(COALESCE(character_name,'')) = 'Frinop'
  AND (char_id IS NULL OR trim(char_id::text) = '')
UNION ALL
SELECT 'raid_attendance: by char_id' AS source, COUNT(*) AS cnt
FROM raid_attendance ra
WHERE ra.char_id IN (SELECT char_id::text FROM characters WHERE name ILIKE '%Frinop%');

-- 3) Duplicate tics: same (raid_id, event_id) with BOTH a name-only row and a char_id row for Frinop
SELECT rea_name.raid_id, rea_name.event_id,
       rea_name.char_id AS name_row_char_id,
       rea_name.character_name AS name_row_name,
       rea_cid.char_id AS id_row_char_id,
       rea_cid.character_name AS id_row_name
FROM raid_event_attendance rea_name
JOIN raid_event_attendance rea_cid
  ON rea_name.raid_id = rea_cid.raid_id AND rea_name.event_id = rea_cid.event_id
  AND rea_cid.char_id IN (SELECT char_id::text FROM characters WHERE name ILIKE '%Frinop%')
  AND trim(COALESCE(rea_cid.character_name,'')) = 'Frinop'
WHERE trim(COALESCE(rea_name.character_name,'')) = 'Frinop'
  AND (rea_name.char_id IS NULL OR trim(rea_name.char_id::text) = '')
  AND rea_name.id <> rea_cid.id
LIMIT 20;
