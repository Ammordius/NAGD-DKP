-- Bulk update raid_events.event_time (tic times). Run once in Supabase SQL Editor.
-- Used by: update_supabase_event_times.py (CLI) with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
--
-- data: jsonb array of { "raid_id": "...", "event_id": "...", "event_time": "9:00 pm" }
-- Returns: number of rows updated.

CREATE OR REPLACE FUNCTION update_raid_event_times(data jsonb)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated_count bigint;
BEGIN
  WITH payload AS (
    SELECT trim((e->>'raid_id'))::text AS raid_id,
           trim((e->>'event_id'))::text AS event_id,
           nullif(trim(e->>'event_time'), '') AS event_time
    FROM jsonb_array_elements(data) AS e
    WHERE e ? 'raid_id' AND e ? 'event_id'
  )
  UPDATE raid_events re
  SET event_time = p.event_time
  FROM payload p
  WHERE re.raid_id = p.raid_id AND re.event_id = p.event_id;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

COMMENT ON FUNCTION update_raid_event_times(jsonb) IS 'Bulk update raid_events.event_time by (raid_id, event_id). No truncate; updates existing rows only.';
