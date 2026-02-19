-- Loot-only view of officer_audit_log: who added/deleted/edited raid_loot (officer actions only).
-- Use for "audit of the audit": see deltas (item names, costs, character) and who made each change.
-- We do NOT track loot_assignment (who got the item assigned to which character); that is player/script editable.
-- Run after supabase-schema.sql (or any DB that already has officer_audit_log).

CREATE OR REPLACE VIEW officer_audit_loot AS
SELECT
  id,
  created_at,
  actor_id,
  actor_email,
  actor_display_name,
  action,
  target_type,
  target_id,
  delta
FROM officer_audit_log
WHERE action IN ('add_loot', 'add_loot_from_log', 'delete_loot', 'edit_loot_cost');

COMMENT ON VIEW officer_audit_loot IS 'Loot-related officer audit entries only. Delta: r=raid_id, l=loot_id, i=item_name, c=character_name, cost=DKP; add_loot_from_log has items[] with i,c,cost per row. Use to audit who put in what and flag mismatches.';

-- Optional: grant so officers can select (RLS on base table already restricts to officers)
GRANT SELECT ON officer_audit_loot TO authenticated;
