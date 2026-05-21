-- Officer-only raider activity snapshot for /officer/raider-activity.
-- Run in Supabase SQL Editor after supabase-schema-full.sql (requires is_officer, raid tables, account DKP).
-- Returns JSON: raids, roster_account_ids, accounts, attendance (raid_id + account_id pairs).

CREATE OR REPLACE FUNCTION public.officer_raider_activity(
  p_lookback_days integer DEFAULT 120,
  p_absent_raid_count integer DEFAULT 5
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lookback int := GREATEST(COALESCE(p_lookback_days, 120), 90);
  v_cutoff date := (CURRENT_DATE - v_lookback);
  v_result jsonb;
BEGIN
  IF NOT public.is_officer() THEN
    RAISE EXCEPTION 'Only officers can view raider activity';
  END IF;

  IF v_lookback < 1 OR v_lookback > 730 THEN
    RAISE EXCEPTION 'p_lookback_days must be between 1 and 730';
  END IF;

  SET LOCAL statement_timeout = '120s';

  WITH raids_in_range AS (
    SELECT
      r.raid_id,
      public.raid_date_parsed(r.date_iso) AS raid_date,
      r.date_iso
    FROM raids r
    WHERE public.raid_date_parsed(r.date_iso) >= v_cutoff
      AND public.raid_date_parsed(r.date_iso) <= CURRENT_DATE
  ),
  raids_with_event_att AS (
    SELECT DISTINCT rea.raid_id
    FROM raid_event_attendance rea
    JOIN raids_in_range rir ON rir.raid_id = rea.raid_id
  ),
  event_attendance_resolved AS (
    SELECT DISTINCT
      rea.raid_id,
      COALESCE(
        NULLIF(trim(rea.account_id::text), ''),
        ca_by_char.account_id,
        ca_by_name.account_id
      ) AS account_id
    FROM raid_event_attendance rea
    JOIN raids_with_event_att rwe ON rwe.raid_id = rea.raid_id
    JOIN raid_events re
      ON re.raid_id = rea.raid_id
     AND re.event_id = rea.event_id
    LEFT JOIN character_account ca_by_char
      ON rea.char_id IS NOT NULL
     AND trim(rea.char_id::text) <> ''
     AND ca_by_char.char_id = trim(rea.char_id::text)
    LEFT JOIN characters c_match
      ON rea.character_name IS NOT NULL
     AND trim(rea.character_name) <> ''
     AND trim(c_match.name) = trim(rea.character_name)
    LEFT JOIN character_account ca_by_name
      ON ca_by_name.char_id = c_match.char_id
    WHERE COALESCE(
      NULLIF(trim(rea.account_id::text), ''),
      ca_by_char.account_id,
      ca_by_name.account_id
    ) IS NOT NULL
  ),
  raid_level_attendance_resolved AS (
    SELECT DISTINCT
      ra.raid_id,
      COALESCE(
        ca_by_char.account_id,
        ca_by_name.account_id
      ) AS account_id
    FROM raid_attendance ra
    JOIN raids_in_range rir ON rir.raid_id = ra.raid_id
    LEFT JOIN raids_with_event_att rwe ON rwe.raid_id = ra.raid_id
    LEFT JOIN character_account ca_by_char
      ON ra.char_id IS NOT NULL
     AND trim(ra.char_id::text) <> ''
     AND ca_by_char.char_id = trim(ra.char_id::text)
    LEFT JOIN characters c_match
      ON ra.character_name IS NOT NULL
     AND trim(ra.character_name) <> ''
     AND trim(c_match.name) = trim(ra.character_name)
    LEFT JOIN character_account ca_by_name
      ON ca_by_name.char_id = c_match.char_id
    WHERE rwe.raid_id IS NULL
      AND COALESCE(ca_by_char.account_id, ca_by_name.account_id) IS NOT NULL
  ),
  attendance_union AS (
    SELECT raid_id, account_id FROM event_attendance_resolved
    UNION
    SELECT raid_id, account_id FROM raid_level_attendance_resolved
  ),
  attendee_counts AS (
    SELECT raid_id, COUNT(DISTINCT account_id)::int AS attendee_count
    FROM attendance_union
    GROUP BY raid_id
  ),
  raids_json AS (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'raid_id', rir.raid_id,
          'date_iso', rir.date_iso,
          'raid_date', to_char(rir.raid_date, 'YYYY-MM-DD'),
          'attendee_count', COALESCE(ec.attendee_count, 0)
        )
        ORDER BY rir.raid_date ASC, rir.raid_id ASC
      ),
      '[]'::jsonb
    ) AS j
    FROM raids_in_range rir
    LEFT JOIN attendee_counts ec ON ec.raid_id = rir.raid_id
  ),
  active_by_date AS (
    SELECT DISTINCT s.account_id
    FROM account_dkp_summary s
    JOIN accounts a ON a.account_id = s.account_id
    WHERE NOT COALESCE(a.inactive, false)
      AND s.last_activity_date IS NOT NULL
      AND s.last_activity_date >= (CURRENT_DATE - v_lookback)
  ),
  pinned AS (
    SELECT DISTINCT aa.account_id
    FROM active_accounts aa
    JOIN accounts a ON a.account_id = aa.account_id
    WHERE NOT COALESCE(a.inactive, false)
  ),
  roster AS (
    SELECT account_id FROM active_by_date
    UNION
    SELECT account_id FROM pinned
  ),
  accounts_with_att AS (
    SELECT DISTINCT au.account_id
    FROM attendance_union au
  ),
  all_account_ids AS (
    SELECT account_id FROM roster
    UNION
    SELECT account_id FROM accounts_with_att
  ),
  accounts_json AS (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'account_id', a.account_id,
          'display_name', COALESCE(NULLIF(trim(a.display_name), ''), ''),
          'toon_names', COALESCE(NULLIF(trim(a.toon_names), ''), ''),
          'inactive', COALESCE(a.inactive, false)
        )
        ORDER BY lower(COALESCE(NULLIF(trim(a.display_name), ''), a.account_id))
      ),
      '[]'::jsonb
    ) AS j
    FROM accounts a
    JOIN all_account_ids ids ON ids.account_id = a.account_id
  ),
  roster_json AS (
    SELECT COALESCE(jsonb_agg(account_id ORDER BY account_id), '[]'::jsonb) AS j
    FROM roster
  ),
  attendance_json AS (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object('raid_id', au.raid_id, 'account_id', au.account_id)
        ORDER BY au.raid_id, au.account_id
      ),
      '[]'::jsonb
    ) AS j
    FROM attendance_union au
  )
  SELECT jsonb_build_object(
    'generated_at', to_jsonb(now() AT TIME ZONE 'utc'),
    'lookback_days', to_jsonb(v_lookback),
    'absent_raid_count', to_jsonb(GREATEST(COALESCE(p_absent_raid_count, 5), 1)),
    'raids', (SELECT j FROM raids_json),
    'roster_account_ids', (SELECT j FROM roster_json),
    'accounts', (SELECT j FROM accounts_json),
    'attendance', (SELECT j FROM attendance_json)
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.officer_raider_activity(integer, integer) IS
  'Officer-only: raid attendance snapshot by account for Raider Activity page.';

GRANT EXECUTE ON FUNCTION public.officer_raider_activity(integer, integer) TO authenticated;
