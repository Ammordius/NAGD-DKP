#!/usr/bin/env python3
"""
Fetch all DKP item pages from TAKP AllaClone to a local cache directory.
Use with build_item_stats.py --from-cache to build item cards from the cache (no network).

Usage:
  python scripts/fetch_item_pages.py [--delay 1.5] [--limit N] [--cache-dir data/item_pages]
  Then: python scripts/build_item_stats.py --from-cache data/item_pages --out web/public/item_stats.json

Requires: requests (see requirements.txt).
"""
import argparse
import json
import time
from pathlib import Path

import requests

TAKP_ITEM_URL = "https://www.takproject.net/allaclone/item.php?id={id}"
DELAY_DEFAULT = 1.5
USER_AGENT = "NAGD-DKP-ItemStats/1.0 (guild DKP site; item card data)"


def collect_item_ids_from_mob_loot(mob_loot_path: Path) -> dict[int, str]:
    """Return { item_id: name } from dkp_mob_loot.json."""
    data = json.loads(mob_loot_path.read_text(encoding="utf-8"))
    seen = {}
    for entry in data.values() if isinstance(data, dict) else []:
        for item in entry.get("loot") or []:
            iid = item.get("item_id")
            name = (item.get("name") or "").strip()
            if iid is not None and name and iid not in seen:
                seen[iid] = name
    return seen


def collect_item_ids_from_raid_sources(raid_sources_path: Path) -> dict[int, str]:
    """Return { item_id: name } from raid_item_sources.json."""
    if not raid_sources_path.exists():
        return {}
    data = json.loads(raid_sources_path.read_text(encoding="utf-8"))
    seen = {}
    for sid, entry in (data.items() if isinstance(data, dict) else []):
        try:
            iid = int(sid)
        except (ValueError, TypeError):
            continue
        name = (entry.get("name") or "").strip()
        if name and iid not in seen:
            seen[iid] = name
    return seen


def collect_item_ids_from_elemental(base: Path) -> dict[int, str]:
    """Return { item_id: name } from elemental_mold_armor.json (class-specific armor IDs)."""
    for path in [base / "data" / "elemental_mold_armor.json", base / "web" / "public" / "elemental_mold_armor.json"]:
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            seen = {}
            for mold_id, info in (data.items() if isinstance(data, dict) else []):
                for cls, armor_id in (info.get("by_class") or {}).items():
                    try:
                        aid = int(armor_id)
                        if aid not in seen:
                            seen[aid] = f"Item {armor_id}"
                    except (ValueError, TypeError):
                        pass
            return seen
    return {}


def collect_item_ids(mob_loot_path: Path, raid_sources_path: Path | None, base: Path | None = None) -> list[tuple[int, str]]:
    """Return unique (item_id, name) from mob loot, raid sources, and elemental armor."""
    seen = collect_item_ids_from_mob_loot(mob_loot_path)
    if raid_sources_path and raid_sources_path.exists():
        for iid, name in collect_item_ids_from_raid_sources(raid_sources_path).items():
            if iid not in seen:
                seen[iid] = name
    if base:
        for iid, name in collect_item_ids_from_elemental(base).items():
            if iid not in seen:
                seen[iid] = name
    return [(iid, seen[iid]) for iid in sorted(seen)]


def main():
    parser = argparse.ArgumentParser(description="Fetch TAKP AllaClone item pages to local cache")
    parser.add_argument("--delay", type=float, default=DELAY_DEFAULT, help=f"Seconds between requests (default {DELAY_DEFAULT})")
    parser.add_argument("--limit", type=int, default=0, help="Max items to fetch (0 = all)")
    parser.add_argument("--cache-dir", type=str, default="data/item_pages", help="Directory to save HTML files (default: data/item_pages)")
    parser.add_argument("--mob-loot", type=str, default="", help="Path to dkp_mob_loot.json")
    parser.add_argument("--raid-sources", type=str, default="", help="Path to raid_item_sources.json")
    args = parser.parse_args()

    base = Path(__file__).resolve().parent.parent
    mob_loot_path = Path(args.mob_loot) if args.mob_loot else None
    if not mob_loot_path or not mob_loot_path.is_absolute():
        for candidate in [base / "data" / "dkp_mob_loot.json", base / "web" / "public" / "dkp_mob_loot.json"]:
            if candidate.exists():
                mob_loot_path = candidate
                break
    if not mob_loot_path or not mob_loot_path.exists():
        print("dkp_mob_loot.json not found in data/ or web/public/")
        return 1

    raid_sources_path = Path(args.raid_sources) if args.raid_sources else None
    if not raid_sources_path or not raid_sources_path.is_absolute():
        for candidate in [base / "raid_item_sources.json", base / "web" / "public" / "raid_item_sources.json"]:
            if candidate.exists():
                raid_sources_path = candidate
                break
    if not raid_sources_path or not raid_sources_path.exists():
        raid_sources_path = None

    cache_dir = Path(args.cache_dir)
    if not cache_dir.is_absolute():
        cache_dir = base / cache_dir
    cache_dir.mkdir(parents=True, exist_ok=True)
    print(f"Cache dir: {cache_dir}")

    items = collect_item_ids(mob_loot_path, raid_sources_path, base)
    n_elem = len(collect_item_ids_from_elemental(base))
    if n_elem:
        print(f"Total items: {len(items)} (from dkp_mob_loot + raid_item_sources + {n_elem} elemental armor)")
    else:
        print(f"Total items: {len(items)} (from dkp_mob_loot + raid_item_sources)")
    if args.limit:
        items = items[: args.limit]
        print(f"Limited to first {len(items)}")
    n_items = len(items)

    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT
    done = 0
    skipped = 0
    for i, (item_id, name) in enumerate(items, 1):
        out_file = cache_dir / f"{item_id}.html"
        if out_file.exists():
            skipped += 1
            if i % 100 == 0 or i == n_items:
                print(f"  [{i}/{n_items}] skipped {skipped} already cached")
            continue
        try:
            r = session.get(TAKP_ITEM_URL.format(id=item_id), timeout=15)
            r.raise_for_status()
            out_file.write_text(r.text, encoding="utf-8")
            done += 1
            print(f"  [{i}/{n_items}] id={item_id} {name[:50]}{'...' if len(name) > 50 else ''} saved")
        except Exception as e:
            print(f"  [{i}/{n_items}] id={item_id} ERROR: {e}")
        if i < n_items:
            time.sleep(args.delay)

    print(f"Done. Fetched {done}, skipped {skipped} (already in cache). Run build_item_stats.py --from-cache {cache_dir} to build item_stats.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
