# Discovery query benchmarking notes

## Decision (initial ship)

No new Postgres indexes, views, or RPCs. Discovery uses existing:

- `idx_raid_loot_raid`
- `idx_raid_loot_item_name_trgm`
- `idx_raids_date_iso`
- `idx_raid_classifications_mob`

## Representative operations

| Op | Pattern | Expected index |
|----|---------|----------------|
| Latest raid in zone | `raid_classifications.eq(zone)` → `raids.in(raid_id).order(date_iso).limit(1)` | zone filter may seq-scan classifications; date uses `idx_raids_date_iso` |
| Latest P3 raid | `raid_classifications.in(mob, [P3, P3 Guardian])` | `idx_raid_classifications_mob` |
| Loot for raid | `raid_loot_with_assignment.eq(raid_id).limit(500)` | `idx_raid_loot_raid` |
| Item awards | `raid_loot_history.ilike(item_name).order(date_iso).limit(N)` | item_name trgm |
| Item count | `raid_loot.select(id, count exact, head).ilike(item_name)` | item_name trgm |

## When to add indexes

Add only if production timings show:

- zone-scoped latest-raid path regularly **> ~500ms**, consider `CREATE INDEX ON raid_classifications (zone)`
- character_name award windows hot, consider `CREATE INDEX ON raid_loot (character_name)`

Do **not** materialize a static guild loot JSON mirror unless egress or latency measurements justify it.

## How to measure

Against a staging/production Supabase project (authenticated), time the same filters the mock client exercises in `fetch.test.js`. Prefer `EXPLAIN (ANALYZE, BUFFERS)` on the SQL equivalents before adding indexes.
