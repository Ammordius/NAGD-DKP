-- Run first: find all characters who have BOTH a char_id row and a name-key row in dkp_summary
-- (same situation as Frinop: double-counted). These are the char_ids we will remove attendance/loot for.

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
  SELECT c.cid, c.cname
  FROM char_id_rows c
  WHERE EXISTS (
    SELECT 1 FROM name_key_rows n
    WHERE n.name_key = c.cname
  )
)
SELECT d.cid AS char_id_to_clean, d.cname AS character_name
FROM duplicate_char_ids d
ORDER BY d.cname;
