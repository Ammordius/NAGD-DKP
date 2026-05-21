-- Account-level class coverage from Magelo class_rankings.json (CI / officer refresh).
-- Run in Supabase SQL Editor after supabase-schema-full.sql.
-- Populated by scripts/build_account_class_coverage.mjs (service role) or officer_upsert_account_class_coverage.

CREATE TABLE IF NOT EXISTS public.account_class_coverage (
  account_id TEXT PRIMARY KEY REFERENCES public.accounts(account_id) ON DELETE CASCADE,
  main_char_id TEXT,
  classes JSONB NOT NULL DEFAULT '[]'::jsonb,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rankings_hash TEXT,
  meta JSONB
);

COMMENT ON TABLE public.account_class_coverage IS
  'Per-account viable raid classes from Magelo gear rankings (>75% general, >85% tanks). Refreshed by CI, not on page load.';

COMMENT ON COLUMN public.account_class_coverage.classes IS
  'JSON array: { abbrev, class_name, gear_pct, is_main, char_id, char_name } — one entry per class (best gear_pct).';

CREATE INDEX IF NOT EXISTS idx_account_class_coverage_refreshed
  ON public.account_class_coverage(refreshed_at DESC);

ALTER TABLE public.account_class_coverage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Officers read account_class_coverage" ON public.account_class_coverage;
CREATE POLICY "Officers read account_class_coverage"
  ON public.account_class_coverage
  FOR SELECT
  TO authenticated
  USING (public.is_officer());

-- Writes: service role (CI) bypasses RLS; officers use RPC below.

CREATE OR REPLACE FUNCTION public.officer_upsert_account_class_coverage(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows jsonb;
  v_hash text;
  v_refreshed timestamptz := now();
  v_inserted int := 0;
BEGIN
  IF NOT public.is_officer() THEN
    RAISE EXCEPTION 'Only officers can refresh class coverage';
  END IF;

  v_rows := COALESCE(p_payload->'rows', '[]'::jsonb);
  v_hash := nullif(trim(p_payload->>'rankings_hash'), '');

  IF jsonb_typeof(v_rows) <> 'array' THEN
    RAISE EXCEPTION 'p_payload.rows must be a JSON array';
  END IF;

  DELETE FROM public.account_class_coverage;

  INSERT INTO public.account_class_coverage (
    account_id,
    main_char_id,
    classes,
    refreshed_at,
    rankings_hash,
    meta
  )
  SELECT
    nullif(trim(e->>'account_id'), ''),
    nullif(trim(e->>'main_char_id'), ''),
    COALESCE(e->'classes', '[]'::jsonb),
    v_refreshed,
    v_hash,
    e->'meta'
  FROM jsonb_array_elements(v_rows) AS e
  WHERE nullif(trim(e->>'account_id'), '') IS NOT NULL;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  RETURN jsonb_build_object(
    'inserted', v_inserted,
    'refreshed_at', v_refreshed,
    'rankings_hash', v_hash
  );
END;
$$;

COMMENT ON FUNCTION public.officer_upsert_account_class_coverage(jsonb) IS
  'Officer-only: replace account_class_coverage from browser manual refresh (Magelo rankings computed client-side).';

GRANT EXECUTE ON FUNCTION public.officer_upsert_account_class_coverage(jsonb) TO authenticated;
