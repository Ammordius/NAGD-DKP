-- =============================================================================
-- RPC for restore: truncate DKP data tables in one call (run via API).
-- Run this once in Supabase SQL Editor to create the function. After that,
-- the restore script can call it via client.rpc('truncate_dkp_for_restore')
-- instead of clearing tables with many API deletes. Does not truncate accounts
-- (profiles references them). Does not touch profiles or auth.
-- =============================================================================

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

-- Allow service_role (and anon if needed) to call it
GRANT EXECUTE ON FUNCTION public.truncate_dkp_for_restore() TO service_role;
GRANT EXECUTE ON FUNCTION public.truncate_dkp_for_restore() TO authenticated;
