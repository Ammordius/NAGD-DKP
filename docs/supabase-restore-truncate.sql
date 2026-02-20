-- =============================================================================
-- Supabase restore: truncate all DKP data tables (no one-off adjustments).
-- Used by scripts/restore_supabase_from_backup.py before loading backup CSVs.
-- Does not touch auth.users. Profiles are truncated only if --include-profiles.
-- =============================================================================

-- Child tables first, then parent. RESTART IDENTITY resets serials for COPY.
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
TRUNCATE TABLE accounts CASCADE;
TRUNCATE TABLE dkp_summary;
TRUNCATE TABLE dkp_adjustments;
TRUNCATE TABLE dkp_period_totals;
TRUNCATE TABLE active_raiders;
TRUNCATE TABLE officer_audit_log;
