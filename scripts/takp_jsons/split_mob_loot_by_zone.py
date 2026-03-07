#!/usr/bin/env python3
"""
Split mob loot by zone so the same god in different zones (e.g. Terris Thule in
Plane of Time vs The Lair of Terris Thule / Plane of Nightmares) have separate
entries with zone-appropriate loot only.

Uses raid_item_sources.json (item_id -> { mob, zone }) to assign each loot item
to the correct (mob, zone). Items only in dkp_mob_loot (no raid_item_sources
entry) stay in the entry's current zone.

Run after merge_duplicate_mob_entries.py (and optionally aggregate_mob_loot.py if you use
merged rows with identical loot). Preserves aggregated mob lists when splitting by zone:
entries that share the same zone and same loot table stay merged as one row. Then run
preprocess_mob_loot_for_display.py.
Outputs to data/ and optionally web/public/.

Usage:
  python scripts/takp_jsons/split_mob_loot_by_zone.py
  python scripts/takp_jsons/split_mob_loot_by_zone.py --no-copy-web  # data/ only
"""
import argparse
import json
from pathlib import Path
from collections import defaultdict


def norm_mob(mob: str) -> str:
    """Normalize mob name for matching (strip # and trailing |, lowercase)."""
    if not mob or not isinstance(mob, str):
        return ""
    s = (mob or "").strip()
    if s.startswith("#"):
        s = s[1:]
    if s.endswith("|"):
        s = s[:-1]
    return s.lower()


def _norm_to_display(norm: str) -> str:
    """Convert normalized mob name back to Title_Case display."""
    if not norm:
        return ""
    return "_".join(w.capitalize() for w in norm.split("_"))


def main():
    parser = argparse.ArgumentParser(description="Split dkp_mob_loot by zone using raid_item_sources")
    parser.add_argument("--no-copy-web", action="store_true", help="Do not copy to web/public/")
    args = parser.parse_args()

    base = Path(__file__).resolve().parent.parent.parent
    path = base / "data" / "dkp_mob_loot.json"
    raid_sources_path = base / "raid_item_sources.json"
    if not path.exists():
        print(f"Not found: {path}")
        return 1
    if not raid_sources_path.exists():
        raid_sources_path = base / "web" / "public" / "raid_item_sources.json"
    if not raid_sources_path.exists():
        print(f"Not found: {raid_sources_path}")
        return 1

    data = json.loads(path.read_text(encoding="utf-8"))
    raid_sources = json.loads(raid_sources_path.read_text(encoding="utf-8"))

    # item_id -> (mob_norm, zone) from raid_item_sources (first occurrence if multiple)
    item_to_mob_zone: dict[int, tuple[str, str]] = {}
    for item_id_str, entry in raid_sources.items():
        if not isinstance(entry, dict):
            continue
        mob = (entry.get("mob") or "").strip()
        zone = (entry.get("zone") or "").strip()
        if not mob:
            continue
        try:
            iid = int(item_id_str)
        except ValueError:
            continue
        mob_norm = norm_mob(mob)
        if iid not in item_to_mob_zone or (zone and not item_to_mob_zone[iid][1]):
            item_to_mob_zone[iid] = (mob_norm, zone)

    # (mob_norm, zone) -> { "mobs_set": set of display names, "loot": list }
    # We collect all mob names from entries that contribute to each bucket so
    # aggregated entries (e.g. A_Deadly_Warboar (+3) with identical loot) stay merged.
    by_mob_zone: dict[tuple[str, str], dict] = defaultdict(lambda: {"mobs_set": set(), "loot": []})
    mob_display_by_key: dict[tuple[str, str], str] = {}

    for key, entry in data.items():
        if not isinstance(entry, dict) or "loot" not in entry:
            continue
        key_mob = key.split("|")[0].strip() if "|" in key else key
        key_mob_norm = norm_mob(key_mob)
        entry_zone = (entry.get("zone") or "").strip()
        entry_mob_display = (entry.get("mob") or key_mob or "").replace("#", "").strip()
        if not entry_zone and key.count("|") >= 1:
            entry_zone = key.split("|", 1)[1].strip()

        # All mob names from this entry (aggregated list from merge/aggregate scripts)
        mobs_from_entry = set()
        for m in entry.get("mobs") or [entry.get("mob") or key_mob]:
            if m:
                mobs_from_entry.add((m or "").replace("#", "").strip())
        if not mobs_from_entry:
            mobs_from_entry = {entry_mob_display or key_mob.replace("#", "").strip()}

        for item in entry.get("loot") or []:
            item_id = item.get("item_id")
            name = (item.get("name") or "").strip()
            sources = list(item.get("sources") or [])

            target_mob_norm = key_mob_norm
            target_zone = entry_zone

            if item_id is not None and item_id in item_to_mob_zone:
                ris_mob_norm, ris_zone = item_to_mob_zone[item_id]
                if ris_mob_norm == key_mob_norm and ris_zone:
                    target_zone = ris_zone
                target_mob_norm = ris_mob_norm
                if ris_zone:
                    target_zone = ris_zone

            if not target_zone:
                target_zone = "Other / Unknown"

            k = (target_mob_norm, target_zone)
            bucket = by_mob_zone[k]
            bucket["mobs_set"].update(mobs_from_entry)
            if k not in mob_display_by_key and entry_mob_display:
                mob_display_by_key[k] = entry_mob_display if target_mob_norm == key_mob_norm else _norm_to_display(target_mob_norm)

            loot_item = {"item_id": item_id, "name": name, "sources": sources}
            bucket["loot"].append(loot_item)

    def dedupe_loot(loot: list) -> list:
        by_key = {}
        for it in loot:
            iid = it.get("item_id")
            name = (it.get("name") or "").strip().lower()
            k = (iid, name)
            if k not in by_key:
                by_key[k] = dict(it)
                by_key[k]["sources"] = list(set(it.get("sources") or []))
            else:
                by_key[k]["sources"] = list(set(by_key[k]["sources"]) | set(it.get("sources") or []))
        for it in by_key.values():
            it["sources"] = sorted(set(it["sources"]))
        return list(by_key.values())

    def loot_signature(loot: list) -> tuple:
        """Canonical signature for merging buckets with identical loot."""
        deduped = dedupe_loot(loot)
        return tuple(sorted((it.get("item_id"), (it.get("name") or "").strip()) for it in deduped))

    # Merge buckets that have same zone and same loot (restore aggregated mob rows)
    merged: dict[tuple[str, tuple], dict] = {}
    for (mob_norm, zone), bucket in by_mob_zone.items():
        if not bucket["loot"]:
            continue
        loot = dedupe_loot(bucket["loot"])
        sig = loot_signature(bucket["loot"])
        key = (zone, sig)
        if key not in merged:
            merged[key] = {"mobs_set": set(), "loot": loot}
        merged[key]["mobs_set"].update(bucket["mobs_set"])
        # Prefer display name from mob_display_by_key for this (mob_norm, zone) if we're first
        if "display_mob" not in merged[key]:
            merged[key]["display_mob"] = mob_display_by_key.get((mob_norm, zone)) or _norm_to_display(mob_norm)

    new_data = {}
    for (zone, sig), group in merged.items():
        mobs_set = group["mobs_set"]
        if not mobs_set:
            continue
        loot = group["loot"]
        display_mob = group.get("display_mob") or _norm_to_display(min(mobs_set, key=lambda s: s.lower()))
        first_mob = sorted(mobs_set, key=lambda s: s.lower())[0]
        out_key = f"{first_mob}|{zone}" if zone else f"{first_mob}|"
        suffix = 0
        while out_key in new_data:
            suffix += 1
            out_key = f"{first_mob}|{zone}_{suffix}" if zone else f"{first_mob}|_{suffix}"
        new_data[out_key] = {
            "mob": first_mob,
            "mobs": sorted(mobs_set, key=lambda s: s.lower()),
            "zone": zone,
            "loot": loot,
        }

    path.write_text(json.dumps(new_data, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Split by zone: {len(data)} -> {len(new_data)} entries. Wrote {path}")

    if not args.no_copy_web:
        public_path = base / "web" / "public" / "dkp_mob_loot.json"
        public_path.parent.mkdir(parents=True, exist_ok=True)
        public_path.write_text(json.dumps(new_data, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"  Also wrote {public_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
