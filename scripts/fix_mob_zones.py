#!/usr/bin/env python3
"""
Update zone fields in data/dkp_mob_loot.json for a list of mobs.
Run from repo root. Copy to web/public after: copy data\\dkp_mob_loot.json web\\public\\
"""
import json
from pathlib import Path

# mob name (as in JSON key, before |) -> zone. Use title case for zones.
MOB_ZONES = [
    ("Nrinda_of_Ice", "Plane of Water"),
    ("Pwelon_of_Vapor", "Plane of Water"),
    ("Azobian_the_Darklord", "Plane of Fire"),
    ("Dersool_Fal`Giersnaol", "Plane of Time"),
    ("Derugoak_Bloodwalker", "Plane of Earth"),
    ("Halgoz_Rellinic", "Halls of Honor"),
    ("Herlsoakian", "Plane of Time"),
    ("Narandi_the_Wretched", "The Great Divide"),
    ("Freegan_Haun", "Halls of Honor"),
    ("Tribal_Leader_Diseranon", "Plane of Earth"),
    ("War_Shapen_Emissary", "Plane of Time"),
    ("Hebabbilys_the_Ragelord", "Plane of Fire"),
    ("Javonn_the_Overlord", "Plane of Fire"),
    ("Ralthos_Enrok", "Plane of Time"),
    ("Reaxnous_the_Chaoslord", "Plane of Fire"),
    ("A_Deadly_Warboar", "Plane of Time"),
    ("Anar_of_Water", "Plane of Time"),
    ("A_Ferocious_Warboar", "Plane of Time"),
    ("Rythor_of_the_Undead", "Plane of Time"),
    ("A_Needletusk_Warboar", "Plane of Time"),
    ("The_Protector_of_Dresolik", "Tower of Solusek Ro"),
    ("an_Enchanted_War_Boar", "Plane of Time"),
    ("Peregrin_Rockskull", "Plane of Earth"),
    ("Gutripping_War_Beast", "Plane of Time"),
    ("Neimon_of_Air", "Plane of Time"),
    ("Windshapen_Warlord_of_Air", "Plane of Time"),
    ("Kazrok_of_Fire", "Plane of Time"),
    ("Fennin_Ro_the_Tyrant_of_Fire", "Plane of Fire"),
    ("A_Monsterous_Mudwalker", "Plane of Earth"),
    ("A_Mystical_Arbitor_of_Earth", "Plane of Earth"),
    ("A_Perfected_Warder_of_Earth", "Plane of Earth"),
    ("Earthen_Overseer", "Plane of Time"),
    ("Terlok_of_Earth", "Plane of Time"),
    ("The_Living_Earth", "Plane of Earth"),
    ("Bertoxxulous", "Plane of Time"),
    ("#Bertoxxulous", "Plane of Time"),
    ("Cazic_Thule", "Plane of Time"),
    ("Innoruuk", "Plane of Time"),
    ("Rallos_Zek", "Plane of Time"),
    ("Rallos_Zek_the_Warlord", "Plane of Time"),
    ("Tallon_Zek", "Plane of Time"),
    ("Vallon_Zek", "Plane of Time"),
    ("Saryrn", "Plane of Time"),
    ("Terris_Thule", "Plane of Time"),
    ("Quarm", "Plane of Time"),
    ("The_Avatar_of_War", "Plane of Time"),
    ("Avatar_of_the_Elements", "Plane of Time"),
    ("Supernatural_Guardian", "Plane of Time"),
    ("Champion_of_Torment", "Plane of Time"),
    ("Dark_Knight_of_Terris", "Plane of Time"),
    ("Dreamwarp", "Plane of Time"),
    ("Kraksmaal_Fir`Dethsin", "Plane of Time"),
    ("Sinrunal_Gorgedreal", "Plane of Time"),
    ("Xeroan_Xi`Geruonask", "Plane of Time"),
    ("Xerskel_Gerodnsal", "Plane of Time"),
    ("Undead_Squad_Leader", "Plane of Time"),
]


def norm_mob_from_key(key: str) -> str:
    """Extract mob part from key like 'MobName|Zone' or '#MobName|'."""
    if not key or "|" not in key:
        return (key or "").strip()
    mob = key.split("|")[0].strip()
    if mob.startswith("#"):
        mob = mob[1:]
    return mob


def main():
    base = Path(__file__).resolve().parent.parent
    path = base / "data" / "dkp_mob_loot.json"
    if not path.exists():
        print(f"Not found: {path}")
        return 1
    data = json.loads(path.read_text(encoding="utf-8"))

    # Exact mob name -> zone
    mob_to_zone = {mob: zone for mob, zone in MOB_ZONES}
    # Deathbringer_* -> Plane of Time
    deathbringer_zone = "Plane of Time"

    updated = 0
    for key, entry in list(data.items()):
        if not isinstance(entry, dict):
            continue
        key_mob = norm_mob_from_key(key)
        entry_mob = (entry.get("mob") or "").replace("#", "").strip()
        zone = None
        if key_mob in mob_to_zone:
            zone = mob_to_zone[key_mob]
        elif entry_mob in mob_to_zone:
            zone = mob_to_zone[entry_mob]
        elif key_mob.startswith("Deathbringer_") or entry_mob.startswith("Deathbringer_"):
            zone = deathbringer_zone
        if zone is not None and entry.get("zone") != zone:
            entry["zone"] = zone
            updated += 1
            print(f"  {key_mob or entry_mob} -> {zone}")

    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Updated {updated} mob zone(s) in {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
