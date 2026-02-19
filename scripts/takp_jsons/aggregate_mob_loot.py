#!/usr/bin/env python3
"""
Merge mobs with identical loot tables in data/dkp_mob_loot.json.
Each entry becomes one row with mobs: ["Mob1", "Mob2", ...] and the shared loot.
Zone is set to the most common zone in the group (or first non-empty).

Usage:
  python scripts/aggregate_mob_loot.py
  Then copy data/dkp_mob_loot.json to web/public/ if needed.
"""
import json
from pathlib import Path
from collections import defaultdict


def loot_signature(loot: list) -> tuple:
    """Canonical signature for a loot list (order-independent)."""
    if not loot:
        return ()
    keys = []
    for item in loot:
        iid = item.get("item_id")
        name = (item.get("name") or "").strip()
        keys.append((iid, name))
    return tuple(sorted(keys))


def mob_name_from_key(key: str, entry: dict) -> str:
    """Get display mob name from key or entry."""
    mob = (entry.get("mob") or "").strip()
    if mob:
        return mob.replace("#", "")
    if "|" in key:
        return key.split("|")[0].replace("#", "").strip()
    return key.replace("#", "").strip()


def main():
    base = Path(__file__).resolve().parent.parent.parent  # repo root
    path = base / "data" / "dkp_mob_loot.json"
    if not path.exists():
        print(f"Not found: {path}")
        return 1
    data = json.loads(path.read_text(encoding="utf-8"))

    # Group entries by loot signature
    by_sig: dict[tuple, list[tuple[str, dict]]] = defaultdict(list)
    for key, entry in data.items():
        if not isinstance(entry, dict) or "loot" not in entry:
            continue
        loot = entry.get("loot") or []
        if not loot:
            continue
        sig = loot_signature(loot)
        by_sig[sig].append((key, entry))

    # Build new data: one entry per group
    new_data = {}
    merged_count = 0
    for sig, group in by_sig.items():
        if len(group) == 1:
            key, entry = group[0]
            new_data[key] = entry
            continue
        # Merge: collect mob names and pick zone
        mob_names = []
        zones = []
        loot = None
        for key, entry in group:
            name = mob_name_from_key(key, entry)
            if name and name not in mob_names:
                mob_names.append(name)
            z = (entry.get("zone") or "").strip()
            if z:
                zones.append(z)
            if loot is None:
                loot = entry.get("loot") or []
        mob_names.sort(key=lambda s: s.lower())
        zone = max(zones, key=zones.count) if zones else (group[0][1].get("zone") or "")
        # Key: first mob + " (+N)" to avoid collision, e.g. "A_Deadly_Warboar (+3)|Plane of Time"
        first = mob_names[0]
        suffix = f" (+{len(mob_names) - 1})" if len(mob_names) > 1 else ""
        new_key = f"{first}{suffix}|{zone}" if zone else f"{first}{suffix}|"
        new_data[new_key] = {
            "mob": first,
            "mobs": mob_names,
            "zone": zone,
            "loot": loot,
        }
        merged_count += len(group) - 1
        print(f"  Merged {len(mob_names)} mobs: {', '.join(mob_names[:5])}{'...' if len(mob_names) > 5 else ''} -> {new_key}")

    path.write_text(json.dumps(new_data, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Aggregated: {merged_count} duplicate entries merged. {len(new_data)} unique loot tables.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
