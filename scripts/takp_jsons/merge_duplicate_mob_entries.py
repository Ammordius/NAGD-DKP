#!/usr/bin/env python3
"""
Merge duplicate mob entries in data/dkp_mob_loot.json.

When the same mob appears under multiple keys (e.g. "Gutripping_War_Beast|" with no zone
and "Gutripping_War_Beast|Plane of Time"), merge into a single entry: union of mobs arrays,
union of loot by item_id/name, and use the best zone (from entry or fix_mob_zones list).
This fixes the loot page showing the same mob under "Other / Unknown" and again under
the real zone with different items.

Usage:
  python scripts/merge_duplicate_mob_entries.py
  Then copy data/dkp_mob_loot.json to web/public/ if needed.
"""
import json
from pathlib import Path
from collections import defaultdict

# Same as scripts/takp_jsons/fix_mob_zones.py: mob (from key) -> zone for entries with no zone
MOB_ZONES = {
    "Nrinda_of_Ice": "Plane of Water",
    "Pwelon_of_Vapor": "Plane of Water",
    "Azobian_the_Darklord": "Plane of Fire",
    "Dersool_Fal`Giersnaol": "Plane of Time",
    "Derugoak_Bloodwalker": "Plane of Earth",
    "Halgoz_Rellinic": "Halls of Honor",
    "Herlsoakian": "Plane of Time",
    "Narandi_the_Wretched": "The Great Divide",
    "Freegan_Haun": "Halls of Honor",
    "Tribal_Leader_Diseranon": "Plane of Earth",
    "War_Shapen_Emissary": "Plane of Time",
    "Hebabbilys_the_Ragelord": "Plane of Fire",
    "Javonn_the_Overlord": "Plane of Fire",
    "Ralthos_Enrok": "Plane of Time",
    "Reaxnous_the_Chaoslord": "Plane of Fire",
    "A_Deadly_Warboar": "Plane of Time",
    "Anar_of_Water": "Plane of Time",
    "A_Ferocious_Warboar": "Plane of Time",
    "Rythor_of_the_Undead": "Plane of Time",
    "A_Needletusk_Warboar": "Plane of Time",
    "The_Protector_of_Dresolik": "Tower of Solusek Ro",
    "a_torrid_elemental": "Tower of Solusek Ro",
    "an_Enchanted_War_Boar": "Tower of Solusek Ro",
    "Calris_Bristlebranch": "Plane of Earth",
    "Peregrin_Rockskull": "Plane of Earth",
    "Gutripping_War_Beast": "Plane of Time",
    "Neimon_of_Air": "Plane of Time",
    "Windshapen_Warlord_of_Air": "Plane of Time",
    "Kazrok_of_Fire": "Plane of Time",
    "Fennin_Ro_the_Tyrant_of_Fire": "Plane of Fire",
    "A_Monsterous_Mudwalker": "Plane of Earth",
    "A_Mystical_Arbitor_of_Earth": "Plane of Earth",
    "A_Perfected_Warder_of_Earth": "Plane of Earth",
    "Earthen_Overseer": "Plane of Time",
    "Terlok_of_Earth": "Plane of Time",
    "The_Living_Earth": "Plane of Earth",
    "Bertoxxulous": "Plane of Time",
    "#Bertoxxulous": "Plane of Time",
    "Cazic_Thule": "Plane of Time",
    "Innoruuk": "Plane of Time",
    "Rallos_Zek": "Plane of Time",
    "Rallos_Zek_the_Warlord": "Plane of Time",
    "Tallon_Zek": "Plane of Time",
    "Vallon_Zek": "Plane of Time",
    "Saryrn": "Plane of Time",
    "Terris_Thule": "Plane of Time",
    "Quarm": "Plane of Time",
    "The_Avatar_of_War": "Plane of Time",
    "Avatar_of_the_Elements": "Plane of Time",
    "Supernatural_Guardian": "Plane of Time",
    "Champion_of_Torment": "Plane of Time",
    "Dark_Knight_of_Terris": "Plane of Time",
    "Dreamwarp": "Plane of Time",
    "Kraksmaal_Fir`Dethsin": "Plane of Time",
    "Sinrunal_Gorgedreal": "Plane of Time",
    "Xeroan_Xi`Geruonask": "Plane of Time",
    "Xerskel_Gerodnsal": "Plane of Time",
    "Undead_Squad_Leader": "Plane of Time",
}


def norm_mob_from_key(key: str) -> str:
    """Extract mob part from key like 'MobName|Zone' or '#MobName|'."""
    if not key or "|" not in key:
        return (key or "").strip()
    mob = key.split("|")[0].strip()
    if mob.startswith("#"):
        mob = mob[1:]
    return mob


def loot_key(item: dict) -> tuple:
    """Canonical key for deduplicating loot (item_id, name lower)."""
    iid = item.get("item_id")
    name = ((item.get("name") or "").strip().lower(),)
    if iid is not None:
        return (iid, name)
    return (None, name)


def main():
    base = Path(__file__).resolve().parent.parent.parent  # repo root
    path = base / "data" / "dkp_mob_loot.json"
    if not path.exists():
        print(f"Not found: {path}")
        return 1
    data = json.loads(path.read_text(encoding="utf-8"))

    # Group entries by (primary_mob, resolved_zone) so we only merge same mob in same zone
    def resolve_zone(key: str, entry: dict) -> str:
        z = (entry.get("zone") or "").strip()
        if z:
            return z
        mob = norm_mob_from_key(key)
        return MOB_ZONES.get(mob) or MOB_ZONES.get(f"#{mob}", "")

    by_mob_zone = defaultdict(list)
    for key, entry in data.items():
        if not isinstance(entry, dict) or "loot" not in entry:
            continue
        mob = norm_mob_from_key(key)
        if not mob:
            continue
        zone = resolve_zone(key, entry)
        by_mob_zone[(mob, zone)].append((key, entry))

    new_data = {}
    merged_count = 0
    for (primary_mob, zone), group in by_mob_zone.items():
        if len(group) == 1:
            key, entry = group[0]
            new_data[key] = entry
            continue

        # Merge all entries in this (mob, zone) group
        # Union mobs
        mobs_set = set()
        for _k, e in group:
            for m in e.get("mobs") or [e.get("mob") or _k.split("|")[0]]:
                if m:
                    mobs_set.add((m or "").replace("#", "").strip())
            if not (e.get("mobs") or e.get("mob")):
                mobs_set.add(primary_mob)
        mobs = sorted(mobs_set) if mobs_set else [primary_mob]

        # Union loot by item_id / name
        loot_by_key = {}
        for _k, e in group:
            for item in e.get("loot") or []:
                k = loot_key(item)
                if k not in loot_by_key:
                    loot_by_key[k] = dict(item)
                    loot_by_key[k].setdefault("sources", [])
                else:
                    for s in item.get("sources") or []:
                        if s not in loot_by_key[k]["sources"]:
                            loot_by_key[k]["sources"].append(s)
        loot = list(loot_by_key.values())
        for it in loot:
            if "sources" in it and isinstance(it["sources"], list):
                it["sources"] = sorted(set(it["sources"]))

        new_key = f"{primary_mob}|{zone}" if zone else f"{primary_mob}|"
        new_data[new_key] = {
            "mob": mobs[0] if mobs else primary_mob,
            "mobs": mobs,
            "zone": zone,
            "loot": loot,
        }
        merged_count += len(group) - 1
        print(f"  Merged {len(group)} entries for {primary_mob} -> {new_key} ({len(loot)} items)")

    path.write_text(json.dumps(new_data, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Merged {merged_count} duplicate mob entries. {len(new_data)} unique entries.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
