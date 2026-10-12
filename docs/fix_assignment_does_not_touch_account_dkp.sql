-- Character assignment (loot_assignment) must not change account DKP.
-- Account spent follows the raid_loot buyer only.

DROP TRIGGER IF EXISTS loot_assignment_spent_ins ON loot_assignment;
DROP TRIGGER IF EXISTS loot_assignment_spent_upd ON loot_assignment;
DROP TRIGGER IF EXISTS loot_assignment_spent_del ON loot_assignment;
DROP FUNCTION IF EXISTS public.trigger_loot_assignment_spent();
DROP FUNCTION IF EXISTS public.apply_account_spent_deltas(jsonb);

CREATE OR REPLACE FUNCTION public.resolve_loot_account_id(p_loot_id bigint, p_char_id text, p_character_name text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.resolve_dkp_account_id(NULL, NULLIF(trim(p_char_id), ''), NULLIF(trim(p_character_name), ''));
$$;
COMMENT ON FUNCTION public.resolve_loot_account_id(bigint, text, text) IS
  'Account charged for a raid_loot row, from that row''s buyer only. loot_assignment is character ownership and does not affect account DKP. p_loot_id is unused and kept so existing callers do not change.';


CREATE OR REPLACE FUNCTION public.refresh_dkp_last_activity(p_character_keys text[], p_account_ids text[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_character_keys IS NOT NULL AND cardinality(p_character_keys) > 0 THEN
    UPDATE dkp_summary s
    SET last_activity_date = src.last_activity_date
    FROM (
      SELECT k.key AS character_key, MAX(d.raid_date) AS last_activity_date
      FROM unnest(p_character_keys) AS k(key)
      LEFT JOIN (
        SELECT public.dkp_character_key(rea.char_id::text, rea.character_name) AS character_key,
               public.raid_date_parsed(r.date_iso) AS raid_date
        FROM raid_event_attendance rea
        JOIN raids r ON r.raid_id = rea.raid_id
        WHERE public.dkp_character_key(rea.char_id::text, rea.character_name) = ANY (p_character_keys)
        UNION ALL
        SELECT public.dkp_character_key(rl.char_id::text, rl.character_name),
               public.raid_date_parsed(r.date_iso)
        FROM raid_loot rl
        JOIN raids r ON r.raid_id = rl.raid_id
        WHERE public.dkp_character_key(rl.char_id::text, rl.character_name) = ANY (p_character_keys)
      ) d ON d.character_key = k.key
      GROUP BY k.key
    ) src
    WHERE s.character_key = src.character_key;
  END IF;

  IF p_account_ids IS NOT NULL AND cardinality(p_account_ids) > 0 THEN
    UPDATE account_dkp_summary s
    SET last_activity_date = src.last_activity_date
    FROM (
      SELECT k.account_id, MAX(d.raid_date) AS last_activity_date
      FROM unnest(p_account_ids) AS k(account_id)
      LEFT JOIN (
        SELECT COALESCE(NULLIF(trim(rea.account_id), ''), ca.account_id) AS account_id,
               public.raid_date_parsed(r.date_iso) AS raid_date
        FROM raid_event_attendance rea
        JOIN raids r ON r.raid_id = rea.raid_id
        LEFT JOIN character_account ca
          ON NULLIF(trim(rea.account_id), '') IS NULL
         AND ca.char_id = NULLIF(trim(rea.char_id::text), '')
        WHERE COALESCE(NULLIF(trim(rea.account_id), ''), ca.account_id) = ANY (p_account_ids)
        UNION ALL
        SELECT ca.account_id,
               public.raid_date_parsed(r.date_iso)
        FROM raid_event_attendance rea
        JOIN raids r ON r.raid_id = rea.raid_id
        JOIN characters c ON trim(c.name) = trim(rea.character_name)
        JOIN character_account ca ON ca.char_id = c.char_id
        WHERE COALESCE(trim(rea.account_id), '') = ''
          AND COALESCE(trim(rea.char_id::text), '') = ''
          AND ca.account_id = ANY (p_account_ids)
        UNION ALL
        SELECT ca.account_id,
               public.raid_date_parsed(r.date_iso)
        FROM raid_loot rl
        JOIN raids r ON r.raid_id = rl.raid_id
        JOIN character_account ca ON ca.char_id = NULLIF(trim(rl.char_id::text), '')
        WHERE ca.account_id = ANY (p_account_ids)
        UNION ALL
        SELECT ca.account_id,
               public.raid_date_parsed(r.date_iso)
        FROM raid_loot rl
        JOIN raids r ON r.raid_id = rl.raid_id
        JOIN characters c ON trim(c.name) = trim(rl.character_name)
        JOIN character_account ca ON ca.char_id = c.char_id
        WHERE COALESCE(trim(rl.char_id::text), '') = ''
          AND ca.account_id = ANY (p_account_ids)
      ) d ON d.account_id = k.account_id
      GROUP BY k.account_id
    ) src
    WHERE s.account_id = src.account_id;
  END IF;
END;
$$;


CREATE OR REPLACE FUNCTION public.recompute_dkp_last_activity_if_latest(
  p_character_keys text[],
  p_account_ids text[],
  p_raid_dates date[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_keys text[];
  v_id_keys text[];
  v_name_keys text[];
  v_accounts text[];
BEGIN
  IF p_raid_dates IS NULL OR cardinality(p_raid_dates) = 0 THEN
    RETURN;
  END IF;

  SELECT ARRAY_AGG(character_key)
  INTO v_keys
  FROM dkp_summary
  WHERE character_key = ANY (p_character_keys)
    AND last_activity_date = ANY (p_raid_dates);

  SELECT ARRAY_AGG(account_id)
  INTO v_accounts
  FROM account_dkp_summary
  WHERE account_id = ANY (p_account_ids)
    AND last_activity_date = ANY (p_raid_dates);

  IF (v_keys IS NULL OR cardinality(v_keys) = 0)
     AND (v_accounts IS NULL OR cardinality(v_accounts) = 0) THEN
    RETURN;
  END IF;

  IF v_keys IS NOT NULL AND cardinality(v_keys) > 0 THEN
    SELECT ARRAY_AGG(k.key)
    INTO v_id_keys
    FROM unnest(v_keys) AS k(key)
    WHERE EXISTS (SELECT 1 FROM characters c WHERE c.char_id = k.key);

    SELECT ARRAY_AGG(k.key)
    INTO v_name_keys
    FROM unnest(v_keys) AS k(key)
    WHERE NOT EXISTS (SELECT 1 FROM characters c WHERE c.char_id = k.key);

    IF v_id_keys IS NOT NULL AND cardinality(v_id_keys) > 0 THEN
      UPDATE dkp_summary s
      SET last_activity_date = src.last_activity_date
      FROM (
        SELECT k.key AS character_key, MAX(d.raid_date) AS last_activity_date
        FROM unnest(v_id_keys) AS k(key)
        LEFT JOIN (
          SELECT rea.char_id AS character_key, public.raid_date_parsed(r.date_iso) AS raid_date
          FROM raid_event_attendance rea
          JOIN raids r ON r.raid_id = rea.raid_id
          WHERE rea.char_id = ANY (v_id_keys)
          UNION ALL
          SELECT rl.char_id, public.raid_date_parsed(r.date_iso)
          FROM raid_loot rl
          JOIN raids r ON r.raid_id = rl.raid_id
          WHERE rl.char_id = ANY (v_id_keys)
        ) d ON d.character_key = k.key
        GROUP BY k.key
      ) src
      WHERE s.character_key = src.character_key;
    END IF;

    IF v_name_keys IS NOT NULL AND cardinality(v_name_keys) > 0 THEN
      UPDATE dkp_summary s
      SET last_activity_date = src.last_activity_date
      FROM (
        SELECT k.key AS character_key, MAX(d.raid_date) AS last_activity_date
        FROM unnest(v_name_keys) AS k(key)
        LEFT JOIN (
          SELECT COALESCE(NULLIF(trim(rea.character_name), ''), 'unknown') AS character_key,
                 public.raid_date_parsed(r.date_iso) AS raid_date
          FROM raid_event_attendance rea
          JOIN raids r ON r.raid_id = rea.raid_id
          WHERE COALESCE(trim(rea.char_id::text), '') = ''
            AND COALESCE(NULLIF(trim(rea.character_name), ''), 'unknown') = ANY (v_name_keys)
          UNION ALL
          SELECT COALESCE(NULLIF(trim(rl.character_name), ''), 'unknown'),
                 public.raid_date_parsed(r.date_iso)
          FROM raid_loot rl
          JOIN raids r ON r.raid_id = rl.raid_id
          WHERE COALESCE(trim(rl.char_id::text), '') = ''
            AND COALESCE(NULLIF(trim(rl.character_name), ''), 'unknown') = ANY (v_name_keys)
        ) d ON d.character_key = k.key
        GROUP BY k.key
      ) src
      WHERE s.character_key = src.character_key;
    END IF;
  END IF;

  IF v_accounts IS NOT NULL AND cardinality(v_accounts) > 0 THEN
    UPDATE account_dkp_summary s
    SET last_activity_date = src.last_activity_date
    FROM (
      SELECT k.account_id, MAX(d.raid_date) AS last_activity_date
      FROM unnest(v_accounts) AS k(account_id)
      LEFT JOIN (
        SELECT rea.account_id, public.raid_date_parsed(r.date_iso) AS raid_date
        FROM raid_event_attendance rea
        JOIN raids r ON r.raid_id = rea.raid_id
        WHERE rea.account_id = ANY (v_accounts)
        UNION ALL
        SELECT ca.account_id, public.raid_date_parsed(r.date_iso)
        FROM character_account ca
        JOIN raid_event_attendance rea ON rea.char_id = ca.char_id
        JOIN raids r ON r.raid_id = rea.raid_id
        WHERE ca.account_id = ANY (v_accounts)
          AND NULLIF(trim(rea.account_id), '') IS NULL
        UNION ALL
        SELECT ca.account_id, public.raid_date_parsed(r.date_iso)
        FROM character_account ca
        JOIN raid_loot rl ON rl.char_id = ca.char_id
        JOIN raids r ON r.raid_id = rl.raid_id
        WHERE ca.account_id = ANY (v_accounts)
        UNION ALL
        SELECT ca.account_id, public.raid_date_parsed(r.date_iso)
        FROM raid_event_attendance rea
        JOIN raids r ON r.raid_id = rea.raid_id
        JOIN characters c ON trim(c.name) = trim(rea.character_name)
        JOIN character_account ca ON ca.char_id = c.char_id
        WHERE COALESCE(trim(rea.account_id), '') = ''
          AND COALESCE(trim(rea.char_id::text), '') = ''
          AND ca.account_id = ANY (v_accounts)
        UNION ALL
        SELECT ca.account_id, public.raid_date_parsed(r.date_iso)
        FROM raid_loot rl
        JOIN raids r ON r.raid_id = rl.raid_id
        JOIN characters c ON trim(c.name) = trim(rl.character_name)
        JOIN character_account ca ON ca.char_id = c.char_id
        WHERE COALESCE(trim(rl.char_id::text), '') = ''
          AND ca.account_id = ANY (v_accounts)
      ) d ON d.account_id = k.account_id
      GROUP BY k.account_id
    ) src
    WHERE s.account_id = src.account_id;
  END IF;
END;
$$;


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

  -- Earned: one credit per account per tic (raid_id, event_id), then sum dkp by account.
  INSERT INTO account_dkp_summary (account_id, display_name, earned, earned_30d, earned_60d, last_activity_date, updated_at)
  WITH rea_one_account AS (
    SELECT DISTINCT rea.raid_id, rea.event_id,
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
    SUM(public.dkp_one_tic_value(roa.raid_id, roa.event_id)),
    (SUM(CASE WHEN raid_date_parsed(r.date_iso) >= (current_date - 30) THEN public.dkp_one_tic_value(roa.raid_id, roa.event_id) ELSE 0 END))::INTEGER,
    (SUM(CASE WHEN raid_date_parsed(r.date_iso) >= (current_date - 60) THEN public.dkp_one_tic_value(roa.raid_id, roa.event_id) ELSE 0 END))::INTEGER,
    MAX(raid_date_parsed(r.date_iso)),
    now()
  FROM rea_one_account roa
  LEFT JOIN raids r ON r.raid_id = roa.raid_id
  LEFT JOIN accounts a ON a.account_id = roa.account_id
  WHERE roa.account_id IS NOT NULL
  GROUP BY roa.account_id;

  -- Spent: raid_loot buyer only (char_id / character_name). loot_assignment is character
  -- ownership and must not move account DKP.
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
    LEFT JOIN character_account ca ON (
      (COALESCE(trim(rl.char_id::text), '') <> '' AND ca.char_id = trim(rl.char_id::text))
      OR (COALESCE(trim(rl.character_name), '') <> '' AND EXISTS (
        SELECT 1 FROM characters c WHERE c.char_id = ca.char_id AND trim(c.name) = trim(rl.character_name)
      ))
    )
    LEFT JOIN accounts a ON a.account_id = ca.account_id
    WHERE ca.account_id IS NOT NULL
    ORDER BY rl.id, ca.account_id
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

  SET LOCAL statement_timeout = '180s';

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

  -- Recompute earned (and periods) for these accounts from ALL their attendance; then UPSERT into account_dkp_summary.
  -- Restrict raid_event_attendance to rows that belong to target accounts (indexed paths) before resolving account_id.
  INSERT INTO account_dkp_summary (account_id, display_name, earned, spent, earned_30d, earned_60d, last_activity_date, updated_at)
  WITH rea_for_targets AS (
    SELECT rea.*
    FROM raid_event_attendance rea
    WHERE
      (rea.account_id IS NOT NULL AND rea.account_id = ANY(target_accounts))
      OR (
        rea.char_id IS NOT NULL AND trim(rea.char_id::text) <> ''
        AND EXISTS (
          SELECT 1 FROM character_account ca
          WHERE ca.account_id = ANY(target_accounts) AND ca.char_id = trim(rea.char_id::text)
        )
      )
      OR (
        (rea.char_id IS NULL OR trim(rea.char_id::text) = '')
        AND rea.character_name IS NOT NULL AND trim(rea.character_name) <> ''
        AND EXISTS (
          SELECT 1 FROM character_account ca
          INNER JOIN characters c ON c.char_id = ca.char_id
          WHERE ca.account_id = ANY(target_accounts) AND trim(c.name) = trim(rea.character_name)
        )
      )
  ),
  rea_one_account AS (
    SELECT DISTINCT rea.raid_id, rea.event_id,
      COALESCE(rea.account_id, (
        SELECT ca.account_id FROM character_account ca
        WHERE (rea.char_id IS NOT NULL AND trim(rea.char_id::text) <> '' AND ca.char_id = trim(rea.char_id::text))
           OR (rea.character_name IS NOT NULL AND trim(rea.character_name) <> '' AND EXISTS (SELECT 1 FROM characters c WHERE c.char_id = ca.char_id AND trim(c.name) = trim(rea.character_name)))
        LIMIT 1
      )) AS account_id
    FROM rea_for_targets rea
  )
  SELECT
    roa.account_id,
    MAX(a.display_name),
    SUM(public.dkp_one_tic_value(roa.raid_id, roa.event_id)),
    0::numeric,
    (SUM(CASE WHEN raid_date_parsed(r.date_iso) >= (current_date - 30) THEN public.dkp_one_tic_value(roa.raid_id, roa.event_id) ELSE 0 END))::INTEGER,
    (SUM(CASE WHEN raid_date_parsed(r.date_iso) >= (current_date - 60) THEN public.dkp_one_tic_value(roa.raid_id, roa.event_id) ELSE 0 END))::INTEGER,
    MAX(raid_date_parsed(r.date_iso)),
    now()
  FROM rea_one_account roa
  LEFT JOIN raids r ON r.raid_id = roa.raid_id
  LEFT JOIN accounts a ON a.account_id = roa.account_id
  WHERE roa.account_id IS NOT NULL AND roa.account_id = ANY(target_accounts)
  GROUP BY roa.account_id
  ON CONFLICT (account_id) DO UPDATE SET
    earned = EXCLUDED.earned,
    earned_30d = EXCLUDED.earned_30d,
    earned_60d = EXCLUDED.earned_60d,
    last_activity_date = GREATEST(COALESCE(account_dkp_summary.last_activity_date, '1970-01-01'::date), COALESCE(EXCLUDED.last_activity_date, '1970-01-01'::date)),
    updated_at = now();

  -- Spent follows the raid_loot buyer, never loot_assignment.
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
    SELECT DISTINCT ON (b.id)
      ca.account_id,
      a.display_name,
      COALESCE((b.cost::numeric), 0) AS cost_num,
      b.raid_id
    FROM (
      SELECT rl.id, rl.raid_id, rl.cost, rl.char_id, rl.character_name
      FROM raid_loot rl
      WHERE (
        COALESCE(trim(rl.char_id::text), '') <> ''
        AND EXISTS (
          SELECT 1 FROM character_account ca0
          WHERE ca0.account_id = ANY(target_accounts)
            AND ca0.char_id = trim(rl.char_id::text)
        )
      )
      OR (
        COALESCE(trim(rl.char_id::text), '') = ''
        AND COALESCE(trim(rl.character_name), '') <> ''
        AND EXISTS (
          SELECT 1 FROM character_account ca0
          INNER JOIN characters c0 ON c0.char_id = ca0.char_id
          WHERE ca0.account_id = ANY(target_accounts)
            AND trim(c0.name) = trim(rl.character_name)
        )
      )
    ) b
    LEFT JOIN character_account ca ON (
      (COALESCE(trim(b.char_id::text), '') <> '' AND ca.char_id = trim(b.char_id::text))
      OR (COALESCE(trim(b.character_name), '') <> '' AND EXISTS (
        SELECT 1 FROM characters c WHERE c.char_id = ca.char_id AND trim(c.name) = trim(b.character_name)
      ))
    )
    LEFT JOIN accounts a ON a.account_id = ca.account_id
    WHERE ca.account_id IS NOT NULL AND ca.account_id = ANY(target_accounts)
    ORDER BY b.id, ca.account_id
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


CREATE OR REPLACE FUNCTION public.refresh_after_bulk_loot_assignment()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '180s'
AS $$
BEGIN
  SET LOCAL statement_timeout = '180s';
  PERFORM refresh_character_dkp_spent();
  PERFORM refresh_dkp_summary_internal();
END;
$$;

COMMENT ON FUNCTION public.refresh_after_bulk_loot_assignment() IS 'Refreshes character_dkp_spent and dkp_summary after bulk loot assignment updates. Does not touch account_dkp_summary; account spent follows raid_loot only.';

