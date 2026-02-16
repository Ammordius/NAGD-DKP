-- Loot-to-character assignment: link raid_loot to the toon that actually has the item (from Magelo).
-- Run after supabase-schema.sql. Used by assign_loot_to_characters.py and eventual CI from Magelo pulls.
--
-- Data: assign_loot_to_characters.py writes data/raid_loot.csv (with assigned_char_id, assigned_character_name)
-- and data/character_loot_assignment_counts.csv (char_id, character_name, items_assigned).
-- Import raid_loot with the new columns; the view below can be fed from that or computed in DB.

-- Add assigned character to raid_loot (nullable: NULL = use namesake buyer)
ALTER TABLE raid_loot ADD COLUMN IF NOT EXISTS assigned_char_id TEXT;
ALTER TABLE raid_loot ADD COLUMN IF NOT EXISTS assigned_character_name TEXT;
-- 1 = we found the item on a toon (Magelo); 0 = fallback to namesake (optional, for analytics)
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

-- RLS: same as raid_loot (authenticated/anon read)
-- No new policies needed if raid_loot already has read for all.
