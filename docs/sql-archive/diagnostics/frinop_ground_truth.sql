-- Run in Supabase SQL Editor. Copy-paste the whole block and run once.

WITH frinop_chars AS (
  SELECT char_id::text AS cid FROM characters WHERE name ILIKE '%Frinop%'
),
summary_rows AS (
  SELECT character_key, character_name, earned, spent
  FROM dkp_summary
  WHERE character_name ILIKE '%Frinop%' OR character_key IN (SELECT cid FROM frinop_chars)
)
SELECT label, value, row_count FROM (
  SELECT 1 AS ord, 'DB: dkp_summary rows for Frinop' AS label,
    (SELECT json_agg(json_build_object('character_key', character_key, 'character_name', character_name, 'earned', earned, 'spent', spent))::text FROM summary_rows) AS value,
    (SELECT COUNT(*) FROM summary_rows)::bigint AS row_count
  UNION ALL
  SELECT 2, 'DB: sum(earned) from those rows',
    (SELECT COALESCE(SUM(earned), 0)::text FROM summary_rows),
    NULL::bigint
  UNION ALL
  SELECT 3, 'DB: Frinop char_id(s) in characters',
    (SELECT json_agg(cid)::text FROM frinop_chars),
    (SELECT COUNT(*) FROM frinop_chars)::bigint
  UNION ALL
  SELECT 4, 'UI would: dedupe by name then sum to account',
    (SELECT COALESCE(SUM(earned), 0)::text FROM summary_rows),
    NULL::bigint
) t
ORDER BY ord;
