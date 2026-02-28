#!/usr/bin/env python3
"""
Preprocess dkp_mob_loot.json for display: merge entries by zone+mob, dedupe loot,
remove VZ tactics-only items from Plane of Time Vallon Zek. Run after
merge_duplicate_mob_entries.py. Outputs to data/ and web/public/ so the site
does minimal work at runtime.

Usage:
  python scripts/takp_jsons/preprocess_mob_loot_for_display.py
"""
import json
import sys
from pathlib import Path
from collections import defaultdict

# Reuse zone resolution from merge_duplicate_mob_entries (same dir)
sys.path.insert(0, str(Path(__file__).resolve().parent))
from merge_duplicate_mob_entries import MOB_ZONES, norm_mob_from_key

# Frontend MOB_ZONE_OVERRIDES (normalized key -> zone)
MOB_ZONE_OVERRIDES = {
    "a_monsterous_mudwalker": "Plane of Earth",
    "a_mystical_arbitor_of_earth": "Plane of Earth",
    "a_perfected_warder_of_earth": "Plane of Earth",
    "peregrin_rockskull": "Plane of Earth",
    "tribal_leader_diseranon": "Plane of Earth",
    "avatar_of_earth": "Tower of Solusek Ro",
    "the_protector_of_dresolik": "Tower of Solusek Ro",
    "rizlona": "Tower of Solusek Ro",
}


VZ_TACTICS_ONLY_ITEM_NAMES = frozenset({
    "furious hammer of zek",
    "obsidian scimitar of war",
    "resplendent war maul",
    "girdle of the tactician",
    "pendant of the triumphant victor",
})


def normalize_mob_key(mob: str) -> str:
    if not mob:
        return ""
    return (mob or "").replace("#", "").strip().lower().replace(" ", "_")


def resolve_display_zone(key: str, entry: dict) -> str:
    z = (entry.get("zone") or "").strip()
    if z:
        return z
    mob = norm_mob_from_key(key)
    mobs_raw = entry.get("mobs") or [entry.get("mob") or mob]
    for m in mobs_raw:
        n = normalize_mob_key(m)
        if n in MOB_ZONE_OVERRIDES:
            return MOB_ZONE_OVERRIDES[n]
    return MOB_ZONES.get(mob) or MOB_ZONES.get(f"#{mob}", "")


def main():
    base = Path(__file__).resolve().parent.parent.parent
    path = base / "data" / "dkp_mob_loot.json"
    if not path.exists():
        print(f"Not found: {path}")
        return 1
    data = json.loads(path.read_text(encoding="utf-8"))

    # Build name -> item_id from all loot for dedupe (prefer first id we see)
    name_to_id = {}
    for entry in data.values():
        if not isinstance(entry, dict):
            continue
        for item in entry.get("loot") or []:
            iid = item.get("item_id")
            name = (item.get("name") or "").strip().lower()
            if name and name not in name_to_id and iid is not None:
                name_to_id[name] = iid

    # Group by (display_zone, mob_sig) to match frontend entriesMergedByMobAndZone
    def mob_sig(entry: dict, key: str) -> tuple:
        mobs = entry.get("mobs") or [entry.get("mob") or key.split("|")[0]]
        return tuple(sorted({(m or "").replace("#", "").strip() for m in mobs if m}))

    by_group = defaultdict(list)
    for key, entry in data.items():
        if not isinstance(entry, dict) or "loot" not in entry:
            continue
        zone = resolve_display_zone(key, entry) or "Other / Unknown"
        sig = mob_sig(entry, key)
        if not sig:
            continue
        by_group[(zone, sig)].append((key, entry))

    out = {}
    for (display_zone, sig), group in by_group.items():
        mobs_set = set()
        loot_by_key = {}  # (item_id or name_key) -> { item, sources }

        for _key, e in group:
            for m in e.get("mobs") or [e.get("mob") or _key.split("|")[0]]:
                if m:
                    mobs_set.add((m or "").replace("#", "").strip())
            for item in e.get("loot") or []:
                name_norm = (item.get("name") or "").strip().lower()
                resolved_id = item.get("item_id") or name_to_id.get(name_norm)
                k = str(resolved_id) if resolved_id is not None else (name_norm or "unknown")
                if k not in loot_by_key:
                    loot_by_key[k] = {"item": dict(item), "sources": set(item.get("sources") or [])}
                else:
                    rec = loot_by_key[k]
                    rec["sources"].update(item.get("sources") or [])
                    if rec["item"].get("item_id") is None and item.get("item_id") is not None:
                        rec["item"] = dict(item)

        mobs = sorted(mobs_set)
        loot = []
        for rec in loot_by_key.values():
            item = rec["item"]
            name_norm = (item.get("name") or "").strip().lower()
            # VZ in Plane of Time: drop tactics-only items
            if (
                display_zone == "Plane of Time"
                and any("vallon_zek" in normalize_mob_key(m) for m in mobs)
                and name_norm in VZ_TACTICS_ONLY_ITEM_NAMES
            ):
                continue
            sources = sorted(set(rec["sources"]))
            loot.append({**item, "sources": sources})

        first = group[0][1]
        out_key = f"{mobs[0]}|{display_zone}" if display_zone else f"{mobs[0]}|"
        out[out_key] = {
            "mob": mobs[0],
            "mobs": mobs,
            "zone": first.get("zone") or display_zone,
            "loot": loot,
        }

    indent = 2
    payload = json.dumps(out, indent=indent, ensure_ascii=False)

    path.write_text(payload, encoding="utf-8")
    public_path = base / "web" / "public" / "dkp_mob_loot.json"
    public_path.parent.mkdir(parents=True, exist_ok=True)
    public_path.write_text(payload, encoding="utf-8")
    print(f"Preprocessed: {len(data)} -> {len(out)} entries. Wrote data/ and web/public/dkp_mob_loot.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
