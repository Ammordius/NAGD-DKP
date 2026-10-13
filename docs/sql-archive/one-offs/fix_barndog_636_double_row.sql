-- Account 22077721: compare raid_attendance_dkp sum vs dkp_summary.earned per toon.
-- Match app behavior: sum BOTH keys (char_id and name) for each character so from_dkp_summary = what the app shows after merge.
-- Run in Supabase SQL Editor.

-- 1) Per character on account 22077721: name, char_id, earned from raid_attendance_dkp, earned in dkp_summary (both keys summed), diff
WITH chars AS (
  SELECT c.char_id, c.name
  FROM character_account ca
  JOIN characters c ON c.char_id = ca.char_id
  WHERE ca.account_id = '22077721'
),
raid_earned AS (
  SELECT
    c.char_id,
    c.name,
    ROUND(COALESCE(SUM(d.dkp_earned::numeric), 0)::numeric, 2) AS earned_from_raids
  FROM chars c
  LEFT JOIN raid_attendance_dkp d
    ON d.character_key = c.char_id::text
    OR trim(COALESCE(d.character_name, '')) = trim(c.name)
  GROUP BY c.char_id, c.name
),
-- Sum dkp_summary.earned across BOTH keys (char_id and name), like the app does when merging rows
summary_earned AS (
  SELECT
    c.char_id,
    c.name,
    ROUND(COALESCE(SUM(s.earned), 0)::numeric, 2) AS earned_in_summary
  FROM chars c
  LEFT JOIN dkp_summary s
    ON s.character_key = c.char_id::text
    OR trim(s.character_key) = trim(c.name)
    OR trim(COALESCE(s.character_name, '')) = trim(c.name)
  GROUP BY c.char_id, c.name
)
SELECT
  re.name,
  re.char_id,
  re.earned_from_raids AS from_raid_attendance_dkp,
  se.earned_in_summary AS from_dkp_summary,
  ROUND((re.earned_from_raids - COALESCE(se.earned_in_summary, 0))::numeric, 2) AS diff
FROM raid_earned re
LEFT JOIN summary_earned se ON se.char_id = re.char_id AND se.name = re.name
ORDER BY re.name;

-- 2) One-time fix for Barndog (638 ground truth): uncomment to run
-- 22077721 = account_id (this account). Barndog char_id = 22077757 (character_key in dkp_summary).
-- UPDATE dkp_summary SET earned = 638 WHERE character_key = '22077757';
