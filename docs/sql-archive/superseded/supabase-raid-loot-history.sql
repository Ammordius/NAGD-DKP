-- Item History (/loot) read view.
-- Run once in the Supabase SQL editor. Safe to re-run.
-- raid_loot.raid_id has no foreign key to raids, so the app cannot sort loot by raid date
-- through PostgREST embeds. cost is text, so this view exposes cost_num for numeric sort.

CREATE OR REPLACE VIEW raid_loot_history WITH (security_invoker = true) AS
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
  la.assigned_via_magelo,
  r.raid_name,
  r.date,
  r.date_iso,
  CASE
    WHEN btrim(rl.cost) ~ '^-?[0-9]+(\.[0-9]+)?$' THEN btrim(rl.cost)::numeric
    ELSE NULL
  END AS cost_num
FROM raid_loot rl
LEFT JOIN loot_assignment la ON la.loot_id = rl.id
LEFT JOIN raids r ON r.raid_id = rl.raid_id;

COMMENT ON VIEW raid_loot_history IS 'Item History reads. raid_loot plus assignment, raid name/date, and cost_num for numeric sort. security_invoker so RLS on the base tables applies.';

GRANT SELECT ON raid_loot_history TO authenticated;
GRANT SELECT ON raid_loot_history TO anon;
