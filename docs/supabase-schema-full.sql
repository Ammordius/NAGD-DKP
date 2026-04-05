-- =============================================================================
-- Single canonical schema. Run this once in Supabase SQL Editor after creating a project.
-- Tables, RLS, triggers, account DKP, officer writes, upload script RPCs.
-- =============================================================================

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
  toon_count INTEGER,
  display_name TEXT
);

CREATE TABLE IF NOT EXISTS character_account (
  char_id TEXT REFERENCES characters(char_id),
  account_id TEXT REFERENCES accounts(account_id),
  PRIMARY KEY (char_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_character_account_account_id ON character_account(account_id);

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

-- raid_loot: CI upserts by id with conflict resolution (UPDATE existing rows), not ignore.
-- Use update_raid_loot_assignments RPC (see supabase-loot-to-character.sql) for bulk assignment updates.
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

-- Pre-computed DKP per raid (sum of event dkp_value). Updated by trigger when raid_events change.
-- After first deploy or import, run: SELECT refresh_all_raid_attendance_totals();
CREATE TABLE IF NOT EXISTS raid_dkp_totals (
  raid_id TEXT PRIMARY KEY REFERENCES raids(raid_id),
  total_dkp NUMERIC NOT NULL DEFAULT 0
);

-- Pre-computed DKP earned per character per raid. Updated by trigger when raid_events or raid_event_attendance change.
-- Activity page reads this instead of per-tic data. character_key matches dkp_summary (char_id or character_name).
CREATE TABLE IF NOT EXISTS raid_attendance_dkp (
  raid_id TEXT NOT NULL REFERENCES raids(raid_id),
  character_key TEXT NOT NULL,
  character_name TEXT,
  dkp_earned NUMERIC NOT NULL DEFAULT 0,
  PRIMARY KEY (raid_id, character_key)
);

-- View for fetching raid_events in reverse chronological order (most recent raids first when paginating).
-- Use table name raid_events_ordered with .order('raid_date_iso', { ascending: false }) so first pages are latest.
CREATE OR REPLACE VIEW raid_events_ordered WITH (security_invoker = true) AS
  SELECT re.id, re.raid_id, re.event_id, re.event_order, re.event_name, re.dkp_value, re.attendee_count, re.event_time,
         r.date_iso AS raid_date_iso
  FROM raid_events re
  LEFT JOIN raids r ON r.raid_id = re.raid_id;

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

-- Officer audit log: who, what, when for sensitive officer actions (add raid, edit DKP totals). Officer-only (RLS). Append-only.
CREATE TABLE IF NOT EXISTS officer_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_email TEXT,
  actor_display_name TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  delta JSONB
);
ALTER TABLE officer_audit_log ADD COLUMN IF NOT EXISTS actor_display_name TEXT;
COMMENT ON TABLE officer_audit_log IS 'Audit trail for officer actions: add_raid, add_tic, delete_event, raid_deleted, add_loot, add_loot_from_log, delete_loot, add_attendee_to_tic, remove_attendee_from_tic, edit_event_dkp, edit_event_time, edit_loot_cost. Delta is minimal (short keys) to limit storage and egress.';

-- Add new columns if upgrading from an older schema (no-op if already present)
ALTER TABLE dkp_summary ADD COLUMN IF NOT EXISTS last_activity_date DATE;
ALTER TABLE dkp_summary ADD COLUMN IF NOT EXISTS earned_30d INTEGER;
ALTER TABLE dkp_summary ADD COLUMN IF NOT EXISTS earned_60d INTEGER;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS inactive BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN accounts.inactive IS 'When true: account is hidden from DKP leaderboard and Accounts list; loot and tics still show on raid/character views.';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS account_id TEXT REFERENCES accounts(account_id);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS unclaim_cooldown_until TIMESTAMPTZ;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS unclaim_count INTEGER NOT NULL DEFAULT 0;
COMMENT ON COLUMN profiles.unclaim_cooldown_until IS 'After unclaiming an account, user cannot claim again until this time. 1st unclaim: 10 min, 2nd: 1 day, 3rd+: 7 days. Officers can reset via reset_claim_cooldown.';
COMMENT ON COLUMN profiles.unclaim_count IS 'Number of times this user has unclaimed an account; used to tier cooldown duration.';

-- Parse raids.date_iso to DATE safely (handles YYYY-MM-DD, YYYY-MM-DDThh:mm:ss, empty/null). Returns NULL if not parseable.
CREATE OR REPLACE FUNCTION public.raid_date_parsed(iso_text TEXT)
RETURNS DATE LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN iso_text IS NOT NULL AND trim(iso_text) ~ '^\d{4}-\d{2}-\d{2}'
    THEN (SUBSTRING(trim(iso_text) FROM 1 FOR 10))::date
    ELSE NULL
  END
$$;

-- Helper: current user is officer (SECURITY DEFINER so reading profiles doesn't trigger RLS). Must be defined before any RPC or policy that calls it.
CREATE OR REPLACE FUNCTION public.is_officer()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'officer');
$$;

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_raid_events_raid ON raid_events(raid_id);
CREATE INDEX IF NOT EXISTS idx_raid_loot_raid ON raid_loot(raid_id);
CREATE INDEX IF NOT EXISTS idx_raid_loot_char ON raid_loot(char_id);
CREATE INDEX IF NOT EXISTS idx_raid_attendance_raid ON raid_attendance(raid_id);
CREATE INDEX IF NOT EXISTS idx_raid_attendance_char ON raid_attendance(char_id);
CREATE INDEX IF NOT EXISTS idx_raid_event_attendance_raid ON raid_event_attendance(raid_id);
CREATE INDEX IF NOT EXISTS idx_raid_event_attendance_char ON raid_event_attendance(char_id);
-- Prevent same character being added to the same tic twice (see docs/fix_duplicate_tic_attendance_and_prevent.sql)
CREATE UNIQUE INDEX IF NOT EXISTS uq_raid_event_attendance_raid_event_char_id
  ON raid_event_attendance (raid_id, event_id, char_id)
  WHERE char_id IS NOT NULL AND trim(char_id::text) <> '';
CREATE UNIQUE INDEX IF NOT EXISTS uq_raid_event_attendance_raid_event_character_name
  ON raid_event_attendance (raid_id, event_id, character_name)
  WHERE character_name IS NOT NULL AND trim(character_name) <> '';
CREATE INDEX IF NOT EXISTS idx_raid_attendance_dkp_character ON raid_attendance_dkp(character_key);
CREATE INDEX IF NOT EXISTS idx_raid_attendance_dkp_raid ON raid_attendance_dkp(raid_id);
CREATE INDEX IF NOT EXISTS idx_raid_classifications_raid ON raid_classifications(raid_id);
CREATE INDEX IF NOT EXISTS idx_raid_classifications_mob ON raid_classifications(mob);
CREATE INDEX IF NOT EXISTS idx_dkp_adjustments_name ON dkp_adjustments(character_name);
CREATE INDEX IF NOT EXISTS officer_audit_log_created_at_desc ON officer_audit_log (created_at DESC);

-- Loot-only audit view: who added/deleted/edited raid_loot (see docs/AUDIT-OF-AUDIT-LOOT.md)
CREATE OR REPLACE VIEW officer_audit_loot WITH (security_invoker = true) AS
SELECT id, created_at, actor_id, actor_email, actor_display_name, action, target_type, target_id, delta
FROM officer_audit_log
WHERE action IN ('add_loot', 'add_loot_from_log', 'delete_loot', 'edit_loot_cost');
COMMENT ON VIEW officer_audit_loot IS 'Loot-related officer audit entries. Delta: r=raid_id, l=loot_id, i=item_name, c=character_name, cost=DKP; add_loot_from_log has items[].';
GRANT SELECT ON officer_audit_loot TO authenticated;

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
        (SUM(CASE WHEN raid_date_parsed(r.date_iso) >= (current_date - 30) THEN COALESCE((re.dkp_value::numeric), 0) ELSE 0 END))::INTEGER AS earned_30d,
        (SUM(CASE WHEN raid_date_parsed(r.date_iso) >= (current_date - 60) THEN COALESCE((re.dkp_value::numeric), 0) ELSE 0 END))::INTEGER AS earned_60d,
        MAX(raid_date_parsed(r.date_iso)) AS last_activity_date
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

-- RPC: officers only when called with auth (e.g. from app). When auth.uid() is NULL (e.g. SQL Editor, pg_cron), allow so admins can run refresh.
CREATE OR REPLACE FUNCTION public.refresh_dkp_summary()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_officer() THEN
    RAISE EXCEPTION 'Only officers can refresh DKP summary';
  END IF;
  PERFORM refresh_dkp_summary_internal();
END;
$$;

-- RPC: add a character to an account. Links existing character or creates a new one if not in DB.
-- p_account_id: account to add to (optional); if null, uses current user's claimed account. Officers can pass any account_id.
-- p_character_name: display name (required). p_char_id_override: optional server char_id; if provided and exists, links that character.
CREATE OR REPLACE FUNCTION public.add_character_to_my_account(p_character_name text, p_char_id_override text DEFAULT NULL, p_account_id text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id text;
  v_my_account_id text;
  v_char_id text;
  v_name_trim text;
  v_char_id_use text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT account_id INTO v_my_account_id FROM public.profiles WHERE id = auth.uid();

  IF p_account_id IS NOT NULL AND trim(p_account_id) <> '' THEN
    IF NOT public.is_officer() AND (v_my_account_id IS NULL OR v_my_account_id <> trim(p_account_id)) THEN
      RAISE EXCEPTION 'You can only add characters to your own claimed account';
    END IF;
    v_account_id := trim(p_account_id);
  ELSE
    v_account_id := v_my_account_id;
  END IF;

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'No account claimed. Claim an account first.';
  END IF;

  v_name_trim := trim(coalesce(p_character_name, ''));
  IF v_name_trim = '' THEN
    RAISE EXCEPTION 'Character name is required';
  END IF;

  -- Resolve character: by char_id override if given, else by name
  IF p_char_id_override IS NOT NULL AND trim(p_char_id_override) <> '' THEN
    SELECT c.char_id INTO v_char_id FROM characters c WHERE c.char_id = trim(p_char_id_override) LIMIT 1;
    IF v_char_id IS NOT NULL THEN
      INSERT INTO character_account (char_id, account_id) VALUES (v_char_id, v_account_id)
      ON CONFLICT (char_id, account_id) DO NOTHING;
      RETURN;
    END IF;
  END IF;

  -- Look up by name (exact match preferred, then ilike)
  SELECT c.char_id INTO v_char_id
  FROM characters c
  WHERE trim(coalesce(c.name, '')) = v_name_trim
  LIMIT 1;
  IF v_char_id IS NULL THEN
    SELECT c.char_id INTO v_char_id
    FROM characters c
    WHERE c.name ILIKE v_name_trim
    LIMIT 1;
  END IF;

  IF v_char_id IS NOT NULL THEN
    INSERT INTO character_account (char_id, account_id) VALUES (v_char_id, v_account_id)
    ON CONFLICT (char_id, account_id) DO NOTHING;
    RETURN;
  END IF;

  -- Multiple matches by ilike: require exact name or char_id
  IF (SELECT count(*) FROM characters c WHERE c.name ILIKE v_name_trim) > 1 THEN
    RAISE EXCEPTION 'Multiple characters match; use exact name or char_id';
  END IF;

  -- Not found: create new character and link
  v_char_id_use := coalesce(nullif(trim(p_char_id_override), ''), v_name_trim);
  INSERT INTO characters (char_id, name) VALUES (v_char_id_use, v_name_trim);
  INSERT INTO character_account (char_id, account_id) VALUES (v_char_id_use, v_account_id)
  ON CONFLICT (char_id, account_id) DO NOTHING;
  RETURN;
EXCEPTION
  WHEN unique_violation THEN
    -- character already exists (e.g. char_id_use taken); try to link it
    SELECT char_id INTO v_char_id FROM characters WHERE char_id = v_char_id_use LIMIT 1;
    IF v_char_id IS NOT NULL THEN
      INSERT INTO character_account (char_id, account_id) VALUES (v_char_id, v_account_id)
      ON CONFLICT (char_id, account_id) DO NOTHING;
      RETURN;
    END IF;
    RAISE EXCEPTION 'Character with this ID already exists; use a different name or char_id';
END;
$$;

-- RPC: create exactly one DKP account for the current user and claim it. Fails if user already has an account.
-- Returns the new account_id. Caller must be authenticated and must not already have profile.account_id set.
CREATE OR REPLACE FUNCTION public.create_my_account(p_display_name text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid;
  v_existing_id text;
  v_new_account_id text;
  v_display text;
  v_cooldown_until timestamptz;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT account_id, unclaim_cooldown_until INTO v_existing_id, v_cooldown_until FROM public.profiles WHERE id = v_uid;
  IF v_existing_id IS NOT NULL AND trim(v_existing_id) <> '' THEN
    RAISE EXCEPTION 'You already have an account. Unclaim it first if you want to create a different one.';
  END IF;
  IF NOT public.is_officer() AND v_cooldown_until IS NOT NULL AND v_cooldown_until > now() THEN
    RAISE EXCEPTION 'You cannot claim or create an account until % (cooldown after unclaiming). An officer can remove this cooldown.', v_cooldown_until;
  END IF;

  v_display := trim(coalesce(p_display_name, ''));
  IF v_display = '' THEN
    v_display := 'My account';
  END IF;

  v_new_account_id := gen_random_uuid()::text;
  INSERT INTO public.accounts (account_id, display_name, toon_count, char_ids, toon_names)
  VALUES (v_new_account_id, v_display, 0, NULL, NULL);

  UPDATE public.profiles SET account_id = v_new_account_id, updated_at = now() WHERE id = v_uid;

  RETURN v_new_account_id;
END;
$$;

-- RPC: officer-only. Create a new DKP account (unclaimed). Player can then claim it on the account page.
-- Returns the new account_id. Share the account link so the player can claim it.
CREATE OR REPLACE FUNCTION public.create_account(p_display_name text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_account_id text;
  v_display text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT public.is_officer() THEN
    RAISE EXCEPTION 'Only officers can create new DKP accounts';
  END IF;

  v_display := trim(coalesce(p_display_name, ''));
  IF v_display = '' THEN
    v_display := 'New account';
  END IF;

  v_new_account_id := gen_random_uuid()::text;
  INSERT INTO public.accounts (account_id, display_name, toon_count, char_ids, toon_names)
  VALUES (v_new_account_id, v_display, 0, NULL, NULL);

  RETURN v_new_account_id;
END;
$$;

-- RPC: unclaim current user's account and set cooldown before they can claim again.
-- Cooldown: 1st unclaim 10 min, 2nd 1 day, 3rd+ 7 days. Officers never get a cooldown.
CREATE OR REPLACE FUNCTION public.unclaim_account()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid;
  v_count integer;
  v_until timestamptz;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF public.is_officer() THEN
    UPDATE public.profiles SET account_id = NULL, updated_at = now() WHERE id = v_uid;
    RETURN;
  END IF;

  SELECT COALESCE(unclaim_count, 0) + 1 INTO v_count FROM public.profiles WHERE id = v_uid;
  v_until := now() + CASE
    WHEN v_count <= 1 THEN interval '10 minutes'
    WHEN v_count = 2 THEN interval '1 day'
    ELSE interval '7 days'
  END;

  UPDATE public.profiles
  SET account_id = NULL, updated_at = now(), unclaim_count = v_count, unclaim_cooldown_until = v_until
  WHERE id = v_uid;
END;
$$;

-- RPC: claim an account for the current user. Fails if user is on cooldown (unclaim_cooldown_until > now()). Officers bypass cooldown.
CREATE OR REPLACE FUNCTION public.claim_account(p_account_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid;
  v_until timestamptz;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT public.is_officer() THEN
    SELECT unclaim_cooldown_until INTO v_until FROM public.profiles WHERE id = v_uid;
    IF v_until IS NOT NULL AND v_until > now() THEN
      RAISE EXCEPTION 'You cannot claim an account until % (cooldown after unclaiming). An officer can remove this cooldown.', v_until;
    END IF;
  END IF;

  UPDATE public.profiles SET account_id = trim(p_account_id), updated_at = now() WHERE id = v_uid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;
END;
$$;

-- RPC: officer-only. Clear unclaim cooldown for a profile so they can claim again immediately.
CREATE OR REPLACE FUNCTION public.reset_claim_cooldown(p_profile_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT public.is_officer() THEN
    RAISE EXCEPTION 'Only officers can reset claim cooldown';
  END IF;

  UPDATE public.profiles
  SET unclaim_cooldown_until = NULL, unclaim_count = 0, updated_at = now()
  WHERE id = p_profile_id;
END;
$$;

-- Full refresh trigger (used only on UPDATE/DELETE so corrections are applied).
CREATE OR REPLACE FUNCTION public.trigger_refresh_dkp_summary()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF restore_load_in_progress() THEN RETURN NULL; END IF;
  PERFORM refresh_dkp_summary_internal();
  RETURN NULL;
END;
$$;

-- Refresh raid_dkp_totals, raid_attendance_dkp, and raid_attendance_dkp_by_account for one raid (used by triggers and by backfill).
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

-- Backfill all raids in one go (set-based). Use this after bulk import instead of looping refresh_raid_attendance_totals to avoid timeout.
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
           SUM(COALESCE((re.dkp_value::numeric), 0))
    FROM raid_event_attendance rea
    LEFT JOIN raid_events re ON re.raid_id = rea.raid_id AND re.event_id = rea.event_id
    GROUP BY rea.raid_id, (CASE WHEN COALESCE(trim(rea.char_id::text), '') = '' THEN COALESCE(trim(rea.character_name), 'unknown') ELSE trim(rea.char_id::text) END);

    -- 4a) raid_attendance_dkp_by_account (all raids in one statement)
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
    WHERE rea.account_id IS NOT NULL OR x.aid IS NOT NULL
    GROUP BY rea.raid_id, COALESCE(rea.account_id, x.aid);
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

-- Restore load mode: when true, DKP triggers no-op so bulk insert is fast; restore script calls end_restore_load() to clear and run refresh.
CREATE TABLE IF NOT EXISTS public.restore_in_progress (id int PRIMARY KEY DEFAULT 1, in_progress boolean NOT NULL DEFAULT false);
INSERT INTO public.restore_in_progress (id, in_progress) VALUES (1, false) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.restore_in_progress ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated read restore_in_progress" ON public.restore_in_progress;
CREATE POLICY "Authenticated read restore_in_progress" ON public.restore_in_progress FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Service role full restore_in_progress" ON public.restore_in_progress;
CREATE POLICY "Service role full restore_in_progress" ON public.restore_in_progress FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.restore_load_in_progress()
RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT in_progress FROM restore_in_progress WHERE id = 1 LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.begin_restore_load()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO restore_in_progress (id, in_progress) VALUES (1, true) ON CONFLICT (id) DO UPDATE SET in_progress = true;
END;
$$;
COMMENT ON FUNCTION public.begin_restore_load() IS 'Signal start of bulk restore load; DKP triggers skip work until end_restore_load().';
GRANT EXECUTE ON FUNCTION public.begin_restore_load() TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_restore_load() TO authenticated;

-- Fix serial sequences after restore: backup CSVs include explicit id values, so the sequence
-- stays at 1 and the next insert would duplicate. Call this after loading tables with id columns.
CREATE OR REPLACE FUNCTION public.fix_serial_sequences_for_restore()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r RECORD;
  seq_name text;
  max_id bigint;
BEGIN
  FOR r IN (SELECT t.relname AS tablename, a.attname AS columnname
            FROM pg_class t
            JOIN pg_attribute a ON a.attrelid = t.oid
            WHERE t.relkind = 'r' AND t.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
            AND a.attname = 'id' AND a.attnum > 0 AND NOT a.attisdropped
            AND t.relname IN ('raid_events', 'raid_loot', 'raid_attendance', 'raid_event_attendance', 'officer_audit_log'))
  LOOP
    seq_name := pg_get_serial_sequence(quote_ident(r.tablename), r.columnname);
    IF seq_name IS NOT NULL THEN
      EXECUTE format('SELECT COALESCE(max(id), 1) FROM %I', r.tablename) INTO max_id;
      EXECUTE format('SELECT setval(%L, %s)', seq_name, max_id);
    END IF;
  END LOOP;
END;
$$;
COMMENT ON FUNCTION public.fix_serial_sequences_for_restore() IS 'Set serial sequences to max(id) for tables restored from CSV with explicit id; prevents duplicate key on next insert.';

-- Trigger: when raid_events change, refresh totals for affected raid(s).
CREATE OR REPLACE FUNCTION public.trigger_refresh_raid_totals_after_events()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF restore_load_in_progress() THEN IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
  IF TG_OP = 'DELETE' THEN
    PERFORM refresh_raid_attendance_totals(OLD.raid_id);
    RETURN OLD;
  ELSE
    PERFORM refresh_raid_attendance_totals(NEW.raid_id);
    RETURN NEW;
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS refresh_raid_totals_after_events_ins ON raid_events;
DROP TRIGGER IF EXISTS refresh_raid_totals_after_events_upd ON raid_events;
DROP TRIGGER IF EXISTS refresh_raid_totals_after_events_del ON raid_events;
CREATE TRIGGER refresh_raid_totals_after_events_ins AFTER INSERT ON raid_events FOR EACH ROW EXECUTE FUNCTION public.trigger_refresh_raid_totals_after_events();
CREATE TRIGGER refresh_raid_totals_after_events_upd AFTER UPDATE ON raid_events FOR EACH ROW EXECUTE FUNCTION public.trigger_refresh_raid_totals_after_events();
CREATE TRIGGER refresh_raid_totals_after_events_del AFTER DELETE ON raid_events FOR EACH ROW EXECUTE FUNCTION public.trigger_refresh_raid_totals_after_events();

-- Trigger: when raid_event_attendance change, refresh per-character totals for affected raid(s).
CREATE OR REPLACE FUNCTION public.trigger_refresh_raid_totals_after_event_attendance()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF restore_load_in_progress() THEN IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
  IF TG_OP = 'DELETE' THEN
    PERFORM refresh_raid_attendance_totals(OLD.raid_id);
    RETURN OLD;
  ELSE
    PERFORM refresh_raid_attendance_totals(NEW.raid_id);
    RETURN NEW;
  END IF;
END;
$$;

-- Statement-level DELETE: refresh each affected raid once (avoids timeout when deleting a tic with many rows).
CREATE OR REPLACE FUNCTION public.trigger_refresh_raid_totals_after_event_attendance_del_stmt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
BEGIN
  IF restore_load_in_progress() THEN RETURN NULL; END IF;
  FOR r IN SELECT DISTINCT raid_id FROM deleted_rows
  LOOP
    PERFORM refresh_raid_attendance_totals(r.raid_id);
  END LOOP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS refresh_raid_totals_after_event_attendance_ins ON raid_event_attendance;
DROP TRIGGER IF EXISTS refresh_raid_totals_after_event_attendance_upd ON raid_event_attendance;
DROP TRIGGER IF EXISTS refresh_raid_totals_after_event_attendance_del ON raid_event_attendance;
CREATE TRIGGER refresh_raid_totals_after_event_attendance_ins AFTER INSERT ON raid_event_attendance FOR EACH ROW EXECUTE FUNCTION public.trigger_refresh_raid_totals_after_event_attendance();
CREATE TRIGGER refresh_raid_totals_after_event_attendance_upd AFTER UPDATE ON raid_event_attendance FOR EACH ROW EXECUTE FUNCTION public.trigger_refresh_raid_totals_after_event_attendance();
CREATE TRIGGER refresh_raid_totals_after_event_attendance_del
  AFTER DELETE ON raid_event_attendance
  REFERENCING OLD TABLE AS deleted_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.trigger_refresh_raid_totals_after_event_attendance_del_stmt();

-- Incremental delta: cache is refreshed whenever a new row is added (INSERT) to attendance or loot.
-- Apply only NEW rows to dkp_summary (no full table scan). For DELETE/UPDATE we run full refresh.
-- Run a full refresh daily (e.g. pg_cron) so 30d/60d windows roll; delta triggers do not recompute period totals.

CREATE OR REPLACE FUNCTION public.trigger_delta_event_attendance()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF restore_load_in_progress() THEN RETURN NULL; END IF;
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
  IF restore_load_in_progress() THEN RETURN NULL; END IF;
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
  IF restore_load_in_progress() THEN RETURN NULL; END IF;
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
DROP TRIGGER IF EXISTS delta_dkp_after_event_attendance ON raid_event_attendance;
CREATE TRIGGER delta_dkp_after_event_attendance
  AFTER INSERT ON raid_event_attendance
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.trigger_delta_event_attendance();

DROP TRIGGER IF EXISTS refresh_dkp_after_attendance ON raid_attendance;
DROP TRIGGER IF EXISTS delta_dkp_after_attendance ON raid_attendance;
CREATE TRIGGER delta_dkp_after_attendance
  AFTER INSERT ON raid_attendance
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.trigger_delta_attendance();

DROP TRIGGER IF EXISTS refresh_dkp_after_loot ON raid_loot;
DROP TRIGGER IF EXISTS delta_dkp_after_loot ON raid_loot;
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
ALTER TABLE raid_dkp_totals ENABLE ROW LEVEL SECURITY;
ALTER TABLE raid_attendance_dkp ENABLE ROW LEVEL SECURITY;
ALTER TABLE officer_audit_log ENABLE ROW LEVEL SECURITY;

-- Data tables: any authenticated user can read (drop first so script is re-runnable)
DROP POLICY IF EXISTS "Authenticated read characters" ON characters;
CREATE POLICY "Authenticated read characters" ON characters FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Authenticated read accounts" ON accounts;
CREATE POLICY "Authenticated read accounts" ON accounts FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Officers update accounts" ON accounts;
CREATE POLICY "Officers update accounts" ON accounts FOR UPDATE TO authenticated
  USING (public.is_officer()) WITH CHECK (public.is_officer());
DROP POLICY IF EXISTS "Authenticated read character_account" ON character_account;
CREATE POLICY "Authenticated read character_account" ON character_account FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Officers manage character_account" ON character_account;
CREATE POLICY "Officers manage character_account" ON character_account FOR ALL TO authenticated
  USING (public.is_officer())
  WITH CHECK (public.is_officer());
DROP POLICY IF EXISTS "Users add character to own claimed account" ON character_account;
CREATE POLICY "Users add character to own claimed account" ON character_account FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT account_id FROM public.profiles WHERE id = auth.uid()) = character_account.account_id
  );
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
DROP POLICY IF EXISTS "Authenticated read raid_dkp_totals" ON raid_dkp_totals;
CREATE POLICY "Authenticated read raid_dkp_totals" ON raid_dkp_totals FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Authenticated read raid_attendance_dkp" ON raid_attendance_dkp;
CREATE POLICY "Authenticated read raid_attendance_dkp" ON raid_attendance_dkp FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Officers manage active_raiders" ON active_raiders;
CREATE POLICY "Officers manage active_raiders" ON active_raiders FOR ALL TO authenticated
  USING (public.is_officer())
  WITH CHECK (public.is_officer());

-- Officer audit log: officers only (no anon, no authenticated read for non-officers). Append-only.
DROP POLICY IF EXISTS "Officer audit log select" ON officer_audit_log;
CREATE POLICY "Officer audit log select" ON officer_audit_log FOR SELECT USING (public.is_officer());
DROP POLICY IF EXISTS "Officer audit log insert" ON officer_audit_log;
CREATE POLICY "Officer audit log insert" ON officer_audit_log FOR INSERT WITH CHECK (public.is_officer());

-- Data tables: no anon read. Only authenticated users (and officers) can read (see "Authenticated read" policies above).
-- Anon key is used only for auth handshake and sign-in; all data access requires a signed-in user.
-- Drop anon read policies if present (so reapplying this full schema gives correct permissions).
DROP POLICY IF EXISTS "Anon read characters" ON characters;
DROP POLICY IF EXISTS "Anon read accounts" ON accounts;
DROP POLICY IF EXISTS "Anon read character_account" ON character_account;
DROP POLICY IF EXISTS "Anon read raids" ON raids;
DROP POLICY IF EXISTS "Anon read raid_events" ON raid_events;
DROP POLICY IF EXISTS "Anon read raid_loot" ON raid_loot;
DROP POLICY IF EXISTS "Anon read raid_attendance" ON raid_attendance;
DROP POLICY IF EXISTS "Anon read raid_event_attendance" ON raid_event_attendance;
DROP POLICY IF EXISTS "Anon read raid_classifications" ON raid_classifications;
DROP POLICY IF EXISTS "Anon read dkp_adjustments" ON dkp_adjustments;
DROP POLICY IF EXISTS "Anon read dkp_summary" ON dkp_summary;
DROP POLICY IF EXISTS "Anon read dkp_period_totals" ON dkp_period_totals;
DROP POLICY IF EXISTS "Anon read active_raiders" ON active_raiders;
DROP POLICY IF EXISTS "Anon read raid_dkp_totals" ON raid_dkp_totals;
DROP POLICY IF EXISTS "Anon read raid_attendance_dkp" ON raid_attendance_dkp;

-- 5) First officer: run after creating your user in Supabase Auth (replace YOUR_USER_UUID)
-- INSERT INTO profiles (id, email, role) VALUES ('YOUR_USER_UUID', 'your@email.com', 'officer')
-- ON CONFLICT (id) DO UPDATE SET role = 'officer';



-- Stub so refresh_account_dkp_summary_internal can reference loot_assignment (LEFT JOIN LATERAL).
-- If you later run supabase-loot-assignment-table.sql, it uses CREATE TABLE IF NOT EXISTS and adds views/RPCs.
CREATE TABLE IF NOT EXISTS loot_assignment (
  loot_id BIGINT PRIMARY KEY REFERENCES raid_loot(id) ON DELETE CASCADE,
  assigned_char_id TEXT,
  assigned_character_name TEXT,
  assigned_via_magelo SMALLINT DEFAULT NULL
);
COMMENT ON TABLE loot_assignment IS 'Which character has each loot item. Stub from account-dkp-schema; full definition in supabase-loot-assignment-table.sql.';

-- Views for app/CI: raid_loot + assignment columns; per-character assignment count. security_invoker so they run as caller.
CREATE OR REPLACE VIEW raid_loot_with_assignment WITH (security_invoker = true) AS
SELECT
  rl.id, rl.raid_id, rl.event_id, rl.item_name, rl.char_id, rl.character_name, rl.cost,
  la.assigned_char_id, la.assigned_character_name, la.assigned_via_magelo
FROM raid_loot rl
LEFT JOIN loot_assignment la ON la.loot_id = rl.id;
COMMENT ON VIEW raid_loot_with_assignment IS 'raid_loot plus assignment columns. Use for reads; write loot to raid_loot, assignment via RPC or loot_assignment.';
GRANT SELECT ON raid_loot_with_assignment TO authenticated;
GRANT SELECT ON raid_loot_with_assignment TO anon;

CREATE OR REPLACE VIEW character_loot_assignment_count WITH (security_invoker = true) AS
SELECT
  la.assigned_char_id AS char_id,
  la.assigned_character_name AS character_name,
  COUNT(*)::bigint AS items_assigned
FROM loot_assignment la
WHERE la.assigned_char_id IS NOT NULL AND trim(la.assigned_char_id) <> ''
GROUP BY la.assigned_char_id, la.assigned_character_name;
GRANT SELECT ON character_loot_assignment_count TO authenticated;

-- Table: same shape as view, populated by CI from character_loot_assignment_counts.csv (Table Editor / push_character_loot_assignment_counts_supabase.py).
CREATE TABLE IF NOT EXISTS character_loot_assignment_counts (
  char_id TEXT PRIMARY KEY,
  character_name TEXT,
  items_assigned BIGINT
);
ALTER TABLE character_loot_assignment_counts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated read character_loot_assignment_counts" ON character_loot_assignment_counts;
CREATE POLICY "Authenticated read character_loot_assignment_counts" ON character_loot_assignment_counts FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Service role full character_loot_assignment_counts" ON character_loot_assignment_counts;
CREATE POLICY "Service role full character_loot_assignment_counts" ON character_loot_assignment_counts FOR ALL TO service_role USING (true) WITH CHECK (true);

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
  SET LOCAL statement_timeout = '600s';
  PERFORM refresh_account_dkp_summary_internal();
END;
$$;
COMMENT ON FUNCTION public.refresh_account_dkp_summary() IS 'Officer-only: refresh account_dkp_summary from attendance and loot.';

-- 9) end_restore_load: also refresh account DKP
CREATE OR REPLACE FUNCTION public.end_restore_load()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  SET LOCAL statement_timeout = '600s';  -- 10 min for full refresh over all raids
  UPDATE restore_in_progress SET in_progress = false WHERE id = 1;
  PERFORM fix_serial_sequences_for_restore();
  PERFORM refresh_dkp_summary();
  PERFORM refresh_all_raid_attendance_totals();
  PERFORM refresh_account_dkp_summary_internal();
END;
$$;
COMMENT ON FUNCTION public.end_restore_load() IS 'Signal end of bulk restore load; re-enables triggers and runs full DKP/raid totals refresh.';
GRANT EXECUTE ON FUNCTION public.end_restore_load() TO service_role;
GRANT EXECUTE ON FUNCTION public.end_restore_load() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fix_serial_sequences_for_restore() TO service_role;
GRANT EXECUTE ON FUNCTION public.fix_serial_sequences_for_restore() TO authenticated;

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
COMMENT ON FUNCTION public.truncate_dkp_for_restore() IS 'Truncate DKP data tables for restore; used by restore script via API. Does not truncate accounts.';
GRANT EXECUTE ON FUNCTION public.truncate_dkp_for_restore() TO service_role;
GRANT EXECUTE ON FUNCTION public.truncate_dkp_for_restore() TO authenticated;

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

-- No anon read (canonical); drop if present so re-apply is consistent
DROP POLICY IF EXISTS "Anon read account_dkp_summary" ON account_dkp_summary;
DROP POLICY IF EXISTS "Anon read raid_attendance_dkp_by_account" ON raid_attendance_dkp_by_account;
DROP POLICY IF EXISTS "Anon read active_accounts" ON active_accounts;

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
    SELECT rea.raid_id, rea.event_id,
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
COMMENT ON FUNCTION public.refresh_account_dkp_summary_for_raid(TEXT, TEXT[]) IS 'Update account_dkp_summary only for accounts with attendance in this raid (plus p_extra_account_ids). Use after add/remove tic or attendee.';

GRANT EXECUTE ON FUNCTION public.refresh_account_dkp_summary_for_raid(TEXT, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_account_dkp_summary_for_raid(TEXT, TEXT[]) TO service_role;



-- Profiles: one SELECT (own row or officer), one UPDATE (own row or officer)
DROP POLICY IF EXISTS "Users can read own profile" ON profiles;
DROP POLICY IF EXISTS "Officers can read all profiles" ON profiles;
DROP POLICY IF EXISTS "Profiles select" ON profiles;
CREATE POLICY "Profiles select" ON profiles
  FOR SELECT USING (auth.uid() = id OR public.is_officer());

DROP POLICY IF EXISTS "Users can update own profile (limited)" ON profiles;
DROP POLICY IF EXISTS "Officers can update profiles" ON profiles;
DROP POLICY IF EXISTS "Profiles update" ON profiles;
CREATE POLICY "Profiles update" ON profiles
  FOR UPDATE USING (auth.uid() = id OR public.is_officer())
  WITH CHECK (auth.uid() = id OR public.is_officer());

-- Officer-only write policies (use is_officer() for consistency)
DROP POLICY IF EXISTS "Officers manage raids" ON raids;
CREATE POLICY "Officers manage raids" ON raids FOR ALL TO authenticated
  USING (public.is_officer())
  WITH CHECK (public.is_officer());

DROP POLICY IF EXISTS "Officers manage raid_events" ON raid_events;
CREATE POLICY "Officers manage raid_events" ON raid_events FOR ALL TO authenticated
  USING (public.is_officer())
  WITH CHECK (public.is_officer());

DROP POLICY IF EXISTS "Officers manage raid_loot" ON raid_loot;
CREATE POLICY "Officers manage raid_loot" ON raid_loot FOR ALL TO authenticated
  USING (public.is_officer())
  WITH CHECK (public.is_officer());

DROP POLICY IF EXISTS "Officers manage raid_attendance" ON raid_attendance;
CREATE POLICY "Officers manage raid_attendance" ON raid_attendance FOR ALL TO authenticated
  USING (public.is_officer())
  WITH CHECK (public.is_officer());

DROP POLICY IF EXISTS "Officers manage raid_event_attendance" ON raid_event_attendance;
CREATE POLICY "Officers manage raid_event_attendance" ON raid_event_attendance FOR ALL TO authenticated
  USING (public.is_officer())
  WITH CHECK (public.is_officer());

DROP POLICY IF EXISTS "Officers manage raid_classifications" ON raid_classifications;
CREATE POLICY "Officers manage raid_classifications" ON raid_classifications FOR ALL TO authenticated
  USING (public.is_officer())
  WITH CHECK (public.is_officer());

-- active_raiders in main schema also references profiles; fix it to avoid recursion when evaluating officer.
DROP POLICY IF EXISTS "Officers manage active_raiders" ON active_raiders;
CREATE POLICY "Officers manage active_raiders" ON active_raiders FOR ALL TO authenticated
  USING (public.is_officer())
  WITH CHECK (public.is_officer());

-- Cascading delete: removes all attendance, events, loot, and the raid. Officers only.
-- Disables refresh triggers during delete to avoid statement timeout (each trigger would run
-- full refresh or per-row refresh). Runs a single refresh_dkp_summary_internal() at the end.
CREATE OR REPLACE FUNCTION public.delete_raid(p_raid_id TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '60s'
AS $$
BEGIN
  IF NOT public.is_officer() THEN
    RAISE EXCEPTION 'Only officers can delete raids';
  END IF;

  -- Belt-and-suspenders: role default is 8s (authenticated); function-level SET above overrides for this invocation.
  SET LOCAL statement_timeout = '60s';

  -- Disable triggers that would run full refresh or per-row refresh on each delete (causes timeout).
  ALTER TABLE raid_loot DISABLE TRIGGER full_refresh_dkp_after_loot_change;
  ALTER TABLE raid_event_attendance DISABLE TRIGGER full_refresh_dkp_after_event_attendance_change;
  ALTER TABLE raid_event_attendance DISABLE TRIGGER refresh_raid_totals_after_event_attendance_del;
  ALTER TABLE raid_attendance DISABLE TRIGGER full_refresh_dkp_after_attendance_change;
  ALTER TABLE raid_events DISABLE TRIGGER refresh_raid_totals_after_events_del;

  DELETE FROM raid_loot WHERE raid_id = p_raid_id;
  DELETE FROM raid_attendance_dkp WHERE raid_id = p_raid_id;
  DELETE FROM raid_attendance_dkp_by_account WHERE raid_id = p_raid_id;
  DELETE FROM raid_dkp_totals WHERE raid_id = p_raid_id;
  DELETE FROM raid_event_attendance WHERE raid_id = p_raid_id;
  DELETE FROM raid_attendance WHERE raid_id = p_raid_id;
  DELETE FROM raid_events WHERE raid_id = p_raid_id;
  DELETE FROM raid_classifications WHERE raid_id = p_raid_id;
  DELETE FROM raids WHERE raid_id = p_raid_id;

  -- Single full refresh so dkp_summary, dkp_period_totals, and account_dkp_summary stay correct.
  PERFORM refresh_dkp_summary_internal();
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'refresh_account_dkp_summary_internal') THEN
    PERFORM refresh_account_dkp_summary_internal();
  END IF;

  -- Re-enable triggers (same order as disable).
  ALTER TABLE raid_events ENABLE TRIGGER refresh_raid_totals_after_events_del;
  ALTER TABLE raid_attendance ENABLE TRIGGER full_refresh_dkp_after_attendance_change;
  ALTER TABLE raid_event_attendance ENABLE TRIGGER refresh_raid_totals_after_event_attendance_del;
  ALTER TABLE raid_event_attendance ENABLE TRIGGER full_refresh_dkp_after_event_attendance_change;
  ALTER TABLE raid_loot ENABLE TRIGGER full_refresh_dkp_after_loot_change;
END;
$$;

-- Delete one tic (event) and its attendance. Officer only.
-- Disables refresh triggers during delete, then runs one refresh so the operation completes without statement timeout.
CREATE OR REPLACE FUNCTION public.delete_tic(p_raid_id TEXT, p_event_id TEXT, p_extra_account_ids TEXT[] DEFAULT '{}')
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
BEGIN
  IF NOT public.is_officer() THEN
    RAISE EXCEPTION 'Only officers can delete tics';
  END IF;

  SET LOCAL statement_timeout = '120s';

  ALTER TABLE raid_event_attendance DISABLE TRIGGER full_refresh_dkp_after_event_attendance_change;
  ALTER TABLE raid_event_attendance DISABLE TRIGGER refresh_raid_totals_after_event_attendance_del;

  DELETE FROM raid_event_attendance WHERE raid_id = p_raid_id AND event_id = p_event_id;
  DELETE FROM raid_events WHERE raid_id = p_raid_id AND event_id = p_event_id;

  DELETE FROM raid_attendance ra
  WHERE ra.raid_id = p_raid_id
    AND NOT EXISTS (
      SELECT 1 FROM raid_event_attendance rea
      WHERE rea.raid_id = ra.raid_id AND rea.char_id = ra.char_id
    );

  UPDATE raids
  SET attendees = (SELECT count(*)::text FROM raid_attendance WHERE raid_id = p_raid_id)
  WHERE raid_id = p_raid_id;

  ALTER TABLE raid_event_attendance ENABLE TRIGGER refresh_raid_totals_after_event_attendance_del;
  ALTER TABLE raid_event_attendance ENABLE TRIGGER full_refresh_dkp_after_event_attendance_change;

  PERFORM refresh_raid_attendance_totals(p_raid_id);
  PERFORM refresh_dkp_summary_internal();
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'refresh_account_dkp_summary_for_raid') THEN
    PERFORM refresh_account_dkp_summary_for_raid(p_raid_id, p_extra_account_ids);
  ELSIF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'refresh_account_dkp_summary_internal') THEN
    PERFORM refresh_account_dkp_summary_internal();
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_tic(TEXT, TEXT, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_tic(TEXT, TEXT, TEXT[]) TO service_role;



-- 1) Delete one raid's data for re-upload
CREATE OR REPLACE FUNCTION public.delete_raid_for_reupload(p_raid_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_raid_id IS NULL OR trim(p_raid_id) = '' THEN
    RAISE EXCEPTION 'p_raid_id is required';
  END IF;
  DELETE FROM raid_event_attendance WHERE raid_id = trim(p_raid_id);
  DELETE FROM raid_loot          WHERE raid_id = trim(p_raid_id);
  DELETE FROM raid_attendance    WHERE raid_id = trim(p_raid_id);
  DELETE FROM raid_events        WHERE raid_id = trim(p_raid_id);
  PERFORM refresh_dkp_summary_internal();
  PERFORM refresh_raid_attendance_totals(trim(p_raid_id));
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'refresh_account_dkp_summary_internal') THEN
    PERFORM refresh_account_dkp_summary_internal();
  END IF;
END;
$$;

COMMENT ON FUNCTION public.delete_raid_for_reupload(text) IS 'Delete one raid from events/loot/attendance/event_attendance for re-upload. Used by upload_raid_detail_to_supabase.py via API.';
GRANT EXECUTE ON FUNCTION public.delete_raid_for_reupload(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_raid_for_reupload(text) TO authenticated;

-- 2) Bulk insert raid_event_attendance (avoids per-row triggers)
-- No end_restore_load: Supabase API statement cap; upload script runs refresh_dkp_summary separately.
CREATE OR REPLACE FUNCTION public.insert_raid_event_attendance_for_upload(p_raid_id text, p_rows jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_raid_id IS NULL OR trim(p_raid_id) = '' THEN
    RAISE EXCEPTION 'p_raid_id is required';
  END IF;
  IF p_rows IS NULL OR jsonb_array_length(p_rows) = 0 THEN
    RETURN;
  END IF;

  PERFORM begin_restore_load();

  BEGIN
    INSERT INTO raid_event_attendance (raid_id, event_id, char_id, character_name, account_id)
    SELECT
      COALESCE(trim((elem->>'raid_id')), trim(p_raid_id)),
      trim(elem->>'event_id'),
      NULLIF(trim(elem->>'char_id'), ''),
      NULLIF(trim(elem->>'character_name'), ''),
      NULLIF(trim(elem->>'account_id'), '')
    FROM jsonb_array_elements(p_rows) AS elem;

    UPDATE restore_in_progress SET in_progress = false WHERE id = 1;
    PERFORM refresh_raid_attendance_totals(trim(p_raid_id));
  EXCEPTION WHEN OTHERS THEN
    UPDATE restore_in_progress SET in_progress = false WHERE id = 1;
    RAISE;
  END;
END;
$$;

COMMENT ON FUNCTION public.insert_raid_event_attendance_for_upload(text, jsonb) IS 'Bulk insert raid_event_attendance under restore_load; clears restore flag; refresh_raid_attendance_totals for this raid only. Caller must run refresh_account_dkp_summary_for_raid / refresh_dkp_summary.';
GRANT EXECUTE ON FUNCTION public.insert_raid_event_attendance_for_upload(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.insert_raid_event_attendance_for_upload(text, jsonb) TO authenticated;

-- =============================================================================
-- Officer bid forecast RPCs (SECURITY DEFINER, is_officer). GRANT EXECUTE on RPCs to authenticated only.
-- normalize_item_name_for_lookup: keep aligned with web/src/lib/itemNameNormalize.js.
-- Ref-price (global): avg of up to 3 prior guild sales (cost > 0) per normalized name; zero-cost uses guarded subquery.
-- Loot to account matches refresh_account_dkp_summary_internal (loot_assignment + char or name resolve).
-- Purchase-history CTEs use a 730-day raid-date cutoff (matches max p_activity_days on global) to avoid full guild scans.
-- statement_timeout 120s fail-fast on pooled connections; client runs bid reconstruction from returned JSON.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.officer_loot_bid_forecast(p_raid_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_raid text := trim(p_raid_id);
  v_use_per_event boolean;
  v_hist_cutoff date := (CURRENT_DATE - INTERVAL '730 days')::date;
BEGIN
  IF NOT public.is_officer() THEN
    RAISE EXCEPTION 'officer only';
  END IF;

  IF v_raid = '' THEN
    RAISE EXCEPTION 'raid_id required';
  END IF;

  SELECT EXISTS (SELECT 1 FROM raid_event_attendance WHERE raid_id = v_raid LIMIT 1) INTO v_use_per_event;

  SET LOCAL statement_timeout = '120s';

  RETURN (
    WITH attendees_raw AS (
      SELECT DISTINCT
        NULLIF(trim(rea.char_id::text), '') AS char_id,
        NULLIF(trim(rea.character_name::text), '') AS character_name
      FROM raid_event_attendance rea
      WHERE v_use_per_event AND rea.raid_id = v_raid
      UNION
      SELECT DISTINCT
        NULLIF(trim(ra.char_id::text), ''),
        NULLIF(trim(ra.character_name::text), '')
      FROM raid_attendance ra
      WHERE NOT v_use_per_event AND ra.raid_id = v_raid
    ),
    attendees_resolved AS (
      SELECT
        ar.char_id AS raw_char_id,
        ar.character_name AS raw_character_name,
        c.char_id AS resolved_char_id,
        c.name AS resolved_name,
        c.class_name AS class_name,
        ca.account_id,
        COALESCE(NULLIF(trim(acct.display_name), ''), '') AS account_display_name
      FROM attendees_raw ar
      LEFT JOIN characters c ON (
        (ar.char_id IS NOT NULL AND c.char_id = ar.char_id)
        OR (
          ar.char_id IS NULL
          AND ar.character_name IS NOT NULL
          AND lower(trim(c.name)) = lower(trim(ar.character_name))
        )
      )
      LEFT JOIN character_account ca ON ca.char_id = c.char_id
      LEFT JOIN accounts acct ON acct.account_id = ca.account_id
    ),
    attendee_list AS (
      SELECT jsonb_agg(
        jsonb_build_object(
          'char_id', COALESCE(resolved_char_id, raw_char_id, ''),
          'character_name', COALESCE(NULLIF(trim(resolved_name), ''), NULLIF(trim(raw_character_name), ''), ''),
          'class_name', COALESCE(class_name, ''),
          'account_id', account_id,
          'display_name', COALESCE(account_display_name, '')
        )
        ORDER BY COALESCE(NULLIF(trim(resolved_name), ''), NULLIF(trim(raw_character_name), ''))
      ) AS arr
      FROM attendees_resolved
    ),
    account_ids AS (
      SELECT DISTINCT account_id
      FROM attendees_resolved
      WHERE account_id IS NOT NULL
    ),
    loot_for_accounts AS (
      SELECT DISTINCT ON (rl.id)
        ca.account_id,
        rl.id AS loot_id,
        public.raid_date_parsed(r.date_iso) AS raid_date,
        rl.item_name,
        rl.cost::text AS cost_text,
        NULLIF(trim(ca.char_id::text), '') AS loot_char_id,
        COALESCE(
          NULLIF(trim(la.assigned_character_name), ''),
          NULLIF(trim(rl.character_name), ''),
          NULLIF(trim(ch.name), '')
        ) AS loot_character_name
      FROM raid_loot rl
      JOIN raids r ON r.raid_id = rl.raid_id
      LEFT JOIN LATERAL (
        SELECT la0.assigned_char_id, la0.assigned_character_name
        FROM loot_assignment la0
        WHERE la0.loot_id = rl.id
        LIMIT 1
      ) la ON true
      LEFT JOIN character_account ca ON (
        (COALESCE(trim(la.assigned_char_id), trim(rl.char_id::text)) <> ''
          AND ca.char_id = COALESCE(trim(la.assigned_char_id), trim(rl.char_id::text)))
        OR (
          COALESCE(trim(la.assigned_character_name), trim(rl.character_name)) <> ''
          AND EXISTS (
            SELECT 1
            FROM characters c2
            WHERE c2.char_id = ca.char_id
              AND trim(c2.name) = COALESCE(trim(la.assigned_character_name), trim(rl.character_name))
          )
        )
      )
      LEFT JOIN characters ch ON ch.char_id = ca.char_id
      WHERE ca.account_id IN (SELECT account_id FROM account_ids)
        AND public.raid_date_parsed(r.date_iso) >= v_hist_cutoff
      ORDER BY rl.id, ca.account_id
    ),
    loot_numeric AS (
      SELECT
        account_id,
        loot_id,
        raid_date,
        item_name,
        CASE
          WHEN cost_text IS NULL OR trim(cost_text) = '' THEN 0::numeric
          ELSE COALESCE(
            NULLIF(regexp_replace(trim(cost_text), '[^0-9.\-]', '', 'g'), '')::numeric,
            0::numeric
          )
        END AS cost_num,
        loot_char_id,
        loot_character_name
      FROM loot_for_accounts
    ),
    per_account_last AS (
      SELECT DISTINCT ON (account_id)
        account_id,
        raid_date AS last_date,
        item_name AS last_item_name,
        cost_num AS last_cost,
        loot_char_id AS last_char_id,
        loot_character_name AS last_character_name
      FROM loot_numeric
      ORDER BY account_id, raid_date DESC NULLS LAST, loot_id DESC
    ),
    per_toon AS (
      SELECT account_id, loot_char_id AS char_id, sum(cost_num) AS spent
      FROM loot_numeric
      WHERE loot_char_id IS NOT NULL
      GROUP BY account_id, loot_char_id
    ),
    per_account_totals AS (
      SELECT account_id, sum(cost_num) AS total_spent, count(*)::int AS purchase_count
      FROM loot_numeric
      GROUP BY account_id
    ),
    per_account_top_share AS (
      SELECT
        ai.account_id,
        CASE
          WHEN COALESCE(pat.total_spent, 0) <= 0 THEN 0::numeric
          ELSE COALESCE(
            (SELECT max(s.spent) FROM per_toon s WHERE s.account_id = ai.account_id),
            0::numeric
          ) / pat.total_spent
        END AS top_toon_share
      FROM account_ids ai
      LEFT JOIN per_account_totals pat ON pat.account_id = ai.account_id
    ),
    dkp AS (
      SELECT
        a.account_id,
        COALESCE(s.earned, 0)::numeric AS earned,
        COALESCE(s.spent, 0)::numeric AS spent
      FROM account_ids ai
      JOIN accounts a ON a.account_id = ai.account_id
      LEFT JOIN account_dkp_summary s ON s.account_id = a.account_id
    ),
    purchases_limited AS (
      SELECT *
      FROM (
        SELECT
          ln.*,
          row_number() OVER (PARTITION BY account_id ORDER BY raid_date DESC NULLS LAST, loot_id DESC) AS rn
        FROM loot_numeric ln
      ) x
      WHERE x.rn <= 150
    ),
    purchases_json AS (
      SELECT
        pl.account_id,
        jsonb_agg(
          jsonb_build_object(
            'loot_id', pl.loot_id,
            'raid_date', pl.raid_date,
            'item_name', pl.item_name,
            'cost', pl.cost_num,
            'char_id', pl.loot_char_id,
            'character_name', pl.loot_character_name,
            'paid_to_ref_ratio', gle.paid_to_ref_ratio
          )
          ORDER BY pl.raid_date ASC NULLS FIRST, pl.loot_id ASC
        ) AS purchases
      FROM purchases_limited pl
      LEFT JOIN public.guild_loot_sale_enriched gle ON gle.loot_id = pl.loot_id
      GROUP BY pl.account_id
    ),
    per_toon_json AS (
      SELECT
        account_id,
        jsonb_object_agg(char_id, spent) AS per_toon
      FROM per_toon
      GROUP BY account_id
    ),
    per_toon_earned_agg AS (
      SELECT
        ca.account_id,
        NULLIF(trim(c.char_id::text), '') AS char_id,
        COALESCE(SUM(rad.dkp_earned), 0)::numeric AS earned
      FROM account_ids ai
      INNER JOIN character_account ca ON ca.account_id = ai.account_id
      INNER JOIN characters c ON c.char_id = ca.char_id AND c.char_id IS NOT NULL
      INNER JOIN raid_attendance_dkp rad ON (
        rad.character_key = NULLIF(trim(c.char_id::text), '')
        OR (
          COALESCE(NULLIF(trim(c.name), ''), '') <> ''
          AND rad.character_key = trim(c.name)
        )
      )
      GROUP BY ca.account_id, NULLIF(trim(c.char_id::text), '')
    ),
    per_toon_earned_json AS (
      SELECT
        account_id,
        jsonb_object_agg(char_id::text, earned) AS per_toon_earned
      FROM per_toon_earned_agg
      WHERE char_id IS NOT NULL
      GROUP BY account_id
    ),
    profiles AS (
      SELECT jsonb_object_agg(
        d.account_id,
        jsonb_build_object(
          'earned', d.earned,
          'spent', d.spent,
          'balance', d.earned - d.spent,
          'last_purchase', CASE
            WHEN pal.last_date IS NULL THEN NULL
            ELSE jsonb_build_object(
              'raid_date', pal.last_date,
              'item_name', pal.last_item_name,
              'cost', pal.last_cost,
              'char_id', COALESCE(pal.last_char_id, ''),
              'character_name', COALESCE(pal.last_character_name, '')
            )
          END,
          'days_since_last_spend', CASE
            WHEN pal.last_date IS NULL THEN NULL
            ELSE (CURRENT_DATE - pal.last_date)::int
          END,
          'per_toon_spent', COALESCE(pt.per_toon, '{}'::jsonb),
          'per_toon_earned', COALESCE(pte.per_toon_earned, '{}'::jsonb),
          'top_toon_share', COALESCE(pts.top_toon_share, 0),
          'total_spent_tracked', COALESCE(pat.total_spent, 0),
          'purchase_count', COALESCE(pat.purchase_count, 0),
          'recent_purchases_desc', COALESCE(pj.purchases, '[]'::jsonb)
        )
      ) AS obj
      FROM dkp d
      LEFT JOIN per_account_last pal ON pal.account_id = d.account_id
      LEFT JOIN per_toon_json pt ON pt.account_id = d.account_id
      LEFT JOIN per_toon_earned_json pte ON pte.account_id = d.account_id
      LEFT JOIN per_account_top_share pts ON pts.account_id = d.account_id
      LEFT JOIN per_account_totals pat ON pat.account_id = d.account_id
      LEFT JOIN purchases_json pj ON pj.account_id = d.account_id
    )
    SELECT jsonb_build_object(
      'raid_id', v_raid,
      'attendees', COALESCE((SELECT arr FROM attendee_list), '[]'::jsonb),
      'account_profiles', COALESCE((SELECT obj FROM profiles), '{}'::jsonb)
    )
  );
END;
$$;

COMMENT ON FUNCTION public.officer_loot_bid_forecast(text) IS
  'Officers only: distinct raid attendees with class/account + spend profiles (per_toon_earned from raid_attendance_dkp, per_toon_spent, last purchase, sample purchases) for bid-interest UI. Purchase history CTEs use last 730d of raid dates; SET LOCAL statement_timeout = 120s.';

REVOKE ALL ON FUNCTION public.officer_loot_bid_forecast(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.officer_loot_bid_forecast(text) TO authenticated;

-- v2: union attendees when per-event data is incomplete; raid-scoped per_toon_earned; loot timeline + rollups for bid reconstruction UI.
CREATE OR REPLACE FUNCTION public.officer_loot_bid_forecast_v2(
  p_raid_id text,
  p_loot_id bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_raid text := trim(p_raid_id);
  v_use_per_event boolean;
  v_scope_event_id text := NULL;
  v_hist_cutoff date := (CURRENT_DATE - INTERVAL '730 days')::date;
BEGIN
  IF NOT public.is_officer() THEN
    RAISE EXCEPTION 'officer only';
  END IF;

  IF v_raid = '' THEN
    RAISE EXCEPTION 'raid_id required';
  END IF;

  IF p_loot_id IS NOT NULL THEN
    SELECT NULLIF(trim(rl.event_id::text), '')
    INTO v_scope_event_id
    FROM raid_loot rl
    WHERE rl.id = p_loot_id AND rl.raid_id = v_raid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'loot_id not found for this raid';
    END IF;
  END IF;

  SELECT EXISTS (SELECT 1 FROM raid_event_attendance WHERE raid_id = v_raid LIMIT 1) INTO v_use_per_event;

  SET LOCAL statement_timeout = '120s';

  RETURN (
    WITH
    attendees_resolved AS (
      SELECT
        x.raw_char_id,
        x.raw_character_name,
        x.resolved_char_id,
        x.resolved_name,
        x.class_name,
        x.account_id,
        x.account_display_name
      FROM public.bid_forecast_attendees_resolved_for_scope(v_raid, v_scope_event_id) x
    ),
    attendee_list AS (
      SELECT jsonb_agg(
        jsonb_build_object(
          'char_id', COALESCE(resolved_char_id, raw_char_id, ''),
          'character_name', COALESCE(NULLIF(trim(resolved_name), ''), NULLIF(trim(raw_character_name), ''), ''),
          'class_name', COALESCE(class_name, ''),
          'account_id', account_id,
          'display_name', COALESCE(account_display_name, '')
        )
        ORDER BY COALESCE(NULLIF(trim(resolved_name), ''), NULLIF(trim(raw_character_name), ''))
      ) AS arr
      FROM attendees_resolved
    ),
    account_ids AS (
      SELECT DISTINCT account_id
      FROM attendees_resolved
      WHERE account_id IS NOT NULL
    ),
    loot_for_accounts AS (
      SELECT DISTINCT ON (rl.id)
        ca.account_id,
        rl.id AS loot_id,
        public.raid_date_parsed(r.date_iso) AS raid_date,
        rl.item_name,
        rl.cost::text AS cost_text,
        NULLIF(trim(ca.char_id::text), '') AS loot_char_id,
        COALESCE(
          NULLIF(trim(la.assigned_character_name), ''),
          NULLIF(trim(rl.character_name), ''),
          NULLIF(trim(ch.name), '')
        ) AS loot_character_name
      FROM raid_loot rl
      JOIN raids r ON r.raid_id = rl.raid_id
      LEFT JOIN LATERAL (
        SELECT la0.assigned_char_id, la0.assigned_character_name
        FROM loot_assignment la0
        WHERE la0.loot_id = rl.id
        LIMIT 1
      ) la ON true
      LEFT JOIN character_account ca ON (
        (COALESCE(trim(la.assigned_char_id), trim(rl.char_id::text)) <> ''
          AND ca.char_id = COALESCE(trim(la.assigned_char_id), trim(rl.char_id::text)))
        OR (
          COALESCE(trim(la.assigned_character_name), trim(rl.character_name)) <> ''
          AND EXISTS (
            SELECT 1
            FROM characters c2
            WHERE c2.char_id = ca.char_id
              AND trim(c2.name) = COALESCE(trim(la.assigned_character_name), trim(rl.character_name))
          )
        )
      )
      LEFT JOIN characters ch ON ch.char_id = ca.char_id
      WHERE ca.account_id IN (SELECT account_id FROM account_ids)
        AND public.raid_date_parsed(r.date_iso) >= v_hist_cutoff
      ORDER BY rl.id, ca.account_id
    ),
    loot_numeric AS (
      SELECT
        account_id,
        loot_id,
        raid_date,
        item_name,
        CASE
          WHEN cost_text IS NULL OR trim(cost_text) = '' THEN 0::numeric
          ELSE COALESCE(
            NULLIF(regexp_replace(trim(cost_text), '[^0-9.\-]', '', 'g'), '')::numeric,
            0::numeric
          )
        END AS cost_num,
        loot_char_id,
        loot_character_name
      FROM loot_for_accounts
    ),
    per_account_last AS (
      SELECT DISTINCT ON (account_id)
        account_id,
        raid_date AS last_date,
        item_name AS last_item_name,
        cost_num AS last_cost,
        loot_char_id AS last_char_id,
        loot_character_name AS last_character_name
      FROM loot_numeric
      ORDER BY account_id, raid_date DESC NULLS LAST, loot_id DESC
    ),
    per_toon AS (
      SELECT account_id, loot_char_id AS char_id, sum(cost_num) AS spent
      FROM loot_numeric
      WHERE loot_char_id IS NOT NULL
      GROUP BY account_id, loot_char_id
    ),
    per_account_totals AS (
      SELECT account_id, sum(cost_num) AS total_spent, count(*)::int AS purchase_count
      FROM loot_numeric
      GROUP BY account_id
    ),
    per_account_top_share AS (
      SELECT
        ai.account_id,
        CASE
          WHEN COALESCE(pat.total_spent, 0) <= 0 THEN 0::numeric
          ELSE COALESCE(
            (SELECT max(s.spent) FROM per_toon s WHERE s.account_id = ai.account_id),
            0::numeric
          ) / pat.total_spent
        END AS top_toon_share
      FROM account_ids ai
      LEFT JOIN per_account_totals pat ON pat.account_id = ai.account_id
    ),
    dkp AS (
      SELECT
        a.account_id,
        COALESCE(s.earned, 0)::numeric AS earned,
        COALESCE(s.spent, 0)::numeric AS spent
      FROM account_ids ai
      JOIN accounts a ON a.account_id = ai.account_id
      LEFT JOIN account_dkp_summary s ON s.account_id = a.account_id
    ),
    purchases_limited AS (
      SELECT *
      FROM (
        SELECT
          ln.*,
          row_number() OVER (PARTITION BY account_id ORDER BY raid_date DESC NULLS LAST, loot_id DESC) AS rn
        FROM loot_numeric ln
      ) x
      WHERE x.rn <= 150
    ),
    purchases_json AS (
      SELECT
        pl.account_id,
        jsonb_agg(
          jsonb_build_object(
            'loot_id', pl.loot_id,
            'raid_date', pl.raid_date,
            'item_name', pl.item_name,
            'cost', pl.cost_num,
            'char_id', pl.loot_char_id,
            'character_name', pl.loot_character_name,
            'paid_to_ref_ratio', gle.paid_to_ref_ratio
          )
          ORDER BY pl.raid_date ASC NULLS FIRST, pl.loot_id ASC
        ) AS purchases
      FROM purchases_limited pl
      LEFT JOIN public.guild_loot_sale_enriched gle ON gle.loot_id = pl.loot_id
      GROUP BY pl.account_id
    ),
    per_toon_json AS (
      SELECT
        account_id,
        jsonb_object_agg(char_id, spent) AS per_toon
      FROM per_toon
      GROUP BY account_id
    ),
    per_toon_earned_agg AS (
      SELECT
        ca.account_id,
        NULLIF(trim(c.char_id::text), '') AS char_id,
        COALESCE(SUM(rad.dkp_earned), 0)::numeric AS earned
      FROM account_ids ai
      INNER JOIN character_account ca ON ca.account_id = ai.account_id
      INNER JOIN characters c ON c.char_id = ca.char_id AND c.char_id IS NOT NULL
      INNER JOIN raid_attendance_dkp rad ON (
        rad.raid_id = v_raid
        AND (
          rad.character_key = NULLIF(trim(c.char_id::text), '')
          OR (
            COALESCE(NULLIF(trim(c.name), ''), '') <> ''
            AND rad.character_key = trim(c.name)
          )
        )
      )
      GROUP BY ca.account_id, NULLIF(trim(c.char_id::text), '')
    ),
    per_toon_earned_json AS (
      SELECT
        account_id,
        jsonb_object_agg(char_id::text, earned) AS per_toon_earned_this_raid
      FROM per_toon_earned_agg
      WHERE char_id IS NOT NULL
      GROUP BY account_id
    ),
    profiles AS (
      SELECT jsonb_object_agg(
        d.account_id,
        jsonb_build_object(
          'earned', d.earned,
          'spent', d.spent,
          'balance', d.earned - d.spent,
          'last_purchase', CASE
            WHEN pal.last_date IS NULL THEN NULL
            ELSE jsonb_build_object(
              'raid_date', pal.last_date,
              'item_name', pal.last_item_name,
              'cost', pal.last_cost,
              'char_id', COALESCE(pal.last_char_id, ''),
              'character_name', COALESCE(pal.last_character_name, '')
            )
          END,
          'days_since_last_spend', CASE
            WHEN pal.last_date IS NULL THEN NULL
            ELSE (CURRENT_DATE - pal.last_date)::int
          END,
          'per_toon_spent', COALESCE(pt.per_toon, '{}'::jsonb),
          'per_toon_earned_this_raid', COALESCE(pte.per_toon_earned_this_raid, '{}'::jsonb),
          'top_toon_share', COALESCE(pts.top_toon_share, 0),
          'total_spent_tracked', COALESCE(pat.total_spent, 0),
          'purchase_count', COALESCE(pat.purchase_count, 0),
          'recent_purchases_desc', COALESCE(pj.purchases, '[]'::jsonb)
        )
      ) AS obj
      FROM dkp d
      LEFT JOIN per_account_last pal ON pal.account_id = d.account_id
      LEFT JOIN per_toon_json pt ON pt.account_id = d.account_id
      LEFT JOIN per_toon_earned_json pte ON pte.account_id = d.account_id
      LEFT JOIN per_account_top_share pts ON pts.account_id = d.account_id
      LEFT JOIN per_account_totals pat ON pat.account_id = d.account_id
      LEFT JOIN purchases_json pj ON pj.account_id = d.account_id
    ),
    loot_row_buyer AS (
      SELECT
        rl.id AS loot_id,
        rl.raid_id,
        NULLIF(trim(rl.event_id::text), '') AS event_id,
        rl.item_name,
        rl.cost::text AS cost_text,
        ca.account_id AS buyer_account_id
      FROM raid_loot rl
      LEFT JOIN LATERAL (
        SELECT la0.assigned_char_id, la0.assigned_character_name
        FROM loot_assignment la0
        WHERE la0.loot_id = rl.id
        LIMIT 1
      ) la ON true
      LEFT JOIN character_account ca ON (
        (COALESCE(trim(la.assigned_char_id), trim(rl.char_id::text)) <> ''
          AND ca.char_id = COALESCE(trim(la.assigned_char_id), trim(rl.char_id::text)))
        OR (
          COALESCE(trim(la.assigned_character_name), trim(rl.character_name)) <> ''
          AND EXISTS (
            SELECT 1
            FROM characters c2
            WHERE c2.char_id = ca.char_id
              AND trim(c2.name) = COALESCE(trim(la.assigned_character_name), trim(rl.character_name))
          )
        )
      )
      WHERE rl.raid_id = v_raid
    ),
    loot_timeline AS (
      SELECT jsonb_agg(
        jsonb_build_object(
          'loot_id', lb.loot_id,
          'event_id', COALESCE(lb.event_id, ''),
          'event_order', COALESCE(re.event_order, 2147483647),
          'item_name', lb.item_name,
          'cost',
            CASE
              WHEN lb.cost_text IS NULL OR trim(lb.cost_text) = '' THEN 0::numeric
              ELSE COALESCE(
                NULLIF(regexp_replace(trim(lb.cost_text), '[^0-9.\-]', '', 'g'), '')::numeric,
                0::numeric
              )
            END,
          'buyer_account_id', lb.buyer_account_id
        )
        ORDER BY COALESCE(re.event_order, 2147483647), lb.loot_id
      ) AS arr
      FROM loot_row_buyer lb
      LEFT JOIN raid_events re ON re.raid_id = lb.raid_id AND re.event_id = lb.event_id
    ),
    raid_events_ordered AS (
      SELECT jsonb_agg(
        jsonb_build_object(
          'event_id', re.event_id,
          'event_order', COALESCE(re.event_order, 2147483647)
        )
        ORDER BY COALESCE(re.event_order, 2147483647), re.event_id
      ) AS arr
      FROM raid_events re
      WHERE re.raid_id = v_raid
    ),
    per_event_earned_rows AS (
      SELECT
        x.aid AS account_id,
        rea.event_id,
        SUM(COALESCE(NULLIF(regexp_replace(trim(re.dkp_value::text), '[^0-9.\-]', '', 'g'), '')::numeric, 0::numeric)) AS dkp_earned
      FROM raid_event_attendance rea
      JOIN raid_events re ON re.raid_id = rea.raid_id AND re.event_id = rea.event_id
      INNER JOIN LATERAL (
        SELECT ca.account_id AS aid
        FROM character_account ca
        WHERE (
            rea.char_id IS NOT NULL
            AND trim(rea.char_id::text) <> ''
            AND ca.char_id = trim(rea.char_id::text)
          )
          OR (
            rea.character_name IS NOT NULL
            AND trim(rea.character_name) <> ''
            AND EXISTS (
              SELECT 1
              FROM characters c
              WHERE c.char_id = ca.char_id
                AND trim(c.name) = trim(rea.character_name)
            )
          )
        LIMIT 1
      ) x ON true
      WHERE rea.raid_id = v_raid
      GROUP BY x.aid, rea.event_id
    ),
    per_event_earned_json AS (
      SELECT COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'account_id', account_id,
            'event_id', event_id,
            'dkp_earned', dkp_earned
          )
        ),
        '[]'::jsonb
      ) AS arr
      FROM per_event_earned_rows
    ),
    account_raid_rollup AS (
      SELECT COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'account_id', aid.account_id,
            'earned_this_raid', COALESCE(rad.dkp_earned, 0::numeric),
            'spent_this_raid', COALESCE(sp.spent, 0::numeric)
          )
        ),
        '[]'::jsonb
      ) AS arr
      FROM account_ids aid
      LEFT JOIN raid_attendance_dkp_by_account rad
        ON rad.raid_id = v_raid AND rad.account_id = aid.account_id
      LEFT JOIN (
        SELECT
          lb.buyer_account_id AS account_id,
          SUM(
            CASE
              WHEN lb.cost_text IS NULL OR trim(lb.cost_text) = '' THEN 0::numeric
              ELSE COALESCE(
                NULLIF(regexp_replace(trim(lb.cost_text), '[^0-9.\-]', '', 'g'), '')::numeric,
                0::numeric
              )
            END
          ) AS spent
        FROM loot_row_buyer lb
        WHERE lb.buyer_account_id IS NOT NULL
        GROUP BY lb.buyer_account_id
      ) sp ON sp.account_id = aid.account_id
    ),
    loot_context_row AS (
      SELECT
        lb.loot_id,
        lb.event_id,
        lb.item_name,
        CASE
          WHEN lb.cost_text IS NULL OR trim(lb.cost_text) = '' THEN 0::numeric
          ELSE COALESCE(
            NULLIF(regexp_replace(trim(lb.cost_text), '[^0-9.\-]', '', 'g'), '')::numeric,
            0::numeric
          )
        END AS cost_num,
        COALESCE(re.event_order, 2147483647) AS event_order
      FROM loot_row_buyer lb
      LEFT JOIN raid_events re ON re.raid_id = lb.raid_id AND re.event_id = lb.event_id
      WHERE p_loot_id IS NOT NULL AND lb.loot_id = p_loot_id
      LIMIT 1
    )
    SELECT jsonb_build_object(
      'raid_id', v_raid,
      'attendees', COALESCE((SELECT arr FROM attendee_list), '[]'::jsonb),
      'account_profiles', COALESCE((SELECT obj FROM profiles), '{}'::jsonb),
      'loot_context', CASE
        WHEN p_loot_id IS NULL THEN NULL::jsonb
        ELSE (
          SELECT jsonb_build_object(
            'loot_id', lr.loot_id,
            'event_id', COALESCE(lr.event_id, ''),
            'item_name', lr.item_name,
            'cost', lr.cost_num,
            'event_order', lr.event_order
          )
          FROM loot_context_row lr
          LIMIT 1
        )
      END,
      'loot_timeline', COALESCE((SELECT arr FROM loot_timeline), '[]'::jsonb),
      'raid_events_ordered', COALESCE((SELECT arr FROM raid_events_ordered), '[]'::jsonb),
      'per_event_earned', (SELECT arr FROM per_event_earned_json),
      'account_raid_rollup', (SELECT arr FROM account_raid_rollup),
      'sim_mode', CASE WHEN v_use_per_event THEN 'per_event' ELSE 'raid_level' END
    )
  );
END;
$$;

COMMENT ON FUNCTION public.officer_loot_bid_forecast_v2(text, bigint) IS
  'Officers only: v1-style attendees/profiles plus raid loot timeline, per-event DKP credits, account raid rollup, optional loot_context for client-side bid reconstruction. per_toon_earned_this_raid is scoped to this raid. Profile purchase history uses last 730d of raid dates; SET LOCAL statement_timeout = 120s.';

REVOKE ALL ON FUNCTION public.officer_loot_bid_forecast_v2(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.officer_loot_bid_forecast_v2(text, bigint) TO authenticated;

CREATE OR REPLACE FUNCTION public.normalize_item_name_for_lookup(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
  SELECT regexp_replace(
    regexp_replace(
      trim(
        regexp_replace(
          lower(
            trim(
              regexp_replace(
                regexp_replace(COALESCE(p_name, ''), E'[\u2019\u2018''`]', '', 'g'),
                '-',
                ' ',
                'g'
              )
            )
          ),
          '\s+',
          ' ',
          'g'
        )
      ),
      '^[,.;:!?]+',
      '',
      'g'
    ),
    '[,.;:!?]+$',
    '',
    'g'
  );
$fn$;

COMMENT ON FUNCTION public.normalize_item_name_for_lookup(text) IS
  'Normalized item name for cross-table matching; keep in sync with web/src/lib/itemNameNormalize.js.';

-- Guild-wide sale rows with reference price (avg of up to 3 prior positive-cost sales per norm_name) and buyer account.
CREATE OR REPLACE VIEW public.guild_loot_sale_enriched WITH (security_invoker = true) AS
WITH guild_loot_base AS (
  SELECT
    rl.id AS loot_id,
    rl.raid_id,
    NULLIF(trim(rl.event_id::text), '') AS event_id,
    rl.item_name,
    public.normalize_item_name_for_lookup(rl.item_name) AS norm_name,
    public.raid_date_parsed(r.date_iso) AS raid_date,
    CASE
      WHEN rl.cost IS NULL OR trim(rl.cost::text) = '' THEN 0::numeric
      ELSE COALESCE(
        NULLIF(regexp_replace(trim(rl.cost::text), '[^0-9.\-]', '', 'g'), '')::numeric,
        0::numeric
      )
    END AS cost_num,
    rl.cost::text AS cost_text
  FROM raid_loot rl
  JOIN raids r ON r.raid_id = rl.raid_id
  WHERE rl.item_name IS NOT NULL AND trim(rl.item_name) <> ''
),
buyer AS (
  SELECT DISTINCT ON (rl.id)
    rl.id AS loot_id,
    ca.account_id AS buyer_account_id
  FROM raid_loot rl
  LEFT JOIN LATERAL (
    SELECT la0.assigned_char_id, la0.assigned_character_name
    FROM loot_assignment la0
    WHERE la0.loot_id = rl.id
    LIMIT 1
  ) la ON true
  LEFT JOIN character_account ca ON (
    (COALESCE(trim(la.assigned_char_id), trim(rl.char_id::text)) <> ''
      AND ca.char_id = COALESCE(trim(la.assigned_char_id), trim(rl.char_id::text)))
    OR (
      COALESCE(trim(la.assigned_character_name), trim(rl.character_name)) <> ''
      AND EXISTS (
        SELECT 1
        FROM characters c2
        WHERE c2.char_id = ca.char_id
          AND trim(c2.name) = COALESCE(trim(la.assigned_character_name), trim(rl.character_name))
      )
    )
  )
  ORDER BY rl.id, ca.account_id
),
guild_positive_ref AS (
  SELECT
    gp.loot_id,
    gp.norm_name,
    gp.raid_date,
    avg(gp.cost_num) OVER (
      PARTITION BY gp.norm_name
      ORDER BY gp.raid_date ASC NULLS FIRST, gp.loot_id ASC
      ROWS BETWEEN 3 PRECEDING AND 1 PRECEDING
    ) AS ref_price_at_sale
  FROM guild_loot_base gp
  WHERE gp.cost_num > 0
),
guild_loot_core AS (
  SELECT
    glb.loot_id,
    glb.raid_id,
    glb.event_id,
    glb.item_name,
    glb.norm_name,
    glb.raid_date,
    glb.cost_num,
    glb.cost_text,
    b.buyer_account_id,
    CASE
      WHEN glb.cost_num > 0 THEN gpr.ref_price_at_sale
      ELSE NULL::numeric
    END AS ref_price_at_sale,
    CASE
      WHEN glb.cost_num > 0 AND gpr.ref_price_at_sale IS NOT NULL AND gpr.ref_price_at_sale > 0
      THEN (glb.cost_num / gpr.ref_price_at_sale)::numeric
      ELSE NULL::numeric
    END AS paid_to_ref_ratio
  FROM guild_loot_base glb
  LEFT JOIN buyer b ON b.loot_id = glb.loot_id
  LEFT JOIN guild_positive_ref gpr ON glb.cost_num > 0
    AND gpr.loot_id = glb.loot_id
)
SELECT
  c.loot_id,
  c.raid_id,
  c.event_id,
  c.item_name,
  c.norm_name,
  c.raid_date,
  c.cost_num,
  c.cost_text,
  c.buyer_account_id,
  c.ref_price_at_sale,
  c.paid_to_ref_ratio,
  LEAD(c.loot_id) OVER (
    PARTITION BY c.norm_name
    ORDER BY c.raid_date ASC NULLS FIRST, c.loot_id ASC
  ) AS next_guild_sale_loot_id,
  LEAD(c.buyer_account_id) OVER (
    PARTITION BY c.norm_name
    ORDER BY c.raid_date ASC NULLS FIRST, c.loot_id ASC
  ) AS next_guild_sale_buyer_account_id
FROM guild_loot_core c;

COMMENT ON VIEW public.guild_loot_sale_enriched IS
  'All raid_loot rows with parsed cost, norm_name, ref_price_at_sale (3 prior sales), paid_to_ref_ratio, buyer_account_id, and next guild sale of same norm_name (LEAD by raid_date, loot_id).';

GRANT SELECT ON public.guild_loot_sale_enriched TO authenticated;
GRANT SELECT ON public.guild_loot_sale_enriched TO anon;

-- Shared attendee resolution for bid forecast v2 and bidding portfolio (same rules as former v2 CTEs).
CREATE OR REPLACE FUNCTION public.bid_forecast_attendees_resolved_for_scope(
  p_raid_id text,
  p_pin_event_id text
)
RETURNS TABLE (
  raw_char_id text,
  raw_character_name text,
  resolved_char_id text,
  resolved_name text,
  class_name text,
  account_id text,
  account_display_name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $bfatt$
  WITH
  vars AS (
    SELECT
      trim(p_raid_id) AS rid,
      EXISTS (SELECT 1 FROM raid_event_attendance rea WHERE rea.raid_id = trim(p_raid_id) LIMIT 1) AS use_per_event,
      NULLIF(trim(COALESCE(p_pin_event_id, '')), '') AS scope_event_id
  ),
  vars2 AS (
    SELECT
      v.rid,
      v.use_per_event,
      v.scope_event_id,
      (
        v.use_per_event
        AND v.scope_event_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM raid_event_attendance rea
          WHERE rea.raid_id = v.rid AND rea.event_id = v.scope_event_id
          LIMIT 1
        )
      ) AS scope_event_has_att
    FROM vars v
  ),
  attendees_from_events AS (
    SELECT DISTINCT
      NULLIF(trim(rea.char_id::text), '') AS char_id,
      NULLIF(trim(rea.character_name::text), '') AS character_name
    FROM raid_event_attendance rea
    CROSS JOIN vars2 x
    WHERE x.use_per_event AND rea.raid_id = x.rid
  ),
  attendees_from_raid_level AS (
    SELECT DISTINCT
      NULLIF(trim(ra.char_id::text), '') AS char_id,
      NULLIF(trim(ra.character_name::text), '') AS character_name
    FROM raid_attendance ra
    CROSS JOIN vars2 x
    WHERE ra.raid_id = x.rid
  ),
  attendees_raw AS (
    SELECT DISTINCT
      NULLIF(trim(rea.char_id::text), '') AS char_id,
      NULLIF(trim(rea.character_name::text), '') AS character_name
    FROM raid_event_attendance rea
    CROSS JOIN vars2 x
    WHERE x.use_per_event
      AND x.scope_event_id IS NOT NULL
      AND x.scope_event_has_att
      AND rea.raid_id = x.rid
      AND rea.event_id = x.scope_event_id
    UNION ALL
    SELECT fe.char_id, fe.character_name
    FROM attendees_from_events fe
    CROSS JOIN vars2 x
    WHERE x.use_per_event
      AND NOT (x.scope_event_id IS NOT NULL AND x.scope_event_has_att)
    UNION ALL
    SELECT fr.char_id, fr.character_name
    FROM attendees_from_raid_level fr
    CROSS JOIN vars2 x
    WHERE x.use_per_event
      AND NOT (x.scope_event_id IS NOT NULL AND x.scope_event_has_att)
    UNION ALL
    SELECT fr.char_id, fr.character_name
    FROM attendees_from_raid_level fr
    CROSS JOIN vars2 x
    WHERE NOT x.use_per_event
  ),
  attendees_raw_dedup AS (
    SELECT DISTINCT ON (
      COALESCE(char_id, ''),
      lower(trim(COALESCE(character_name, '')))
    )
      char_id,
      character_name
    FROM attendees_raw
    WHERE char_id IS NOT NULL OR character_name IS NOT NULL
    ORDER BY
      COALESCE(char_id, ''),
      lower(trim(COALESCE(character_name, ''))),
      char_id NULLS LAST
  )
  SELECT
    ar.char_id AS raw_char_id,
    ar.character_name AS raw_character_name,
    c.char_id AS resolved_char_id,
    c.name AS resolved_name,
    c.class_name AS class_name,
    ca.account_id,
    COALESCE(NULLIF(trim(acct.display_name), ''), '') AS account_display_name
  FROM attendees_raw_dedup ar
  LEFT JOIN characters c ON (
    (ar.char_id IS NOT NULL AND c.char_id = ar.char_id)
    OR (
      ar.char_id IS NULL
      AND ar.character_name IS NOT NULL
      AND lower(trim(c.name)) = lower(trim(ar.character_name))
    )
  )
  LEFT JOIN character_account ca ON ca.char_id = c.char_id
  LEFT JOIN accounts acct ON acct.account_id = ca.account_id;
$bfatt$;

COMMENT ON FUNCTION public.bid_forecast_attendees_resolved_for_scope(text, text) IS
  'Internal: raid attendees with character/account resolution; pin event_id when that tic has attendance (matches officer_loot_bid_forecast_v2).';

REVOKE ALL ON FUNCTION public.bid_forecast_attendees_resolved_for_scope(text, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.attendee_accounts_for_loot(p_loot_id bigint)
RETURNS TABLE (account_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $afl$
  SELECT DISTINCT ar.account_id
  FROM raid_loot rl
  CROSS JOIN LATERAL public.bid_forecast_attendees_resolved_for_scope(
    rl.raid_id,
    NULLIF(trim(rl.event_id::text), '')
  ) ar
  WHERE rl.id = p_loot_id
    AND ar.account_id IS NOT NULL;
$afl$;

COMMENT ON FUNCTION public.attendee_accounts_for_loot(bigint) IS
  'Internal: distinct attendee account_ids for a loot row (event-scoped when that tic has attendance).';

REVOKE ALL ON FUNCTION public.attendee_accounts_for_loot(bigint) FROM PUBLIC;

-- Pool before a loot row auction (parity with web/src/lib/bidForecastModel.js simulateBalancesBeforeLootRow).
CREATE OR REPLACE FUNCTION public.account_balance_before_loot(
  p_loot_id bigint,
  p_account_id text
)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $abb$
DECLARE
  v_raid text;
  v_target bigint := p_loot_id;
  v_aid text := trim(p_account_id);
  v_use_per_event boolean;
  v_sim_mode text;
  v_bal numeric;
  v_earned_raid numeric;
  v_spent_raid numeric;
  v_opening numeric;
  ev_rec record;
  loot_rec record;
  v_event_id text;
  v_per_event numeric;
  v_buyer text;
BEGIN
  IF v_aid = '' THEN
    RETURN NULL;
  END IF;

  SELECT rl.raid_id INTO v_raid
  FROM raid_loot rl
  WHERE rl.id = p_loot_id;

  IF v_raid IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT EXISTS (SELECT 1 FROM raid_event_attendance WHERE raid_id = v_raid LIMIT 1) INTO v_use_per_event;
  v_sim_mode := CASE WHEN v_use_per_event THEN 'per_event' ELSE 'raid_level' END;

  SELECT COALESCE(s.earned, 0)::numeric - COALESCE(s.spent, 0)::numeric
  INTO v_bal
  FROM accounts a
  LEFT JOIN account_dkp_summary s ON s.account_id = a.account_id
  WHERE a.account_id = v_aid;

  IF v_bal IS NULL THEN
    v_bal := 0::numeric;
  END IF;

  SELECT COALESCE(rad.dkp_earned, 0::numeric) INTO v_earned_raid
  FROM raid_attendance_dkp_by_account rad
  WHERE rad.raid_id = v_raid AND rad.account_id = v_aid;

  SELECT COALESCE(SUM(
    CASE
      WHEN lb.cost_text IS NULL OR trim(lb.cost_text) = '' THEN 0::numeric
      ELSE COALESCE(
        NULLIF(regexp_replace(trim(lb.cost_text), '[^0-9.\-]', '', 'g'), '')::numeric,
        0::numeric
      )
    END
  ), 0::numeric) INTO v_spent_raid
  FROM (
    SELECT rl.id AS loot_id, rl.cost::text AS cost_text
    FROM raid_loot rl
    LEFT JOIN LATERAL (
      SELECT la0.assigned_char_id, la0.assigned_character_name
      FROM loot_assignment la0
      WHERE la0.loot_id = rl.id
      LIMIT 1
    ) la ON true
    LEFT JOIN character_account ca ON (
      (COALESCE(trim(la.assigned_char_id), trim(rl.char_id::text)) <> ''
        AND ca.char_id = COALESCE(trim(la.assigned_char_id), trim(rl.char_id::text)))
      OR (
        COALESCE(trim(la.assigned_character_name), trim(rl.character_name)) <> ''
        AND EXISTS (
          SELECT 1 FROM characters c2
          WHERE c2.char_id = ca.char_id
            AND trim(c2.name) = COALESCE(trim(la.assigned_character_name), trim(rl.character_name))
        )
      )
    )
    WHERE rl.raid_id = v_raid AND ca.account_id = v_aid
  ) lb;

  v_opening := v_bal + COALESCE(v_spent_raid, 0) - COALESCE(v_earned_raid, 0);

  IF v_sim_mode = 'raid_level' THEN
    v_opening := v_opening + COALESCE(v_earned_raid, 0);
    FOR loot_rec IN
      SELECT
        rl.id AS loot_id,
        CASE
          WHEN rl.cost IS NULL OR trim(rl.cost::text) = '' THEN 0::numeric
          ELSE COALESCE(
            NULLIF(regexp_replace(trim(rl.cost::text), '[^0-9.\-]', '', 'g'), '')::numeric,
            0::numeric
          )
        END AS cost_num,
        ca.account_id AS buyer_account_id,
        COALESCE(re.event_order, 2147483647) AS event_order
      FROM raid_loot rl
      LEFT JOIN raid_events re ON re.raid_id = rl.raid_id AND re.event_id = rl.event_id
      LEFT JOIN LATERAL (
        SELECT la0.assigned_char_id, la0.assigned_character_name
        FROM loot_assignment la0
        WHERE la0.loot_id = rl.id
        LIMIT 1
      ) la ON true
      LEFT JOIN character_account ca ON (
        (COALESCE(trim(la.assigned_char_id), trim(rl.char_id::text)) <> ''
          AND ca.char_id = COALESCE(trim(la.assigned_char_id), trim(rl.char_id::text)))
        OR (
          COALESCE(trim(la.assigned_character_name), trim(rl.character_name)) <> ''
          AND EXISTS (
            SELECT 1 FROM characters c2
            WHERE c2.char_id = ca.char_id
              AND trim(c2.name) = COALESCE(trim(la.assigned_character_name), trim(rl.character_name))
          )
        )
      )
      WHERE rl.raid_id = v_raid
      ORDER BY COALESCE(re.event_order, 2147483647), rl.id
    LOOP
      IF loot_rec.loot_id = v_target THEN
        RETURN v_opening;
      END IF;
      IF loot_rec.buyer_account_id = v_aid AND loot_rec.cost_num <> 0 THEN
        v_opening := v_opening - loot_rec.cost_num;
      END IF;
    END LOOP;
    RETURN v_opening;
  END IF;

  -- per_event
  FOR ev_rec IN
    SELECT re.event_id, COALESCE(re.event_order, 2147483647) AS event_order
    FROM raid_events re
    WHERE re.raid_id = v_raid
    ORDER BY COALESCE(re.event_order, 2147483647), re.event_id
  LOOP
    v_event_id := ev_rec.event_id;
    SELECT COALESCE(SUM(
      COALESCE(NULLIF(regexp_replace(trim(re2.dkp_value::text), '[^0-9.\-]', '', 'g'), '')::numeric, 0::numeric)
    ), 0::numeric)
    INTO v_per_event
    FROM raid_event_attendance rea
    JOIN raid_events re2 ON re2.raid_id = rea.raid_id AND re2.event_id = rea.event_id
    INNER JOIN LATERAL (
      SELECT ca.account_id AS aid
      FROM character_account ca
      WHERE (
          rea.char_id IS NOT NULL AND trim(rea.char_id::text) <> ''
          AND ca.char_id = trim(rea.char_id::text)
        )
        OR (
          rea.character_name IS NOT NULL AND trim(rea.character_name) <> ''
          AND EXISTS (
            SELECT 1 FROM characters c
            WHERE c.char_id = ca.char_id AND trim(c.name) = trim(rea.character_name)
          )
        )
      LIMIT 1
    ) x ON true
    WHERE rea.raid_id = v_raid AND rea.event_id = v_event_id AND x.aid = v_aid;

    v_opening := v_opening + COALESCE(v_per_event, 0);

    FOR loot_rec IN
      SELECT
        rl.id AS loot_id,
        CASE
          WHEN rl.cost IS NULL OR trim(rl.cost::text) = '' THEN 0::numeric
          ELSE COALESCE(
            NULLIF(regexp_replace(trim(rl.cost::text), '[^0-9.\-]', '', 'g'), '')::numeric,
            0::numeric
          )
        END AS cost_num,
        ca.account_id AS buyer_account_id
      FROM raid_loot rl
      LEFT JOIN LATERAL (
        SELECT la0.assigned_char_id, la0.assigned_character_name
        FROM loot_assignment la0
        WHERE la0.loot_id = rl.id
        LIMIT 1
      ) la ON true
      LEFT JOIN character_account ca ON (
        (COALESCE(trim(la.assigned_char_id), trim(rl.char_id::text)) <> ''
          AND ca.char_id = COALESCE(trim(la.assigned_char_id), trim(rl.char_id::text)))
        OR (
          COALESCE(trim(la.assigned_character_name), trim(rl.character_name)) <> ''
          AND EXISTS (
            SELECT 1 FROM characters c2
            WHERE c2.char_id = ca.char_id
              AND trim(c2.name) = COALESCE(trim(la.assigned_character_name), trim(rl.character_name))
          )
        )
      )
      WHERE rl.raid_id = v_raid AND rl.event_id IS NOT DISTINCT FROM v_event_id
      ORDER BY rl.id
    LOOP
      IF loot_rec.loot_id = v_target THEN
        RETURN v_opening;
      END IF;
      IF loot_rec.buyer_account_id = v_aid AND loot_rec.cost_num <> 0 THEN
        v_opening := v_opening - loot_rec.cost_num;
      END IF;
    END LOOP;
  END LOOP;

  -- Orphan loot (event not in raid_events or empty event_id): match JS orphan pass
  FOR loot_rec IN
    SELECT
      rl.id AS loot_id,
      CASE
        WHEN rl.cost IS NULL OR trim(rl.cost::text) = '' THEN 0::numeric
        ELSE COALESCE(
          NULLIF(regexp_replace(trim(rl.cost::text), '[^0-9.\-]', '', 'g'), '')::numeric,
          0::numeric
        )
      END AS cost_num,
      ca.account_id AS buyer_account_id,
      COALESCE(re.event_order, 2147483647) AS event_order
    FROM raid_loot rl
    LEFT JOIN raid_events re ON re.raid_id = rl.raid_id AND re.event_id = rl.event_id
    LEFT JOIN LATERAL (
      SELECT la0.assigned_char_id, la0.assigned_character_name
      FROM loot_assignment la0
      WHERE la0.loot_id = rl.id
      LIMIT 1
    ) la ON true
    LEFT JOIN character_account ca ON (
      (COALESCE(trim(la.assigned_char_id), trim(rl.char_id::text)) <> ''
        AND ca.char_id = COALESCE(trim(la.assigned_char_id), trim(rl.char_id::text)))
      OR (
        COALESCE(trim(la.assigned_character_name), trim(rl.character_name)) <> ''
        AND EXISTS (
          SELECT 1 FROM characters c2
          WHERE c2.char_id = ca.char_id
            AND trim(c2.name) = COALESCE(trim(la.assigned_character_name), trim(rl.character_name))
        )
      )
    )
    WHERE rl.raid_id = v_raid
      AND NOT EXISTS (
        SELECT 1 FROM raid_events re2
        WHERE re2.raid_id = rl.raid_id AND re2.event_id IS NOT DISTINCT FROM rl.event_id
      )
    ORDER BY COALESCE(re.event_order, 2147483647), rl.id
  LOOP
    IF loot_rec.loot_id = v_target THEN
      RETURN v_opening;
    END IF;
    IF loot_rec.buyer_account_id = v_aid AND loot_rec.cost_num <> 0 THEN
      v_opening := v_opening - loot_rec.cost_num;
    END IF;
  END LOOP;

  RETURN v_opening;
END;
$abb$;

COMMENT ON FUNCTION public.account_balance_before_loot(bigint, text) IS
  'Internal: reconstructed DKP pool for an account immediately before the given loot row (matches bidForecastModel simulateBalancesBeforeLootRow).';

REVOKE ALL ON FUNCTION public.account_balance_before_loot(bigint, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.bid_portfolio_runner_up_guess(p_loot_id bigint)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $bru$
DECLARE
  v_p numeric;
  v_buyer text;
  v_best text;
  v_best_pool numeric := NULL;
  v_pool numeric;
  r record;
BEGIN
  SELECT gle.cost_num, gle.buyer_account_id
  INTO v_p, v_buyer
  FROM public.guild_loot_sale_enriched gle
  WHERE gle.loot_id = p_loot_id;

  IF v_p IS NULL OR v_p <= 0 THEN
    RETURN NULL;
  END IF;

  FOR r IN
    SELECT a.account_id
    FROM public.attendee_accounts_for_loot(p_loot_id) a
  LOOP
    IF r.account_id IS NULL OR r.account_id = v_buyer THEN
      CONTINUE;
    END IF;
    v_pool := public.account_balance_before_loot(p_loot_id, r.account_id);
    IF v_pool IS NULL OR v_pool < v_p THEN
      CONTINUE;
    END IF;
    IF v_best IS NULL OR v_pool > v_best_pool
       OR (v_pool = v_best_pool AND r.account_id < v_best) THEN
      v_best_pool := v_pool;
      v_best := r.account_id;
    END IF;
  END LOOP;

  RETURN v_best;
END;
$bru$;

COMMENT ON FUNCTION public.bid_portfolio_runner_up_guess(bigint) IS
  'DEPRECATED for product use: class-unaware max-pool heuristic. Officer UI and bid_portfolio_auction_fact.runner_up_* should come from Python compute_bid_portfolio_from_csv (unified item_stats + character CSV eligibility). Kept for ad-hoc SQL only.';

REVOKE ALL ON FUNCTION public.bid_portfolio_runner_up_guess(bigint) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.officer_bid_portfolio_for_loot(p_loot_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $obpfl$
DECLARE
  v_raid text;
  v_use_per_event boolean;
  v_sale jsonb;
  v_att jsonb := '[]'::jsonb;
  v_p numeric;
  v_buyer text;
  v_runner text;
  v_runner_char text;
  v_pool numeric;
  v_could_clear boolean;
  v_syn numeric;
  v_prior_median numeric;
  v_prior_cnt int;
  v_prior_ratio_med numeric;
  v_later_id bigint;
  v_later_flag boolean;
  r record;
BEGIN
  IF NOT (
    public.is_officer()
    OR nullif(trim(COALESCE(current_setting('request.jwt.claim.role', true), '')), '') = 'service_role'
    OR session_user IN ('postgres', 'supabase_admin')
  ) THEN
    RAISE EXCEPTION 'officer only';
  END IF;

  -- Pooled connections often use a short statement_timeout; this RPC does many subqueries per attendee.
  SET LOCAL statement_timeout = '20min';

  SELECT gle.raid_id INTO v_raid FROM public.guild_loot_sale_enriched gle WHERE gle.loot_id = p_loot_id;
  IF v_raid IS NULL THEN
    RAISE EXCEPTION 'loot_id not found';
  END IF;

  SELECT EXISTS (SELECT 1 FROM raid_event_attendance WHERE raid_id = v_raid LIMIT 1) INTO v_use_per_event;

  SELECT gle.cost_num, gle.buyer_account_id INTO v_p, v_buyer
  FROM public.guild_loot_sale_enriched gle WHERE gle.loot_id = p_loot_id;

  v_runner := NULL;
  v_runner_char := NULL;
  SELECT bpf.runner_up_account_guess, bpf.runner_up_char_guess
  INTO v_runner, v_runner_char
  FROM public.bid_portfolio_auction_fact bpf
  WHERE bpf.loot_id = p_loot_id;

  FOR r IN
    SELECT DISTINCT a.account_id FROM public.attendee_accounts_for_loot(p_loot_id) a
  LOOP
    v_pool := public.account_balance_before_loot(p_loot_id, r.account_id);
    v_could_clear := (v_p IS NOT NULL AND v_p > 0 AND v_pool IS NOT NULL AND v_pool >= v_p);
    v_syn := CASE
      WHEN v_p IS NOT NULL AND v_p > 0 AND v_pool IS NOT NULL THEN
        LEAST(v_pool, GREATEST(0::numeric, v_p - 1))
      ELSE NULL::numeric
    END;

    SELECT
      percentile_cont(0.5) WITHIN GROUP (ORDER BY sub.cost_num),
      count(*)::int
    INTO v_prior_median, v_prior_cnt
    FROM (
      SELECT g2.cost_num
      FROM public.guild_loot_sale_enriched g2
      WHERE g2.buyer_account_id = r.account_id
        AND g2.cost_num > 0
        AND (
          g2.raid_date < (SELECT gle2.raid_date FROM public.guild_loot_sale_enriched gle2 WHERE gle2.loot_id = p_loot_id)
          OR (
            g2.raid_date IS NOT DISTINCT FROM (SELECT gle2.raid_date FROM public.guild_loot_sale_enriched gle2 WHERE gle2.loot_id = p_loot_id)
            AND g2.loot_id < p_loot_id
          )
        )
    ) sub;

    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY sub.ratio)
    INTO v_prior_ratio_med
    FROM (
      SELECT pr.paid_to_ref_ratio AS ratio
      FROM public.guild_loot_sale_enriched pr
      WHERE pr.buyer_account_id = r.account_id
        AND pr.cost_num > 0
        AND pr.paid_to_ref_ratio IS NOT NULL
        AND (
          pr.raid_date < (SELECT gle2.raid_date FROM public.guild_loot_sale_enriched gle2 WHERE gle2.loot_id = p_loot_id)
          OR (
            pr.raid_date IS NOT DISTINCT FROM (SELECT gle2.raid_date FROM public.guild_loot_sale_enriched gle2 WHERE gle2.loot_id = p_loot_id)
            AND pr.loot_id < p_loot_id
          )
        )
    ) sub;

    SELECT g3.loot_id INTO v_later_id
    FROM public.guild_loot_sale_enriched g3
    WHERE g3.buyer_account_id = r.account_id
      AND g3.norm_name = (SELECT gle3.norm_name FROM public.guild_loot_sale_enriched gle3 WHERE gle3.loot_id = p_loot_id)
      AND g3.cost_num > 0
      AND (
        g3.raid_date > (SELECT gle4.raid_date FROM public.guild_loot_sale_enriched gle4 WHERE gle4.loot_id = p_loot_id)
        OR (
          g3.raid_date IS NOT DISTINCT FROM (SELECT gle4.raid_date FROM public.guild_loot_sale_enriched gle4 WHERE gle4.loot_id = p_loot_id)
          AND g3.loot_id > p_loot_id
        )
      )
    ORDER BY g3.raid_date ASC NULLS FIRST, g3.loot_id ASC
    LIMIT 1;

    v_later_flag := v_later_id IS NOT NULL;

    v_att := v_att || jsonb_build_array(
      jsonb_build_object(
        'account_id', r.account_id,
        'pool_before', v_pool,
        'could_clear', v_could_clear,
        'synthetic_max_bid', v_syn,
        'is_buyer', (r.account_id IS NOT DISTINCT FROM v_buyer),
        'median_paid_prior', v_prior_median,
        'purchase_count_prior', COALESCE(v_prior_cnt, 0),
        'median_paid_to_ref_prior', v_prior_ratio_med,
        'later_bought_same_norm', COALESCE(v_later_flag, false),
        'first_later_loot_id', v_later_id
      )
    );
  END LOOP;

  SELECT jsonb_build_object(
    'loot_id', gle.loot_id,
    'raid_id', gle.raid_id,
    'event_id', gle.event_id,
    'item_name', gle.item_name,
    'norm_name', gle.norm_name,
    'raid_date', gle.raid_date,
    'cost_num', gle.cost_num,
    'cost_text', gle.cost_text,
    'buyer_account_id', gle.buyer_account_id,
    'ref_price_at_sale', gle.ref_price_at_sale,
    'paid_to_ref_ratio', gle.paid_to_ref_ratio,
    'next_guild_sale_loot_id', gle.next_guild_sale_loot_id,
    'next_guild_sale_buyer_account_id', gle.next_guild_sale_buyer_account_id
  ) INTO v_sale
  FROM public.guild_loot_sale_enriched gle
  WHERE gle.loot_id = p_loot_id;

  RETURN jsonb_build_object(
    'loot_id', p_loot_id,
    'raid_id', v_raid,
    'sim_mode', CASE WHEN v_use_per_event THEN 'per_event' ELSE 'raid_level' END,
    'sale', COALESCE(v_sale, '{}'::jsonb),
    'runner_up_account_guess', v_runner,
    'runner_up_char_guess', v_runner_char,
    'attendees', v_att,
    'notes', jsonb_build_array(
      'Heuristic only: no auction log.',
      'synthetic_max_bid uses LEAST(pool, P-1) for teaching scaffold.',
      'runner_up_* read from bid_portfolio_auction_fact when present (Python unified pipeline); NULL until CSV/batch backfill.'
    )
  );
END;
$obpfl$;

COMMENT ON FUNCTION public.officer_bid_portfolio_for_loot(bigint) IS
  'Officers only: one loot row — enriched sale, sim_mode, per-attendee pool/could_clear/synthetic_max_bid, purchase priors, later_bought_same_norm, runner_up from bid_portfolio_auction_fact. Uses SET LOCAL statement_timeout = 20min for the call.';

REVOKE ALL ON FUNCTION public.officer_bid_portfolio_for_loot(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.officer_bid_portfolio_for_loot(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.officer_bid_portfolio_for_loot(bigint) TO service_role;

CREATE OR REPLACE FUNCTION public.officer_account_bidding_portfolio(
  p_account_id text,
  p_from_date date DEFAULT NULL,
  p_to_date date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $oabp$
DECLARE
  v_aid text := trim(p_account_id);
  v_wins int := 0;
  v_win_dkp numeric := 0;
  v_present int := 0;
  v_could_clear_lost int := 0;
  v_runner_hits int := 0;
  v_syn_sum numeric := 0;
  v_ref_sum numeric := 0;
  v_ref_n int := 0;
  rec record;
  v_p numeric;
  v_buyer text;
  v_pool numeric;
  v_runner text;
BEGIN
  IF NOT public.is_officer() THEN
    RAISE EXCEPTION 'officer only';
  END IF;

  IF v_aid = '' THEN
    RAISE EXCEPTION 'account_id required';
  END IF;

  FOR rec IN
    SELECT gle.*
    FROM public.guild_loot_sale_enriched gle
    WHERE (p_from_date IS NULL OR gle.raid_date >= p_from_date)
      AND (p_to_date IS NULL OR gle.raid_date <= p_to_date)
  LOOP
    IF rec.buyer_account_id IS NOT DISTINCT FROM v_aid THEN
      v_wins := v_wins + 1;
      v_win_dkp := v_win_dkp + COALESCE(rec.cost_num, 0);
      IF rec.paid_to_ref_ratio IS NOT NULL THEN
        v_ref_sum := v_ref_sum + rec.paid_to_ref_ratio;
        v_ref_n := v_ref_n + 1;
      END IF;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.bid_forecast_attendees_resolved_for_scope(
        rec.raid_id,
        rec.event_id
      ) ar
      WHERE ar.account_id IS NOT DISTINCT FROM v_aid
    ) THEN
      v_present := v_present + 1;
      v_p := rec.cost_num;
      v_buyer := rec.buyer_account_id;
      v_pool := public.account_balance_before_loot(rec.loot_id, v_aid);
      IF v_p > 0 AND v_buyer IS DISTINCT FROM v_aid AND v_pool IS NOT NULL AND v_pool >= v_p THEN
        v_could_clear_lost := v_could_clear_lost + 1;
        v_syn_sum := v_syn_sum + LEAST(v_pool, GREATEST(0::numeric, v_p - 1));
      END IF;
      v_runner := NULL;
      SELECT bpf.runner_up_account_guess INTO v_runner
      FROM public.bid_portfolio_auction_fact bpf
      WHERE bpf.loot_id = rec.loot_id;
      IF v_runner IS NOT DISTINCT FROM v_aid THEN
        v_runner_hits := v_runner_hits + 1;
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'account_id', v_aid,
    'from_date', p_from_date,
    'to_date', p_to_date,
    'loot_rows_won', v_wins,
    'total_dkp_spent_on_wins', v_win_dkp,
    'auction_rows_present', v_present,
    'could_clear_but_not_buyer_count', v_could_clear_lost,
    'runner_up_guess_count', v_runner_hits,
    'sum_synthetic_max_bid_when_present_non_buyer', v_syn_sum,
    'avg_paid_to_ref_on_wins', CASE WHEN v_ref_n > 0 THEN (v_ref_sum / v_ref_n)::numeric ELSE NULL END,
    'notes', jsonb_build_array(
      'auction_rows_present counts loot rows where account appears in attendee resolution for that row event scope.',
      'runner_up_guess_count compares account to bid_portfolio_auction_fact.runner_up_account_guess (Python backfill).'
    )
  );
END;
$oabp$;

COMMENT ON FUNCTION public.officer_account_bidding_portfolio(text, date, date) IS
  'Officers only: aggregate bidding-portfolio stats for one account over raid_date range (guild_loot_sale_enriched + attendee scope per row).';

REVOKE ALL ON FUNCTION public.officer_account_bidding_portfolio(text, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.officer_account_bidding_portfolio(text, date, date) TO authenticated;

-- Materialized bidding-portfolio facts (optional backfill for analytics; batch via officer_backfill_bid_portfolio_batch).
CREATE TABLE IF NOT EXISTS public.bid_portfolio_auction_fact (
  loot_id bigint PRIMARY KEY REFERENCES raid_loot(id) ON DELETE CASCADE,
  raid_id text,
  event_id text,
  raid_date date,
  item_name text,
  norm_name text,
  cost_num numeric,
  buyer_account_id text,
  ref_price_at_sale numeric,
  paid_to_ref_ratio numeric,
  runner_up_account_guess text,
  runner_up_char_guess text,
  next_guild_sale_loot_id bigint,
  next_guild_sale_buyer_account_id text,
  payload jsonb,
  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bid_portfolio_auction_fact_raid_date
  ON public.bid_portfolio_auction_fact (raid_date);
CREATE INDEX IF NOT EXISTS idx_bid_portfolio_auction_fact_buyer
  ON public.bid_portfolio_auction_fact (buyer_account_id);
CREATE INDEX IF NOT EXISTS idx_bid_portfolio_auction_fact_runner_up
  ON public.bid_portfolio_auction_fact (runner_up_account_guess)
  WHERE runner_up_account_guess IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bid_portfolio_auction_fact_norm
  ON public.bid_portfolio_auction_fact (norm_name);

COMMENT ON TABLE public.bid_portfolio_auction_fact IS
  'Optional denormalized row per raid_loot for bidding heuristics (runner-up guess, next guild sale of same item). runner_up_* from Python compute_bid_portfolio_from_csv or upload_second_bidder_runner_up; officer_backfill_bid_portfolio_batch inserts NULL runner columns (use CSV pipeline to fill).';

COMMENT ON COLUMN public.bid_portfolio_auction_fact.runner_up_account_guess IS
  'Inferred second-bidder account_id from Python unified pipeline (compute_bid_portfolio_from_csv and/or run_second_bidder_batch JSONL upload); officer SQL no longer computes this.';

COMMENT ON COLUMN public.bid_portfolio_auction_fact.runner_up_char_guess IS
  'Optional characters.char_id: item-eligible attending lane from unified Python pipeline or second-bidder JSONL upload.';

-- Existing databases before this column: ALTER TABLE public.bid_portfolio_auction_fact ADD COLUMN IF NOT EXISTS runner_up_char_guess text;

ALTER TABLE public.bid_portfolio_auction_fact ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Officers select bid_portfolio_auction_fact" ON public.bid_portfolio_auction_fact;
CREATE POLICY "Officers select bid_portfolio_auction_fact"
  ON public.bid_portfolio_auction_fact FOR SELECT TO authenticated
  USING (public.is_officer());

DROP POLICY IF EXISTS "Officers insert bid_portfolio_auction_fact" ON public.bid_portfolio_auction_fact;
CREATE POLICY "Officers insert bid_portfolio_auction_fact"
  ON public.bid_portfolio_auction_fact FOR INSERT TO authenticated
  WITH CHECK (public.is_officer());

DROP POLICY IF EXISTS "Officers update bid_portfolio_auction_fact" ON public.bid_portfolio_auction_fact;
CREATE POLICY "Officers update bid_portfolio_auction_fact"
  ON public.bid_portfolio_auction_fact FOR UPDATE TO authenticated
  USING (public.is_officer())
  WITH CHECK (public.is_officer());

DROP POLICY IF EXISTS "Officers delete bid_portfolio_auction_fact" ON public.bid_portfolio_auction_fact;
CREATE POLICY "Officers delete bid_portfolio_auction_fact"
  ON public.bid_portfolio_auction_fact FOR DELETE TO authenticated
  USING (public.is_officer());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.bid_portfolio_auction_fact TO authenticated;

DROP POLICY IF EXISTS "Service role full bid_portfolio_auction_fact" ON public.bid_portfolio_auction_fact;
CREATE POLICY "Service role full bid_portfolio_auction_fact"
  ON public.bid_portfolio_auction_fact FOR ALL TO service_role
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.bid_portfolio_auction_fact TO service_role;

CREATE OR REPLACE FUNCTION public.officer_backfill_bid_portfolio_batch(
  p_min_loot_id bigint,
  p_max_loot_id bigint,
  p_include_payload boolean DEFAULT false
)
RETURNS TABLE (rows_upserted integer, rows_errored integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $obfb$
DECLARE
  v_gle record;
  v_payload jsonb;
  v_ok int := 0;
  v_bad int := 0;
  v_inc boolean := COALESCE(p_include_payload, false);
BEGIN
  IF NOT (
    public.is_officer()
    OR nullif(trim(COALESCE(current_setting('request.jwt.claim.role', true), '')), '') = 'service_role'
    OR session_user IN ('postgres', 'supabase_admin')
  ) THEN
    RAISE EXCEPTION 'officer only';
  END IF;

  IF p_min_loot_id IS NULL OR p_max_loot_id IS NULL OR p_min_loot_id > p_max_loot_id THEN
    RAISE EXCEPTION 'invalid loot_id range';
  END IF;

  -- Same as officer_bid_portfolio_for_loot: default pool timeout is too low for payload backfill.
  SET LOCAL statement_timeout = '20min';

  FOR v_gle IN
    SELECT *
    FROM public.guild_loot_sale_enriched gle
    WHERE gle.loot_id >= p_min_loot_id AND gle.loot_id <= p_max_loot_id
    ORDER BY gle.loot_id
  LOOP
    BEGIN
      v_payload := NULL;
      IF v_inc THEN
        v_payload := public.officer_bid_portfolio_for_loot(v_gle.loot_id);
      END IF;

      INSERT INTO public.bid_portfolio_auction_fact (
        loot_id,
        raid_id,
        event_id,
        raid_date,
        item_name,
        norm_name,
        cost_num,
        buyer_account_id,
        ref_price_at_sale,
        paid_to_ref_ratio,
        runner_up_account_guess,
        runner_up_char_guess,
        next_guild_sale_loot_id,
        next_guild_sale_buyer_account_id,
        payload,
        computed_at
      )
      VALUES (
        v_gle.loot_id,
        v_gle.raid_id,
        v_gle.event_id,
        v_gle.raid_date,
        v_gle.item_name,
        v_gle.norm_name,
        v_gle.cost_num,
        v_gle.buyer_account_id,
        v_gle.ref_price_at_sale,
        v_gle.paid_to_ref_ratio,
        NULL,
        NULL,
        v_gle.next_guild_sale_loot_id,
        v_gle.next_guild_sale_buyer_account_id,
        v_payload,
        now()
      )
      ON CONFLICT (loot_id) DO UPDATE SET
        raid_id = EXCLUDED.raid_id,
        event_id = EXCLUDED.event_id,
        raid_date = EXCLUDED.raid_date,
        item_name = EXCLUDED.item_name,
        norm_name = EXCLUDED.norm_name,
        cost_num = EXCLUDED.cost_num,
        buyer_account_id = EXCLUDED.buyer_account_id,
        ref_price_at_sale = EXCLUDED.ref_price_at_sale,
        paid_to_ref_ratio = EXCLUDED.paid_to_ref_ratio,
        runner_up_account_guess = COALESCE(
          EXCLUDED.runner_up_account_guess,
          bid_portfolio_auction_fact.runner_up_account_guess
        ),
        runner_up_char_guess = COALESCE(
          EXCLUDED.runner_up_char_guess,
          bid_portfolio_auction_fact.runner_up_char_guess
        ),
        next_guild_sale_loot_id = EXCLUDED.next_guild_sale_loot_id,
        next_guild_sale_buyer_account_id = EXCLUDED.next_guild_sale_buyer_account_id,
        payload = CASE WHEN v_inc THEN EXCLUDED.payload ELSE bid_portfolio_auction_fact.payload END,
        computed_at = EXCLUDED.computed_at;

      v_ok := v_ok + 1;
    EXCEPTION
      WHEN OTHERS THEN
        v_bad := v_bad + 1;
    END;
  END LOOP;

  RETURN QUERY SELECT v_ok, v_bad;
END;
$obfb$;

COMMENT ON FUNCTION public.officer_backfill_bid_portfolio_batch(bigint, bigint, boolean) IS
  'Officers (JWT), service_role, or direct DB session as postgres/supabase_admin: upsert bid_portfolio_auction_fact for loot_id in [min,max]. Raises statement_timeout locally to 20min. p_include_payload stores full officer_bid_portfolio_for_loot JSON (slow). Inserts NULL runner columns; on conflict, runner_up_* = COALESCE(EXCLUDED, existing) so Python CSV/JSONL backfill is not wiped. For large backfills from the SQL Editor, prefer CALL dba_backfill_bid_portfolio_range (COMMIT between chunks).';

REVOKE ALL ON FUNCTION public.officer_backfill_bid_portfolio_batch(bigint, bigint, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.officer_backfill_bid_portfolio_batch(bigint, bigint, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.officer_backfill_bid_portfolio_batch(bigint, bigint, boolean) TO service_role;

-- Chunked backfill with COMMIT between chunks (SQL Editor / postgres only). Avoids one long transaction and
-- matches manageable statement timeouts per chunk. Not granted to PostgREST API roles.
CREATE OR REPLACE PROCEDURE public.dba_backfill_bid_portfolio_range(
  p_min_loot_id bigint,
  p_max_loot_id bigint,
  p_chunk_size integer DEFAULT 50,
  p_include_payload boolean DEFAULT false
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $dba$
DECLARE
  v_lo bigint;
  v_hi bigint;
  r record;
BEGIN
  IF p_min_loot_id IS NULL OR p_max_loot_id IS NULL OR p_min_loot_id > p_max_loot_id THEN
    RAISE EXCEPTION 'invalid loot_id range';
  END IF;
  IF p_chunk_size IS NULL OR p_chunk_size < 1 THEN
    RAISE EXCEPTION 'p_chunk_size must be >= 1';
  END IF;

  IF session_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'dba_backfill_bid_portfolio_range: run only from Supabase SQL Editor (postgres or supabase_admin)';
  END IF;

  v_lo := p_min_loot_id;
  WHILE v_lo <= p_max_loot_id LOOP
    v_hi := LEAST(v_lo + p_chunk_size::bigint - 1, p_max_loot_id);
    FOR r IN
      SELECT * FROM public.officer_backfill_bid_portfolio_batch(v_lo, v_hi, p_include_payload)
    LOOP
      RAISE NOTICE '[bid_portfolio backfill] loot_id % to %: upserted=% errored=%',
        v_lo, v_hi, r.rows_upserted, r.rows_errored;
    END LOOP;
    COMMIT;
    v_lo := v_hi + 1;
  END LOOP;
END;
$dba$;

COMMENT ON PROCEDURE public.dba_backfill_bid_portfolio_range(bigint, bigint, integer, boolean) IS
  'Supabase SQL Editor: CALL dba_backfill_bid_portfolio_range(1, 10000, 50, false); COMMIT after each chunk. Use p_chunk_size=1 when p_include_payload=true.';

REVOKE ALL ON PROCEDURE public.dba_backfill_bid_portfolio_range(bigint, bigint, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON PROCEDURE public.dba_backfill_bid_portfolio_range(bigint, bigint, integer, boolean) TO postgres;
DO $dba_grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    GRANT EXECUTE ON PROCEDURE public.dba_backfill_bid_portfolio_range(bigint, bigint, integer, boolean) TO supabase_admin;
  END IF;
END;
$dba_grant$;

CREATE OR REPLACE FUNCTION public.officer_global_bid_forecast(p_activity_days integer DEFAULT 120)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_days int := COALESCE(p_activity_days, 120);
  v_hist_cutoff date := (CURRENT_DATE - INTERVAL '730 days')::date;
BEGIN
  IF NOT public.is_officer() THEN
    RAISE EXCEPTION 'officer only';
  END IF;

  IF v_days < 1 OR v_days > 730 THEN
    RAISE EXCEPTION 'p_activity_days must be between 1 and 730';
  END IF;

  SET LOCAL statement_timeout = '120s';

  RETURN (
    WITH active_by_date AS (
      SELECT DISTINCT s.account_id
      FROM account_dkp_summary s
      JOIN accounts a ON a.account_id = s.account_id
      WHERE NOT COALESCE(a.inactive, false)
        AND s.last_activity_date IS NOT NULL
        AND s.last_activity_date >= (CURRENT_DATE - v_days)
    ),
    pinned AS (
      SELECT DISTINCT aa.account_id
      FROM active_accounts aa
      JOIN accounts a ON a.account_id = aa.account_id
      WHERE NOT COALESCE(a.inactive, false)
    ),
    active_account_ids AS (
      SELECT account_id FROM active_by_date
      UNION
      SELECT account_id FROM pinned
    ),
    guild_loot_base AS (
      SELECT
        rl.id AS loot_id,
        public.normalize_item_name_for_lookup(rl.item_name) AS norm_name,
        public.raid_date_parsed(r.date_iso) AS raid_date,
        CASE
          WHEN rl.cost IS NULL OR trim(rl.cost::text) = '' THEN 0::numeric
          ELSE COALESCE(
            NULLIF(regexp_replace(trim(rl.cost::text), '[^0-9.\-]', '', 'g'), '')::numeric,
            0::numeric
          )
        END AS cost_num
      FROM raid_loot rl
      JOIN raids r ON r.raid_id = rl.raid_id
      WHERE rl.item_name IS NOT NULL AND trim(rl.item_name) <> ''
        AND public.raid_date_parsed(r.date_iso) >= v_hist_cutoff
    ),
    roster_by_account AS (
      SELECT
        aai.account_id,
        max(COALESCE(NULLIF(trim(acc.display_name), ''), '')) AS display_name,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'char_id', NULLIF(trim(c.char_id::text), ''),
              'name', COALESCE(NULLIF(trim(c.name), ''), ''),
              'class_name', COALESCE(NULLIF(trim(c.class_name), ''), '')
            )
            ORDER BY lower(trim(COALESCE(c.name, '')))
          ) FILTER (WHERE c.char_id IS NOT NULL),
          '[]'::jsonb
        ) AS characters
      FROM active_account_ids aai
      LEFT JOIN accounts acc ON acc.account_id = aai.account_id
      LEFT JOIN character_account ca ON ca.account_id = aai.account_id
      LEFT JOIN characters c ON c.char_id = ca.char_id
      GROUP BY aai.account_id
    ),
    roster_json AS (
      SELECT jsonb_agg(
        jsonb_build_object(
          'account_id', rba.account_id,
          'display_name', COALESCE(NULLIF(trim(rba.display_name), ''), ''),
          'characters', rba.characters
        )
        ORDER BY rba.account_id
      ) AS arr
      FROM roster_by_account rba
    ),
    loot_for_accounts AS (
      SELECT DISTINCT ON (rl.id)
        ca.account_id,
        rl.id AS loot_id,
        public.raid_date_parsed(r.date_iso) AS raid_date,
        rl.item_name,
        public.normalize_item_name_for_lookup(rl.item_name) AS norm_name,
        rl.cost::text AS cost_text,
        NULLIF(trim(ca.char_id::text), '') AS loot_char_id,
        COALESCE(
          NULLIF(trim(la.assigned_character_name), ''),
          NULLIF(trim(rl.character_name), ''),
          NULLIF(trim(ch.name), '')
        ) AS loot_character_name
      FROM raid_loot rl
      JOIN raids r ON r.raid_id = rl.raid_id
      LEFT JOIN LATERAL (
        SELECT la0.assigned_char_id, la0.assigned_character_name
        FROM loot_assignment la0
        WHERE la0.loot_id = rl.id
        LIMIT 1
      ) la ON true
      LEFT JOIN character_account ca ON (
        (COALESCE(trim(la.assigned_char_id), trim(rl.char_id::text)) <> ''
          AND ca.char_id = COALESCE(trim(la.assigned_char_id), trim(rl.char_id::text)))
        OR (
          COALESCE(trim(la.assigned_character_name), trim(rl.character_name)) <> ''
          AND EXISTS (
            SELECT 1
            FROM characters c2
            WHERE c2.char_id = ca.char_id
              AND trim(c2.name) = COALESCE(trim(la.assigned_character_name), trim(rl.character_name))
          )
        )
      )
      LEFT JOIN characters ch ON ch.char_id = ca.char_id
      WHERE ca.account_id IN (SELECT account_id FROM active_account_ids)
        AND public.raid_date_parsed(r.date_iso) >= v_hist_cutoff
      ORDER BY rl.id, ca.account_id
    ),
    loot_numeric AS (
      SELECT
        account_id,
        loot_id,
        raid_date,
        item_name,
        norm_name,
        CASE
          WHEN cost_text IS NULL OR trim(cost_text) = '' THEN 0::numeric
          ELSE COALESCE(
            NULLIF(regexp_replace(trim(cost_text), '[^0-9.\-]', '', 'g'), '')::numeric,
            0::numeric
          )
        END AS cost_num,
        loot_char_id,
        loot_character_name
      FROM loot_for_accounts
    ),
    per_account_last AS (
      SELECT DISTINCT ON (account_id)
        account_id,
        raid_date AS last_date,
        item_name AS last_item_name,
        cost_num AS last_cost,
        loot_char_id AS last_char_id,
        loot_character_name AS last_character_name
      FROM loot_numeric
      ORDER BY account_id, raid_date DESC NULLS LAST, loot_id DESC
    ),
    per_toon AS (
      SELECT account_id, loot_char_id AS char_id, sum(cost_num) AS spent
      FROM loot_numeric
      WHERE loot_char_id IS NOT NULL
      GROUP BY account_id, loot_char_id
    ),
    per_account_totals AS (
      SELECT account_id, sum(cost_num) AS total_spent, count(*)::int AS purchase_count
      FROM loot_numeric
      GROUP BY account_id
    ),
    per_account_top_share AS (
      SELECT
        aai.account_id,
        CASE
          WHEN COALESCE(pat.total_spent, 0) <= 0 THEN 0::numeric
          ELSE COALESCE(
            (SELECT max(s.spent) FROM per_toon s WHERE s.account_id = aai.account_id),
            0::numeric
          ) / pat.total_spent
        END AS top_toon_share
      FROM active_account_ids aai
      LEFT JOIN per_account_totals pat ON pat.account_id = aai.account_id
    ),
    dkp AS (
      SELECT
        a.account_id,
        COALESCE(s.earned, 0)::numeric AS earned,
        COALESCE(s.spent, 0)::numeric AS spent
      FROM active_account_ids aai
      JOIN accounts a ON a.account_id = aai.account_id
      LEFT JOIN account_dkp_summary s ON s.account_id = a.account_id
    ),
    purchases_limited AS (
      SELECT *
      FROM (
        SELECT
          ln.*,
          row_number() OVER (PARTITION BY account_id ORDER BY raid_date DESC NULLS LAST, loot_id DESC) AS rn
        FROM loot_numeric ln
      ) x
      WHERE x.rn <= 150
    ),
    guild_positive_ref AS (
      SELECT
        gp.loot_id,
        gp.norm_name,
        gp.raid_date,
        avg(gp.cost_num) OVER (
          PARTITION BY gp.norm_name
          ORDER BY gp.raid_date ASC NULLS FIRST, gp.loot_id ASC
          ROWS BETWEEN 3 PRECEDING AND 1 PRECEDING
        ) AS ref_price_at_sale
      FROM guild_loot_base gp
      WHERE gp.cost_num > 0
    ),
    purchases_with_ref AS (
      SELECT
        x.account_id,
        x.loot_id,
        x.raid_date,
        x.item_name,
        x.norm_name,
        x.cost_num,
        x.loot_char_id,
        x.loot_character_name,
        x.ref_price_at_sale,
        CASE
          WHEN x.ref_price_at_sale IS NOT NULL AND x.ref_price_at_sale > 0 AND x.cost_num > 0
          THEN (x.cost_num / x.ref_price_at_sale)::numeric
          ELSE NULL::numeric
        END AS paid_to_ref_ratio
      FROM (
        SELECT
          pl.account_id,
          pl.loot_id,
          pl.raid_date,
          pl.item_name,
          pl.norm_name,
          pl.cost_num,
          pl.loot_char_id,
          pl.loot_character_name,
          CASE
            WHEN pl.cost_num > 0 THEN gpr.ref_price_at_sale
            -- Zero-cost rows: skip per-purchase scans over guild_loot_base (was timing out at scale).
            ELSE NULL::numeric
          END AS ref_price_at_sale
        FROM purchases_limited pl
        LEFT JOIN guild_positive_ref gpr ON pl.cost_num > 0
          AND gpr.norm_name = pl.norm_name
          AND gpr.raid_date IS NOT DISTINCT FROM pl.raid_date
          AND gpr.loot_id = pl.loot_id
      ) x
    ),
    purchases_json AS (
      SELECT
        account_id,
        jsonb_agg(
          jsonb_build_object(
            'loot_id', loot_id,
            'raid_date', raid_date,
            'item_name', item_name,
            'cost', cost_num,
            'char_id', loot_char_id,
            'character_name', loot_character_name,
            'ref_price_at_sale', ref_price_at_sale,
            'paid_to_ref_ratio', paid_to_ref_ratio
          )
          ORDER BY raid_date ASC NULLS FIRST, loot_id ASC
        ) AS purchases
      FROM purchases_with_ref
      GROUP BY account_id
    ),
    per_toon_json AS (
      SELECT
        account_id,
        jsonb_object_agg(char_id, spent) AS per_toon
      FROM per_toon
      GROUP BY account_id
    ),
    -- Lifetime DKP earned per roster character (raid_attendance_dkp.character_key is char_id or name)
    per_toon_earned_agg AS (
      SELECT
        ca.account_id,
        NULLIF(trim(c.char_id::text), '') AS char_id,
        COALESCE(SUM(rad.dkp_earned), 0)::numeric AS earned
      FROM active_account_ids aai
      INNER JOIN character_account ca ON ca.account_id = aai.account_id
      INNER JOIN characters c ON c.char_id = ca.char_id AND c.char_id IS NOT NULL
      INNER JOIN raid_attendance_dkp rad ON (
        rad.character_key = NULLIF(trim(c.char_id::text), '')
        OR (
          COALESCE(NULLIF(trim(c.name), ''), '') <> ''
          AND rad.character_key = trim(c.name)
        )
      )
      GROUP BY ca.account_id, NULLIF(trim(c.char_id::text), '')
    ),
    per_toon_earned_json AS (
      SELECT
        account_id,
        jsonb_object_agg(char_id::text, earned) AS per_toon_earned
      FROM per_toon_earned_agg
      WHERE char_id IS NOT NULL
      GROUP BY account_id
    ),
    profiles AS (
      SELECT jsonb_object_agg(
        d.account_id,
        jsonb_build_object(
          'earned', d.earned,
          'spent', d.spent,
          'balance', d.earned - d.spent,
          'last_purchase', CASE
            WHEN pal.last_date IS NULL THEN NULL
            ELSE jsonb_build_object(
              'raid_date', pal.last_date,
              'item_name', pal.last_item_name,
              'cost', pal.last_cost,
              'char_id', COALESCE(pal.last_char_id, ''),
              'character_name', COALESCE(pal.last_character_name, '')
            )
          END,
          'days_since_last_spend', CASE
            WHEN pal.last_date IS NULL THEN NULL
            ELSE (CURRENT_DATE - pal.last_date)::int
          END,
          'per_toon_spent', COALESCE(pt.per_toon, '{}'::jsonb),
          'per_toon_earned', COALESCE(pte.per_toon_earned, '{}'::jsonb),
          'top_toon_share', COALESCE(pts.top_toon_share, 0),
          'total_spent_tracked', COALESCE(pat.total_spent, 0),
          'purchase_count', COALESCE(pat.purchase_count, 0),
          'recent_purchases_desc', COALESCE(pj.purchases, '[]'::jsonb)
        )
      ) AS obj
      FROM dkp d
      LEFT JOIN per_account_last pal ON pal.account_id = d.account_id
      LEFT JOIN per_toon_json pt ON pt.account_id = d.account_id
      LEFT JOIN per_toon_earned_json pte ON pte.account_id = d.account_id
      LEFT JOIN per_account_top_share pts ON pts.account_id = d.account_id
      LEFT JOIN per_account_totals pat ON pat.account_id = d.account_id
      LEFT JOIN purchases_json pj ON pj.account_id = d.account_id
    )
    SELECT jsonb_build_object(
      'activity_days', v_days,
      'roster', COALESCE((SELECT arr FROM roster_json), '[]'::jsonb),
      'account_profiles', COALESCE((SELECT obj FROM profiles), '{}'::jsonb)
    )
  );
END;
$$;

COMMENT ON FUNCTION public.officer_global_bid_forecast(integer) IS
  'Officers only: active accounts (recent activity or pinned) with roster characters + spend profiles including per_toon_earned (raid_attendance_dkp), per_toon_spent, ref_price_at_sale per purchase (paid rows only; zero-cost purchases omit ref). guild_loot_base and per-account purchase joins use last 730d of raid dates; SET LOCAL statement_timeout = 120s.';

REVOKE ALL ON FUNCTION public.normalize_item_name_for_lookup(text) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.officer_global_bid_forecast(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.officer_global_bid_forecast(integer) TO authenticated;
