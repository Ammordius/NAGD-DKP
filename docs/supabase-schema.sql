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

-- 5) First officer: run after creating your user in Supabase Auth (replace YOUR_USER_UUID)
-- INSERT INTO profiles (id, email, role) VALUES ('YOUR_USER_UUID', 'your@email.com', 'officer')
-- ON CONFLICT (id) DO UPDATE SET role = 'officer';
