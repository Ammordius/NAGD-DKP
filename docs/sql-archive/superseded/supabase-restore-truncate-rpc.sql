-- =============================================================================
-- Restore RPCs. Run this in the Supabase SQL Editor. Does not touch accounts,
-- account_class_coverage, profiles, or auth.
--   truncate_dkp_for_restore: clear DKP tables in one call
--   end_restore_load: sequences, DKP refresh, and character spent
--   character_dkp_spent triggers: no-op while a restore load is in progress
-- =============================================================================

CREATE OR REPLACE FUNCTION public.truncate_dkp_for_restore()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  TRUNCATE TABLE loot_assignment;
  TRUNCATE TABLE bid_portfolio_auction_fact;
  TRUNCATE TABLE character_dkp_spent;
  TRUNCATE TABLE character_loot_assignment_counts;
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
  -- do not truncate accounts (profiles references them) or account_class_coverage
  TRUNCATE TABLE account_dkp_summary;
  TRUNCATE TABLE dkp_summary;
  TRUNCATE TABLE dkp_adjustments;
  TRUNCATE TABLE dkp_period_totals;
  TRUNCATE TABLE active_raiders;
  TRUNCATE TABLE active_accounts;
  TRUNCATE TABLE officer_audit_log;
END;
$$;

COMMENT ON FUNCTION public.truncate_dkp_for_restore() IS 'Truncate DKP data tables for restore; used by restore script via API. Does not truncate accounts or account_class_coverage.';

-- Allow service_role (and anon if needed) to call it
GRANT EXECUTE ON FUNCTION public.truncate_dkp_for_restore() TO service_role;
GRANT EXECUTE ON FUNCTION public.truncate_dkp_for_restore() TO authenticated;

CREATE OR REPLACE FUNCTION public.end_restore_load()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  SET LOCAL statement_timeout = '600s';
  UPDATE restore_in_progress SET in_progress = false WHERE id = 1;
  PERFORM fix_serial_sequences_for_restore();
  PERFORM refresh_dkp_summary();
  PERFORM refresh_all_raid_attendance_totals();
  PERFORM refresh_account_dkp_summary_internal();
  PERFORM refresh_character_dkp_spent();
END;
$$;
COMMENT ON FUNCTION public.end_restore_load() IS 'Signal end of bulk restore load; re-enables triggers and runs full DKP, raid totals, and character spent refresh.';
GRANT EXECUTE ON FUNCTION public.end_restore_load() TO service_role;
GRANT EXECUTE ON FUNCTION public.end_restore_load() TO authenticated;

CREATE OR REPLACE FUNCTION public.trigger_refresh_character_dkp_spent()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF restore_load_in_progress() THEN RETURN NULL; END IF;
  PERFORM refresh_character_dkp_spent();
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.trigger_refresh_character_dkp_spent_after_assignment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF restore_load_in_progress() THEN RETURN NULL; END IF;
  PERFORM refresh_character_dkp_spent();
  RETURN NULL;
END;
$$;
