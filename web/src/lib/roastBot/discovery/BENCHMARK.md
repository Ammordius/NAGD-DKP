# Discovery query benchmarking notes

## Decision

No `raid_classifications` reads. Zone / phase / boss raid nights are a client-side join:

1. Static `item_sources` (and classification overrides) → set of item names for zone/phase/boss
2. `raid_loot_history` latest award per item name (narrow `ilike` + `limit 1`)
3. Pick max `date_iso` raid, then `raid_loot_with_assignment.eq(raid_id)`

## Representative operations

| Op | Pattern | Expected index |
|----|---------|----------------|
| Latest raid for catalog items | N× `raid_loot_history.ilike(item_name).order(date_iso).limit(1)` | `idx_raid_loot_item_name_trgm` |
| Loot for raid | `raid_loot_with_assignment.eq(raid_id).limit(500)` | `idx_raid_loot_raid` |
| Item awards / count | `raid_loot_history` / `raid_loot` by item name | item_name trgm |

## When to add indexes

Only if measured latency on the per-item latest-award fan-out is hot for large phase/zone catalogs. Prefer batching / RPC later over materializing classifications.
