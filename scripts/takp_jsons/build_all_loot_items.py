#!/usr/bin/env python3
"""
Build a consolidated list of all loot item names seen in DKP or present in our JSONs.
For use by log-file watchers (e.g. bid helpers) that need to match item names.

Sources:
  - data/raid_loot.csv (item_name)
  - data/items_seen.json
  - data/dkp_mob_loot.json (mob -> loot[].name)
  - data/items_seen_to_mobs.json (keys)
  - data/item_sources_lookup.json (keys, lowercase)
  - data/raid_loot_classification.json (classifications + aliases)
  - dkp_elemental_to_magelo.json (dkp_purchases[].name)
  - raid_item_sources.json (id -> name)

Outputs:
  - data/all_loot_items.json   : sorted unique item names (array)
  - data/all_loot_items.txt    : one item per line (for grep/simple matching)
  - data/all_loot_items_aliases.json : optional canonical -> [aliases] for log normalization
"""

from pathlib import Path
import csv
import json


def main():
    root = Path(__file__).resolve().parent.parent.parent  # repo root
    data = root / "data"
    seen = set()  # preserve first-seen spelling for consistency

    def add(name: str) -> None:
        if not name or not isinstance(name, str):
            return
        n = name.strip()
        if not n:
            return
        # Skip placeholder names like "(item 10137)" from logs/DB
        if n.startswith("(item ") and n.endswith(")"):
            return
        seen.add(n)

    # 1) raid_loot.csv
    raid_loot = data / "raid_loot.csv"
    if raid_loot.exists():
        with open(raid_loot, encoding="utf-8", newline="") as f:
            reader = csv.DictReader(f)
            if "item_name" in (reader.fieldnames or []):
                for row in reader:
                    add(row.get("item_name", ""))

    # 2) items_seen.json
    items_seen = data / "items_seen.json"
    if items_seen.exists():
        with open(items_seen, encoding="utf-8") as f:
            arr = json.load(f)
            for n in arr:
                add(n)

    # 3) dkp_mob_loot.json
    dkp_mob = data / "dkp_mob_loot.json"
    if dkp_mob.exists():
        with open(dkp_mob, encoding="utf-8") as f:
            obj = json.load(f)
            for mob_data in obj.values():
                if isinstance(mob_data, dict) and "loot" in mob_data:
                    for entry in mob_data["loot"]:
                        if isinstance(entry, dict) and "name" in entry:
                            add(entry["name"])

    # 4) items_seen_to_mobs.json (keys are item names)
    items_to_mobs = data / "items_seen_to_mobs.json"
    if items_to_mobs.exists():
        with open(items_to_mobs, encoding="utf-8") as f:
            obj = json.load(f)
            for key in obj:
                add(key)

    # 5) item_sources_lookup.json (keys are lowercase item names)
    lookup = data / "item_sources_lookup.json"
    if lookup.exists():
        with open(lookup, encoding="utf-8") as f:
            obj = json.load(f)
            for key in obj:
                add(key)

    # 6) raid_loot_classification.json
    classification = data / "raid_loot_classification.json"
    if classification.exists():
        with open(classification, encoding="utf-8") as f:
            obj = json.load(f)
            cls = obj.get("classifications") or {}
            for key in cls:
                add(key)
            aliases = obj.get("aliases") or {}
            for alias, canonical in aliases.items():
                add(alias)
                add(canonical)

    # 7) dkp_elemental_to_magelo.json
    elemental = root / "dkp_elemental_to_magelo.json"
    if elemental.exists():
        with open(elemental, encoding="utf-8") as f:
            obj = json.load(f)
            purchases = obj.get("dkp_purchases") or {}
            for v in purchases.values():
                if isinstance(v, dict) and "name" in v:
                    add(v["name"])

    # 8) raid_item_sources.json
    raid_sources = root / "raid_item_sources.json"
    if raid_sources.exists():
        with open(raid_sources, encoding="utf-8") as f:
            obj = json.load(f)
            for v in obj.values():
                if isinstance(v, dict) and "name" in v:
                    add(v["name"])

    items = sorted(seen)

    data.mkdir(parents=True, exist_ok=True)

    out_json = data / "all_loot_items.json"
    out_txt = data / "all_loot_items.txt"
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(items, f, indent=2)
    with open(out_txt, "w", encoding="utf-8") as f:
        f.write("\n".join(items) + "\n")

    print(f"Wrote {len(items)} unique item names to {out_json} and {out_txt}")

    # Aliases map (for log watcher: normalize known typos/variants to canonical)
    aliases_path = data / "raid_loot_classification.json"
    alias_map = {}  # canonical -> [aliases that map to it]
    if aliases_path.exists():
        with open(aliases_path, encoding="utf-8") as f:
            obj = json.load(f)
            for alias, canonical in (obj.get("aliases") or {}).items():
                alias_map.setdefault(canonical, []).append(alias)

    out_aliases = data / "all_loot_items_aliases.json"
    with open(out_aliases, "w", encoding="utf-8") as f:
        json.dump(alias_map, f, indent=2)
    print(f"Wrote aliases for {len(alias_map)} canonicals to {out_aliases}")


if __name__ == "__main__":
    main()
