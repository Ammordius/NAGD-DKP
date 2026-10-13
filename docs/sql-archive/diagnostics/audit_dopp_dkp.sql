-- Audit Dopp: snapshot/website shows 756 earned, 684 spent; audit_dkp_snapshot_vs_db showed db_earned 757.
-- This query investigates the +1 discrepancy (likely duplicate dkp_summary rows: char_id key + name key).
-- Run in Supabase SQL Editor.

-- 0) Is Dopp in the "double key" list? (has BOTH character_key=char_id AND character_key=name in dkp_summary)
SELECT
  'Dopp in dedupe list (char_id + name key)' AS check_type,
  d.cid AS char_id,
  d.cname AS character_name
FROM (
  SELECT c.cid, c.cname
  FROM (
    SELECT character_key AS cid, trim(COALESCE(character_name,'')) AS cname
    FROM dkp_summary
    WHERE character_key ~ '^[0-9]+$' AND character_name IS NOT NULL AND trim(character_name) <> ''
  ) c
  WHERE EXISTS (
    SELECT 1 FROM dkp_summary n
    WHERE trim(COALESCE(n.character_key,'')) = c.cname
      AND trim(COALESCE(n.character_key,'')) = trim(COALESCE(n.character_name,''))
      AND trim(COALESCE(n.character_key,'')) <> ''
  )
) d
WHERE d.cname = 'Dopp';

-- 1) Every dkp_summary row that contributes to Dopp (by char_id 21866900 or name 'Dopp')
-- If two rows exist, the main audit UNION ALL sums both → 757; app dedupes by name → 756.
SELECT
  'Dopp dkp_summary (all keys)' AS check_type,
  character_key,
  character_name,
  earned,
  spent,
  (earned - spent) AS balance,
  CASE WHEN character_key ~ '^[0-9]+$' THEN 'char_id_key' ELSE 'name_key' END AS key_type
FROM dkp_summary
WHERE character_key = '21866900'
   OR trim(character_key) = 'Dopp'
   OR (character_name IS NOT NULL AND trim(character_name) = 'Dopp')
ORDER BY key_type, character_key;

-- 2) Raw sum (how audit_dkp_snapshot_vs_db computes: UNION ALL by char_id and by name, no dedupe)
WITH dopp_summary_rows AS (
  SELECT earned, spent
  FROM dkp_summary
  WHERE character_key = '21866900'
     OR trim(character_key) = 'Dopp'
     OR (character_name IS NOT NULL AND trim(character_name) = 'Dopp')
)
SELECT
  'Dopp raw sum (audit logic)' AS check_type,
  SUM(earned)::bigint AS total_earned,
  SUM(spent)::bigint AS total_spent
FROM dopp_summary_rows;

-- 3) Deduped sum (how app/leaderboard computes: one row per canonical name, then sum)
-- Should match snapshot 756 earned, 684 spent.
WITH raw AS (
  SELECT character_key, character_name, earned, spent,
         lower(trim(replace(replace(trim(COALESCE(character_name, character_key)), '(*)', ''), '  ', ' '))) AS canon
  FROM dkp_summary
  WHERE character_key = '21866900'
     OR trim(character_key) = 'Dopp'
     OR (character_name IS NOT NULL AND trim(character_name) = 'Dopp')
),
deduped AS (
  SELECT canon, sum(earned) AS earned, sum(spent) AS spent
  FROM raw
  GROUP BY canon
)
SELECT
  'Dopp deduped (app logic)' AS check_type,
  SUM(earned)::bigint AS total_earned,
  SUM(spent)::bigint AS total_spent
FROM deduped;

-- 4) raid_attendance_dkp: all rows for Dopp (by char_id or name).
-- Dedupe check: if the same raid_id appears twice (once with character_key 21866900, once with 'Dopp'), that would
-- double-count that raid. If every row has character_key 21866900 and raid_ids are unique, no dedupe in this table.
SELECT
  'Dopp raid_attendance_dkp' AS check_type,
  raid_id,
  character_key,
  character_name,
  dkp_earned
FROM raid_attendance_dkp
WHERE character_key = '21866900'
   OR trim(character_key) = 'Dopp'
   OR (character_name IS NOT NULL AND trim(character_name) = 'Dopp')
ORDER BY raid_id, character_key;

-- 5) dkp_adjustments for Dopp (should not explain +1 earned by itself)
SELECT
  'Dopp dkp_adjustments' AS check_type,
  character_name,
  earned_delta,
  spent_delta
FROM dkp_adjustments
WHERE trim(character_name) = 'Dopp';
