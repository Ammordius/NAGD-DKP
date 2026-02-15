-- Officer raid management: RLS policies for INSERT/UPDATE/DELETE and delete_raid RPC.
-- Run in Supabase SQL Editor after supabase-schema.sql.
--
-- Fix for "infinite recursion in policy for relation profiles": policies on profiles
-- must not SELECT from profiles. We use a SECURITY DEFINER function so the check
-- runs with definer (bypasses RLS) and use it everywhere.

-- Helper: current user is officer (SECURITY DEFINER so reading profiles doesn't trigger RLS).
CREATE OR REPLACE FUNCTION public.is_officer()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'officer');
$$;

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
AS $$
BEGIN
  IF NOT public.is_officer() THEN
    RAISE EXCEPTION 'Only officers can delete raids';
  END IF;

  -- Allow more time for deletes + one full refresh (Supabase default can be as low as 8s).
  SET LOCAL statement_timeout = '120s';

  -- Disable triggers that would run full refresh or per-row refresh on each delete (causes timeout).
  ALTER TABLE raid_loot DISABLE TRIGGER full_refresh_dkp_after_loot_change;
  ALTER TABLE raid_event_attendance DISABLE TRIGGER full_refresh_dkp_after_event_attendance_change;
  ALTER TABLE raid_event_attendance DISABLE TRIGGER refresh_raid_totals_after_event_attendance_del;
  ALTER TABLE raid_attendance DISABLE TRIGGER full_refresh_dkp_after_attendance_change;
  ALTER TABLE raid_events DISABLE TRIGGER refresh_raid_totals_after_events_del;

  DELETE FROM raid_loot WHERE raid_id = p_raid_id;
  DELETE FROM raid_attendance_dkp WHERE raid_id = p_raid_id;
  DELETE FROM raid_dkp_totals WHERE raid_id = p_raid_id;
  DELETE FROM raid_event_attendance WHERE raid_id = p_raid_id;
  DELETE FROM raid_attendance WHERE raid_id = p_raid_id;
  DELETE FROM raid_events WHERE raid_id = p_raid_id;
  DELETE FROM raid_classifications WHERE raid_id = p_raid_id;
  DELETE FROM raids WHERE raid_id = p_raid_id;

  -- Single full refresh so dkp_summary and dkp_period_totals stay correct.
  PERFORM refresh_dkp_summary_internal();

  -- Re-enable triggers (same order as disable).
  ALTER TABLE raid_events ENABLE TRIGGER refresh_raid_totals_after_events_del;
  ALTER TABLE raid_attendance ENABLE TRIGGER full_refresh_dkp_after_attendance_change;
  ALTER TABLE raid_event_attendance ENABLE TRIGGER refresh_raid_totals_after_event_attendance_del;
  ALTER TABLE raid_event_attendance ENABLE TRIGGER full_refresh_dkp_after_event_attendance_change;
  ALTER TABLE raid_loot ENABLE TRIGGER full_refresh_dkp_after_loot_change;
END;
$$;
