-- =============================================================================
-- RPC: delete all data for one raid (events, loot, attendance, event_attendance)
-- so it can be re-uploaded. Call via API: client.rpc('delete_raid_for_reupload', {'p_raid_id': '1598692'}).
--
-- Run this once in Supabase SQL Editor to create the function. After that, the
-- upload script uses it via the API (no SQL Editor needed).
-- =============================================================================

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
