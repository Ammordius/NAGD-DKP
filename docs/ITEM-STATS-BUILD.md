# Building item_stats.json for hover cards

The DKP site shows **item cards** (Magelo-style stats) on hover for item links. Card data comes from **item_stats.json**, which is built by fetching TAKP AllaClone item pages and parsing them.

## One-time / periodic build

1. **From repo root**, with Python 3 and deps installed:
   ```bash
   pip install -r requirements.txt
   python scripts/build_item_stats.py
   ```
   This reads **dkp_mob_loot.json** (from `data/` or `web/public/`), fetches each unique item page from `https://www.takproject.net/allaclone/item.php?id=<id>` with a **1.5s delay** between requests (~759 items ≈ 19 minutes), and writes **data/item_stats.json**.

2. **Copy into the web app** so the site can load it:
   ```bash
   cp data/item_stats.json web/public/item_stats.json
   ```
   The app loads `/item_stats.json` at runtime and uses it for hover cards; if the file is missing, only the small built-in mock set is used.

## Options

- **`--delay 2`** – Slower requests (default 1.5s). Use if you want to be gentler on TAKP’s server.
- **`--limit 50`** – Fetch only the first 50 items (useful for testing the script).
- **`--out web/public/item_stats.json`** – Write directly to public so you can skip the `cp` step.
- **`--mob-loot path/to/dkp_mob_loot.json`** – Use a specific mob-loot file.

Example (test run, then full run with output to public):

```bash
python scripts/build_item_stats.py --limit 5 --out web/public/item_stats.json
# then full:
python scripts/build_item_stats.py --out web/public/item_stats.json
```

## Prompt summary (for automation or handoff)

**Goal:** Populate item cards for all DKP items by pulling data from TAKP.

**Input:** `data/dkp_mob_loot.json` (or `web/public/dkp_mob_loot.json`) — list of unique `item_id`s from DKP mob loot.

**Process:** For each `item_id`, GET `https://www.takproject.net/allaclone/item.php?id=<id>` with a rate limit (e.g. 1.5s between requests). Parse the HTML into the schema expected by the web app (flags, slot, AC, weapon stats, mods, resists, effect/focus spell IDs, instrument mods, light, tint, etc.). Script: **scripts/build_item_stats.py**.

**Output:** **data/item_stats.json** (and optionally **web/public/item_stats.json**). The app loads **/item_stats.json** once and uses it for hover cards; missing or empty entries fall back to the small built-in mock.

**Request volume:** One request per unique item in dkp_mob_loot (~759 items). With 1.5s delay, total run time is about 19 minutes.
