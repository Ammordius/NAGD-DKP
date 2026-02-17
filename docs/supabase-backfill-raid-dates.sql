-- =============================================================================
-- Backfill raids.date_iso from raids.date (human-readable "Wed Sep 30, 2020 12:50 am").
-- Run in Supabase SQL Editor. No truncate, no re-import — just fixes missing dates.
-- Then run: SELECT refresh_dkp_summary(); SELECT refresh_all_raid_attendance_totals();
-- =============================================================================

-- Parse "Wed Sep 30, 2020 12:50 am" -> '2020-09-30'. Returns NULL if not parseable.
CREATE OR REPLACE FUNCTION public.parse_raid_date_to_iso(display_date TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  dt TIMESTAMPTZ;
  s TEXT;
BEGIN
  s := trim(display_date);
  IF s IS NULL OR s = '' THEN
    RETURN NULL;
  END IF;
  -- Already YYYY-MM-DD
  IF s ~ '^\d{4}-\d{2}-\d{2}' THEN
    RETURN substring(s from 1 for 10);
  END IF;
  -- "Wed Sep 30, 2020 12:50 am" (use first 26 chars so "am"/"pm" is included)
  BEGIN
    dt := to_timestamp(substring(s from 1 for 26), 'Dy Mon DD, YYYY HH12:MI am');
    RETURN to_char(dt::date, 'YYYY-MM-DD');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  -- "Wed Sep 30, 2020" (date only)
  BEGIN
    dt := to_timestamp(substring(s from 1 for 17), 'Dy Mon DD, YYYY');
    RETURN to_char(dt::date, 'YYYY-MM-DD');
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;
END;
$$;

-- Backfill: set date_iso where it's missing, using the existing date column
UPDATE raids
SET date_iso = COALESCE(
  trim(date_iso),
  parse_raid_date_to_iso(date)
)
WHERE (date_iso IS NULL OR trim(date_iso) = '')
  AND date IS NOT NULL
  AND trim(date) <> '';

-- Optional: show how many were updated (run separately if you want to check)
-- SELECT count(*) FROM raids WHERE date_iso IS NOT NULL AND trim(date_iso) <> '';
