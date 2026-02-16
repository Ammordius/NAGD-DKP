-- Loot-to-character assignment: link raid_loot to the toon that actually has the item (from Magelo).
-- Run after supabase-schema.sql. Used by assign_loot_to_characters.py and eventual CI from Magelo pulls.
--
-- Data: assign_loot_to_characters.py writes data/raid_loot.csv (with assigned_char_id, assigned_character_name)
-- and data/character_loot_assignment_counts.csv (char_id, character_name, items_assigned).
-- Import raid_loot with the new columns; the view below can be fed from that or computed in DB.

-- Add assigned character to raid_loot (nullable: NULL/empty = unassigned; do not default to buyer)
ALTER TABLE raid_loot ADD COLUMN IF NOT EXISTS assigned_char_id TEXT;
ALTER TABLE raid_loot ADD COLUMN IF NOT EXISTS assigned_character_name TEXT;
-- 1 = we found the item on a toon (Magelo); 0 = manual edit in UI (optional, for analytics)
ALTER TABLE raid_loot ADD COLUMN IF NOT EXISTS assigned_via_magelo SMALLINT DEFAULT NULL;

-- Optional: FK to characters for assigned_char_id (allow NULL)
-- ALTER TABLE raid_loot ADD CONSTRAINT fk_raid_loot_assigned_char
--   FOREIGN KEY (assigned_char_id) REFERENCES characters(char_id);

-- View: per-character count of loot rows assigned to that character (for display / tie-breaker during assignment)
CREATE OR REPLACE VIEW character_loot_assignment_count AS
SELECT
  assigned_char_id AS char_id,
  assigned_character_name AS character_name,
  COUNT(*) AS items_assigned
FROM raid_loot
WHERE assigned_char_id IS NOT NULL AND trim(assigned_char_id) <> ''
GROUP BY assigned_char_id, assigned_character_name;

-- Table: same shape as the view, populated by CI from character_loot_assignment_counts.csv (so Table Editor shows data).
-- Run this if the table is missing; then CI or push_character_loot_assignment_counts_supabase.py will fill it.
CREATE TABLE IF NOT EXISTS character_loot_assignment_counts (
  char_id TEXT PRIMARY KEY,
  character_name TEXT,
  items_assigned BIGINT
);

-- Index for lookups by assigned character
CREATE INDEX IF NOT EXISTS idx_raid_loot_assigned_char ON raid_loot(assigned_char_id)
  WHERE assigned_char_id IS NOT NULL;

-- Bulk update assignments: resolve conflicts by updating existing rows (do not ignore).
-- CI/update_raid_loot_assignments_supabase.py calls this RPC so updates always apply.
-- data: jsonb array of { id, assigned_char_id, assigned_character_name, assigned_via_magelo }.
CREATE OR REPLACE FUNCTION update_raid_loot_assignments(data jsonb)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated_count bigint;
BEGIN
  WITH payload AS (
    SELECT (e->>'id')::bigint AS id,
           nullif(trim(e->>'assigned_char_id'), '') AS assigned_char_id,
           nullif(trim(e->>'assigned_character_name'), '') AS assigned_character_name,
           (CASE WHEN trim(e->>'assigned_via_magelo') IN ('1', 'true') THEN 1 ELSE 0 END)::smallint AS assigned_via_magelo
    FROM jsonb_array_elements(data) AS e
  )
  UPDATE raid_loot r
  SET
    assigned_char_id = p.assigned_char_id,
    assigned_character_name = p.assigned_character_name,
    assigned_via_magelo = p.assigned_via_magelo
  FROM payload p
  WHERE r.id = p.id;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

COMMENT ON FUNCTION update_raid_loot_assignments(jsonb) IS 'Bulk update raid_loot assignment columns by id; resolves conflicts by updating, never ignores.';

-- Single-row assignment update: officers or the account that owns the loot row (buyer char_id on that account).
-- p_assigned_char_id / p_assigned_character_name may be NULL or '' to set Unassigned.
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

  UPDATE raid_loot
  SET
    assigned_char_id = nullif(trim(p_assigned_char_id), ''),
    assigned_character_name = nullif(trim(p_assigned_character_name), ''),
    assigned_via_magelo = 0
  WHERE id = p_loot_id;
END;
$$;

COMMENT ON FUNCTION update_single_raid_loot_assignment(bigint, text, text) IS 'Update one raid_loot assignment. Allowed: officer, or user whose claimed account owns the loot row (char_id). Use NULL/empty to set Unassigned.';

-- Per-character total DKP spent (by assignment). Updated by trigger on raid_loot so Loot recipients and character page can read one value.
-- Uses assigned_char_id / assigned_character_name when set; otherwise char_id / character_name so unassigned buyer still counts.
CREATE TABLE IF NOT EXISTS character_dkp_spent (
  character_key TEXT PRIMARY KEY,
  char_id TEXT,
  character_name TEXT,
  total_spent NUMERIC NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

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
      (CASE WHEN COALESCE(trim(assigned_char_id), '') <> '' THEN trim(assigned_char_id)
            WHEN COALESCE(trim(assigned_character_name), '') <> '' THEN trim(assigned_character_name)
            WHEN COALESCE(trim(char_id::text), '') <> '' THEN trim(char_id::text)
            ELSE COALESCE(trim(character_name), 'unknown') END) AS character_key,
      nullif(trim(COALESCE(assigned_char_id::text, char_id::text)), '') AS char_id,
      nullif(trim(COALESCE(assigned_character_name, character_name)), '') AS character_name,
      cost
    FROM raid_loot
    WHERE COALESCE(trim(assigned_char_id), '') <> ''
       OR COALESCE(trim(assigned_character_name), '') <> ''
       OR COALESCE(trim(char_id::text), '') <> ''
       OR COALESCE(trim(character_name), '') <> ''
  ) t
  GROUP BY character_key;
END;
$$;

-- Trigger: update character_dkp_spent when loot is inserted, updated, or deleted (or assignment changed).
CREATE OR REPLACE FUNCTION public.trigger_refresh_character_dkp_spent()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM refresh_character_dkp_spent();
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS refresh_character_dkp_spent_after_loot ON raid_loot;
CREATE TRIGGER refresh_character_dkp_spent_after_loot
  AFTER INSERT OR UPDATE OR DELETE ON raid_loot
  FOR EACH STATEMENT EXECUTE FUNCTION public.trigger_refresh_character_dkp_spent();

-- RPC: return rows for any character whose character_key, char_id, or character_name is in keys (for Loot recipients lookup).
CREATE OR REPLACE FUNCTION public.get_character_dkp_spent(p_keys text[])
RETURNS TABLE(character_key text, char_id text, character_name text, total_spent numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.character_key, c.char_id, c.character_name, c.total_spent
  FROM character_dkp_spent c
  WHERE c.character_key = ANY(p_keys)
     OR c.char_id = ANY(p_keys)
     OR c.character_name = ANY(p_keys);
$$;

COMMENT ON TABLE character_dkp_spent IS 'Total DKP spent per character (from raid_loot cost). Refreshed on raid_loot change. Look up by character_key, char_id, or character_name. After first deploy run: SELECT refresh_character_dkp_spent();';
COMMENT ON FUNCTION get_character_dkp_spent(text[]) IS 'Returns character_dkp_spent rows where character_key, char_id, or character_name is in the given array.';

-- RLS: allow anon/authenticated read (same as raid_loot).
ALTER TABLE character_dkp_spent ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated read character_dkp_spent" ON character_dkp_spent;
CREATE POLICY "Authenticated read character_dkp_spent" ON character_dkp_spent FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Anon read character_dkp_spent" ON character_dkp_spent;
CREATE POLICY "Anon read character_dkp_spent" ON character_dkp_spent FOR SELECT TO anon USING (true);

-- RLS: same as raid_loot (authenticated/anon read)
-- No new policies needed if raid_loot already has read for all.
