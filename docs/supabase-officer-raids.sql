-- Officer raid management: RLS policies for INSERT/UPDATE/DELETE and delete_raid RPC.
-- Run in Supabase SQL Editor after supabase-schema.sql.

-- Officer-only write policies for raids and related tables
DROP POLICY IF EXISTS "Officers manage raids" ON raids;
CREATE POLICY "Officers manage raids" ON raids FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'officer'))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'officer'));

DROP POLICY IF EXISTS "Officers manage raid_events" ON raid_events;
CREATE POLICY "Officers manage raid_events" ON raid_events FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'officer'))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'officer'));

DROP POLICY IF EXISTS "Officers manage raid_loot" ON raid_loot;
CREATE POLICY "Officers manage raid_loot" ON raid_loot FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'officer'))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'officer'));

DROP POLICY IF EXISTS "Officers manage raid_attendance" ON raid_attendance;
CREATE POLICY "Officers manage raid_attendance" ON raid_attendance FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'officer'))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'officer'));

DROP POLICY IF EXISTS "Officers manage raid_event_attendance" ON raid_event_attendance;
CREATE POLICY "Officers manage raid_event_attendance" ON raid_event_attendance FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'officer'))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'officer'));

DROP POLICY IF EXISTS "Officers manage raid_classifications" ON raid_classifications;
CREATE POLICY "Officers manage raid_classifications" ON raid_classifications FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'officer'))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'officer'));

-- Cascading delete: removes all attendance, events, loot, and the raid. Officers only.
CREATE OR REPLACE FUNCTION public.delete_raid(p_raid_id TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (SELECT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'officer')) THEN
    RAISE EXCEPTION 'Only officers can delete raids';
  END IF;
  DELETE FROM raid_loot WHERE raid_id = p_raid_id;
  DELETE FROM raid_event_attendance WHERE raid_id = p_raid_id;
  DELETE FROM raid_attendance WHERE raid_id = p_raid_id;
  DELETE FROM raid_events WHERE raid_id = p_raid_id;
  DELETE FROM raid_classifications WHERE raid_id = p_raid_id;
  DELETE FROM raids WHERE raid_id = p_raid_id;
END;
$$;
