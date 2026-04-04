-- Diagnose "Vex Thal 2025-12-04 · Earned: 5 / 4 DKP" (earned > raid total = duplicate TIC count).
-- Run in Supabase SQL Editor.
-- After reviewing, run fix_duplicate_tic_attendance_and_prevent.sql (includes new step 1b2 for same-raid name-only cleanup), then re-run this to confirm.

-- 1) Find the raid_id for Vex Thal on 2025-12-04
SELECT r.raid_id, r.raid_name, r.date_iso,
       (SELECT total_dkp FROM raid_dkp_totals rdt WHERE rdt.raid_id = r.raid_id) AS total_dkp
FROM raids r
WHERE r.raid_name ILIKE '%Vex Thal%'
  AND (r.date_iso LIKE '2025-12-04%' OR r.date_iso = '2025-12-04');

-- 2) For that raid: raid_attendance_dkp rows where sum per raid would exceed total_dkp
--    (multiple rows per raid with same or different character_key = double count when account has both keys)
WITH raid AS (
  SELECT r.raid_id, r.raid_name, r.date_iso,
         (SELECT total_dkp FROM raid_dkp_totals rdt WHERE rdt.raid_id = r.raid_id) AS total_dkp
  FROM raids r
  WHERE r.raid_name ILIKE '%Vex Thal%'
    AND (r.date_iso LIKE '2025-12-04%' OR r.date_iso = '2025-12-04')
  LIMIT 1
),
per_raid_sum AS (
  SELECT rad.raid_id, SUM(rad.dkp_earned) AS earned_sum
  FROM raid_attendance_dkp rad
  JOIN raid ON raid.raid_id = rad.raid_id
  GROUP BY rad.raid_id
)
SELECT rad.raid_id, rad.character_key, rad.character_name, rad.dkp_earned,
       r.total_dkp,
       s.earned_sum AS sum_of_all_keys_for_raid
FROM raid_attendance_dkp rad
JOIN raid r ON r.raid_id = rad.raid_id
JOIN per_raid_sum s ON s.raid_id = rad.raid_id
ORDER BY rad.raid_id, rad.character_key;

-- 3) raid_event_attendance for this raid: look for duplicate (same raid/event, same person as char_id AND as name-only)
WITH raid AS (
  SELECT r.raid_id FROM raids r
  WHERE r.raid_name ILIKE '%Vex Thal%'
    AND (r.date_iso LIKE '2025-12-04%' OR r.date_iso = '2025-12-04')
  LIMIT 1
)
SELECT rea.id, rea.raid_id, rea.event_id, rea.char_id, rea.character_name,
       re.dkp_value
FROM raid_event_attendance rea
JOIN raid ON raid.raid_id = rea.raid_id
LEFT JOIN raid_events re ON re.raid_id = rea.raid_id AND re.event_id = rea.event_id
ORDER BY rea.event_id, rea.char_id NULLS LAST, rea.character_name;

-- 4) If one character appears under TWO keys (char_id and name), we get two rows in raid_attendance_dkp
--    and the UI sums them. Find (raid_id, character_key) pairs that might be same person:
--    character_key in (char_id, name) and characters.name = that name -> same person, two rows
SELECT rad.raid_id, rad.character_key, rad.character_name, rad.dkp_earned
FROM raid_attendance_dkp rad
WHERE rad.raid_id IN (SELECT raid_id FROM raids WHERE raid_name ILIKE '%Vex Thal%' AND (date_iso LIKE '2025-12-04%' OR date_iso = '2025-12-04'))
ORDER BY rad.raid_id, rad.character_key;
