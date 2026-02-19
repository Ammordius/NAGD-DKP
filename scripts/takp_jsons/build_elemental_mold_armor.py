#!/usr/bin/env python3
"""
Build elemental_mold_armor.json from dkp_elemental_to_magelo.json for the DKP web app.
Maps each DKP mold/pattern ID to class-specific armor item IDs (uppercase class keys).
Used with item_stats.json so when a class is selected we can show the wearable armor
instead of the mold, while keeping DKP/loot context and indicating the source mold.
"""

import json
from pathlib import Path


def main():
    base = Path(__file__).resolve().parent.parent.parent  # repo root
    src = base / "dkp_elemental_to_magelo.json"
    out_data = base / "data" / "elemental_mold_armor.json"
    out_public = base / "web" / "public" / "elemental_mold_armor.json"

    data = json.loads(src.read_text(encoding="utf-8"))
    purchases = data.get("dkp_purchases") or {}

    out = {}
    for mold_id_str, entry in purchases.items():
        mold_id = mold_id_str
        name = entry.get("name") or ""
        slot = entry.get("slot") or ""
        armor_type = entry.get("armor_type") or ""
        by_class_raw = entry.get("magelo_item_ids_by_class") or {}
        by_class = {k.upper(): str(v) for k, v in by_class_raw.items()}
        out[mold_id_str] = {
            "mold_name": name,
            "slot": slot,
            "armor_type": armor_type,
            "by_class": by_class,
        }

    out_data.parent.mkdir(parents=True, exist_ok=True)
    out_data.write_text(json.dumps(out, indent=2), encoding="utf-8")
    out_public.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"Wrote {len(out)} molds to {out_data} and {out_public}")


if __name__ == "__main__":
    main()
