#!/usr/bin/env python3
"""
Remove 'Mark of Shadows' (item_id 26769) from all mobs in dkp_mob_loot.json
except the canonical dropper: Kaas Thox Xi Aten Ha Ra (Vex Thal).

Usage:
  python scripts/fix_mark_of_shadows_loot.py
  # Then copy to web if needed: python build_raid_classifications.py --copy-dkp-mob-loot
"""
import json
from pathlib import Path

MARK_OF_SHADOWS_ITEM_ID = 26769
MARK_OF_SHADOWS_NAME = "Mark of Shadows"
CANONICAL_MOB_KEY = "Kaas_Thox_Xi_Aten_Ha_Ra|Vex Thal"

def main():
    base = Path(__file__).resolve().parent.parent.parent  # repo root
    path = base / "data" / "dkp_mob_loot.json"
    if not path.exists():
        print(f"Not found: {path}")
        return 1
    data = json.loads(path.read_text(encoding="utf-8"))
    removed = 0
    for mob_key, entry in data.items():
        if not isinstance(entry, dict) or "loot" not in entry:
            continue
        if mob_key == CANONICAL_MOB_KEY:
            continue
        loot = entry["loot"]
        new_loot = []
        for item in loot:
            if item.get("item_id") == MARK_OF_SHADOWS_ITEM_ID or (item.get("name") or "").strip() == MARK_OF_SHADOWS_NAME:
                removed += 1
                continue
            new_loot.append(item)
        entry["loot"] = new_loot
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Removed Mark of Shadows (26769) from {removed} mob entries. Kept only under '{CANONICAL_MOB_KEY}'.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
