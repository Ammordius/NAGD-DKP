-- =============================================================================
-- Performance fix: per-raid account DKP refresh (upload + officer flows).
-- Apply in Supabase SQL Editor (or psql) against an existing project.
--
-- 1) Index: reverse lookup from account_id to characters (speeds EXISTS filters).
--    CONCURRENTLY cannot run inside a transaction; run this statement alone if needed.
-- 2) Deploy the CREATE OR REPLACE FUNCTION public.refresh_account_dkp_summary_for_raid
--    definition from docs/supabase-schema-full.sql (same as docs/supabase-account-dkp-schema.sql).
--
-- Staging verification (optional):
--   EXPLAIN (ANALYZE, BUFFERS) SELECT refresh_account_dkp_summary_for_raid('YOUR_RAID_ID');
-- =============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_character_account_account_id
  ON character_account (account_id);
