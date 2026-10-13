-- =============================================================================
-- One-off for existing DBs: avoid statement timeout when deleting a tic.
-- Canonical schema (supabase-schema.sql) now includes the statement-level DELETE
-- trigger. Run this only if you applied an older supabase-schema.sql before that
-- change (same content as the canonical trigger block).
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
