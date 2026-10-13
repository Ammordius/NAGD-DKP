-- Audit: account 22077606 (sverder) — raids he should NOT have attended (no tic presence).
-- Run in Supabase SQL Editor. READ-ONLY; no changes.
--
-- If your editor only returns the LAST query result: run section "6c" (and optionally "6" or "6b") by itself
-- to see which character got credited and WHY (tic vs raid-level). Section "7" is summary only.
--
-- Suspect raids (user says sverder was not on these / not on tics):
--   SSra-Again! 2024-01-31
--   12/7/18 PRAES/SERU 2018-12-07
--   12/4/18 A SUMMONED BURROWER 2018-12-04
--   1Dec - AC Burrower + Emp Ssra 2018-12-02
--   XTC & HIGH PRIEST 2018-11-25
--   RHAGS 1,2, ARCH LICH & CURSED CYCLE 2018-11-23
--   11/19/18 RHAGS & ARCH LICH 2018-11-19
--   15Nov - AL and Cursed 2018-11-16
--   11Nov - KT, Statue, AOW 2018-11-12

-- 1) Account 22077606 and its characters
SELECT
  '1_account_and_chars' AS section,
  a.account_id,
  a.display_name,
  a.toon_names,
  a.char_ids,
  c.char_id,
  c.name AS character_name
FROM accounts a
LEFT JOIN character_account ca ON ca.account_id = a.account_id
LEFT JOIN characters c ON c.char_id = ca.char_id
WHERE a.account_id = '22077606';

-- 2) Raids on the suspect dates: raid_id, name, date, and whether raid has per-event (tic) attendance
WITH suspect_dates AS (
  SELECT d::date AS raid_date
  FROM unnest(ARRAY[
    '2024-01-31'::date,
    '2018-12-07'::date,
    '2018-12-04'::date,
    '2018-12-02'::date,
    '2018-11-25'::date,
    '2018-11-23'::date,
    '2018-11-19'::date,
    '2018-11-16'::date,
    '2018-11-12'::date
  ]) AS d
),
raids_on_dates AS (
  SELECT r.raid_id, r.raid_name, r.date_iso, raid_date_parsed(r.date_iso) AS raid_date,
         EXISTS (SELECT 1 FROM raid_event_attendance rea WHERE rea.raid_id = r.raid_id LIMIT 1) AS has_tic_attendance
  FROM raids r
  WHERE raid_date_parsed(r.date_iso) IN (SELECT raid_date FROM suspect_dates)
)
SELECT
  '2_raids_on_suspect_dates' AS section,
  raid_id,
  raid_name,
  date_iso,
  raid_date,
  has_tic_attendance
FROM raids_on_dates
ORDER BY raid_date, raid_id;

-- 3) For each suspect-date raid: does account 22077606 appear in raid_attendance, raid_event_attendance, or raid_attendance_dkp?
WITH acct_chars AS (
  SELECT c.char_id, trim(c.name) AS char_name
  FROM character_account ca
  JOIN characters c ON c.char_id = ca.char_id
  WHERE ca.account_id = '22077606'
),
suspect_dates AS (
  SELECT d::date AS raid_date
  FROM unnest(ARRAY[
    '2024-01-31'::date, '2018-12-07'::date, '2018-12-04'::date, '2018-12-02'::date,
    '2018-11-25'::date, '2018-11-23'::date, '2018-11-19'::date, '2018-11-16'::date, '2018-11-12'::date
  ]) AS d
),
raids_on_dates AS (
  SELECT r.raid_id, r.raid_name, raid_date_parsed(r.date_iso) AS raid_date
  FROM raids r
  WHERE raid_date_parsed(r.date_iso) IN (SELECT raid_date FROM suspect_dates)
),
-- In raid_attendance (legacy raid-level)?
in_raid_att AS (
  SELECT ra.raid_id, 1 AS in_raid_att
  FROM raid_attendance ra
  WHERE ra.raid_id IN (SELECT raid_id FROM raids_on_dates)
    AND (
      ra.char_id IN (SELECT char_id FROM acct_chars)
      OR trim(COALESCE(ra.character_name, '')) IN (SELECT char_name FROM acct_chars)
    )
),
-- In raid_event_attendance (on any tic)?
in_tic_att AS (
  SELECT rea.raid_id, COUNT(*) AS tic_rows
  FROM raid_event_attendance rea
  WHERE rea.raid_id IN (SELECT raid_id FROM raids_on_dates)
    AND (
      rea.char_id IN (SELECT char_id FROM acct_chars)
      OR trim(COALESCE(rea.character_name, '')) IN (SELECT char_name FROM acct_chars)
    )
  GROUP BY rea.raid_id
),
-- In raid_attendance_dkp (has DKP earned for this raid)?
in_dkp AS (
  SELECT rad.raid_id, rad.character_key, rad.character_name, rad.dkp_earned
  FROM raid_attendance_dkp rad
  WHERE rad.raid_id IN (SELECT raid_id FROM raids_on_dates)
    AND (
      rad.character_key IN (SELECT char_id::text FROM acct_chars) OR rad.character_key IN (SELECT char_name FROM acct_chars)
      OR trim(COALESCE(rad.character_name, '')) IN (SELECT char_name FROM acct_chars)
    )
)
SELECT
  '3_audit_per_raid' AS section,
  r.raid_id,
  r.raid_name,
  r.raid_date,
  COALESCE(ira.in_raid_att, 0) AS in_raid_attendance,
  COALESCE(ita.tic_rows, 0) AS tic_attendance_rows,
  COALESCE(SUM(d.dkp_earned), 0)::numeric AS dkp_earned_for_raid
FROM raids_on_dates r
LEFT JOIN in_raid_att ira ON ira.raid_id = r.raid_id
LEFT JOIN in_tic_att ita ON ita.raid_id = r.raid_id
LEFT JOIN in_dkp d ON d.raid_id = r.raid_id
GROUP BY r.raid_id, r.raid_name, r.raid_date, ira.in_raid_att, ita.tic_rows
ORDER BY r.raid_date, r.raid_id;

-- 4) Detail: raid_event_attendance rows for account 22077606 on suspect-date raids (should be empty if user is correct)
WITH acct_chars AS (
  SELECT c.char_id, trim(c.name) AS char_name
  FROM character_account ca
  JOIN characters c ON c.char_id = ca.char_id
  WHERE ca.account_id = '22077606'
),
suspect_dates AS (
  SELECT d::date FROM unnest(ARRAY[
    '2024-01-31'::date, '2018-12-07'::date, '2018-12-04'::date, '2018-12-02'::date,
    '2018-11-25'::date, '2018-11-23'::date, '2018-11-19'::date, '2018-11-16'::date, '2018-11-12'::date
  ]) AS d
)
SELECT
  '4_tic_rows_for_sverder' AS section,
  rea.raid_id,
  r.raid_name,
  raid_date_parsed(r.date_iso) AS raid_date,
  rea.event_id,
  re.event_name,
  rea.char_id,
  rea.character_name,
  re.dkp_value
FROM raid_event_attendance rea
JOIN raids r ON r.raid_id = rea.raid_id
LEFT JOIN raid_events re ON re.raid_id = rea.raid_id AND re.event_id = rea.event_id
WHERE raid_date_parsed(r.date_iso) IN (SELECT * FROM suspect_dates)
  AND (
    rea.char_id IN (SELECT char_id FROM acct_chars)
    OR trim(COALESCE(rea.character_name, '')) IN (SELECT char_name FROM acct_chars)
  )
ORDER BY raid_date_parsed(r.date_iso), rea.raid_id, rea.event_id;

-- 5) Detail: raid_attendance rows for account 22077606 on suspect-date raids
WITH acct_chars AS (
  SELECT c.char_id, trim(c.name) AS char_name
  FROM character_account ca
  JOIN characters c ON c.char_id = ca.char_id
  WHERE ca.account_id = '22077606'
),
suspect_dates AS (
  SELECT d::date FROM unnest(ARRAY[
    '2024-01-31'::date, '2018-12-07'::date, '2018-12-04'::date, '2018-12-02'::date,
    '2018-11-25'::date, '2018-11-23'::date, '2018-11-19'::date, '2018-11-16'::date, '2018-11-12'::date
  ]) AS d
)
SELECT
  '5_raid_attendance_rows_for_sverder' AS section,
  ra.raid_id,
  r.raid_name,
  raid_date_parsed(r.date_iso) AS raid_date,
  ra.char_id,
  ra.character_name
FROM raid_attendance ra
JOIN raids r ON r.raid_id = ra.raid_id
WHERE raid_date_parsed(r.date_iso) IN (SELECT * FROM suspect_dates)
  AND (
    ra.char_id IN (SELECT char_id FROM acct_chars)
    OR trim(COALESCE(ra.character_name, '')) IN (SELECT char_name FROM acct_chars)
  )
ORDER BY raid_date_parsed(r.date_iso), ra.raid_id;

-- 6) raid_attendance_dkp rows for account 22077606 on suspect-date raids (shows which character_key/character_name got the credit; DKP that would be removed if we correct)
WITH acct_chars AS (
  SELECT c.char_id, trim(c.name) AS char_name
  FROM character_account ca
  JOIN characters c ON c.char_id = ca.char_id
  WHERE ca.account_id = '22077606'
),
suspect_dates AS (
  SELECT d::date FROM unnest(ARRAY[
    '2024-01-31'::date, '2018-12-07'::date, '2018-12-04'::date, '2018-12-02'::date,
    '2018-11-25'::date, '2018-11-23'::date, '2018-11-19'::date, '2018-11-16'::date, '2018-11-12'::date
  ]) AS d
)
SELECT
  '6_raid_attendance_dkp_for_sverder' AS section,
  rad.raid_id,
  r.raid_name,
  raid_date_parsed(r.date_iso) AS raid_date,
  rad.character_key,
  rad.character_name,
  rad.dkp_earned
FROM raid_attendance_dkp rad
JOIN raids r ON r.raid_id = rad.raid_id
WHERE raid_date_parsed(r.date_iso) IN (SELECT * FROM suspect_dates)
  AND (
    rad.character_key IN (SELECT char_id::text FROM acct_chars) OR rad.character_key IN (SELECT char_name FROM acct_chars)
    OR trim(COALESCE(rad.character_name, '')) IN (SELECT char_name FROM acct_chars)
  )
ORDER BY raid_date_parsed(r.date_iso), rad.raid_id;

-- 6b) Which character got credited per raid (one row per raid–character; answers "which toon got the DKP")
WITH acct_chars AS (
  SELECT c.char_id, trim(c.name) AS char_name
  FROM character_account ca
  JOIN characters c ON c.char_id = ca.char_id
  WHERE ca.account_id = '22077606'
),
suspect_dates AS (
  SELECT d::date FROM unnest(ARRAY[
    '2024-01-31'::date, '2018-12-07'::date, '2018-12-04'::date, '2018-12-02'::date,
    '2018-11-25'::date, '2018-11-23'::date, '2018-11-19'::date, '2018-11-16'::date, '2018-11-12'::date
  ]) AS d
)
SELECT
  '6b_which_character_credited_per_raid' AS section,
  rad.raid_id,
  r.raid_name,
  raid_date_parsed(r.date_iso) AS raid_date,
  rad.character_key   AS credited_as_key,
  rad.character_name AS credited_character_name,
  rad.dkp_earned
FROM raid_attendance_dkp rad
JOIN raids r ON r.raid_id = rad.raid_id
WHERE raid_date_parsed(r.date_iso) IN (SELECT * FROM suspect_dates)
  AND (
    rad.character_key IN (SELECT char_id::text FROM acct_chars) OR rad.character_key IN (SELECT char_name FROM acct_chars)
    OR trim(COALESCE(rad.character_name, '')) IN (SELECT char_name FROM acct_chars)
  )
ORDER BY raid_date_parsed(r.date_iso), rad.raid_id, rad.character_key;

-- 6c) WHY he got credited: for each raid where account has DKP, show source (tic vs raid-level)
WITH acct_chars AS (
  SELECT c.char_id, trim(c.name) AS char_name
  FROM character_account ca
  JOIN characters c ON c.char_id = ca.char_id
  WHERE ca.account_id = '22077606'
),
suspect_dates AS (
  SELECT d::date FROM unnest(ARRAY[
    '2024-01-31'::date, '2018-12-07'::date, '2018-12-04'::date, '2018-12-02'::date,
    '2018-11-25'::date, '2018-11-23'::date, '2018-11-19'::date, '2018-11-16'::date, '2018-11-12'::date
  ]) AS d
),
-- Raids where account has DKP (from raid_attendance_dkp)
credited AS (
  SELECT rad.raid_id, rad.character_key, rad.character_name, rad.dkp_earned
  FROM raid_attendance_dkp rad
  JOIN raids r ON r.raid_id = rad.raid_id
  WHERE raid_date_parsed(r.date_iso) IN (SELECT * FROM suspect_dates)
    AND (
      rad.character_key IN (SELECT char_id::text FROM acct_chars) OR rad.character_key IN (SELECT char_name FROM acct_chars)
      OR trim(COALESCE(rad.character_name, '')) IN (SELECT char_name FROM acct_chars)
    )
),
-- For each such raid: does this raid use tics? and is he on any tic?
raid_has_tics AS (
  SELECT raid_id, EXISTS (SELECT 1 FROM raid_event_attendance rea WHERE rea.raid_id = c.raid_id LIMIT 1) AS has_tic_attendance
  FROM (SELECT DISTINCT raid_id FROM credited) c
),
tic_count AS (
  SELECT rea.raid_id, COUNT(*) AS n
  FROM raid_event_attendance rea
  WHERE rea.raid_id IN (SELECT raid_id FROM credited)
    AND (
      rea.char_id IN (SELECT char_id FROM acct_chars)
      OR trim(COALESCE(rea.character_name, '')) IN (SELECT char_name FROM acct_chars)
    )
  GROUP BY rea.raid_id
),
in_raid_att AS (
  SELECT ra.raid_id, 1 AS on_raid_list
  FROM raid_attendance ra
  WHERE ra.raid_id IN (SELECT raid_id FROM credited)
    AND (
      ra.char_id IN (SELECT char_id FROM acct_chars)
      OR trim(COALESCE(ra.character_name, '')) IN (SELECT char_name FROM acct_chars)
    )
)
SELECT
  '6c_why_credited' AS section,
  r.raid_id,
  r.raid_name,
  raid_date_parsed(r.date_iso) AS raid_date,
  c.character_key AS credited_as_key,
  c.character_name AS credited_character_name,
  c.dkp_earned,
  COALESCE(t.n, 0)::int AS tic_rows_for_this_char,
  COALESCE(ira.on_raid_list, 0)::int AS on_raid_attendance_list,
  CASE
    WHEN COALESCE(rht.has_tic_attendance, false) AND COALESCE(t.n, 0) > 0 THEN 'raid_event_attendance (listed on tics)'
    WHEN COALESCE(rht.has_tic_attendance, false) AND COALESCE(t.n, 0) = 0 THEN 'raid_attendance_dkp present but NOT on tics (data inconsistency)'
    WHEN NOT COALESCE(rht.has_tic_attendance, false) AND COALESCE(ira.on_raid_list, 0) = 1 THEN 'raid_attendance (raid-level list, no tics for this raid)'
    ELSE 'unknown'
  END AS why_credited
FROM credited c
JOIN raids r ON r.raid_id = c.raid_id
LEFT JOIN raid_has_tics rht ON rht.raid_id = c.raid_id
LEFT JOIN tic_count t ON t.raid_id = c.raid_id
LEFT JOIN in_raid_att ira ON ira.raid_id = c.raid_id
ORDER BY raid_date_parsed(r.date_iso), c.raid_id;

-- 7) Summary: total DKP to remove if we strip account 22077606 from these raids (from section 6)
WITH acct_chars AS (
  SELECT c.char_id, trim(c.name) AS char_name
  FROM character_account ca
  JOIN characters c ON c.char_id = ca.char_id
  WHERE ca.account_id = '22077606'
),
suspect_dates AS (
  SELECT d::date FROM unnest(ARRAY[
    '2024-01-31'::date, '2018-12-07'::date, '2018-12-04'::date, '2018-12-02'::date,
    '2018-11-25'::date, '2018-11-23'::date, '2018-11-19'::date, '2018-11-16'::date, '2018-11-12'::date
  ]) AS d
)
SELECT
  '7_summary_dkp_to_remove' AS section,
  COUNT(DISTINCT rad.raid_id) AS raids_affected,
  ROUND(SUM(rad.dkp_earned::numeric), 2) AS total_dkp_to_remove
FROM raid_attendance_dkp rad
JOIN raids r ON r.raid_id = rad.raid_id
WHERE raid_date_parsed(r.date_iso) IN (SELECT * FROM suspect_dates)
  AND (
    rad.character_key IN (SELECT char_id::text FROM acct_chars) OR rad.character_key IN (SELECT char_name FROM acct_chars)
    OR trim(COALESCE(rad.character_name, '')) IN (SELECT char_name FROM acct_chars)
  );
