# Scripts layout

Scripts are grouped by scope so the repo stays clear and the **current website/CI** surface is minimal.

| Directory | Purpose |
|-----------|---------|
| **`pull_parse_dkp_site/`** | Pull and parse the **existing/legacy DKP site** (GamerLaunch, roster, attendees). Produces CSVs and uploads to Supabase. One-time or periodic migration; not used by the live site at runtime. |
| **`takp_jsons/`** | Generate **JSONs from the TAKP website** (AllaClone item pages, mob loot, raid classifications, elemental armor). Builds `item_stats.json`, `dkp_mob_loot.json`, etc. Run when refreshing static data. |
| **Root-level scripts** | Used by the **current website and CI**: `fetch_raid_loot_from_supabase.py`, `assign_loot_to_characters.py`, `update_raid_loot_assignments_supabase.py`, `push_character_loot_assignment_counts_supabase.py`, `update_character_levels_from_magelo.py`, `export_supabase_public_tables.py`, `estimate_backup_size.py`. |
| **`scripts/` (this level)** | Site/CI helpers: `gen_github_worker_jwt.py`, `ledger_delta.py`. |

Run **pull_parse_dkp_site** and **takp_jsons** scripts from **repo root** so paths like `data/`, `raids/`, `web/public/` resolve:

```bash
python scripts/pull_parse_dkp_site/extract_structured_data.py
python scripts/takp_jsons/build_item_stats.py --out web/public/item_stats.json
```

See each subdirectory’s `README.md` for details.
