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
CREATE OR REPLACE VIEW raid_events_ordered AS
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
CREATE OR REPLACE VIEW officer_audit_loot AS
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

-- Helper for RLS and RPCs: is current user an officer? (SECURITY DEFINER so reading profiles doesn't trigger RLS recursion.)
CREATE OR REPLACE FUNCTION public.is_officer()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'officer');
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

-- Refresh raid_dkp_totals and raid_attendance_dkp for one raid (used by triggers and by backfill).
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
  -- 1) Raid total DKP from raid_events
  SELECT COALESCE(SUM((dkp_value::numeric)), 0) INTO raid_total FROM raid_events WHERE raid_id = p_raid_id;
  INSERT INTO raid_dkp_totals (raid_id, total_dkp) VALUES (p_raid_id, COALESCE(raid_total, 0))
  ON CONFLICT (raid_id) DO UPDATE SET total_dkp = EXCLUDED.total_dkp;

  -- 2) Per-character earned for this raid
  DELETE FROM raid_attendance_dkp WHERE raid_id = p_raid_id;

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

-- RPC for restore: truncate DKP data tables in one call (used by restore script via client.rpc).
-- Does not truncate accounts (profiles references them). Does not touch profiles or auth.
CREATE OR REPLACE FUNCTION public.truncate_dkp_for_restore()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
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
  -- do not truncate accounts (profiles references them)
  TRUNCATE TABLE dkp_summary;
  TRUNCATE TABLE dkp_adjustments;
  TRUNCATE TABLE dkp_period_totals;
  TRUNCATE TABLE active_raiders;
  TRUNCATE TABLE officer_audit_log;
END;
$$;
COMMENT ON FUNCTION public.truncate_dkp_for_restore() IS 'Truncate DKP data tables for restore; used by restore script via API. Does not truncate accounts.';
GRANT EXECUTE ON FUNCTION public.truncate_dkp_for_restore() TO service_role;
GRANT EXECUTE ON FUNCTION public.truncate_dkp_for_restore() TO authenticated;

-- Restore load mode: when true, DKP triggers no-op so bulk insert is fast; restore script calls end_restore_load() to clear and run refresh.
CREATE TABLE IF NOT EXISTS public.restore_in_progress (id int PRIMARY KEY DEFAULT 1, in_progress boolean NOT NULL DEFAULT false);
INSERT INTO public.restore_in_progress (id, in_progress) VALUES (1, false) ON CONFLICT (id) DO NOTHING;

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

CREATE OR REPLACE FUNCTION public.end_restore_load()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE restore_in_progress SET in_progress = false WHERE id = 1;
  PERFORM fix_serial_sequences_for_restore();
  PERFORM refresh_dkp_summary();
  PERFORM refresh_all_raid_attendance_totals();
END;
$$;
COMMENT ON FUNCTION public.end_restore_load() IS 'Signal end of bulk restore load; re-enables triggers and runs full DKP/raid totals refresh.';
GRANT EXECUTE ON FUNCTION public.end_restore_load() TO service_role;
GRANT EXECUTE ON FUNCTION public.end_restore_load() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fix_serial_sequences_for_restore() TO service_role;
GRANT EXECUTE ON FUNCTION public.fix_serial_sequences_for_restore() TO authenticated;

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
