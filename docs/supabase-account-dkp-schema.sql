-- =============================================================================
-- Account-scoped DKP schema: run AFTER supabase-schema.sql (and loot-assignment if used).
-- Adds account_dkp_summary, account_id on raid_event_attendance, raid_attendance_dkp_by_account,
-- account_id on dkp_adjustments, active_accounts. Keeps existing character-based tables during transition.
-- Requires: loot_assignment table must exist (run supabase-loot-assignment-table.sql first, or create empty loot_assignment).
-- =============================================================================

-- 1) account_dkp_summary: one row per account (replaces dkp_summary for leaderboard once migrated)
CREATE TABLE IF NOT EXISTS account_dkp_summary (
  account_id TEXT PRIMARY KEY REFERENCES accounts(account_id),
  display_name TEXT,
  earned NUMERIC NOT NULL DEFAULT 0,
  spent NUMERIC NOT NULL DEFAULT 0,
  earned_30d INTEGER NOT NULL DEFAULT 0,
  earned_60d INTEGER NOT NULL DEFAULT 0,
  last_activity_date DATE,
  updated_at TIMESTAMPTZ DEFAULT now()
);
COMMENT ON TABLE account_dkp_summary IS 'DKP totals per account. Refreshed from raid_event_attendance (earned) and raid_loot/loot_assignment (spent) via character_account.';

-- 2) raid_event_attendance: add account_id (nullable, backfilled from character_account)
ALTER TABLE raid_event_attendance ADD COLUMN IF NOT EXISTS account_id TEXT REFERENCES accounts(account_id);
COMMENT ON COLUMN raid_event_attendance.account_id IS 'Resolved from char_id/character_name via character_account; used for DKP by account.';
CREATE INDEX IF NOT EXISTS idx_raid_event_attendance_account ON raid_event_attendance(account_id) WHERE account_id IS NOT NULL;

-- 3) raid_attendance_dkp_by_account: per-raid DKP earned by account (for activity page)
CREATE TABLE IF NOT EXISTS raid_attendance_dkp_by_account (
  raid_id TEXT NOT NULL REFERENCES raids(raid_id),
  account_id TEXT NOT NULL REFERENCES accounts(account_id),
  dkp_earned NUMERIC NOT NULL DEFAULT 0,
  PRIMARY KEY (raid_id, account_id)
);
COMMENT ON TABLE raid_attendance_dkp_by_account IS 'Pre-computed DKP earned per account per raid. Filled by refresh_raid_attendance_totals.';
CREATE INDEX IF NOT EXISTS idx_raid_attendance_dkp_by_account_account ON raid_attendance_dkp_by_account(account_id);
CREATE INDEX IF NOT EXISTS idx_raid_attendance_dkp_by_account_raid ON raid_attendance_dkp_by_account(raid_id);

-- 4) dkp_adjustments: add account_id (nullable during migration; adjustments apply to account)
ALTER TABLE dkp_adjustments ADD COLUMN IF NOT EXISTS account_id TEXT REFERENCES accounts(account_id);
COMMENT ON COLUMN dkp_adjustments.account_id IS 'When set, adjustment applies to this account. Otherwise resolved from character_name for backward compat.';

-- 5) active_accounts: optional list of accounts always shown on leaderboard (exceptions). Leaderboard already shows any account with recent activity (e.g. 120d); this table is for "pin to list" only. Officers manage it.
CREATE TABLE IF NOT EXISTS active_accounts (
  account_id TEXT PRIMARY KEY REFERENCES accounts(account_id)
);
COMMENT ON TABLE active_accounts IS 'Optional: accounts always shown on DKP leaderboard (exceptions). Default view shows accounts with recent activity; this is for pin-to-list only.';

-- 6) refresh_account_dkp_summary_internal: compute account_dkp_summary from attendance + loot (resolve char -> account)
CREATE OR REPLACE FUNCTION public.refresh_account_dkp_summary_internal()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  use_per_event BOOLEAN;
BEGIN
  SELECT EXISTS (SELECT 1 FROM raid_event_attendance LIMIT 1) INTO use_per_event;

  TRUNCATE account_dkp_summary;

  -- Earned: one account per attendance row (use rea.account_id or first character_account match), then sum dkp by account
  INSERT INTO account_dkp_summary (account_id, display_name, earned, earned_30d, earned_60d, last_activity_date, updated_at)
  WITH rea_one_account AS (
    SELECT rea.raid_id, rea.event_id,
      COALESCE(rea.account_id, (
        SELECT ca.account_id FROM character_account ca
        WHERE (rea.char_id IS NOT NULL AND trim(rea.char_id::text) <> '' AND ca.char_id = trim(rea.char_id::text))
           OR (rea.character_name IS NOT NULL AND trim(rea.character_name) <> '' AND EXISTS (SELECT 1 FROM characters c WHERE c.char_id = ca.char_id AND trim(c.name) = trim(rea.character_name)))
        LIMIT 1
      )) AS account_id
    FROM raid_event_attendance rea
  )
  SELECT
    roa.account_id,
    MAX(a.display_name),
    SUM(COALESCE((re.dkp_value::numeric), 0)),
    (SUM(CASE WHEN raid_date_parsed(r.date_iso) >= (current_date - 30) THEN COALESCE((re.dkp_value::numeric), 0) ELSE 0 END))::INTEGER,
    (SUM(CASE WHEN raid_date_parsed(r.date_iso) >= (current_date - 60) THEN COALESCE((re.dkp_value::numeric), 0) ELSE 0 END))::INTEGER,
    MAX(raid_date_parsed(r.date_iso)),
    now()
  FROM rea_one_account roa
  LEFT JOIN raid_events re ON re.raid_id = roa.raid_id AND re.event_id = roa.event_id
  LEFT JOIN raids r ON r.raid_id = roa.raid_id
  LEFT JOIN accounts a ON a.account_id = roa.account_id
  WHERE roa.account_id IS NOT NULL
  GROUP BY roa.account_id;

  -- Spent: from raid_loot (and loot_assignment when present), resolve to account via character_account. from raid_loot (and loot_assignment when present), resolve to account via character_account.
  -- One account per loot row (DISTINCT ON rl.id); if character on multiple accounts, pick one.
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
    LEFT JOIN raids r ON r.raid_id = rl.raid_id
    LEFT JOIN LATERAL (SELECT la.assigned_char_id, la.assigned_character_name FROM loot_assignment la WHERE la.loot_id = rl.id LIMIT 1) la ON true
    LEFT JOIN character_account ca ON (
      (COALESCE(trim(la.assigned_char_id), trim(rl.char_id::text)) <> '' AND ca.char_id = COALESCE(trim(la.assigned_char_id), trim(rl.char_id::text)))
      OR (COALESCE(trim(la.assigned_character_name), trim(rl.character_name)) <> '' AND EXISTS (
        SELECT 1 FROM characters c WHERE c.char_id = ca.char_id AND trim(c.name) = COALESCE(trim(la.assigned_character_name), trim(rl.character_name))
      ))
    )
    LEFT JOIN accounts a ON a.account_id = ca.account_id
    WHERE ca.account_id IS NOT NULL
  ) sub
  LEFT JOIN raids r ON r.raid_id = sub.raid_id
  GROUP BY sub.account_id
  ON CONFLICT (account_id) DO UPDATE SET
    spent = account_dkp_summary.spent + EXCLUDED.spent,
    last_activity_date = GREATEST(COALESCE(account_dkp_summary.last_activity_date, '1970-01-01'::date), COALESCE(EXCLUDED.last_activity_date, '1970-01-01'::date)),
    updated_at = now();

  -- Period totals unchanged (still from raid_events)
  INSERT INTO dkp_period_totals (period, total_dkp)
  SELECT '30d', COALESCE(SUM((re.dkp_value::numeric)), 0) FROM raid_events re JOIN raids r ON r.raid_id = re.raid_id WHERE raid_date_parsed(r.date_iso) >= (current_date - 30)
  ON CONFLICT (period) DO UPDATE SET total_dkp = EXCLUDED.total_dkp;
  INSERT INTO dkp_period_totals (period, total_dkp)
  SELECT '60d', COALESCE(SUM((re.dkp_value::numeric)), 0) FROM raid_events re JOIN raids r ON r.raid_id = re.raid_id WHERE raid_date_parsed(r.date_iso) >= (current_date - 60)
  ON CONFLICT (period) DO UPDATE SET total_dkp = EXCLUDED.total_dkp;
END;
$$;

COMMENT ON FUNCTION public.refresh_account_dkp_summary_internal() IS 'Recompute account_dkp_summary from raid_event_attendance and raid_loot (resolve char to account).';

-- 7) refresh_raid_attendance_totals: also populate raid_attendance_dkp_by_account for the raid
CREATE OR REPLACE FUNCTION public.refresh_raid_attendance_totals(p_raid_id TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  raid_total NUMERIC;
  use_per_event BOOLEAN;
BEGIN
  SELECT COALESCE(SUM((dkp_value::numeric)), 0) INTO raid_total FROM raid_events WHERE raid_id = p_raid_id;
  INSERT INTO raid_dkp_totals (raid_id, total_dkp) VALUES (p_raid_id, COALESCE(raid_total, 0))
  ON CONFLICT (raid_id) DO UPDATE SET total_dkp = EXCLUDED.total_dkp;

  DELETE FROM raid_attendance_dkp WHERE raid_id = p_raid_id;
  DELETE FROM raid_attendance_dkp_by_account WHERE raid_id = p_raid_id;

  SELECT EXISTS (SELECT 1 FROM raid_event_attendance WHERE raid_id = p_raid_id LIMIT 1) INTO use_per_event;

  IF use_per_event THEN
    INSERT INTO raid_attendance_dkp (raid_id, character_key, character_name, dkp_earned)
    SELECT rea.raid_id,
           (CASE WHEN COALESCE(trim(rea.char_id::text), '') = '' THEN COALESCE(trim(rea.character_name), 'unknown') ELSE trim(rea.char_id::text) END),
           MAX(COALESCE(trim(rea.character_name), rea.char_id::text, 'unknown')),
           SUM(COALESCE((re.dkp_value::numeric), 0))
    FROM raid_event_attendance rea
    LEFT JOIN raid_events re ON re.raid_id = rea.raid_id AND re.event_id = rea.event_id
    WHERE rea.raid_id = p_raid_id
    GROUP BY rea.raid_id, (CASE WHEN COALESCE(trim(rea.char_id::text), '') = '' THEN COALESCE(trim(rea.character_name), 'unknown') ELSE trim(rea.char_id::text) END);

    INSERT INTO raid_attendance_dkp_by_account (raid_id, account_id, dkp_earned)
    SELECT rea.raid_id, COALESCE(rea.account_id, x.aid), SUM(COALESCE((re.dkp_value::numeric), 0))
    FROM raid_event_attendance rea
    LEFT JOIN raid_events re ON re.raid_id = rea.raid_id AND re.event_id = rea.event_id
    LEFT JOIN LATERAL (
      SELECT ca.account_id FROM character_account ca
      WHERE (rea.char_id IS NOT NULL AND trim(rea.char_id::text) <> '' AND ca.char_id = trim(rea.char_id::text))
         OR (rea.character_name IS NOT NULL AND trim(rea.character_name) <> '' AND EXISTS (
           SELECT 1 FROM characters c WHERE c.char_id = ca.char_id AND trim(c.name) = trim(rea.character_name)
         ))
      LIMIT 1
    ) x(aid) ON true
    WHERE rea.raid_id = p_raid_id AND (rea.account_id IS NOT NULL OR x.aid IS NOT NULL)
    GROUP BY rea.raid_id, COALESCE(rea.account_id, x.aid);
  ELSE
    INSERT INTO raid_attendance_dkp (raid_id, character_key, character_name, dkp_earned)
    SELECT ra.raid_id,
           (CASE WHEN COALESCE(trim(ra.char_id::text), '') = '' THEN COALESCE(trim(ra.character_name), 'unknown') ELSE trim(ra.char_id::text) END),
           MAX(COALESCE(trim(ra.character_name), ra.char_id::text, 'unknown')),
           COALESCE(raid_total, 0)
    FROM raid_attendance ra
    WHERE ra.raid_id = p_raid_id
    GROUP BY ra.raid_id, (CASE WHEN COALESCE(trim(ra.char_id::text), '') = '' THEN COALESCE(trim(ra.character_name), 'unknown') ELSE trim(ra.char_id::text) END);
  END IF;
END;
$$;

-- 8) RPC for officers to refresh account DKP (and keep legacy dkp_summary in sync if desired)
CREATE OR REPLACE FUNCTION public.refresh_account_dkp_summary()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_officer() THEN
    RAISE EXCEPTION 'Only officers can refresh account DKP summary';
  END IF;
  PERFORM refresh_account_dkp_summary_internal();
END;
$$;
COMMENT ON FUNCTION public.refresh_account_dkp_summary() IS 'Officer-only: refresh account_dkp_summary from attendance and loot.';

-- 9) end_restore_load: also refresh account DKP
CREATE OR REPLACE FUNCTION public.end_restore_load()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE restore_in_progress SET in_progress = false WHERE id = 1;
  PERFORM fix_serial_sequences_for_restore();
  PERFORM refresh_dkp_summary();
  PERFORM refresh_all_raid_attendance_totals();
  PERFORM refresh_account_dkp_summary_internal();
END;
$$;

-- 10) truncate_dkp_for_restore: include new account tables
CREATE OR REPLACE FUNCTION public.truncate_dkp_for_restore()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  TRUNCATE TABLE raid_attendance_dkp_by_account;
  TRUNCATE TABLE raid_attendance_dkp;
  TRUNCATE TABLE raid_dkp_totals;
  TRUNCATE TABLE raid_event_attendance RESTART IDENTITY CASCADE;
  TRUNCATE TABLE raid_loot RESTART IDENTITY CASCADE;
  TRUNCATE TABLE raid_attendance RESTART IDENTITY CASCADE;
  TRUNCATE TABLE raid_events RESTART IDENTITY CASCADE;
  TRUNCATE TABLE raid_classifications CASCADE;
  TRUNCATE TABLE raids RESTART IDENTITY CASCADE;
  TRUNCATE TABLE character_account CASCADE;
  TRUNCATE TABLE characters CASCADE;
  TRUNCATE TABLE account_dkp_summary;
  TRUNCATE TABLE dkp_summary;
  TRUNCATE TABLE dkp_adjustments;
  TRUNCATE TABLE dkp_period_totals;
  TRUNCATE TABLE active_raiders;
  TRUNCATE TABLE active_accounts;
  TRUNCATE TABLE officer_audit_log;
END;
$$;

-- 11) RLS for new tables
ALTER TABLE account_dkp_summary ENABLE ROW LEVEL SECURITY;
ALTER TABLE raid_attendance_dkp_by_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE active_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated read account_dkp_summary" ON account_dkp_summary;
CREATE POLICY "Authenticated read account_dkp_summary" ON account_dkp_summary FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Authenticated read raid_attendance_dkp_by_account" ON raid_attendance_dkp_by_account;
CREATE POLICY "Authenticated read raid_attendance_dkp_by_account" ON raid_attendance_dkp_by_account FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Authenticated read active_accounts" ON active_accounts;
CREATE POLICY "Authenticated read active_accounts" ON active_accounts FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Officers manage active_accounts" ON active_accounts;
CREATE POLICY "Officers manage active_accounts" ON active_accounts FOR ALL TO authenticated
  USING (public.is_officer())
  WITH CHECK (public.is_officer());

GRANT EXECUTE ON FUNCTION public.refresh_account_dkp_summary() TO authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_account_dkp_summary() TO service_role;

-- Per-raid account summary refresh: only update accounts that have attendance in this raid (plus optional extra, e.g. removed attendee).
-- Use this when adding/removing a tic or attendee so we don't run a full refresh over all raids.
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

  -- Accounts with attendance in this raid (resolve account_id from char_id/name if null) plus any extra (e.g. removed attendee)
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

  -- Recompute earned (and periods) for these accounts from ALL their attendance; then UPSERT into account_dkp_summary
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

  -- Spent for these accounts: sum from raid_loot (all raids) and UPSERT (add to existing earned row)
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
