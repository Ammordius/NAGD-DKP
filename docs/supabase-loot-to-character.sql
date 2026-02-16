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

-- RLS: same as raid_loot (authenticated/anon read)
-- No new policies needed if raid_loot already has read for all.
