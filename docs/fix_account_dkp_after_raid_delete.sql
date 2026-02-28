-- =============================================================================
-- One-off: fix account_dkp_summary and period totals after deleting a raid.
-- The leaderboard uses account_dkp_summary; delete_raid() only refreshed
-- dkp_summary (character) and dkp_period_totals, so account totals stayed stale.
--
-- Run once in Supabase SQL Editor as an officer (or service_role).
-- After this, deploy the updated delete_raid in supabase-officer-raids.sql
-- so future raid deletes also refresh account_dkp_summary.
-- =============================================================================

SELECT refresh_account_dkp_summary();
