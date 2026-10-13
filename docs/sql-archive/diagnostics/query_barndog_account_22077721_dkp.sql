-- Verify Barndog DKP: manual raid total (expect 638), adjustment (2), and account 22077721 total (51).
-- Run in Supabase SQL Editor.
--
-- If you removed the adjustment and the UI still shows 636 earned / 47 balance (not 638 / 49):
-- Barndog likely has TWO rows in dkp_summary (e.g. character_key = char_id and character_key = 'Barndog').
-- The app dedupes by canonical name and SUMS earned/spent. If one row has earned = -2, you get 638 + (-2) = 636.
-- Run query 4 to see both rows; run 4b to see which raid(s) contributed the -2 in raid_attendance_dkp.

-- 1) Barndog: earned from raids — manual total (expect 638)
-- Match by name 'Barndog' or by his char_id. If he appears under both keys you’d double-count; then check dkp_summary for duplicate keys.
SELECT
  'Barndog earned from raids (manual total)' AS check_type,
  COUNT(*) AS raid_rows,
  ROUND(SUM(dkp_earned::numeric), 2) AS total_earned
FROM raid_attendance_dkp d
WHERE trim(d.character_key) = 'Barndog'
   OR trim(COALESCE(d.character_name, '')) = 'Barndog'
   OR d.character_key IN (SELECT char_id::text FROM characters WHERE trim(name) = 'Barndog');

-- 2) Barndog: spent from raid_loot (cost attributed to him)
SELECT
  'Barndog spent from raid_loot' AS check_type,
  COUNT(*) AS loot_rows,
  SUM(COALESCE(cost::integer, 0)) AS total_spent
FROM raid_loot
WHERE trim(COALESCE(character_name, '')) = 'Barndog'
   OR trim(COALESCE(char_id::text, '')) = 'Barndog'
   OR char_id IN (SELECT char_id FROM characters WHERE trim(name) = 'Barndog');

-- 3) dkp_adjustments for Barndog (expect earned_delta 2 or similar)
SELECT
  'Barndog dkp_adjustments' AS check_type,
  character_name,
  earned_delta,
  spent_delta,
  (earned_delta - spent_delta) AS balance_delta
FROM dkp_adjustments
WHERE trim(character_name) = 'Barndog';

-- 4) dkp_summary row(s) for Barndog (may be 2 rows: char_id key and name key)
-- If two rows and one has earned = -2 (or small negative), the app merges and sums them → 638 + (-2) = 636. That’s the “2 short” in the UI.
SELECT
  'Barndog dkp_summary' AS check_type,
  character_key,
  character_name,
  earned,
  spent,
  (earned - spent) AS balance
FROM dkp_summary
WHERE trim(character_key) = 'Barndog'
   OR trim(COALESCE(character_name, '')) = 'Barndog'
   OR character_key IN (SELECT char_id::text FROM characters WHERE trim(name) = 'Barndog');

-- 4b) Where does the -2 come from? raid_attendance_dkp rows for Barndog (by key and by char_id)
SELECT
  'Barndog raid_attendance_dkp per row' AS check_type,
  raid_id,
  character_key,
  character_name,
  dkp_earned
FROM raid_attendance_dkp
WHERE trim(character_key) = 'Barndog'
   OR trim(COALESCE(character_name, '')) = 'Barndog'
   OR character_key IN (SELECT char_id::text FROM characters WHERE trim(name) = 'Barndog')
ORDER BY raid_id;

-- 5) Account 22077721: all toons and their contribution to DKP total
-- (dkp_summary is per character_key; we sum by account after dedupe + adjustment in app)
WITH chars_on_account AS (
  SELECT c.char_id, c.name
  FROM character_account ca
  JOIN characters c ON c.char_id = ca.char_id
  WHERE ca.account_id = '22077721'
),
summary_with_adj AS (
  SELECT
    s.character_key,
    s.character_name,
    s.earned,
    s.spent,
    COALESCE(a.earned_delta, 0) AS earned_delta,
    COALESCE(a.spent_delta, 0) AS spent_delta,
    (s.earned + COALESCE(a.earned_delta, 0)) AS earned_adj,
    (s.spent + COALESCE(a.spent_delta, 0)) AS spent_adj
  FROM dkp_summary s
  LEFT JOIN dkp_adjustments a ON trim(a.character_name) = trim(s.character_name)
       OR trim(a.character_name) = trim(replace(s.character_name, '(*) ', ''))
  WHERE s.character_key IN (SELECT char_id::text FROM chars_on_account)
     OR trim(s.character_name) IN (SELECT trim(name) FROM chars_on_account)
)
SELECT
  'Account 22077721 per-summary row (before dedupe)' AS check_type,
  character_key,
  character_name,
  earned,
  spent,
  earned_delta,
  spent_delta,
  earned_adj,
  spent_adj,
  (earned_adj - spent_adj) AS balance_adj
FROM summary_with_adj
ORDER BY character_name;

-- 6) Account 22077721: single summed total (how the app computes: one row per character after dedupe, then + adjustment, then sum)
WITH chars_on_account AS (
  SELECT c.char_id, c.name
  FROM character_account ca
  JOIN characters c ON c.char_id = ca.char_id
  WHERE ca.account_id = '22077721'
),
raw_rows AS (
  SELECT s.character_key, s.character_name, s.earned, s.spent
  FROM dkp_summary s
  WHERE s.character_key IN (SELECT char_id::text FROM chars_on_account)
     OR trim(s.character_name) IN (SELECT trim(name) FROM chars_on_account)
     OR trim(replace(trim(COALESCE(s.character_name, '')), '(*) ', '')) IN (SELECT trim(name) FROM chars_on_account)
),
canon_key AS (
  SELECT
    character_key,
    character_name,
    earned,
    spent,
    lower(trim(replace(replace(trim(COALESCE(character_name, character_key)), '(*)', ''), '  ', ' '))) AS canon
  FROM raw_rows
),
deduped AS (
  SELECT canon, character_name, sum(earned) AS earned, sum(spent) AS spent
  FROM canon_key
  GROUP BY canon, character_name
),
with_adj AS (
  SELECT
    d.earned + COALESCE(a.earned_delta, 0) AS earned_adj,
    d.spent + COALESCE(a.spent_delta, 0) AS spent_adj
  FROM deduped d
  LEFT JOIN dkp_adjustments a ON trim(a.character_name) = trim(d.character_name)
    OR trim(a.character_name) = trim(replace(replace(trim(COALESCE(d.character_name, '')), '(*)', ''), '  ', ' '))
)
SELECT
  'Account 22077721 total (deduped + adjustment)' AS check_type,
  ROUND(SUM(earned_adj), 2) AS total_earned,
  ROUND(SUM(spent_adj), 2) AS total_spent,
  ROUND(SUM(earned_adj - spent_adj), 2) AS account_balance
FROM with_adj;
