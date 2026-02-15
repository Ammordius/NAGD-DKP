#!/usr/bin/env python3
"""
Restrict the four elemental essence DKP items to their canonical droppers only:
- Essence of Wind: only Xegony (Sigismond_Windwalker|Plane of Air)
- Essence of Fire: only Fennin Ro (Fennin_Ro_the_Tyrant_of_Fire|)
- Essence of Water: only Coirnav (Coirnav_the_Avatar_of_Water|Plane of Water)
- Essence of Earth: only Avatar of Earth (Tantisala_Jaggedtooth|Plane of Earth)

Remove these items from all other mobs; ensure they exist on the canonical mob.

Usage:
  python scripts/fix_essence_loot.py
  # Then: python build_raid_classifications.py --copy-dkp-mob-loot
"""
import json
from pathlib import Path

ESSENCES = [
    {
        "name": "Essence of Wind",
        "item_id": 10229,
        "canonical_mob_key": "Sigismond_Windwalker|Plane of Air",
    },
    {
        "name": "Essence of Fire",
        "item_id": 16262,
        "canonical_mob_key": "Fennin_Ro_the_Tyrant_of_Fire|",
    },
    {
        "name": "Essence of Water",
        "item_id": 16265,
        "canonical_mob_key": "Coirnav_the_Avatar_of_Water|Plane of Water",
    },
    {
        "name": "Essence of Earth",
        "item_id": 14760,
        "canonical_mob_key": "Tantisala_Jaggedtooth|Plane of Earth",
    },
]


def main():
    base = Path(__file__).resolve().parent.parent
    path = base / "data" / "dkp_mob_loot.json"
    if not path.exists():
        print(f"Not found: {path}")
        return 1
    data = json.loads(path.read_text(encoding="utf-8"))

    for spec in ESSENCES:
        name = spec["name"]
        item_id = spec["item_id"]
        canonical = spec["canonical_mob_key"]
        removed = 0
        for mob_key, entry in data.items():
            if not isinstance(entry, dict) or "loot" not in entry:
                continue
            loot = entry["loot"]
            new_loot = []
            for item in loot:
                is_essence = (
                    item.get("item_id") == item_id
                    or (item.get("name") or "").strip() == name
                )
                if not is_essence:
                    new_loot.append(item)
                    continue
                if mob_key == canonical:
                    new_loot.append(item)
                    continue
                removed += 1
            entry["loot"] = new_loot

        # Ensure canonical mob has the item
        if canonical in data and isinstance(data[canonical], dict):
            loot = data[canonical].get("loot", [])
            has_it = any(
                (item.get("name") or "").strip() == name or item.get("item_id") == item_id
                for item in loot
            )
            if not has_it:
                loot.append({
                    "item_id": item_id,
                    "name": name,
                    "sources": ["dkp"],
                })
                data[canonical]["loot"] = loot
                print(f"Added {name} to {canonical}")

        print(f"{name}: removed from {removed} mob(s), only on {canonical}")

    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
