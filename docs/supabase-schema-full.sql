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

-- Backfill all raids (run once after creating tables or importing data).
CREATE OR REPLACE FUNCTION public.refresh_all_raid_attendance_totals()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE r TEXT;
BEGIN
  FOR r IN SELECT DISTINCT raid_id FROM (
    SELECT raid_id FROM raid_events
    UNION SELECT raid_id FROM raid_event_attendance
    UNION SELECT raid_id FROM raid_attendance
  ) t
  LOOP
    PERFORM refresh_raid_attendance_totals(r);
  END LOOP;
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

-- 2) Bulk insert raid_event_attendance (avoids per-row triggers; single refresh at end)
CREATE OR REPLACE FUNCTION public.insert_raid_event_attendance_for_upload(p_raid_id text, p_rows jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
BEGIN
  IF p_raid_id IS NULL OR trim(p_raid_id) = '' THEN
    RAISE EXCEPTION 'p_raid_id is required';
  END IF;
  IF p_rows IS NULL OR jsonb_array_length(p_rows) = 0 THEN
    RETURN;
  END IF;

  SET LOCAL statement_timeout = '120s';

  PERFORM begin_restore_load();

  INSERT INTO raid_event_attendance (raid_id, event_id, char_id, character_name, account_id)
  SELECT
    COALESCE(trim((elem->>'raid_id')), trim(p_raid_id)),
    trim(elem->>'event_id'),
    NULLIF(trim(elem->>'char_id'), ''),
    NULLIF(trim(elem->>'character_name'), ''),
    NULLIF(trim(elem->>'account_id'), '')
  FROM jsonb_array_elements(p_rows) AS elem;

  PERFORM end_restore_load();
END;
$$;

COMMENT ON FUNCTION public.insert_raid_event_attendance_for_upload(text, jsonb) IS 'Bulk insert raid_event_attendance for upload script. Uses restore_load to avoid per-row triggers then runs full refresh. p_rows: JSON array of {raid_id, event_id, char_id, character_name, account_id}.';
GRANT EXECUTE ON FUNCTION public.insert_raid_event_attendance_for_upload(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.insert_raid_event_attendance_for_upload(text, jsonb) TO authenticated;
