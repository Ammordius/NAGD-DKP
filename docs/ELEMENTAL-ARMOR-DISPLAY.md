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

- **Mob loot (/mobs):** When the **Class** filter is set, any loot row that is an elemental mold (pattern/mold) resolves to the armor item for that class. The row shows the armor name and stats (from `item_stats.json`), a “(from mold)” badge, and the same DKP column. Filtering and gear-score sort use the armor’s stats.
- **Item page (/items/...):** For an item that is an elemental mold, a **“View armor for class”** dropdown appears. Choosing a class shows that class’s armor (name, card, link) and “Crafted from: [mold name]”. DKP history and table stay keyed by the mold name.

No change to `item_stats.json` or the rest of the stack: one extra static JSON and a small lib (`elementalArmor.js`) used only where needed.
