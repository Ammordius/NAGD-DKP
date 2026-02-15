-- Run this in Supabase SQL Editor after creating a project.
-- Creates tables matching data/*.csv + profiles for auth roles + RLS.

-- 1) Profiles: one per auth user, holds role (officer | player)
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('officer', 'player')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 2) DKP data tables (match CSV structure)
CREATE TABLE IF NOT EXISTS characters (
  char_id TEXT PRIMARY KEY,
  name TEXT,
  race TEXT,
  class_name TEXT,
  level TEXT,
  guild_rank TEXT,
  claim TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  char_ids TEXT,
  toon_names TEXT,
  toon_count INTEGER
);

CREATE TABLE IF NOT EXISTS character_account (
  char_id TEXT REFERENCES characters(char_id),
  account_id TEXT REFERENCES accounts(account_id),
  PRIMARY KEY (char_id, account_id)
);

CREATE TABLE IF NOT EXISTS raids (
  raid_id TEXT PRIMARY KEY,
  raid_pool TEXT,
  raid_name TEXT,
  date TEXT,
  date_iso TEXT,
  attendees TEXT,
  url TEXT
);

CREATE TABLE IF NOT EXISTS raid_events (
  id BIGSERIAL PRIMARY KEY,
  raid_id TEXT REFERENCES raids(raid_id),
  event_id TEXT,
  event_order INTEGER,
  event_name TEXT,
  dkp_value TEXT,
  attendee_count TEXT,
  event_time TEXT
);

CREATE TABLE IF NOT EXISTS raid_loot (
  id BIGSERIAL PRIMARY KEY,
  raid_id TEXT,
  event_id TEXT,
  item_name TEXT,
  char_id TEXT,
  character_name TEXT,
  cost TEXT
);

CREATE TABLE IF NOT EXISTS raid_attendance (
  id BIGSERIAL PRIMARY KEY,
  raid_id TEXT REFERENCES raids(raid_id),
  char_id TEXT,
  character_name TEXT
);

-- Per-event attendance (from parse_raid_attendees.py). When present, DKP earned uses this instead of raid_attendance.
CREATE TABLE IF NOT EXISTS raid_event_attendance (
  id BIGSERIAL PRIMARY KEY,
  raid_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  char_id TEXT,
  character_name TEXT
);

-- Raid classification by mobs/zones (from loot + raid_item_sources). Run build_raid_classifications.py to generate data/raid_classifications.csv
CREATE TABLE IF NOT EXISTS raid_classifications (
  raid_id TEXT REFERENCES raids(raid_id),
  mob TEXT NOT NULL,
  zone TEXT,
  PRIMARY KEY (raid_id, mob)
);

-- One-off DKP adjustments so displayed totals match ground truth (character_name -> earned_delta, spent_delta)
CREATE TABLE IF NOT EXISTS dkp_adjustments (
  character_name TEXT PRIMARY KEY,
  earned_delta NUMERIC NOT NULL DEFAULT 0,
  spent_delta INTEGER NOT NULL DEFAULT 0
);

-- Cached DKP totals per character (refreshed on attendance/loot changes or by officers). Makes the leaderboard fast.
CREATE TABLE IF NOT EXISTS dkp_summary (
  character_key TEXT PRIMARY KEY,
  character_name TEXT,
  earned NUMERIC NOT NULL DEFAULT 0,
  spent INTEGER NOT NULL DEFAULT 0,
  earned_30d INTEGER NOT NULL DEFAULT 0,
  earned_60d INTEGER NOT NULL DEFAULT 0,
  last_activity_date DATE,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Total DKP available per period (sum of all event DKP in that window). Updated by full refresh.
CREATE TABLE IF NOT EXISTS dkp_period_totals (
  period TEXT PRIMARY KEY,
  total_dkp NUMERIC NOT NULL DEFAULT 0
);

-- Characters explicitly marked as active (always shown on leaderboard). Officers manage this list.
CREATE TABLE IF NOT EXISTS active_raiders (
  character_key TEXT PRIMARY KEY
);

-- Add new columns if upgrading from an older schema (no-op if already present)
ALTER TABLE dkp_summary ADD COLUMN IF NOT EXISTS last_activity_date DATE;
ALTER TABLE dkp_summary ADD COLUMN IF NOT EXISTS earned_30d INTEGER;
ALTER TABLE dkp_summary ADD COLUMN IF NOT EXISTS earned_60d INTEGER;

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_raid_events_raid ON raid_events(raid_id);
CREATE INDEX IF NOT EXISTS idx_raid_loot_raid ON raid_loot(raid_id);
CREATE INDEX IF NOT EXISTS idx_raid_loot_char ON raid_loot(char_id);
CREATE INDEX IF NOT EXISTS idx_raid_attendance_raid ON raid_attendance(raid_id);
CREATE INDEX IF NOT EXISTS idx_raid_attendance_char ON raid_attendance(char_id);
CREATE INDEX IF NOT EXISTS idx_raid_event_attendance_raid ON raid_event_attendance(raid_id);
CREATE INDEX IF NOT EXISTS idx_raid_event_attendance_char ON raid_event_attendance(char_id);
CREATE INDEX IF NOT EXISTS idx_raid_classifications_raid ON raid_classifications(raid_id);
CREATE INDEX IF NOT EXISTS idx_raid_classifications_mob ON raid_classifications(mob);
CREATE INDEX IF NOT EXISTS idx_dkp_adjustments_name ON dkp_adjustments(character_name);

-- Internal refresh: recomputes dkp_summary and last_activity_date. No auth check (used by triggers and by RPC).
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
        SUM(COALESCE((re.dkp_value::numeric), 0)) AS earned,
        (SUM(CASE WHEN r.date_iso IS NOT NULL AND (r.date_iso::date) >= (current_date - 30) THEN COALESCE((re.dkp_value::numeric), 0) ELSE 0 END))::INTEGER AS earned_30d,
        (SUM(CASE WHEN r.date_iso IS NOT NULL AND (r.date_iso::date) >= (current_date - 60) THEN COALESCE((re.dkp_value::numeric), 0) ELSE 0 END))::INTEGER AS earned_60d,
        MAX((r.date_iso::date)) AS last_activity_date
      FROM raid_event_attendance rea
      LEFT JOIN raid_events re ON re.raid_id = rea.raid_id AND re.event_id = rea.event_id
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
        (SUM(CASE WHEN r.date_iso IS NOT NULL AND (r.date_iso::date) >= (current_date - 30) THEN COALESCE(raid_totals.dkp, 0) ELSE 0 END))::INTEGER AS earned_30d,
        (SUM(CASE WHEN r.date_iso IS NOT NULL AND (r.date_iso::date) >= (current_date - 60) THEN COALESCE(raid_totals.dkp, 0) ELSE 0 END))::INTEGER AS earned_60d,
        MAX((r.date_iso::date)) AS last_activity_date
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
      SELECT (CASE WHEN COALESCE(trim(rea.char_id::text), '') = '' THEN COALESCE(trim(rea.character_name), 'unknown') ELSE trim(rea.char_id::text) END) AS character_key, (r.date_iso::date) AS raid_date FROM raid_event_attendance rea JOIN raids r ON r.raid_id = rea.raid_id WHERE r.date_iso IS NOT NULL
      UNION ALL
      SELECT (CASE WHEN COALESCE(trim(ra.char_id::text), '') = '' THEN COALESCE(trim(ra.character_name), 'unknown') ELSE trim(ra.char_id::text) END), (r.date_iso::date) FROM raid_attendance ra JOIN raids r ON r.raid_id = ra.raid_id WHERE r.date_iso IS NOT NULL
      UNION ALL
      SELECT (CASE WHEN COALESCE(trim(rl.char_id::text), '') = '' THEN COALESCE(trim(rl.character_name), 'unknown') ELSE trim(rl.char_id::text) END), (r.date_iso::date) FROM raid_loot rl JOIN raids r ON r.raid_id = rl.raid_id WHERE r.date_iso IS NOT NULL
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

  -- Update period totals (total DKP available in last 30d and 60d from all raids).
  INSERT INTO dkp_period_totals (period, total_dkp)
  SELECT '30d', COALESCE(SUM((re.dkp_value::numeric)), 0) FROM raid_events re JOIN raids r ON r.raid_id = re.raid_id WHERE r.date_iso IS NOT NULL AND (r.date_iso::date) >= (current_date - 30)
  ON CONFLICT (period) DO UPDATE SET total_dkp = EXCLUDED.total_dkp;
  INSERT INTO dkp_period_totals (period, total_dkp)
  SELECT '60d', COALESCE(SUM((re.dkp_value::numeric)), 0) FROM raid_events re JOIN raids r ON r.raid_id = re.raid_id WHERE r.date_iso IS NOT NULL AND (r.date_iso::date) >= (current_date - 60)
  ON CONFLICT (period) DO UPDATE SET total_dkp = EXCLUDED.total_dkp;
END;
$$;

-- RPC: officers only. Calls internal refresh.
CREATE OR REPLACE FUNCTION public.refresh_dkp_summary()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (SELECT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'officer')) THEN
    RAISE EXCEPTION 'Only officers can refresh DKP summary';
  END IF;
  PERFORM refresh_dkp_summary_internal();
END;
$$;

-- Full refresh trigger (used only on UPDATE/DELETE so corrections are applied).
CREATE OR REPLACE FUNCTION public.trigger_refresh_dkp_summary()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM refresh_dkp_summary_internal();
  RETURN NULL;
END;
$$;

-- Incremental delta: cache is refreshed whenever a new row is added (INSERT) to attendance or loot.
-- Apply only NEW rows to dkp_summary (no full table scan). For DELETE/UPDATE we run full refresh.
-- Run a full refresh daily (e.g. pg_cron) so 30d/60d windows roll; delta triggers do not recompute period totals.

CREATE OR REPLACE FUNCTION public.trigger_delta_event_attendance()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO dkp_summary (character_key, character_name, earned, spent, last_activity_date, updated_at)
  WITH delta AS (
    SELECT
      (CASE WHEN COALESCE(trim(nr.char_id::text), '') = '' THEN COALESCE(trim(nr.character_name), 'unknown') ELSE trim(nr.char_id::text) END) AS character_key,
      MAX(COALESCE(trim(nr.character_name), nr.char_id::text, 'unknown')) AS character_name,
      SUM(COALESCE((re.dkp_value::numeric), 0)) AS earned,
      MAX((r.date_iso::date)) AS last_activity_date
    FROM new_rows nr
    LEFT JOIN raid_events re ON re.raid_id = nr.raid_id AND re.event_id = nr.event_id
    LEFT JOIN raids r ON r.raid_id = nr.raid_id
    GROUP BY (CASE WHEN COALESCE(trim(nr.char_id::text), '') = '' THEN COALESCE(trim(nr.character_name), 'unknown') ELSE trim(nr.char_id::text) END)
  )
  SELECT character_key, character_name, earned, 0, last_activity_date, now() FROM delta
  ON CONFLICT (character_key) DO UPDATE SET
    earned = dkp_summary.earned + EXCLUDED.earned,
    last_activity_date = GREATEST(COALESCE(dkp_summary.last_activity_date, '1970-01-01'::date), COALESCE(EXCLUDED.last_activity_date, '1970-01-01'::date)),
    updated_at = now(),
    character_name = COALESCE(EXCLUDED.character_name, dkp_summary.character_name);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.trigger_delta_attendance()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO dkp_summary (character_key, character_name, earned, spent, last_activity_date, updated_at)
  WITH delta AS (
    SELECT
      (CASE WHEN COALESCE(trim(nr.char_id::text), '') = '' THEN COALESCE(trim(nr.character_name), 'unknown') ELSE trim(nr.char_id::text) END) AS character_key,
      MAX(COALESCE(trim(nr.character_name), nr.char_id::text, 'unknown')) AS character_name,
      SUM(COALESCE(rt.dkp, 0)) AS earned,
      MAX((r.date_iso::date)) AS last_activity_date
    FROM new_rows nr
    LEFT JOIN raids r ON r.raid_id = nr.raid_id
    LEFT JOIN (SELECT raid_id, SUM((dkp_value::numeric)) AS dkp FROM raid_events GROUP BY raid_id) rt ON rt.raid_id = nr.raid_id
    GROUP BY (CASE WHEN COALESCE(trim(nr.char_id::text), '') = '' THEN COALESCE(trim(nr.character_name), 'unknown') ELSE trim(nr.char_id::text) END)
  )
  SELECT character_key, character_name, earned, 0, last_activity_date, now() FROM delta
  ON CONFLICT (character_key) DO UPDATE SET
    earned = dkp_summary.earned + EXCLUDED.earned,
    last_activity_date = GREATEST(COALESCE(dkp_summary.last_activity_date, '1970-01-01'::date), COALESCE(EXCLUDED.last_activity_date, '1970-01-01'::date)),
    updated_at = now(),
    character_name = COALESCE(EXCLUDED.character_name, dkp_summary.character_name);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.trigger_delta_loot()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO dkp_summary (character_key, character_name, earned, spent, last_activity_date, updated_at)
  WITH delta AS (
    SELECT
      (CASE WHEN COALESCE(trim(nr.char_id::text), '') = '' THEN COALESCE(trim(nr.character_name), 'unknown') ELSE trim(nr.char_id::text) END) AS character_key,
      MAX(COALESCE(trim(nr.character_name), nr.char_id::text, 'unknown')) AS character_name,
      SUM(COALESCE((nr.cost::integer), 0)) AS spent,
      MAX((r.date_iso::date)) AS last_activity_date
    FROM new_rows nr
    LEFT JOIN raids r ON r.raid_id = nr.raid_id
    GROUP BY (CASE WHEN COALESCE(trim(nr.char_id::text), '') = '' THEN COALESCE(trim(nr.character_name), 'unknown') ELSE trim(nr.char_id::text) END)
  )
  SELECT character_key, character_name, 0, spent, last_activity_date, now() FROM delta
  ON CONFLICT (character_key) DO UPDATE SET
    spent = dkp_summary.spent + EXCLUDED.spent,
    last_activity_date = GREATEST(COALESCE(dkp_summary.last_activity_date, '1970-01-01'::date), COALESCE(EXCLUDED.last_activity_date, '1970-01-01'::date)),
    updated_at = now(),
    character_name = COALESCE(EXCLUDED.character_name, dkp_summary.character_name);
  RETURN NULL;
END;
$$;

-- Triggers: only on INSERT so we only apply delta (new rows). For DELETE/UPDATE run full refresh.
DROP TRIGGER IF EXISTS refresh_dkp_after_event_attendance ON raid_event_attendance;
CREATE TRIGGER delta_dkp_after_event_attendance
  AFTER INSERT ON raid_event_attendance
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.trigger_delta_event_attendance();

DROP TRIGGER IF EXISTS refresh_dkp_after_attendance ON raid_attendance;
CREATE TRIGGER delta_dkp_after_attendance
  AFTER INSERT ON raid_attendance
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.trigger_delta_attendance();

DROP TRIGGER IF EXISTS refresh_dkp_after_loot ON raid_loot;
CREATE TRIGGER delta_dkp_after_loot
  AFTER INSERT ON raid_loot
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.trigger_delta_loot();

-- On UPDATE or DELETE we run full refresh so corrections/deletions are applied (rare path).
DROP TRIGGER IF EXISTS full_refresh_dkp_after_event_attendance_change ON raid_event_attendance;
CREATE TRIGGER full_refresh_dkp_after_event_attendance_change
  AFTER UPDATE OR DELETE ON raid_event_attendance
  FOR EACH STATEMENT EXECUTE FUNCTION public.trigger_refresh_dkp_summary();

DROP TRIGGER IF EXISTS full_refresh_dkp_after_attendance_change ON raid_attendance;
CREATE TRIGGER full_refresh_dkp_after_attendance_change
  AFTER UPDATE OR DELETE ON raid_attendance
  FOR EACH STATEMENT EXECUTE FUNCTION public.trigger_refresh_dkp_summary();

DROP TRIGGER IF EXISTS full_refresh_dkp_after_loot_change ON raid_loot;
CREATE TRIGGER full_refresh_dkp_after_loot_change
  AFTER UPDATE OR DELETE ON raid_loot
  FOR EACH STATEMENT EXECUTE FUNCTION public.trigger_refresh_dkp_summary();

-- 3) Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, role)
  VALUES (NEW.id, NEW.email, 'player');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 4) RLS: enable on all tables
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE characters ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE character_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE raids ENABLE ROW LEVEL SECURITY;
ALTER TABLE raid_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE raid_loot ENABLE ROW LEVEL SECURITY;
ALTER TABLE raid_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE raid_event_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE raid_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE dkp_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE dkp_summary ENABLE ROW LEVEL SECURITY;
ALTER TABLE dkp_period_totals ENABLE ROW LEVEL SECURITY;
ALTER TABLE active_raiders ENABLE ROW LEVEL SECURITY;

-- Profiles: users read own row; officers read all (drop first so script is re-runnable)
DROP POLICY IF EXISTS "Users can read own profile" ON profiles;
CREATE POLICY "Users can read own profile" ON profiles
  FOR SELECT USING (auth.uid() = id);

DROP POLICY IF EXISTS "Officers can read all profiles" ON profiles;
CREATE POLICY "Officers can read all profiles" ON profiles
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'officer')
  );

DROP POLICY IF EXISTS "Users can update own profile (limited)" ON profiles;
CREATE POLICY "Users can update own profile (limited)" ON profiles
  FOR UPDATE USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "Officers can update profiles" ON profiles;
CREATE POLICY "Officers can update profiles" ON profiles
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'officer')
  );

-- Data tables: any authenticated user can read (drop first so script is re-runnable)
DROP POLICY IF EXISTS "Authenticated read characters" ON characters;
CREATE POLICY "Authenticated read characters" ON characters FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Authenticated read accounts" ON accounts;
CREATE POLICY "Authenticated read accounts" ON accounts FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Authenticated read character_account" ON character_account;
CREATE POLICY "Authenticated read character_account" ON character_account FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Authenticated read raids" ON raids;
CREATE POLICY "Authenticated read raids" ON raids FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Authenticated read raid_events" ON raid_events;
CREATE POLICY "Authenticated read raid_events" ON raid_events FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Authenticated read raid_loot" ON raid_loot;
CREATE POLICY "Authenticated read raid_loot" ON raid_loot FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Authenticated read raid_attendance" ON raid_attendance;
CREATE POLICY "Authenticated read raid_attendance" ON raid_attendance FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Authenticated read raid_event_attendance" ON raid_event_attendance;
CREATE POLICY "Authenticated read raid_event_attendance" ON raid_event_attendance FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Authenticated read raid_classifications" ON raid_classifications;
CREATE POLICY "Authenticated read raid_classifications" ON raid_classifications FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Authenticated read dkp_adjustments" ON dkp_adjustments;
CREATE POLICY "Authenticated read dkp_adjustments" ON dkp_adjustments FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Authenticated read dkp_summary" ON dkp_summary;
CREATE POLICY "Authenticated read dkp_summary" ON dkp_summary FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Authenticated read dkp_period_totals" ON dkp_period_totals;
CREATE POLICY "Authenticated read dkp_period_totals" ON dkp_period_totals FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Authenticated read active_raiders" ON active_raiders;
CREATE POLICY "Authenticated read active_raiders" ON active_raiders FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Officers manage active_raiders" ON active_raiders;
CREATE POLICY "Officers manage active_raiders" ON active_raiders FOR ALL TO authenticated USING (
  EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'officer')
) WITH CHECK (
  EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'officer')
);

-- 5) First officer: run after creating your user in Supabase Auth (replace YOUR_USER_UUID)
-- INSERT INTO profiles (id, email, role) VALUES ('YOUR_USER_UUID', 'your@email.com', 'officer')
-- ON CONFLICT (id) DO UPDATE SET role = 'officer';
