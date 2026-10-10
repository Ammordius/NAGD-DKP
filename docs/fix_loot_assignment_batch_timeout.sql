-- Stop update_raid_loot_assignments from rebuilding dkp_summary and character_dkp_spent
-- on every CI batch. Those refreshes exceed the API statement timeout (~8s) and cancel
-- the first 1000-row upsert (SQLSTATE 57014).
--
-- The Python script already calls refresh_after_bulk_loot_assignment() once after all batches.
-- Run this in the Supabase SQL Editor. Do not re-run docs/supabase-schema-full.sql.

CREATE OR REPLACE FUNCTION public.update_raid_loot_assignments(data jsonb)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '60s'
AS $$
DECLARE
  updated_count bigint;
BEGIN
  SET LOCAL statement_timeout = '60s';

  ALTER TABLE loot_assignment DISABLE TRIGGER refresh_character_dkp_spent_after_assignment;

  INSERT INTO loot_assignment (loot_id, assigned_char_id, assigned_character_name, assigned_via_magelo)
  SELECT
    (e->>'id')::bigint,
    nullif(trim(e->>'assigned_char_id'), ''),
    nullif(trim(e->>'assigned_character_name'), ''),
    (CASE WHEN trim(e->>'assigned_via_magelo') IN ('1', 'true') THEN 1 ELSE 0 END)::smallint
  FROM jsonb_array_elements(data) AS e
  ON CONFLICT (loot_id) DO UPDATE SET
    assigned_char_id = EXCLUDED.assigned_char_id,
    assigned_character_name = EXCLUDED.assigned_character_name,
    assigned_via_magelo = EXCLUDED.assigned_via_magelo
  WHERE loot_assignment.assigned_char_id IS DISTINCT FROM EXCLUDED.assigned_char_id
     OR loot_assignment.assigned_character_name IS DISTINCT FROM EXCLUDED.assigned_character_name
     OR loot_assignment.assigned_via_magelo IS DISTINCT FROM EXCLUDED.assigned_via_magelo;
  GET DIAGNOSTICS updated_count = ROW_COUNT;

  ALTER TABLE loot_assignment ENABLE TRIGGER refresh_character_dkp_spent_after_assignment;

  RETURN updated_count;
END;
$$;

COMMENT ON FUNCTION public.update_raid_loot_assignments(jsonb) IS 'Bulk upsert loot_assignment by loot id. Skips unchanged rows. Does not refresh caches; call refresh_after_bulk_loot_assignment() once after all batches.';

CREATE OR REPLACE FUNCTION public.refresh_after_bulk_loot_assignment()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '180s'
AS $$
BEGIN
  SET LOCAL statement_timeout = '180s';
  PERFORM refresh_character_dkp_spent();
  PERFORM refresh_dkp_summary_internal();
END;
$$;

COMMENT ON FUNCTION public.refresh_after_bulk_loot_assignment() IS 'Refreshes character_dkp_spent and dkp_summary after bulk loot assignment updates. Call once after all update_raid_loot_assignments batches.';
