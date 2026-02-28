-- =============================================================================
-- Per-raid account summary refresh: only update accounts affected by one raid.
-- Use when adding/removing a tic or attendee so we don't run a full refresh.
--
-- Run in Supabase SQL Editor. Requires account_dkp_summary and
-- refresh_account_dkp_summary_internal() (from supabase-account-dkp-schema.sql).
--
-- After this: the app calls refresh_account_dkp_summary_for_raid(raid_id) after
-- each tic/attendee change; only that raid's accounts are updated.
-- =============================================================================

-- (If your supabase-account-dkp-schema.sql already includes refresh_account_dkp_summary_for_raid, you don't need this file.)

CREATE OR REPLACE FUNCTION public.refresh_account_dkp_summary_for_raid(
  p_raid_id TEXT,
  p_extra_account_ids TEXT[] DEFAULT '{}'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_accounts TEXT[];
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_officer() THEN
    RAISE EXCEPTION 'Only officers can refresh account DKP summary for raid';
  END IF;

  WITH rea_accounts AS (
    SELECT DISTINCT COALESCE(rea.account_id, (
      SELECT ca.account_id FROM character_account ca
      WHERE (rea.char_id IS NOT NULL AND trim(rea.char_id::text) <> '' AND ca.char_id = trim(rea.char_id::text))
         OR (rea.character_name IS NOT NULL AND trim(rea.character_name) <> '' AND EXISTS (SELECT 1 FROM characters c WHERE c.char_id = ca.char_id AND trim(c.name) = trim(rea.character_name)))
      LIMIT 1
    )) AS account_id
    FROM raid_event_attendance rea
    WHERE rea.raid_id = p_raid_id
  ),
  combined AS (
    SELECT account_id FROM rea_accounts WHERE account_id IS NOT NULL
    UNION
    SELECT unnest(p_extra_account_ids) AS account_id WHERE cardinality(p_extra_account_ids) > 0
  )
  SELECT ARRAY_AGG(DISTINCT account_id) INTO target_accounts FROM combined WHERE trim(account_id) <> '';

  IF target_accounts IS NULL OR array_length(target_accounts, 1) IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO account_dkp_summary (account_id, display_name, earned, spent, earned_30d, earned_60d, last_activity_date, updated_at)
  WITH rea_one_account AS (
    SELECT rea.raid_id, rea.event_id,
      COALESCE(rea.account_id, (
        SELECT ca.account_id FROM character_account ca
        WHERE (rea.char_id IS NOT NULL AND trim(rea.char_id::text) <> '' AND ca.char_id = trim(rea.char_id::text))
           OR (rea.character_name IS NOT NULL AND trim(rea.character_name) <> '' AND EXISTS (SELECT 1 FROM characters c WHERE c.char_id = ca.char_id AND trim(c.name) = trim(rea.character_name)))
        LIMIT 1
      )) AS account_id
    FROM raid_event_attendance rea
    WHERE COALESCE(rea.account_id, (
      SELECT ca.account_id FROM character_account ca
      WHERE (rea.char_id IS NOT NULL AND trim(rea.char_id::text) <> '' AND ca.char_id = trim(rea.char_id::text))
         OR (rea.character_name IS NOT NULL AND trim(rea.character_name) <> '' AND EXISTS (SELECT 1 FROM characters c WHERE c.char_id = ca.char_id AND trim(c.name) = trim(rea.character_name)))
      LIMIT 1
    )) = ANY(target_accounts)
  )
  SELECT
    roa.account_id,
    MAX(a.display_name),
    SUM(COALESCE((re.dkp_value::numeric), 0)),
    0::numeric,
    (SUM(CASE WHEN raid_date_parsed(r.date_iso) >= (current_date - 30) THEN COALESCE((re.dkp_value::numeric), 0) ELSE 0 END))::INTEGER,
    (SUM(CASE WHEN raid_date_parsed(r.date_iso) >= (current_date - 60) THEN COALESCE((re.dkp_value::numeric), 0) ELSE 0 END))::INTEGER,
    MAX(raid_date_parsed(r.date_iso)),
    now()
  FROM rea_one_account roa
  LEFT JOIN raid_events re ON re.raid_id = roa.raid_id AND re.event_id = roa.event_id
  LEFT JOIN raids r ON r.raid_id = roa.raid_id
  LEFT JOIN accounts a ON a.account_id = roa.account_id
  WHERE roa.account_id IS NOT NULL
  GROUP BY roa.account_id
  ON CONFLICT (account_id) DO UPDATE SET
    earned = EXCLUDED.earned,
    earned_30d = EXCLUDED.earned_30d,
    earned_60d = EXCLUDED.earned_60d,
    last_activity_date = GREATEST(COALESCE(account_dkp_summary.last_activity_date, '1970-01-01'::date), COALESCE(EXCLUDED.last_activity_date, '1970-01-01'::date)),
    updated_at = now();

  INSERT INTO account_dkp_summary (account_id, display_name, spent, earned_30d, earned_60d, last_activity_date, updated_at)
  SELECT
    sub.account_id,
    MAX(sub.display_name),
    SUM(sub.cost_num),
    0,
    0,
    MAX(raid_date_parsed(r.date_iso)),
    now()
  FROM (
    SELECT DISTINCT ON (rl.id)
      ca.account_id,
      a.display_name,
      COALESCE((rl.cost::numeric), 0) AS cost_num,
      rl.raid_id
    FROM raid_loot rl
    LEFT JOIN raids r2 ON r2.raid_id = rl.raid_id
    LEFT JOIN LATERAL (SELECT la.assigned_char_id, la.assigned_character_name FROM loot_assignment la WHERE la.loot_id = rl.id LIMIT 1) la ON true
    LEFT JOIN character_account ca ON (
      (COALESCE(trim(la.assigned_char_id), trim(rl.char_id::text)) <> '' AND ca.char_id = COALESCE(trim(la.assigned_char_id), trim(rl.char_id::text)))
      OR (COALESCE(trim(la.assigned_character_name), trim(rl.character_name)) <> '' AND EXISTS (
        SELECT 1 FROM characters c WHERE c.char_id = ca.char_id AND trim(c.name) = COALESCE(trim(la.assigned_character_name), trim(rl.character_name))
      ))
    )
    LEFT JOIN accounts a ON a.account_id = ca.account_id
    WHERE ca.account_id IS NOT NULL AND ca.account_id = ANY(target_accounts)
  ) sub
  LEFT JOIN raids r ON r.raid_id = sub.raid_id
  GROUP BY sub.account_id
  ON CONFLICT (account_id) DO UPDATE SET
    spent = EXCLUDED.spent,
    last_activity_date = GREATEST(COALESCE(account_dkp_summary.last_activity_date, '1970-01-01'::date), COALESCE(EXCLUDED.last_activity_date, '1970-01-01'::date)),
    updated_at = now();
END;
$$;
COMMENT ON FUNCTION public.refresh_account_dkp_summary_for_raid(TEXT, TEXT[]) IS 'Update account_dkp_summary only for accounts with attendance in this raid (plus p_extra_account_ids). Use after add/remove tic or attendee.';

GRANT EXECUTE ON FUNCTION public.refresh_account_dkp_summary_for_raid(TEXT, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_account_dkp_summary_for_raid(TEXT, TEXT[]) TO service_role;
