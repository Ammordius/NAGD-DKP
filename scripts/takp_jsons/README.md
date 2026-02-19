# TAKP JSONs: build static data from TAKP website

Scripts that **fetch from or derive from the TAKP website** (AllaClone, Magelo, etc.) and **produce JSON/CSV** consumed by the DKP site or import pipeline.

**Scope:** Building `item_stats.json`, `dkp_mob_loot.json`, `item_sources.json`, raid classifications, elemental armor, etc. Not used by CI at runtime; run when refreshing item/mob/classification data.

- **Item stats (AllaClone):** `fetch_item_pages.py`, `build_item_stats.py`, `build_elemental_mold_armor.py`
- **Raid / mob loot:** `build_raid_classifications.py`, `build_items_seen_json.py`, `build_all_loot_items.py`, `build_dkp_elemental_to_magelo.py`
- **Data cleanup:** `merge_duplicate_mob_entries.py`, `aggregate_mob_loot.py`, `fix_mob_zones.py`, `fix_essence_loot.py`, `fix_mark_of_shadows_loot.py`

Run from **repo root** so paths like `data/`, `web/public/` resolve:

```bash
python scripts/takp_jsons/fetch_item_pages.py --cache-dir data/item_pages
python scripts/takp_jsons/build_item_stats.py --from-cache data/item_pages --out web/public/item_stats.json
python scripts/takp_jsons/build_raid_classifications.py
# etc.
```
