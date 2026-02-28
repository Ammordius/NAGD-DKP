-- =============================================================================
-- Supabase restore: truncate DKP data tables (run in SQL Editor before restore).
-- Optional: for truncate via API, use docs/supabase-restore-truncate-rpc.sql
-- to create truncate_dkp_for_restore(); then the restore script calls it automatically.
-- Does not touch profiles or auth.
-- =============================================================================

-- Do not truncate accounts (profiles references them). Restore script will upsert accounts.

-- Child tables first, then parent. RESTART IDENTITY resets serials.
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
-- TRUNCATE TABLE accounts CASCADE;  -- skip: profiles references accounts
TRUNCATE TABLE account_dkp_summary;
TRUNCATE TABLE dkp_summary;
TRUNCATE TABLE dkp_adjustments;
TRUNCATE TABLE dkp_period_totals;
TRUNCATE TABLE active_raiders;
TRUNCATE TABLE active_accounts;
TRUNCATE TABLE officer_audit_log;
