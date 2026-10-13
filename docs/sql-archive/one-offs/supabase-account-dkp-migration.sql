-- =============================================================================
-- Migration: backfill account_id and populate account-scoped DKP tables.
-- Run AFTER supabase-account-dkp-schema.sql in Supabase SQL Editor.
--
-- Triggers on raid_event_attendance fire per row and make step 1 very slow. Use
-- restore-load mode for the whole migration (same as backup restore), then clear once.
--
--   BEFORE migration: SELECT begin_restore_load();   -- DKP triggers no-op
--   Step 1 (batched): SELECT * FROM run_account_dkp_migration_step1_batch(2000);
--      Repeat until (updated_by_char_id, updated_by_name) = (0, 0).
--   Step 2a: SELECT run_account_dkp_migration_step2a();
--   Step 2b (batched): SELECT * FROM refresh_raid_attendance_totals_batch(50, NULL);
--      Then: SELECT * FROM refresh_raid_attendance_totals_batch(50, '<next_raid_id>');
--      Repeat until processed = 0.
--   Step 3: SELECT run_account_dkp_migration_step3();
--   AFTER migration: SELECT clear_restore_load();    -- re-enable triggers
--
--   Optional: Step 4 populates active_accounts from active_raiders. Not required—
--   the leaderboard shows any account with recent activity (120d). active_accounts
--   is for exceptions only (e.g. always show someone with no recent activity).
--   If desired: SELECT run_account_dkp_migration_step4();
-- =============================================================================

-- Re-enable DKP triggers after migration step 1 (no full refresh; we do batched step 2b instead).
CREATE OR REPLACE FUNCTION public.clear_restore_load()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE restore_in_progress SET in_progress = false WHERE id = 1;
END;
$$;
COMMENT ON FUNCTION public.clear_restore_load() IS 'Clear restore_load flag so DKP triggers run again. Call once after all migration steps (do not run end_restore_load; we use batched step 2b instead).';
GRANT EXECUTE ON FUNCTION public.clear_restore_load() TO service_role;
GRANT EXECUTE ON FUNCTION public.clear_restore_load() TO authenticated;

-- Batched raid totals refresh: process up to p_batch_size raids, return (processed_count, next_raid_id).
-- Call repeatedly with the returned next_raid_id until processed = 0.
CREATE OR REPLACE FUNCTION public.refresh_raid_attendance_totals_batch(
  p_batch_size int DEFAULT 50,
  p_after_raid_id text DEFAULT NULL
)
RETURNS TABLE(processed bigint, next_raid_id text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r text;
  batch_raid_ids text[];
  i int;
  last_id text;
  cnt bigint := 0;
BEGIN
  SELECT ARRAY_AGG(raid_id ORDER BY raid_id)
  INTO batch_raid_ids
  FROM (
    SELECT DISTINCT raid_id FROM (
      SELECT raid_id FROM raid_events
      UNION SELECT raid_id FROM raid_event_attendance
      UNION SELECT raid_id FROM raid_attendance
    ) t
    WHERE (p_after_raid_id IS NULL OR raid_id > p_after_raid_id)
    ORDER BY raid_id
    LIMIT p_batch_size
  ) sub;

  IF batch_raid_ids IS NULL OR array_length(batch_raid_ids, 1) IS NULL THEN
    processed := 0;
    next_raid_id := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  FOR i IN 1 .. array_length(batch_raid_ids, 1) LOOP
    r := batch_raid_ids[i];
    PERFORM refresh_raid_attendance_totals(r);
    cnt := cnt + 1;
    last_id := r;
  END LOOP;

  processed := cnt;
  next_raid_id := last_id;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.refresh_raid_attendance_totals_batch(int, text) IS 'Process up to p_batch_size raids for attendance totals. Returns (processed, next_raid_id). Call repeatedly with next_raid_id until processed=0.';

-- Overload so next_raid_id can be passed as integer/bigint (e.g. from previous result).
CREATE OR REPLACE FUNCTION public.refresh_raid_attendance_totals_batch(
  p_batch_size int,
  p_after_raid_id bigint
)
RETURNS TABLE(processed bigint, next_raid_id text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM public.refresh_raid_attendance_totals_batch(p_batch_size, p_after_raid_id::text);
$$;
COMMENT ON FUNCTION public.refresh_raid_attendance_totals_batch(int, bigint) IS 'Same as (int, text); accepts numeric next_raid_id from previous batch result.';

GRANT EXECUTE ON FUNCTION public.refresh_raid_attendance_totals_batch(int, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_raid_attendance_totals_batch(int, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_raid_attendance_totals_batch(int, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_raid_attendance_totals_batch(int, bigint) TO authenticated;

-- Step 1 (one-shot): Backfill raid_event_attendance.account_id — may timeout on large data; use step1_batch instead. Uses restore_load so triggers no-op.
CREATE OR REPLACE FUNCTION public.run_account_dkp_migration_step1()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM begin_restore_load();
  UPDATE raid_event_attendance rea
  SET account_id = ca.account_id
  FROM character_account ca
  WHERE rea.account_id IS NULL
    AND rea.char_id IS NOT NULL AND trim(rea.char_id::text) <> ''
    AND ca.char_id = trim(rea.char_id::text);

  UPDATE raid_event_attendance rea
  SET account_id = ca.account_id
  FROM character_account ca
  JOIN characters c ON c.char_id = ca.char_id AND trim(c.name) = trim(rea.character_name)
  WHERE rea.account_id IS NULL
    AND rea.character_name IS NOT NULL AND trim(rea.character_name) <> '';

  PERFORM clear_restore_load();
END;
$$;

COMMENT ON FUNCTION public.run_account_dkp_migration_step1() IS 'Migration step 1 (one-shot): backfill raid_event_attendance.account_id. May timeout; use run_account_dkp_migration_step1_batch instead.';
GRANT EXECUTE ON FUNCTION public.run_account_dkp_migration_step1() TO service_role;
GRANT EXECUTE ON FUNCTION public.run_account_dkp_migration_step1() TO authenticated;

-- Step 1 (batched): Backfill raid_event_attendance.account_id in small batches. Run until (0, 0).
CREATE OR REPLACE FUNCTION public.run_account_dkp_migration_step1_batch(p_limit int DEFAULT 2000)
RETURNS TABLE(updated_by_char_id bigint, updated_by_name bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n_char bigint := 0;
  n_name bigint := 0;
BEGIN
  -- Batch: match by char_id (up to p_limit rows)
  WITH batch AS (
    SELECT DISTINCT ON (rea.id) rea.id, ca.account_id
    FROM raid_event_attendance rea
    JOIN character_account ca ON ca.char_id = trim(rea.char_id::text)
    WHERE rea.account_id IS NULL
      AND rea.char_id IS NOT NULL AND trim(rea.char_id::text) <> ''
    LIMIT p_limit
  )
  UPDATE raid_event_attendance rea
  SET account_id = batch.account_id
  FROM batch
  WHERE rea.id = batch.id;
  GET DIAGNOSTICS n_char = ROW_COUNT;

  -- Batch: match by character_name (up to p_limit rows still missing account_id)
  WITH batch AS (
    SELECT DISTINCT ON (rea.id) rea.id, ca.account_id
    FROM raid_event_attendance rea
    JOIN characters c ON trim(c.name) = trim(rea.character_name)
    JOIN character_account ca ON ca.char_id = c.char_id
    WHERE rea.account_id IS NULL
      AND rea.character_name IS NOT NULL AND trim(rea.character_name) <> ''
    LIMIT p_limit
  )
  UPDATE raid_event_attendance rea
  SET account_id = batch.account_id
  FROM batch
  WHERE rea.id = batch.id;
  GET DIAGNOSTICS n_name = ROW_COUNT;

  updated_by_char_id := n_char;
  updated_by_name := n_name;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.run_account_dkp_migration_step1_batch(int) IS 'Migration step 1 (batched): backfill raid_event_attendance.account_id. Returns (updated_by_char_id, updated_by_name). Run until (0, 0).';
GRANT EXECUTE ON FUNCTION public.run_account_dkp_migration_step1_batch(int) TO service_role;
GRANT EXECUTE ON FUNCTION public.run_account_dkp_migration_step1_batch(int) TO authenticated;

-- Step 2a: Refresh account_dkp_summary only (idempotent)
CREATE OR REPLACE FUNCTION public.run_account_dkp_migration_step2a()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM refresh_account_dkp_summary_internal();
END;
$$;

COMMENT ON FUNCTION public.run_account_dkp_migration_step2a() IS 'Migration step 2a: refresh account_dkp_summary. Idempotent.';
GRANT EXECUTE ON FUNCTION public.run_account_dkp_migration_step2a() TO service_role;
GRANT EXECUTE ON FUNCTION public.run_account_dkp_migration_step2a() TO authenticated;

-- Step 3: Backfill dkp_adjustments.account_id (idempotent)
CREATE OR REPLACE FUNCTION public.run_account_dkp_migration_step3()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE dkp_adjustments da
  SET account_id = sub.account_id
  FROM (
    SELECT DISTINCT ON (trim(c.name)) c.name AS character_name, ca.account_id
    FROM characters c
    JOIN character_account ca ON ca.char_id = c.char_id
    WHERE trim(c.name) <> ''
  ) sub
  WHERE da.account_id IS NULL
    AND trim(da.character_name) = sub.character_name;
END;
$$;

COMMENT ON FUNCTION public.run_account_dkp_migration_step3() IS 'Migration step 3: backfill dkp_adjustments.account_id. Idempotent.';
GRANT EXECUTE ON FUNCTION public.run_account_dkp_migration_step3() TO service_role;
GRANT EXECUTE ON FUNCTION public.run_account_dkp_migration_step3() TO authenticated;

-- Step 4 (optional): Populate active_accounts from active_raiders. Only needed if you want to
-- seed "always show" exceptions from the old active_raiders list. Leaderboard already shows
-- any account with recent activity (120d); active_accounts is for extra pin-to-list accounts.
CREATE OR REPLACE FUNCTION public.run_account_dkp_migration_step4()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO active_accounts (account_id)
  SELECT DISTINCT ca.account_id
  FROM active_raiders ar
  JOIN character_account ca ON (
    (trim(ar.character_key) <> '' AND ca.char_id = trim(ar.character_key))
    OR EXISTS (SELECT 1 FROM characters c WHERE c.char_id = ca.char_id AND trim(c.name) = trim(ar.character_key))
  )
  ON CONFLICT (account_id) DO NOTHING;
END;
$$;

COMMENT ON FUNCTION public.run_account_dkp_migration_step4() IS 'Optional: populate active_accounts from active_raiders. Leaderboard shows accounts with recent activity; active_accounts is for exceptions only.';
GRANT EXECUTE ON FUNCTION public.run_account_dkp_migration_step4() TO service_role;
GRANT EXECUTE ON FUNCTION public.run_account_dkp_migration_step4() TO authenticated;

-- Optional: one-shot migration (may still hit upstream timeout; use steps above if it does). Uses restore_load during step 1.
CREATE OR REPLACE FUNCTION public.run_account_dkp_migration()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  SET LOCAL statement_timeout = '15min';
  PERFORM begin_restore_load();
  PERFORM run_account_dkp_migration_step1();  -- step1 clears restore_load at end
  PERFORM run_account_dkp_migration_step2a();
  PERFORM refresh_all_raid_attendance_totals();
  PERFORM run_account_dkp_migration_step3();
  -- Step 4 optional: active_accounts is for exceptions only; leaderboard shows recent activity.
END;
$$;

COMMENT ON FUNCTION public.run_account_dkp_migration() IS 'One-shot migration (all steps). May timeout; use run_account_dkp_migration_step1/2a/3/4 and refresh_raid_attendance_totals_batch if it does.';
GRANT EXECUTE ON FUNCTION public.run_account_dkp_migration() TO service_role;
GRANT EXECUTE ON FUNCTION public.run_account_dkp_migration() TO authenticated;
