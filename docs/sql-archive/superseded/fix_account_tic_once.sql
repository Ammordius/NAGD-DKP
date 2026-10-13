-- An account is credited once per tic. A second character on the same account does not add the tic again.
-- Several raid_events rows can share an event_id. Each distinct tic (event order and name) counts.
-- Identical copies of the same tic still count once.

CREATE OR REPLACE FUNCTION public.dkp_one_tic_value(p_raid_id text, p_event_id text)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(SUM(tic.dkp), 0)
  FROM (
    SELECT DISTINCT ON (re.event_order, lower(trim(re.event_name)))
      COALESCE(NULLIF(trim(re.dkp_value), '')::numeric, 0) AS dkp
    FROM raid_events re
    WHERE re.raid_id = p_raid_id AND re.event_id = p_event_id
    ORDER BY re.event_order, lower(trim(re.event_name)), re.id
  ) tic
$$;

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
           SUM(public.dkp_one_tic_value(rea.raid_id, rea.event_id))
    FROM raid_event_attendance rea
    WHERE rea.raid_id = p_raid_id
    GROUP BY rea.raid_id, (CASE WHEN COALESCE(trim(rea.char_id::text), '') = '' THEN COALESCE(trim(rea.character_name), 'unknown') ELSE trim(rea.char_id::text) END);

    -- One credit per account per tic, even when several characters on the account have the row.
    INSERT INTO raid_attendance_dkp_by_account (raid_id, account_id, dkp_earned)
    SELECT t.raid_id, t.account_id, SUM(public.dkp_one_tic_value(t.raid_id, t.event_id))
    FROM (
      SELECT DISTINCT rea.raid_id, rea.event_id, COALESCE(rea.account_id, x.aid) AS account_id
      FROM raid_event_attendance rea
      LEFT JOIN LATERAL (
        SELECT ca.account_id FROM character_account ca
        WHERE (rea.char_id IS NOT NULL AND trim(rea.char_id::text) <> '' AND ca.char_id = trim(rea.char_id::text))
           OR (rea.character_name IS NOT NULL AND trim(rea.character_name) <> '' AND EXISTS (
             SELECT 1 FROM characters c WHERE c.char_id = ca.char_id AND trim(c.name) = trim(rea.character_name)
           ))
        LIMIT 1
      ) x(aid) ON true
      WHERE rea.raid_id = p_raid_id AND (rea.account_id IS NOT NULL OR x.aid IS NOT NULL)
    ) t
    GROUP BY t.raid_id, t.account_id;
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

CREATE OR REPLACE FUNCTION public.refresh_all_raid_attendance_totals()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  use_per_event BOOLEAN;
BEGIN
  -- 1) raid_dkp_totals: one bulk upsert
  INSERT INTO raid_dkp_totals (raid_id, total_dkp)
  SELECT raid_id, COALESCE(SUM((dkp_value::numeric)), 0)
  FROM raid_events
  GROUP BY raid_id
  ON CONFLICT (raid_id) DO UPDATE SET total_dkp = EXCLUDED.total_dkp;

  -- 2) Clear per-raid cache tables
  TRUNCATE raid_attendance_dkp;
  TRUNCATE raid_attendance_dkp_by_account;

  SELECT EXISTS (SELECT 1 FROM raid_event_attendance LIMIT 1) INTO use_per_event;

  IF use_per_event THEN
    -- 3a) raid_attendance_dkp from per-event attendance (all raids in one statement)
    INSERT INTO raid_attendance_dkp (raid_id, character_key, character_name, dkp_earned)
    SELECT rea.raid_id,
           (CASE WHEN COALESCE(trim(rea.char_id::text), '') = '' THEN COALESCE(trim(rea.character_name), 'unknown') ELSE trim(rea.char_id::text) END),
           MAX(COALESCE(trim(rea.character_name), rea.char_id::text, 'unknown')),
           SUM(public.dkp_one_tic_value(rea.raid_id, rea.event_id))
    FROM raid_event_attendance rea
    GROUP BY rea.raid_id, (CASE WHEN COALESCE(trim(rea.char_id::text), '') = '' THEN COALESCE(trim(rea.character_name), 'unknown') ELSE trim(rea.char_id::text) END);

    -- 4a) raid_attendance_dkp_by_account: one credit per account per tic.
    INSERT INTO raid_attendance_dkp_by_account (raid_id, account_id, dkp_earned)
    SELECT t.raid_id, t.account_id, SUM(public.dkp_one_tic_value(t.raid_id, t.event_id))
    FROM (
      SELECT DISTINCT rea.raid_id, rea.event_id, COALESCE(rea.account_id, x.aid) AS account_id
      FROM raid_event_attendance rea
      LEFT JOIN LATERAL (
        SELECT ca.account_id FROM character_account ca
        WHERE (rea.char_id IS NOT NULL AND trim(rea.char_id::text) <> '' AND ca.char_id = trim(rea.char_id::text))
           OR (rea.character_name IS NOT NULL AND trim(rea.character_name) <> '' AND EXISTS (
             SELECT 1 FROM characters c WHERE c.char_id = ca.char_id AND trim(c.name) = trim(rea.character_name)
           ))
        LIMIT 1
      ) x(aid) ON true
      WHERE rea.account_id IS NOT NULL OR x.aid IS NOT NULL
    ) t
    GROUP BY t.raid_id, t.account_id;
  ELSE
    -- 3b) raid_attendance_dkp from raid-level attendance (all raids in one statement)
    INSERT INTO raid_attendance_dkp (raid_id, character_key, character_name, dkp_earned)
    SELECT ra.raid_id,
           (CASE WHEN COALESCE(trim(ra.char_id::text), '') = '' THEN COALESCE(trim(ra.character_name), 'unknown') ELSE trim(ra.char_id::text) END),
           MAX(COALESCE(trim(ra.character_name), ra.char_id::text, 'unknown')),
           COALESCE(rt.dkp, 0)
    FROM raid_attendance ra
    LEFT JOIN (SELECT raid_id, SUM((dkp_value::numeric)) AS dkp FROM raid_events GROUP BY raid_id) rt ON ra.raid_id = rt.raid_id
    GROUP BY ra.raid_id, (CASE WHEN COALESCE(trim(ra.char_id::text), '') = '' THEN COALESCE(trim(ra.character_name), 'unknown') ELSE trim(ra.char_id::text) END), rt.dkp;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.refresh_dkp_summary_internal()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  use_per_event BOOLEAN;
BEGIN
  SELECT EXISTS (SELECT 1 FROM raid_event_attendance LIMIT 1) INTO use_per_event;

  TRUNCATE dkp_summary;

  IF use_per_event THEN
    INSERT INTO dkp_summary (character_key, character_name, earned, spent, earned_30d, earned_60d, last_activity_date, updated_at)
    SELECT character_key, character_name, earned, 0, earned_30d, earned_60d, last_activity_date, now()
    FROM (
      SELECT
        (CASE WHEN COALESCE(trim(rea.char_id::text), '') = '' THEN COALESCE(trim(rea.character_name), 'unknown') ELSE trim(rea.char_id::text) END) AS character_key,
        MAX(COALESCE(trim(rea.character_name), rea.char_id::text, 'unknown')) AS character_name,
        SUM(public.dkp_one_tic_value(rea.raid_id, rea.event_id)) AS earned,
        (SUM(CASE WHEN raid_date_parsed(r.date_iso) >= (current_date - 30) THEN public.dkp_one_tic_value(rea.raid_id, rea.event_id) ELSE 0 END))::INTEGER AS earned_30d,
        (SUM(CASE WHEN raid_date_parsed(r.date_iso) >= (current_date - 60) THEN public.dkp_one_tic_value(rea.raid_id, rea.event_id) ELSE 0 END))::INTEGER AS earned_60d,
        MAX(raid_date_parsed(r.date_iso)) AS last_activity_date
      FROM raid_event_attendance rea
      LEFT JOIN raids r ON r.raid_id = rea.raid_id
      GROUP BY (CASE WHEN COALESCE(trim(rea.char_id::text), '') = '' THEN COALESCE(trim(rea.character_name), 'unknown') ELSE trim(rea.char_id::text) END)
    ) e;
  ELSE
    INSERT INTO dkp_summary (character_key, character_name, earned, spent, earned_30d, earned_60d, last_activity_date, updated_at)
    SELECT character_key, character_name, earned, 0, earned_30d, earned_60d, last_activity_date, now()
    FROM (
      SELECT
        (CASE WHEN COALESCE(trim(ra.char_id::text), '') = '' THEN COALESCE(trim(ra.character_name), 'unknown') ELSE trim(ra.char_id::text) END) AS character_key,
        MAX(COALESCE(trim(ra.character_name), ra.char_id::text, 'unknown')) AS character_name,
        SUM(COALESCE(raid_totals.dkp, 0)) AS earned,
        (SUM(CASE WHEN raid_date_parsed(r.date_iso) >= (current_date - 30) THEN COALESCE(raid_totals.dkp, 0) ELSE 0 END))::INTEGER AS earned_30d,
        (SUM(CASE WHEN raid_date_parsed(r.date_iso) >= (current_date - 60) THEN COALESCE(raid_totals.dkp, 0) ELSE 0 END))::INTEGER AS earned_60d,
        MAX(raid_date_parsed(r.date_iso)) AS last_activity_date
      FROM raid_attendance ra
      LEFT JOIN (SELECT raid_id, SUM((dkp_value::numeric)) AS dkp FROM raid_events GROUP BY raid_id) raid_totals ON ra.raid_id = raid_totals.raid_id
      LEFT JOIN raids r ON r.raid_id = ra.raid_id
      GROUP BY (CASE WHEN COALESCE(trim(ra.char_id::text), '') = '' THEN COALESCE(trim(ra.character_name), 'unknown') ELSE trim(ra.char_id::text) END)
    ) e;
  END IF;

  -- Copy earned rows to temp table (we are about to truncate dkp_summary and need them for the join).
  CREATE TEMP TABLE IF NOT EXISTS _dkp_earned (character_key TEXT, character_name TEXT, earned NUMERIC, spent INTEGER, earned_30d INTEGER, earned_60d INTEGER, last_activity_date DATE, updated_at TIMESTAMPTZ) ON COMMIT DROP;
  TRUNCATE _dkp_earned;
  INSERT INTO _dkp_earned SELECT character_key, character_name, earned, spent, COALESCE(earned_30d, 0), COALESCE(earned_60d, 0), last_activity_date, updated_at FROM dkp_summary;

  TRUNCATE dkp_summary;

  -- Merge spent and last_activity; insert final rows.
  INSERT INTO dkp_summary (character_key, character_name, earned, spent, earned_30d, earned_60d, last_activity_date, updated_at)
  WITH spent_agg AS (
    SELECT
      (CASE WHEN COALESCE(trim(rl.char_id::text), '') = '' THEN COALESCE(trim(rl.character_name), 'unknown') ELSE trim(rl.char_id::text) END) AS character_key,
      MAX(COALESCE(trim(rl.character_name), rl.char_id::text, 'unknown')) AS character_name,
      SUM(COALESCE((rl.cost::integer), 0)) AS spent
    FROM raid_loot rl
    GROUP BY (CASE WHEN COALESCE(trim(rl.char_id::text), '') = '' THEN COALESCE(trim(rl.character_name), 'unknown') ELSE trim(rl.char_id::text) END)
  ),
  activity_dates AS (
    SELECT character_key, MAX(raid_date) AS last_activity_date FROM (
      SELECT (CASE WHEN COALESCE(trim(rea.char_id::text), '') = '' THEN COALESCE(trim(rea.character_name), 'unknown') ELSE trim(rea.char_id::text) END) AS character_key, raid_date_parsed(r.date_iso) AS raid_date FROM raid_event_attendance rea JOIN raids r ON r.raid_id = rea.raid_id
      UNION ALL
      SELECT (CASE WHEN COALESCE(trim(ra.char_id::text), '') = '' THEN COALESCE(trim(ra.character_name), 'unknown') ELSE trim(ra.char_id::text) END), raid_date_parsed(r.date_iso) FROM raid_attendance ra JOIN raids r ON r.raid_id = ra.raid_id
      UNION ALL
      SELECT (CASE WHEN COALESCE(trim(rl.char_id::text), '') = '' THEN COALESCE(trim(rl.character_name), 'unknown') ELSE trim(rl.char_id::text) END), raid_date_parsed(r.date_iso) FROM raid_loot rl JOIN raids r ON r.raid_id = rl.raid_id
    ) t
    WHERE raid_date IS NOT NULL
    GROUP BY character_key
  ),
  combined AS (
    SELECT
      COALESCE(s.character_key, d.character_key) AS character_key,
      COALESCE(s.character_name, d.character_name) AS character_name,
      COALESCE(d.earned, 0) AS earned,
      COALESCE(s.spent, 0) AS spent,
      COALESCE(d.earned_30d, 0) AS earned_30d,
      COALESCE(d.earned_60d, 0) AS earned_60d
    FROM _dkp_earned d
    FULL OUTER JOIN spent_agg s ON d.character_key = s.character_key
  )
  SELECT c.character_key, c.character_name, c.earned, c.spent, c.earned_30d, c.earned_60d, ad.last_activity_date, now()
  FROM combined c
  LEFT JOIN activity_dates ad ON ad.character_key = c.character_key;

  -- Update period totals (total DKP available in last 30d and 60d from all raids). Use raid dates from raids.date_iso.
  INSERT INTO dkp_period_totals (period, total_dkp)
  SELECT '30d', COALESCE(SUM((re.dkp_value::numeric)), 0) FROM raid_events re JOIN raids r ON r.raid_id = re.raid_id WHERE raid_date_parsed(r.date_iso) >= (current_date - 30)
  ON CONFLICT (period) DO UPDATE SET total_dkp = EXCLUDED.total_dkp;
  INSERT INTO dkp_period_totals (period, total_dkp)
  SELECT '60d', COALESCE(SUM((re.dkp_value::numeric)), 0) FROM raid_events re JOIN raids r ON r.raid_id = re.raid_id WHERE raid_date_parsed(r.date_iso) >= (current_date - 60)
  ON CONFLICT (period) DO UPDATE SET total_dkp = EXCLUDED.total_dkp;
END;
$$;

CREATE OR REPLACE FUNCTION public.trigger_delta_event_attendance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF restore_load_in_progress() THEN RETURN NULL; END IF;
  -- Character earned is per character. Account earned is added only when this insert
  -- is the account's first row on that tic.
  PERFORM apply_earned_deltas((
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'character_key', g.character_key,
      'character_name', g.character_name,
      'account_id', g.account_id,
      'earned', g.earned,
      'earned_30d', g.earned_30d,
      'earned_60d', g.earned_60d,
      'account_earned', g.account_earned,
      'account_earned_30d', g.account_earned_30d,
      'account_earned_60d', g.account_earned_60d
    )), '[]'::jsonb)
    FROM (
      SELECT rows.character_key,
             MAX(rows.character_name) AS character_name,
             rows.account_id,
             SUM(rows.dkp) AS earned,
             SUM(CASE WHEN rows.raid_date >= (current_date - 30) THEN rows.dkp ELSE 0 END)::integer AS earned_30d,
             SUM(CASE WHEN rows.raid_date >= (current_date - 60) THEN rows.dkp ELSE 0 END)::integer AS earned_60d,
             SUM(CASE WHEN rows.is_account_credit THEN rows.dkp ELSE 0 END) AS account_earned,
             SUM(CASE WHEN rows.is_account_credit AND rows.raid_date >= (current_date - 30) THEN rows.dkp ELSE 0 END)::integer AS account_earned_30d,
             SUM(CASE WHEN rows.is_account_credit AND rows.raid_date >= (current_date - 60) THEN rows.dkp ELSE 0 END)::integer AS account_earned_60d
      FROM (
        SELECT tic.character_key,
               tic.character_name,
               tic.account_id,
               tic.dkp,
               tic.raid_date,
               (
                 tic.account_id IS NOT NULL
                 AND tic.rn = 1
                 AND NOT EXISTS (
                   SELECT 1
                   FROM raid_event_attendance existing
                   WHERE existing.raid_id = tic.raid_id
                     AND existing.event_id = tic.event_id
                     AND public.resolve_dkp_account_id(existing.account_id, existing.char_id::text, existing.character_name) = tic.account_id
                     AND existing.id NOT IN (SELECT id FROM new_rows)
                 )
               ) AS is_account_credit
        FROM (
          SELECT public.dkp_character_key(nr.char_id::text, nr.character_name) AS character_key,
                 COALESCE(NULLIF(trim(nr.character_name), ''), nr.char_id::text, 'unknown') AS character_name,
                 public.resolve_dkp_account_id(nr.account_id, nr.char_id::text, nr.character_name) AS account_id,
                 nr.raid_id,
                 nr.event_id,
                 public.dkp_one_tic_value(nr.raid_id, nr.event_id) AS dkp,
                 public.raid_date_parsed(r.date_iso) AS raid_date,
                 row_number() OVER (
                   PARTITION BY public.resolve_dkp_account_id(nr.account_id, nr.char_id::text, nr.character_name), nr.raid_id, nr.event_id
                   ORDER BY nr.id
                 ) AS rn
          FROM new_rows nr
          LEFT JOIN raids r ON r.raid_id = nr.raid_id
        ) tic
      ) rows
      GROUP BY rows.character_key, rows.account_id
    ) g
  ));
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.trigger_delta_event_attendance_del()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF restore_load_in_progress() THEN RETURN NULL; END IF;
  -- Remove the account credit only when no character on the account still has the tic.
  PERFORM apply_earned_deltas((
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'character_key', g.character_key,
      'character_name', g.character_name,
      'account_id', g.account_id,
      'earned', g.earned,
      'earned_30d', g.earned_30d,
      'earned_60d', g.earned_60d,
      'account_earned', g.account_earned,
      'account_earned_30d', g.account_earned_30d,
      'account_earned_60d', g.account_earned_60d
    )), '[]'::jsonb)
    FROM (
      SELECT rows.character_key,
             MAX(rows.character_name) AS character_name,
             rows.account_id,
             SUM(-rows.dkp) AS earned,
             SUM(CASE WHEN rows.raid_date >= (current_date - 30) THEN -rows.dkp ELSE 0 END)::integer AS earned_30d,
             SUM(CASE WHEN rows.raid_date >= (current_date - 60) THEN -rows.dkp ELSE 0 END)::integer AS earned_60d,
             SUM(CASE WHEN rows.is_account_credit THEN -rows.dkp ELSE 0 END) AS account_earned,
             SUM(CASE WHEN rows.is_account_credit AND rows.raid_date >= (current_date - 30) THEN -rows.dkp ELSE 0 END)::integer AS account_earned_30d,
             SUM(CASE WHEN rows.is_account_credit AND rows.raid_date >= (current_date - 60) THEN -rows.dkp ELSE 0 END)::integer AS account_earned_60d
      FROM (
        SELECT tic.character_key,
               tic.character_name,
               tic.account_id,
               tic.dkp,
               tic.raid_date,
               (
                 tic.account_id IS NOT NULL
                 AND tic.rn = 1
                 AND NOT EXISTS (
                   SELECT 1
                   FROM raid_event_attendance existing
                   WHERE existing.raid_id = tic.raid_id
                     AND existing.event_id = tic.event_id
                     AND public.resolve_dkp_account_id(existing.account_id, existing.char_id::text, existing.character_name) = tic.account_id
                 )
               ) AS is_account_credit
        FROM (
          SELECT public.dkp_character_key(o.char_id::text, o.character_name) AS character_key,
                 COALESCE(NULLIF(trim(o.character_name), ''), o.char_id::text, 'unknown') AS character_name,
                 public.resolve_dkp_account_id(o.account_id, o.char_id::text, o.character_name) AS account_id,
                 o.raid_id,
                 o.event_id,
                 public.dkp_one_tic_value(o.raid_id, o.event_id) AS dkp,
                 public.raid_date_parsed(r.date_iso) AS raid_date,
                 row_number() OVER (
                   PARTITION BY public.resolve_dkp_account_id(o.account_id, o.char_id::text, o.character_name), o.raid_id, o.event_id
                   ORDER BY o.id
                 ) AS rn
          FROM old_rows o
          LEFT JOIN raids r ON r.raid_id = o.raid_id
        ) tic
      ) rows
      GROUP BY rows.character_key, rows.account_id
    ) g
  ));
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.trigger_delta_event_attendance_upd()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF restore_load_in_progress() THEN RETURN NULL; END IF;
  -- Old account loses the tic only when this update leaves it with no row.
  PERFORM apply_earned_deltas((
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'character_key', g.character_key,
      'character_name', g.character_name,
      'account_id', g.account_id,
      'earned', g.earned,
      'earned_30d', g.earned_30d,
      'earned_60d', g.earned_60d,
      'account_earned', g.account_earned,
      'account_earned_30d', g.account_earned_30d,
      'account_earned_60d', g.account_earned_60d
    )), '[]'::jsonb)
    FROM (
      SELECT rows.character_key,
             MAX(rows.character_name) AS character_name,
             rows.account_id,
             SUM(-rows.dkp) AS earned,
             SUM(CASE WHEN rows.raid_date >= (current_date - 30) THEN -rows.dkp ELSE 0 END)::integer AS earned_30d,
             SUM(CASE WHEN rows.raid_date >= (current_date - 60) THEN -rows.dkp ELSE 0 END)::integer AS earned_60d,
             SUM(CASE WHEN rows.is_account_credit THEN -rows.dkp ELSE 0 END) AS account_earned,
             SUM(CASE WHEN rows.is_account_credit AND rows.raid_date >= (current_date - 30) THEN -rows.dkp ELSE 0 END)::integer AS account_earned_30d,
             SUM(CASE WHEN rows.is_account_credit AND rows.raid_date >= (current_date - 60) THEN -rows.dkp ELSE 0 END)::integer AS account_earned_60d
      FROM (
        SELECT tic.character_key,
               tic.character_name,
               tic.account_id,
               tic.dkp,
               tic.raid_date,
               (
                 tic.account_id IS NOT NULL
                 AND tic.rn = 1
                 AND NOT EXISTS (
                   SELECT 1
                   FROM raid_event_attendance existing
                   WHERE existing.raid_id = tic.raid_id
                     AND existing.event_id = tic.event_id
                     AND public.resolve_dkp_account_id(existing.account_id, existing.char_id::text, existing.character_name) = tic.account_id
                 )
               ) AS is_account_credit
        FROM (
          SELECT public.dkp_character_key(o.char_id::text, o.character_name) AS character_key,
                 COALESCE(NULLIF(trim(o.character_name), ''), o.char_id::text, 'unknown') AS character_name,
                 public.resolve_dkp_account_id(o.account_id, o.char_id::text, o.character_name) AS account_id,
                 o.raid_id,
                 o.event_id,
                 public.dkp_one_tic_value(o.raid_id, o.event_id) AS dkp,
                 public.raid_date_parsed(r.date_iso) AS raid_date,
                 row_number() OVER (
                   PARTITION BY public.resolve_dkp_account_id(o.account_id, o.char_id::text, o.character_name), o.raid_id, o.event_id
                   ORDER BY o.id
                 ) AS rn
          FROM old_rows o
          LEFT JOIN raids r ON r.raid_id = o.raid_id
        ) tic
      ) rows
      GROUP BY rows.character_key, rows.account_id
    ) g
  ));
  -- New account gains the tic only when it did not already have a row, including the pre-update row.
  PERFORM apply_earned_deltas((
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'character_key', g.character_key,
      'character_name', g.character_name,
      'account_id', g.account_id,
      'earned', g.earned,
      'earned_30d', g.earned_30d,
      'earned_60d', g.earned_60d,
      'account_earned', g.account_earned,
      'account_earned_30d', g.account_earned_30d,
      'account_earned_60d', g.account_earned_60d
    )), '[]'::jsonb)
    FROM (
      SELECT rows.character_key,
             MAX(rows.character_name) AS character_name,
             rows.account_id,
             SUM(rows.dkp) AS earned,
             SUM(CASE WHEN rows.raid_date >= (current_date - 30) THEN rows.dkp ELSE 0 END)::integer AS earned_30d,
             SUM(CASE WHEN rows.raid_date >= (current_date - 60) THEN rows.dkp ELSE 0 END)::integer AS earned_60d,
             SUM(CASE WHEN rows.is_account_credit THEN rows.dkp ELSE 0 END) AS account_earned,
             SUM(CASE WHEN rows.is_account_credit AND rows.raid_date >= (current_date - 30) THEN rows.dkp ELSE 0 END)::integer AS account_earned_30d,
             SUM(CASE WHEN rows.is_account_credit AND rows.raid_date >= (current_date - 60) THEN rows.dkp ELSE 0 END)::integer AS account_earned_60d
      FROM (
        SELECT tic.character_key,
               tic.character_name,
               tic.account_id,
               tic.dkp,
               tic.raid_date,
               (
                 tic.account_id IS NOT NULL
                 AND tic.rn = 1
                 AND NOT EXISTS (
                   SELECT 1
                   FROM raid_event_attendance existing
                   WHERE existing.raid_id = tic.raid_id
                     AND existing.event_id = tic.event_id
                     AND public.resolve_dkp_account_id(existing.account_id, existing.char_id::text, existing.character_name) = tic.account_id
                     AND existing.id NOT IN (SELECT id FROM new_rows)
                 )
                 AND NOT EXISTS (
                   SELECT 1
                   FROM old_rows o
                   WHERE o.id = tic.id
                     AND o.raid_id IS NOT DISTINCT FROM tic.raid_id
                     AND o.event_id IS NOT DISTINCT FROM tic.event_id
                     AND public.resolve_dkp_account_id(o.account_id, o.char_id::text, o.character_name) IS NOT DISTINCT FROM tic.account_id
                 )
               ) AS is_account_credit
        FROM (
          SELECT n.id,
                 public.dkp_character_key(n.char_id::text, n.character_name) AS character_key,
                 COALESCE(NULLIF(trim(n.character_name), ''), n.char_id::text, 'unknown') AS character_name,
                 public.resolve_dkp_account_id(n.account_id, n.char_id::text, n.character_name) AS account_id,
                 n.raid_id,
                 n.event_id,
                 public.dkp_one_tic_value(n.raid_id, n.event_id) AS dkp,
                 public.raid_date_parsed(r.date_iso) AS raid_date,
                 row_number() OVER (
                   PARTITION BY public.resolve_dkp_account_id(n.account_id, n.char_id::text, n.character_name), n.raid_id, n.event_id
                   ORDER BY n.id
                 ) AS rn
          FROM new_rows n
          LEFT JOIN raids r ON r.raid_id = n.raid_id
        ) tic
      ) rows
      GROUP BY rows.character_key, rows.account_id
    ) g
  ));
  RETURN NULL;
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

  -- Spent: filter raid_loot to rows touching target accounts before resolving assignment/character_account (avoids full-table scan).
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
      SELECT rl.id, rl.raid_id, rl.event_id, rl.item_name, rl.char_id, rl.character_name, rl.cost,
        la.assigned_char_id, la.assigned_character_name
      FROM raid_loot rl
      LEFT JOIN LATERAL (SELECT la.assigned_char_id, la.assigned_character_name FROM loot_assignment la WHERE la.loot_id = rl.id LIMIT 1) la ON true
      WHERE (
        EXISTS (
          SELECT 1 FROM character_account ca0
          WHERE ca0.account_id = ANY(target_accounts)
            AND ca0.char_id = COALESCE(NULLIF(trim(la.assigned_char_id), ''), NULLIF(trim(rl.char_id::text), ''))
            AND COALESCE(NULLIF(trim(la.assigned_char_id), ''), NULLIF(trim(rl.char_id::text), '')) <> ''
        )
        OR (
          COALESCE(NULLIF(trim(la.assigned_char_id), ''), NULLIF(trim(rl.char_id::text), '')) = ''
          AND COALESCE(trim(la.assigned_character_name), trim(rl.character_name)) <> ''
          AND EXISTS (
            SELECT 1 FROM character_account ca0
            INNER JOIN characters c0 ON c0.char_id = ca0.char_id
            WHERE ca0.account_id = ANY(target_accounts)
              AND trim(c0.name) = COALESCE(trim(la.assigned_character_name), trim(rl.character_name))
          )
        )
      )
    ) b
    LEFT JOIN character_account ca ON (
      (COALESCE(trim(b.assigned_char_id), trim(b.char_id::text)) <> '' AND ca.char_id = COALESCE(trim(b.assigned_char_id), trim(b.char_id::text)))
      OR (COALESCE(trim(b.assigned_character_name), trim(b.character_name)) <> '' AND EXISTS (
        SELECT 1 FROM characters c WHERE c.char_id = ca.char_id AND trim(c.name) = COALESCE(trim(b.assigned_character_name), trim(b.character_name))
      ))
    )
    LEFT JOIN accounts a ON a.account_id = ca.account_id
    WHERE ca.account_id IS NOT NULL AND ca.account_id = ANY(target_accounts)
    ORDER BY b.id
  ) sub
  LEFT JOIN raids r ON r.raid_id = sub.raid_id
  GROUP BY sub.account_id
  ON CONFLICT (account_id) DO UPDATE SET
    spent = EXCLUDED.spent,
    last_activity_date = GREATEST(COALESCE(account_dkp_summary.last_activity_date, '1970-01-01'::date), COALESCE(EXCLUDED.last_activity_date, '1970-01-01'::date)),
    updated_at = now();
END;
$$;
