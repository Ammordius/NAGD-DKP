-- Backfill missing character_name on dkp_summary where character_key is a char_id.
-- Run in Supabase SQL Editor. Safe to run multiple times (only updates rows where name is null/empty and char_id exists in characters).

-- 1) Preview: rows that would be updated
SELECT s.character_key, s.character_name AS current_name, c.name AS new_name
FROM dkp_summary s
JOIN characters c ON trim(s.character_key) = trim(c.char_id::text)
WHERE s.character_name IS NULL OR trim(s.character_name) = '';

-- 2) Apply: set character_name from characters where key matches char_id
UPDATE dkp_summary s
SET character_name = c.name
FROM characters c
WHERE trim(s.character_key) = trim(c.char_id::text)
  AND (s.character_name IS NULL OR trim(s.character_name) = '');
