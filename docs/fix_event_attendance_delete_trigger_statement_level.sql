-- =============================================================================
-- Avoid statement timeout when deleting a tic (many raid_event_attendance rows).
-- Before: DELETE triggered refresh_raid_attendance_totals(raid_id) FOR EACH ROW,
-- so deleting 50 attendees = 50x the same refresh. Now: one trigger per statement,
-- refresh each affected raid once.
-- Run in Supabase SQL Editor after supabase-schema.sql.
-- =============================================================================

-- Function for statement-level DELETE: refresh each distinct raid_id from deleted rows.
CREATE OR REPLACE FUNCTION public.trigger_refresh_raid_totals_after_event_attendance_del_stmt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
BEGIN
  IF public.restore_load_in_progress() THEN RETURN NULL; END IF;
  FOR r IN SELECT DISTINCT raid_id FROM deleted_rows
  LOOP
    PERFORM refresh_raid_attendance_totals(r.raid_id);
  END LOOP;
  RETURN NULL;
END;
$$;

-- Drop the per-row DELETE trigger and create statement-level one (transition table = deleted_rows).
DROP TRIGGER IF EXISTS refresh_raid_totals_after_event_attendance_del ON raid_event_attendance;
CREATE TRIGGER refresh_raid_totals_after_event_attendance_del
  AFTER DELETE ON raid_event_attendance
  REFERENCING OLD TABLE AS deleted_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.trigger_refresh_raid_totals_after_event_attendance_del_stmt();
