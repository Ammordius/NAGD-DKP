# Elemental mold → class armor display

The DKP app uses **elemental_mold_armor.json** so that when a class is selected (or when viewing an elemental mold item), the UI can show the **class-specific wearable armor** instead of the mold/pattern, while keeping DKP and loot context and showing which mold it came from.

## Data

- **Source:** `dkp_elemental_to_magelo.json` (mold/pattern ID → `magelo_item_ids_by_class`).
- **Generated file:** `elemental_mold_armor.json` (mold ID → `mold_name`, `slot`, `armor_type`, `by_class` with uppercase keys e.g. WAR, ROG).

## Build

From repo root:

```bash
python scripts/build_elemental_mold_armor.py
```

This writes:

- `data/elemental_mold_armor.json`
- `web/public/elemental_mold_armor.json`

The app loads `/elemental_mold_armor.json` at runtime. Ensure `web/public/elemental_mold_armor.json` is deployed (or copy from `data/` if your build does not include the script).

## Behavior

- **Raid Items (/mobs):** When the **Class** filter is set, any loot row that is an elemental mold (pattern/mold) resolves to the armor item for that class. The row shows the armor name and stats (from `item_stats.json`), a “(from mold)” badge, and the same DKP column. **Slot filter** works for molds even when stats are missing: mold slot (e.g. head, wrists) is mapped to the filter (HEAD, WRIST). Filtering and gear-score sort use the armor’s stats when available.
- **Item page (/items/...):** For an item that is an elemental mold, a **“View armor for class”** dropdown appears. Choosing a class shows that class’s armor (name, card, link) and “Crafted from: [mold name]”. DKP history and table stay keyed by the mold name.

## Item stats and gear score

For **gear score and the stats line** to appear on “(from mold)” rows, `item_stats.json` must include the **class-specific armor** item IDs. The build script does this automatically:

- **build_item_stats.py** loads `elemental_mold_armor.json` and adds every `by_class` armor ID to the set of items to fetch. Re-run the script (or build from cache after fetching) so that `item_stats.json` includes those IDs.
- **fetch_item_pages.py** also includes elemental armor IDs when caching HTML, so a full cache + `--from-cache` build will have stats for molds’ class armor.
