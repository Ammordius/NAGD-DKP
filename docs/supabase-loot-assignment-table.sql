-- Loot assignment split: move assigned_char_id, assigned_character_name, assigned_via_magelo
-- from raid_loot into a one-to-one table loot_assignment so permissions can be scoped for CI.
-- Run AFTER supabase-schema.sql and supabase-loot-to-character.sql (so raid_loot has the columns).
-- Officers keep full write on raid_loot and on loot_assignment from the website; CI calls
-- update_raid_loot_assignments (writes only loot_assignment). Later: scoped API key for CI.

-- 1) New table: one row per raid_loot.id
CREATE TABLE IF NOT EXISTS loot_assignment (
  loot_id BIGINT PRIMARY KEY REFERENCES raid_loot(id) ON DELETE CASCADE,
  assigned_char_id TEXT,
  assigned_character_name TEXT,
  assigned_via_magelo SMALLINT DEFAULT NULL
);

COMMENT ON TABLE loot_assignment IS 'Which character has each loot item (from Magelo or manual). One-to-one with raid_loot. Enables scoped permissions for CI.';

-- 2) Backfill from raid_loot (only if columns exist; no-op if already migrated)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'raid_loot' AND column_name = 'assigned_char_id'
  ) THEN
    INSERT INTO loot_assignment (loot_id, assigned_char_id, assigned_character_name, assigned_via_magelo)
    SELECT id, assigned_char_id, assigned_character_name, assigned_via_magelo
    FROM raid_loot
    ON CONFLICT (loot_id) DO NOTHING;
  END IF;
END;
$$;

-- 3) Drop view that depends on raid_loot assignment columns, then drop index and columns
DROP VIEW IF EXISTS character_loot_assignment_count;
DROP INDEX IF EXISTS idx_raid_loot_assigned_char;
ALTER TABLE raid_loot DROP COLUMN IF EXISTS assigned_char_id;
ALTER TABLE raid_loot DROP COLUMN IF EXISTS assigned_character_name;
ALTER TABLE raid_loot DROP COLUMN IF EXISTS assigned_via_magelo;

-- 4) View: same shape as before for reads (app and CI fetch)
CREATE OR REPLACE VIEW raid_loot_with_assignment AS
SELECT
  rl.id,
  rl.raid_id,
  rl.event_id,
  rl.item_name,
  rl.char_id,
  rl.character_name,
  rl.cost,
  la.assigned_char_id,
  la.assigned_character_name,
  la.assigned_via_magelo
FROM raid_loot rl
LEFT JOIN loot_assignment la ON la.loot_id = rl.id;

COMMENT ON VIEW raid_loot_with_assignment IS 'raid_loot plus assignment columns. Use for reads; write loot to raid_loot, assignment via RPC or loot_assignment.';

-- 5) View: per-character count of assigned items (for display / tie-breaker)
CREATE OR REPLACE VIEW character_loot_assignment_count AS
SELECT
  la.assigned_char_id AS char_id,
  la.assigned_character_name AS character_name,
  COUNT(*)::bigint AS items_assigned
FROM loot_assignment la
WHERE la.assigned_char_id IS NOT NULL AND trim(la.assigned_char_id) <> ''
GROUP BY la.assigned_char_id, la.assigned_character_name;

-- 6) refresh_character_dkp_spent: use raid_loot + loot_assignment
CREATE OR REPLACE FUNCTION public.refresh_character_dkp_spent()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  TRUNCATE character_dkp_spent;
  INSERT INTO character_dkp_spent (character_key, char_id, character_name, total_spent, updated_at)
  SELECT
    character_key,
    MAX(char_id) AS char_id,
    MAX(character_name) AS character_name,
    SUM(COALESCE((cost::numeric), 0)) AS total_spent,
    now()
  FROM (
    SELECT
      (CASE WHEN COALESCE(trim(la.assigned_char_id), '') <> '' THEN trim(la.assigned_char_id)
            WHEN COALESCE(trim(la.assigned_character_name), '') <> '' THEN trim(la.assigned_character_name)
            WHEN COALESCE(trim(rl.char_id::text), '') <> '' THEN trim(rl.char_id::text)
            ELSE COALESCE(trim(rl.character_name), 'unknown') END) AS character_key,
      nullif(trim(COALESCE(la.assigned_char_id::text, rl.char_id::text)), '') AS char_id,
      nullif(trim(COALESCE(la.assigned_character_name, rl.character_name)), '') AS character_name,
      rl.cost
    FROM raid_loot rl
    LEFT JOIN loot_assignment la ON la.loot_id = rl.id
    WHERE COALESCE(trim(la.assigned_char_id), '') <> ''
       OR COALESCE(trim(la.assigned_character_name), '') <> ''
       OR COALESCE(trim(rl.char_id::text), '') <> ''
       OR COALESCE(trim(rl.character_name), '') <> ''
  ) t
  GROUP BY character_key;
END;
$$;

-- 7) Trigger on loot_assignment to refresh character_dkp_spent (assignment changed)
CREATE OR REPLACE FUNCTION public.trigger_refresh_character_dkp_spent_after_assignment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM refresh_character_dkp_spent();
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS refresh_character_dkp_spent_after_assignment ON loot_assignment;
CREATE TRIGGER refresh_character_dkp_spent_after_assignment
  AFTER INSERT OR UPDATE OR DELETE ON loot_assignment
  FOR EACH STATEMENT EXECUTE FUNCTION public.trigger_refresh_character_dkp_spent_after_assignment();

-- 8) Bulk update: write only loot_assignment. CI (and later scoped key) calls this.
CREATE OR REPLACE FUNCTION update_raid_loot_assignments(data jsonb)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated_count bigint;
BEGIN
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
    assigned_via_magelo = EXCLUDED.assigned_via_magelo;
  GET DIAGNOSTICS updated_count = ROW_COUNT;

  ALTER TABLE loot_assignment ENABLE TRIGGER refresh_character_dkp_spent_after_assignment;

  PERFORM refresh_character_dkp_spent();
  PERFORM refresh_dkp_summary_internal();
  RETURN updated_count;
END;
$$;

COMMENT ON FUNCTION update_raid_loot_assignments(jsonb) IS 'Bulk upsert loot_assignment by loot id. CI/scoped key only needs EXECUTE on this + SELECT on raid_loot. Call once per batch; refreshes caches at end.';

-- refresh_after_bulk_loot_assignment: still valid (refreshes caches). Call after multiple batches if you split payload.
CREATE OR REPLACE FUNCTION refresh_after_bulk_loot_assignment()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM refresh_character_dkp_spent();
  PERFORM refresh_dkp_summary_internal();
END;
$$;

-- 9) Single-row assignment: officers or account owner. Writes to loot_assignment.
CREATE OR REPLACE FUNCTION update_single_raid_loot_assignment(
  p_loot_id bigint,
  p_assigned_char_id text DEFAULT NULL,
  p_assigned_character_name text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_char_id text;
  v_my_account_id text;
  v_allowed boolean := false;
BEGIN
  SELECT rl.char_id INTO v_char_id FROM raid_loot rl WHERE rl.id = p_loot_id;
  IF v_char_id IS NULL THEN
    RAISE EXCEPTION 'Loot row not found';
  END IF;

  IF public.is_officer() THEN
    v_allowed := true;
  ELSE
    SELECT account_id INTO v_my_account_id FROM public.profiles WHERE id = auth.uid();
    IF v_my_account_id IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1 FROM character_account ca
        WHERE ca.char_id = v_char_id AND ca.account_id = v_my_account_id
      ) INTO v_allowed;
    END IF;
  END IF;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Not allowed to update this loot assignment';
  END IF;

  INSERT INTO loot_assignment (loot_id, assigned_char_id, assigned_character_name, assigned_via_magelo)
  VALUES (p_loot_id, nullif(trim(p_assigned_char_id), ''), nullif(trim(p_assigned_character_name), ''), 0)
  ON CONFLICT (loot_id) DO UPDATE SET
    assigned_char_id = EXCLUDED.assigned_char_id,
    assigned_character_name = EXCLUDED.assigned_character_name,
    assigned_via_magelo = 0;
END;
$$;

COMMENT ON FUNCTION update_single_raid_loot_assignment(bigint, text, text) IS 'Update one loot assignment. Allowed: officer, or user whose claimed account owns the loot row. Writes to loot_assignment.';

-- 10) raid_loot trigger still refreshes character_dkp_spent when loot rows change (insert/update/delete)
--    Supabase-loot-to-character.sql already created refresh_character_dkp_spent_after_loot on raid_loot; keep it.
--    No change needed: trigger still runs; refresh_character_dkp_spent now reads from raid_loot + loot_assignment.

-- 11) RLS on loot_assignment
ALTER TABLE loot_assignment ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated read loot_assignment" ON loot_assignment;
CREATE POLICY "Authenticated read loot_assignment" ON loot_assignment FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Anon read loot_assignment" ON loot_assignment;
CREATE POLICY "Anon read loot_assignment" ON loot_assignment FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "Officers manage loot_assignment" ON loot_assignment;
CREATE POLICY "Officers manage loot_assignment" ON loot_assignment FOR ALL TO authenticated
  USING (public.is_officer())
  WITH CHECK (public.is_officer());

-- RPC update_raid_loot_assignments and update_single_raid_loot_assignment run as SECURITY DEFINER, so they
-- can write loot_assignment regardless of RLS. Officers also get direct write via "Officers manage loot_assignment".
-- CI will use a scoped key with EXECUTE on update_raid_loot_assignments (no direct table write needed).

-- 12) Grant SELECT on view so anon/authenticated can read (RLS on base tables also applies when reading via view)
GRANT SELECT ON raid_loot_with_assignment TO authenticated;
GRANT SELECT ON raid_loot_with_assignment TO anon;

-- 13) Grant EXECUTE on RPCs to anon/authenticated so website and CI can call them
GRANT EXECUTE ON FUNCTION update_raid_loot_assignments(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION update_raid_loot_assignments(jsonb) TO anon;
GRANT EXECUTE ON FUNCTION update_single_raid_loot_assignment(bigint, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION update_single_raid_loot_assignment(bigint, text, text) TO anon;
