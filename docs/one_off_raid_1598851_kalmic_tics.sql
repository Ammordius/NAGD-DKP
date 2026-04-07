-- One-off: raid 1598851 — three tics — diagnose linkage, optional account_id backfill, refresh DKP.
-- Run in Supabase SQL Editor (officer session or service role). Review SELECTs before any UPDATE.

-- Confirmed identifiers
-- raid_id: 1598851
-- event_id: 2499752, 2499753, 2499754
-- Kalmic account (example): 417657a8-ee2b-4dbe-a922-001492410c2

-- 1) Full diagnostic: resolved account per attendance row
-- Uses LATERAL instead of a scalar subquery (avoids parser issues with LIMIT + AS in some clients).
SELECT
  rea.raid_id,
  rea.event_id,
  rea.char_id,
  rea.character_name,
  rea.account_id AS stored_account_id,
  rsv.account_id AS resolved_account_id
FROM public.raid_event_attendance rea
LEFT JOIN LATERAL (
  SELECT ca.account_id
  FROM public.character_account ca
  WHERE (
      rea.char_id IS NOT NULL
      AND btrim(rea.char_id::text) <> ''
      AND ca.char_id = btrim(rea.char_id::text)
    )
    OR (
      rea.character_name IS NOT NULL
      AND btrim(rea.character_name::text) <> ''
      AND EXISTS (
        SELECT 1
        FROM public.characters c
        WHERE c.char_id = ca.char_id
          AND btrim(c.name) = btrim(rea.character_name)
      )
    )
  LIMIT 1
) rsv ON TRUE
WHERE rea.raid_id = '1598851'
  AND rea.event_id IN ('2499752', '2499753', '2499754')
ORDER BY rea.event_id, rea.character_name;

-- Kalmic-only
SELECT
  rea.event_id,
  rea.char_id,
  rea.character_name,
  rea.account_id AS stored_account_id,
  rsv.account_id AS resolved_account_id
FROM public.raid_event_attendance rea
LEFT JOIN LATERAL (
  SELECT ca.account_id
  FROM public.character_account ca
  WHERE (
      btrim(rea.char_id::text) <> ''
      AND ca.char_id = btrim(rea.char_id::text)
    )
    OR (
      btrim(rea.character_name::text) <> ''
      AND EXISTS (
        SELECT 1
        FROM public.characters c
        WHERE c.char_id = ca.char_id
          AND btrim(c.name) = btrim(rea.character_name)
      )
    )
  LIMIT 1
) rsv ON TRUE
WHERE rea.raid_id = '1598851'
  AND rea.event_id IN ('2499752', '2499753', '2499754')
  AND btrim(rea.character_name) ILIKE 'kalmic';

-- 2) Optional: backfill account_id (preview with SELECT first; only if diagnosis requires it)
-- UPDATE raid_event_attendance rea
-- SET account_id = ca.account_id
-- FROM character_account ca
-- INNER JOIN characters c ON c.char_id = ca.char_id
-- WHERE rea.raid_id = '1598851'
--   AND rea.event_id IN ('2499752', '2499753', '2499754')
--   AND trim(c.name) = trim(rea.character_name)
--   AND ca.account_id = '417657a8-ee2b-4dbe-a922-001492410c2'
--   AND ca.char_id = trim(rea.char_id);

-- 3) Refresh materializations after any change to raid_event_attendance
SELECT public.refresh_dkp_summary();
SELECT public.refresh_account_dkp_summary_for_raid(
  '1598851',
  ARRAY['417657a8-ee2b-4dbe-a922-001492410c2']::text[]
);
