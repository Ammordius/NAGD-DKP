-- =============================================================================
-- Diagnose: Frinop shows 2/39 (5%) and 2/72 (3%) despite being on two recent raids
-- (Water Minis + Coirnav 2026-02-24, PoTime Day 2 2026-02-20).
-- Run in Supabase SQL Editor. This finds why earned_30d / earned_60d are only 2.
-- =============================================================================

-- 1) dkp_summary rows for Frinop (both keys: char_id and name)
--    If two rows exist, the app merges them; check earned_30d and earned_60d per row.
SELECT '1_dkp_summary' AS step,
  character_key,
  character_name,
  earned,
  spent,
  earned_30d,
  earned_60d,
  last_activity_date,
  updated_at
FROM dkp_summary
WHERE character_name ILIKE '%Frinop%'
   OR character_key = '21990375'
   OR character_key ILIKE '%Frinop%'
ORDER BY character_key;

-- 2) Recent raids: Water Minis + Coirnav, PoTime Day 2 (around 2026-02-20 and 2026-02-24)
--    Check raid_id and date_iso (must be within 30d/60d for earned_30d/earned_60d).
SELECT '2_recent_raids' AS step,
  raid_id,
  raid_name,
  date_iso,
  raid_date_parsed(date_iso) AS raid_date,
  (raid_date_parsed(date_iso) >= (current_date - 30)) AS in_30d,
  (raid_date_parsed(date_iso) >= (current_date - 60)) AS in_60d
FROM raids
WHERE (raid_name ILIKE '%Water Minis%' OR raid_name ILIKE '%Coirnav%' OR raid_name ILIKE '%PoTime%')
  AND raid_date_parsed(date_iso) >= (current_date - 90)
ORDER BY raid_date_parsed(date_iso) DESC NULLS LAST
LIMIT 20;

-- 3) raid_event_attendance for Frinop (char_id 21990375 OR character_name Frinop)
--    for raids in the last 60 days. If empty for the two recent raids, that's the cause.
SELECT '3_rea_recent' AS step,
  rea.raid_id,
  r.raid_name,
  r.date_iso,
  rea.event_id,
  rea.char_id,
  rea.character_name,
  re.dkp_value
FROM raid_event_attendance rea
JOIN raids r ON r.raid_id = rea.raid_id
LEFT JOIN raid_events re ON re.raid_id = rea.raid_id AND re.event_id = rea.event_id
WHERE raid_date_parsed(r.date_iso) >= (current_date - 60)
  AND (
    rea.char_id = '21990375'
    OR trim(COALESCE(rea.character_name, '')) = 'Frinop'
  )
ORDER BY raid_date_parsed(r.date_iso) DESC, rea.raid_id, rea.event_id;

-- 4) raid_attendance_dkp for Frinop (character_key 21990375 or 'Frinop') in last 60 days
--    Shows what DKP the refresh uses per raid.
SELECT '4_rad_recent' AS step,
  rad.raid_id,
  r.raid_name,
  r.date_iso,
  rad.character_key,
  rad.dkp_earned,
  (raid_date_parsed(r.date_iso) >= (current_date - 30)) AS in_30d
FROM raid_attendance_dkp rad
JOIN raids r ON r.raid_id = rad.raid_id
WHERE raid_date_parsed(r.date_iso) >= (current_date - 60)
  AND (rad.character_key = '21990375' OR trim(rad.character_key) = 'Frinop')
ORDER BY raid_date_parsed(r.date_iso) DESC, rad.raid_id;

-- 5) Sum of DKP in last 30d/60d from raid_attendance_dkp for Frinop (both keys)
--    This should match what refresh_dkp_summary_internal computes from raid_event_attendance.
SELECT '5_expected_30d_60d' AS step,
  character_key,
  SUM(CASE WHEN raid_date_parsed(r.date_iso) >= (current_date - 30) THEN rad.dkp_earned ELSE 0 END) AS expected_30d,
  SUM(CASE WHEN raid_date_parsed(r.date_iso) >= (current_date - 60) THEN rad.dkp_earned ELSE 0 END) AS expected_60d
FROM raid_attendance_dkp rad
JOIN raids r ON r.raid_id = rad.raid_id
WHERE rad.character_key = '21990375' OR trim(rad.character_key) = 'Frinop'
GROUP BY rad.character_key;

-- 6) If refresh uses raid_event_attendance (not raid_attendance_dkp) for earned_30d/60d,
--    show per-event DKP that would be counted for Frinop in last 60d (same logic as refresh).
SELECT '6_rea_sum_30d_60d' AS step,
  (CASE WHEN COALESCE(trim(rea.char_id::text), '') = '' THEN COALESCE(trim(rea.character_name), 'unknown') ELSE trim(rea.char_id::text) END) AS character_key,
  SUM(CASE WHEN raid_date_parsed(r.date_iso) >= (current_date - 30) THEN COALESCE((re.dkp_value::numeric), 0) ELSE 0 END)::INTEGER AS sum_30d,
  SUM(CASE WHEN raid_date_parsed(r.date_iso) >= (current_date - 60) THEN COALESCE((re.dkp_value::numeric), 0) ELSE 0 END)::INTEGER AS sum_60d
FROM raid_event_attendance rea
LEFT JOIN raid_events re ON re.raid_id = rea.raid_id AND re.event_id = rea.event_id
LEFT JOIN raids r ON r.raid_id = rea.raid_id
WHERE (rea.char_id = '21990375' OR trim(COALESCE(rea.character_name, '')) = 'Frinop')
GROUP BY (CASE WHEN COALESCE(trim(rea.char_id::text), '') = '' THEN COALESCE(trim(rea.character_name), 'unknown') ELSE trim(rea.char_id::text) END);
