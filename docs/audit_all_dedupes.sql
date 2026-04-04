-- Audit: find ALL dedupes in the DB (characters with both char_id key and name key in dkp_summary).
-- "Name key" = any row where character_key (non-numeric) equals that character's name (we do NOT require
-- character_name = character_key on that row, so we catch Dopp-style rows where name-key row has character_name NULL).
-- Output is designed for line-by-line comparison. Run each section in Supabase SQL Editor.
-- After fixing, run refresh_all_raid_attendance_totals() and refresh_dkp_summary().

-- =============================================================================
-- SECTION 1: List of all characters that are deduped (both keys exist in dkp_summary)
-- =============================================================================
WITH char_id_rows AS (
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
    SELECT 1 FROM dkp_summary n
    WHERE trim(COALESCE(n.character_key,'')) = c.cname
      AND trim(COALESCE(n.character_key,'')) <> ''
      AND n.character_key !~ '^[0-9]+$'
  )
)
SELECT
  'DEDUPE_CHAR_LIST' AS report_section,
  d.cid AS char_id,
  d.cname AS character_name
FROM duplicate_char_ids d
ORDER BY d.cname;

-- =============================================================================
-- SECTION 2: dkp_summary rows for deduped characters — LINE BY LINE for comparison
-- One row per dkp_summary row; same character appears twice (char_id key + name key).
-- =============================================================================
WITH char_id_rows AS (
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
    SELECT 1 FROM dkp_summary n
    WHERE trim(COALESCE(n.character_key,'')) = c.cname
      AND trim(COALESCE(n.character_key,'')) <> ''
      AND n.character_key !~ '^[0-9]+$'
  )
)
SELECT
  'DKP_SUMMARY' AS report_section,
  d.cname AS character_name,
  d.cid AS char_id,
  s.character_key,
  CASE WHEN s.character_key ~ '^[0-9]+$' THEN 'char_id_key' ELSE 'name_key' END AS key_type,
  s.earned,
  s.spent,
  (s.earned - s.spent) AS balance
FROM duplicate_char_ids d
JOIN dkp_summary s
  ON (s.character_key = d.cid OR (trim(s.character_key) = d.cname AND trim(COALESCE(s.character_name,'')) = d.cname))
ORDER BY d.cname, key_type, s.character_key;

-- =============================================================================
-- SECTION 3: raid_attendance_dkp rows for deduped characters — LINE BY LINE
-- Same raid_id appearing under both character_key = char_id and character_key = name = double-count.
-- =============================================================================
WITH char_id_rows AS (
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
    SELECT 1 FROM dkp_summary n
    WHERE trim(COALESCE(n.character_key,'')) = c.cname
      AND trim(COALESCE(n.character_key,'')) <> ''
      AND n.character_key !~ '^[0-9]+$'
  )
)
SELECT
  'RAID_ATTENDANCE_DKP' AS report_section,
  d.cname AS character_name,
  d.cid AS char_id,
  r.raid_id,
  r.character_key,
  CASE WHEN r.character_key ~ '^[0-9]+$' THEN 'char_id_key' ELSE 'name_key' END AS key_type,
  r.dkp_earned
FROM duplicate_char_ids d
JOIN raid_attendance_dkp r
  ON (r.character_key = d.cid OR (trim(r.character_key) = d.cname AND trim(COALESCE(r.character_name,'')) = d.cname))
ORDER BY d.cname, r.raid_id, key_type, r.character_key;

-- =============================================================================
-- SECTION 4: Raids that appear under BOTH keys for the same character (double-count source)
-- Each row = one raid that is counted twice for that character.
-- =============================================================================
WITH char_id_rows AS (
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
    SELECT 1 FROM dkp_summary n
    WHERE trim(COALESCE(n.character_key,'')) = c.cname
      AND trim(COALESCE(n.character_key,'')) <> ''
      AND n.character_key !~ '^[0-9]+$'
  )
),
by_char_raid AS (
  SELECT d.cname, d.cid, r.raid_id, r.character_key, r.dkp_earned
  FROM duplicate_char_ids d
  JOIN raid_attendance_dkp r
    ON (r.character_key = d.cid OR (trim(r.character_key) = d.cname AND trim(COALESCE(r.character_name,'')) = d.cname))
),
raid_under_both_keys AS (
  SELECT cname, cid, raid_id
  FROM by_char_raid
  GROUP BY cname, cid, raid_id
  HAVING COUNT(*) >= 2
)
SELECT
  'SAME_RAID_BOTH_KEYS' AS report_section,
  b.cname AS character_name,
  b.cid AS char_id,
  b.raid_id,
  b.character_key,
  b.dkp_earned
FROM raid_under_both_keys r
JOIN by_char_raid b ON b.cname = r.cname AND b.cid = r.cid AND b.raid_id = r.raid_id
ORDER BY b.cname, b.raid_id, b.character_key;

-- =============================================================================
-- SECTION 5: Per-character totals (raw sum vs deduped) for comparison
-- raw_sum = sum of both dkp_summary rows; deduped = correct single total.
-- =============================================================================
WITH char_id_rows AS (
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
    SELECT 1 FROM dkp_summary n
    WHERE trim(COALESCE(n.character_key,'')) = c.cname
      AND trim(COALESCE(n.character_key,'')) <> ''
      AND n.character_key !~ '^[0-9]+$'
  )
),
raw_rows AS (
  SELECT d.cid, d.cname, s.earned, s.spent
  FROM duplicate_char_ids d
  JOIN dkp_summary s
    ON (s.character_key = d.cid OR (trim(s.character_key) = d.cname AND trim(COALESCE(s.character_name,'')) = d.cname))
)
SELECT
  'TOTALS_COMPARISON' AS report_section,
  cname AS character_name,
  cid AS char_id,
  SUM(earned)::numeric AS raw_earned_sum,
  SUM(spent)::bigint AS raw_spent_sum,
  SUM(earned - spent)::numeric AS raw_balance_sum,
  COUNT(*) AS dkp_summary_row_count
FROM raw_rows
GROUP BY cid, cname
ORDER BY cname;
