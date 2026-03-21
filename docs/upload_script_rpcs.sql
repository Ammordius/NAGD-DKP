-- =============================================================================
-- Upload script RPCs: run AFTER supabase-officer-raids.sql.
-- Used by scripts/pull_parse_dkp_site/upload_raid_detail_to_supabase.py.
--
-- 1) delete_raid_for_reupload — clear one raid so it can be re-uploaded.
-- 2) insert_raid_event_attendance_for_upload — bulk insert raid_event_attendance
--    (avoids per-row trigger storm; uses restore_load then one refresh).
-- =============================================================================

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
-- Do NOT call end_restore_load() here: Supabase caps statement duration (~120s) for API queries; a full
-- dkp_summary + refresh_all_raid_attendance_totals + account_dkp refresh exceeds that. The upload
-- script already calls refresh_account_dkp_summary_for_raid + refresh_dkp_summary in separate requests.
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
