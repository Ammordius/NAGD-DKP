# Building item_stats.json for hover cards

The DKP site shows **item cards** (Magelo-style stats) on hover for item links. Card data comes from **item_stats.json**, which is built by fetching TAKP AllaClone item pages and parsing them.

## Option A: Fetch to local cache, then build (recommended)

Pull all item pages to a local directory once, then build item cards from that cache (no network needed for rebuilds).

1. **Fetch all item pages** (rate-limited; resumable):
   ```bash
   pip install -r requirements.txt
   python scripts/takp_jsons/fetch_item_pages.py --cache-dir data/item_pages
   ```
   Uses **dkp_mob_loot.json** and **raid_item_sources.json** (same paths as below). Saves each page as `data/item_pages/<id>.html`. Re-run to resume (skips existing files). `data/item_pages/` is in `.gitignore`.

2. **Build item_stats.json and optional CSV from cache**:
   ```bash
   python scripts/takp_jsons/build_item_stats.py --from-cache data/item_pages --out web/public/item_stats.json --csv data/item_stats.csv
   ```
   No network calls; reads the cached HTML and writes **item_stats.json** and a flattened **item_stats.csv** (item_id, name, slot, ac, flags, mods, resists, effect, focus, required_level, classes, weight, size) for inspection.

## Option B: Build directly from the website

1. **From repo root**, with Python 3 and deps installed:
   ```bash
   pip install -r requirements.txt
   python scripts/takp_jsons/build_item_stats.py --out web/public/item_stats.json
   ```
   The script reads **dkp_mob_loot.json** (from `data/` or `web/public/`) and, if present, **raid_item_sources.json** (from repo root or `web/public/`). It fetches each unique item page from TAKP AllaClone with a **1.5s delay** and writes **item_stats.json**. **Include raid_item_sources** so that items that only appear there (e.g. many raid drops) get stats too—otherwise the loot-by-mob inline stats line will be missing for those items.

2. **Copy into the web app** (if you used a different `--out`):
   ```bash
   cp data/item_stats.json web/public/item_stats.json
   ```
   The app loads `/item_stats.json` at runtime and uses it for hover cards; if the file is missing, only the small built-in mock set is used.

## Options

- **`--delay 2`** – Slower requests (default 1.5s). Use if you want to be gentler on TAKP’s server.
- **`--limit 50`** – Fetch only the first 50 items (useful for testing the script).
- **`--out web/public/item_stats.json`** – Write directly to public so you can skip the `cp` step.
- **`--mob-loot path/to/dkp_mob_loot.json`** – Use a specific mob-loot file.
- **`--raid-sources path/to/raid_item_sources.json`** – Use a specific raid item sources file (default: repo root or `web/public/raid_item_sources.json`). Needed for inline stats on loot-by-mob for raid-only items.
- **`--from-cache data/item_pages`** – Build from local HTML cache (from `scripts/takp_jsons/fetch_item_pages.py`); no network.
- **`--csv data/item_stats.csv`** – Also write a flattened CSV (item_id, name, slot, ac, flags, mods, resists, effect, focus, required_level, classes, weight, size).

Example (test run, then full run with output to public):

```bash
python scripts/takp_jsons/build_item_stats.py --limit 5 --out web/public/item_stats.json
# then full:
python scripts/takp_jsons/build_item_stats.py --out web/public/item_stats.json
```

## Prompt summary (for automation or handoff)

**Goal:** Populate item cards for all DKP items by pulling data from TAKP.

**Input:** `data/dkp_mob_loot.json` (or `web/public/dkp_mob_loot.json`) and optionally `raid_item_sources.json` (or `web/public/raid_item_sources.json`) — unique `item_id`s from both are fetched so that raid-only items (e.g. Abashi's Rod, Tolan's Longsword) get stats for the loot-by-mob page.

**Process:** For each `item_id`, GET `https://www.takproject.net/allaclone/item.php?id=<id>` with a rate limit (e.g. 1.5s between requests). Parse the HTML into the schema expected by the web app (flags, slot, AC, weapon stats, mods, resists, effect/focus spell IDs, instrument mods, light, tint, etc.). Script: **scripts/takp_jsons/build_item_stats.py**.

**Output:** **data/item_stats.json** (and optionally **web/public/item_stats.json**). The app loads **/item_stats.json** once and uses it for hover cards; missing or empty entries fall back to the small built-in mock.

**Request volume:** One request per unique item in dkp_mob_loot (~759 items). With 1.5s delay, total run time is about 19 minutes.
