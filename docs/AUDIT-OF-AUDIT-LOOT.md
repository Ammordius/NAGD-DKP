# Audit of the Audit (Loot)

We track **who put in what** for officer-only loot actions in `officer_audit_log`. This doc describes how to use that data to see deltas and flag anything that doesn’t match expectations.

## What we audit

- **Officers assigning loot to accounts** — i.e. rows in `raid_loot`: add loot (single or from log), delete loot, edit loot cost.
- We do **not** track character assignments of loot (who got the item on which character). Those are player-editable and scripted via `loot_assignment` / Magelo; they are out of scope for this audit.

## Where it lives

- **Table:** `officer_audit_log` — all officer actions (raids, tics, loot, etc.).
- **View:** `officer_audit_loot` — loot-only subset:
  - `add_loot` — single item added
  - `add_loot_from_log` — bulk add from paste (delta includes `items[]` with name, character, cost per item)
  - `delete_loot` — one row removed
  - `edit_loot_cost` — cost changed

Delta keys (short to limit storage):

- `r` — raid_id  
- `l` — loot id (raid_loot.id)  
- `i` — item_name  
- `c` — character_name  
- `cost` — DKP cost (string)  
- `items` — for add_loot_from_log: array of `{ i, c, cost }`

## Seeing who put in what

Query the view by time or raid:

```sql
-- Recent loot changes with who did it and delta
SELECT created_at, actor_display_name, action, target_id, delta
FROM officer_audit_loot
ORDER BY created_at DESC
LIMIT 100;
```

```sql
-- All loot audit entries for a raid
SELECT created_at, actor_display_name, action, delta
FROM officer_audit_loot
WHERE (delta->>'r') = 'manual-1771534934991'
ORDER BY created_at;
```

## Seeing deltas

- **add_loot:** `delta->>'i'`, `delta->>'c'`, `delta->>'cost'`  
- **add_loot_from_log:** `delta->'items'` is a JSON array; each element has `i`, `c`, `cost`  
- **delete_loot:** `delta->>'i'`, `delta->>'c'`, `delta->>'cost'`  
- **edit_loot_cost:** `delta->>'i'`, `delta->>'c'` (new cost)

## Flagging mismatches (audit of the audit)

You can compare audit entries to current state:

- After an **add_loot_from_log** with `delta->>'cnt'` = N and `delta->'items'`, expect N rows in `raid_loot` for that raid with matching (item_name, character_name, cost). If you store raid_id and a snapshot of inserted ids, you can later verify those rows still exist or were explicitly deleted (with a matching delete_loot entry).
- **delete_loot** entries record which loot id and item/character were removed; you can confirm that `raid_loot` no longer has that id.
- **edit_loot_cost** records the new cost; you can confirm `raid_loot.cost` matches for that loot id.

Example: list add_loot_from_log entries and expand their items for manual spot-checks:

```sql
SELECT
  created_at,
  actor_display_name,
  delta->>'r' AS raid_id,
  delta->>'cnt' AS inserted_count,
  jsonb_array_elements(delta->'items') AS item_detail
FROM officer_audit_loot
WHERE action = 'add_loot_from_log'
  AND delta ? 'items'
ORDER BY created_at DESC;
```

## Changelog UI

The DKP changelog (/officer/dkp-changelog) shows the same data in a table: when, who, action, target, and details. For **Add loot from log**, details now list each item with name, character, and cost. For **Delete loot**, details show item (character) and cost when available.
