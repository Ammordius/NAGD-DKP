#!/usr/bin/env python3
"""
Build raid classifications from raid_loot using item->mob mappings.

Uses (in order):
- data/items_seen_to_mobs.json   item_name -> [{mob, zone}] (primary lookup)
- data/raid_loot_classification.json  classifications (overrides, e.g. PoTime P1/P3), aliases (typo -> canonical)

Each raid is classified by the mobs/zones that appear in its loot.

Outputs:
- data/raid_classifications.csv   (raid_id, mob, zone) one row per (raid, mob)
- data/unclassified_loot_items.csv  (item_name, times_seen) for items with no source match
- data/item_sources_lookup.json  (optional) item_name -> { mob, zone } or [{mob, zone}] for frontend
- web/public/item_sources.json   (optional) same for frontend to show "Drops from" on Loot page

Run after extract_structured_data.py (so data/raid_loot.csv exists).
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from collections import defaultdict

import pandas as pd


def normalize_name(s: str) -> str:
    """Collapse whitespace and strip for matching."""
    if not s or not isinstance(s, str):
        return ""
    return " ".join(s.split()).strip()


def match_key(s: str) -> str:
    """Key for case-insensitive matching (loot names often vary in casing)."""
    return normalize_name(s).lower()


def norm_mob(s: str) -> str:
    """Normalize mob name for matching (strip # and trailing |, lowercase)."""
    if not s or not isinstance(s, str):
        return ""
    s = s.strip()
    if s.startswith("#"):
        s = s[1:]
    if s.endswith("|"):
        s = s[:-1]
    return s.lower()


def load_dkp_mob_loot(path: Path) -> tuple[set[str], dict[str, str]]:
    """
    Load dkp_mob_loot.json. Return (allowed_mob_keys, mob_key -> zone).
    Only mobs in this set are used for raid classification when path is given.
    """
    allowed: set[str] = set()
    mob_to_zone: dict[str, str] = {}
    if not path.exists():
        return allowed, mob_to_zone
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        return allowed, mob_to_zone
    for key, val in raw.items():
        if not isinstance(val, dict):
            continue
        mob = norm_mob(val.get("mob") or key)
        zone = (val.get("zone") or "").strip()
        if mob:
            allowed.add(mob)
            # Prefer non-empty zone when we have multiple entries for same mob
            if mob not in mob_to_zone or (zone and not mob_to_zone.get(mob)):
                mob_to_zone[mob] = zone or mob_to_zone.get(mob, "")
    return allowed, mob_to_zone


def load_item_to_sources(
    items_seen_to_mobs_path: Path,
    raid_loot_classification_path: Path | None,
) -> tuple[dict[str, list[tuple[str, str]]], dict[str, list[dict]]]:
    """
    Build lookup: match_key(item_name) -> list of (mob, zone).
    Also return a canonical form for frontend: item_name (original casing) -> list of {mob, zone}.
    """
    # 1) items_seen_to_mobs: item_name -> [{mob, zone}]
    name_to_sources: dict[str, list[tuple[str, str]]] = defaultdict(list)
    canonical_sources: dict[str, list[dict]] = {}  # for frontend: preserve one canonical key per match_key

    if items_seen_to_mobs_path.exists():
        raw = json.loads(items_seen_to_mobs_path.read_text(encoding="utf-8"))
        for item_name, arr in raw.items():
            if not item_name or not isinstance(arr, list):
                continue
            key = match_key(item_name)
            pairs: list[tuple[str, str]] = []
            for entry in arr:
                if isinstance(entry, dict):
                    mob = (entry.get("mob") or "").strip()
                    zone = (entry.get("zone") or "").strip()
                    if (mob, zone) not in pairs:
                        pairs.append((mob, zone))
            if pairs:
                for p in pairs:
                    if p not in name_to_sources[key]:
                        name_to_sources[key].append(p)
                if key not in canonical_sources:
                    canonical_sources[key] = [{"mob": m, "zone": z} for m, z in pairs]

    # 2) raid_loot_classification: overrides (classifications) and aliases
    if raid_loot_classification_path and raid_loot_classification_path.exists():
        rlc = json.loads(raid_loot_classification_path.read_text(encoding="utf-8"))
        classifications = rlc.get("classifications") or {}
        aliases = rlc.get("aliases") or {}

        for item_name, obj in classifications.items():
            if not isinstance(obj, dict):
                continue
            mob = (obj.get("mob") or "").strip()
            zone = (obj.get("zone") or "").strip()
            if not mob:
                continue
            key = match_key(item_name)
            # Override: use this single source for this item
            name_to_sources[key] = [(mob, zone)]
            canonical_sources[key] = [{"mob": mob, "zone": zone}]

        for typo, canonical in aliases.items():
            key_typo = match_key(typo)
            key_canon = match_key(canonical)
            if key_canon in name_to_sources:
                name_to_sources[key_typo] = name_to_sources[key_canon].copy()
                canonical_sources[key_typo] = list(canonical_sources.get(key_canon, []))

    return dict(name_to_sources), canonical_sources


def main():
    ap = argparse.ArgumentParser(description="Classify raids by loot sources (mobs/zones)")
    ap.add_argument("--data-dir", type=str, default="data", help="Data directory")
    ap.add_argument("--items-seen-to-mobs", type=str, default="data/items_seen_to_mobs.json", help="Item -> mobs JSON")
    ap.add_argument("--items-seen", type=str, default="data/items_seen.json", help="Only use item->mob mappings for items in this list (canonical items); omit to use all")
    ap.add_argument("--raid-loot-classification", type=str, default="data/raid_loot_classification.json", help="Overrides and aliases JSON")
    ap.add_argument("--loot", type=str, default="data/raid_loot.csv", help="Raid loot CSV")
    ap.add_argument("--out-classifications", type=str, default="data/raid_classifications.csv")
    ap.add_argument("--out-unclassified", type=str, default="data/unclassified_loot_items.csv")
    ap.add_argument("--out-lookup", type=str, default="data/item_sources_lookup.json", help="Item sources JSON for frontend (data dir)")
    ap.add_argument("--out-public", type=str, default="web/public/item_sources.json", help="Copy to web public for Loot page")
    ap.add_argument("--copy-dkp-mob-loot", action="store_true", help="Copy data/dkp_mob_loot.json to web/public for Mob Loot page")
    ap.add_argument("--dkp-mob-loot", type=str, default="data/dkp_mob_loot.json", help="Only classify with mobs in this file (canonical DKP droppers); omit to allow all")
    args = ap.parse_args()

    base = Path(".")
    items_seen_path = base / args.items_seen_to_mobs
    raid_loot_class_path = base / args.raid_loot_classification
    loot_path = base / args.loot
    data_dir = Path(args.data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)

    if not loot_path.exists():
        raise SystemExit(f"Missing {loot_path}. Run extract_structured_data.py first.")

    allowed_item_keys: set[str] | None = None
    items_seen_list_path = base / getattr(args, "items_seen", None) or ""
    if items_seen_list_path and items_seen_list_path.exists():
        items_seen_list = json.loads(items_seen_list_path.read_text(encoding="utf-8"))
        if isinstance(items_seen_list, list):
            allowed_item_keys = {match_key(str(i).strip()) for i in items_seen_list}
            print(f"Restricting to items in {items_seen_list_path}: {len(allowed_item_keys)} item keys")
        else:
            allowed_item_keys = None
    if not allowed_item_keys:
        allowed_item_keys = None

    # Optional: restrict to mobs that appear in dkp_mob_loot.json (canonical DKP droppers)
    dkp_mob_loot_path = base / getattr(args, "dkp_mob_loot", None) or ""
    allowed_mob_keys: set[str] = set()
    mob_to_zone: dict[str, str] = {}
    if dkp_mob_loot_path and dkp_mob_loot_path.exists():
        allowed_mob_keys, mob_to_zone = load_dkp_mob_loot(dkp_mob_loot_path)
        print(f"Restricting to mobs in {dkp_mob_loot_path}: {len(allowed_mob_keys)} mobs (grouped by zone)")

    print("Loading item -> mob sources...")
    name_to_sources, canonical_sources = load_item_to_sources(items_seen_path, Path(raid_loot_class_path))
    if allowed_item_keys is not None:
        name_to_sources = {k: v for k, v in name_to_sources.items() if k in allowed_item_keys}
        canonical_sources = {k: v for k, v in canonical_sources.items() if k in allowed_item_keys}
        print(f"  (filtered to items in items_seen: {len(name_to_sources)} keys)")
    print(f"  {len(name_to_sources)} distinct item keys (case-insensitive)")

    df = pd.read_csv(loot_path)
    if "raid_id" not in df.columns or "item_name" not in df.columns:
        raise SystemExit("raid_loot.csv must have raid_id and item_name")

    classifications: set[tuple[str, str, str]] = set()
    unclassified_names: defaultdict[str, int] = defaultdict(int)

    for _, row in df.iterrows():
        raid_id = str(row.get("raid_id", "")).strip()
        item_name = str(row.get("item_name", "")).strip()
        if not item_name:
            continue
        key = match_key(item_name)
        sources = name_to_sources.get(key)
        if sources:
            for mob, zone in sources:
                if mob:
                    if allowed_mob_keys and norm_mob(mob) not in allowed_mob_keys:
                        continue
                    classifications.add((raid_id, mob, zone))
        else:
            unclassified_names[item_name] += 1

    # Prefer zone from dkp_mob_loot when available (for consistent grouping)
    def best_zone(mob: str, zone: str) -> str:
        from_dkp = mob_to_zone.get(norm_mob(mob), "")
        return (from_dkp or zone).strip() or zone

    # Write classifications: full list (raid_id, mob, zone), sorted by zone then mob then raid_id (grouped by zone)
    out_class = data_dir / "raid_classifications.csv" if args.out_classifications.startswith("data/") else Path(args.out_classifications)
    out_class.parent.mkdir(parents=True, exist_ok=True)
    class_rows = [{"raid_id": r, "mob": m, "zone": best_zone(m, z)} for r, m, z in classifications]
    class_rows.sort(key=lambda row: (row["zone"], row["mob"], row["raid_id"]))
    pd.DataFrame(class_rows).to_csv(out_class, index=False)
    print(f"  raid_classifications: {len(class_rows)} rows (grouped by zone) -> {out_class}")

    # Deduped version for DB import (table PK is (raid_id, mob), one row per (raid_id, mob), prefer zone from dkp_mob_loot)
    out_deduped = out_class.parent / (out_class.stem + "_import.csv")
    seen: dict[tuple[str, str], str] = {}
    for row in class_rows:
        r, m, z = row["raid_id"], row["mob"], row["zone"]
        key = (r, m)
        if key not in seen:
            seen[key] = z
        else:
            # Prefer non-empty zone
            if z and not seen[key]:
                seen[key] = z
    deduped_rows = [{"raid_id": r, "mob": m, "zone": seen[(r, m)]} for (r, m) in seen]
    deduped_rows.sort(key=lambda row: (row["zone"], row["mob"], row["raid_id"]))
    pd.DataFrame(deduped_rows).to_csv(out_deduped, index=False)
    print(f"  raid_classifications_import: {len(deduped_rows)} rows (for Supabase, grouped by zone) -> {out_deduped}")

    # Write unclassified
    out_unc = data_dir / "unclassified_loot_items.csv" if args.out_unclassified.startswith("data/") else Path(args.out_unclassified)
    unc_rows = [{"item_name": name, "times_seen": count} for name, count in sorted(unclassified_names.items(), key=lambda x: -x[1])]
    pd.DataFrame(unc_rows).to_csv(out_unc, index=False)
    print(f"  unclassified_loot_items: {len(unc_rows)} distinct items -> {out_unc}")
    if unc_rows:
        print("  Sample unclassified:", [r["item_name"] for r in unc_rows[:10]])

    # Item sources lookup: match_key -> list of {mob, zone} (for frontend; frontend will match case-insensitively)
    if args.out_lookup:
        lookup = {k: v for k, v in canonical_sources.items() if v}
        out_lookup = Path(args.out_lookup)
        out_lookup.parent.mkdir(parents=True, exist_ok=True)
        out_lookup.write_text(json.dumps(lookup, indent=2), encoding="utf-8")
        print(f"  item_sources_lookup: {len(lookup)} entries -> {out_lookup}")

    # Copy to web public so Loot search can show "Drops from"
    if args.out_public:
        public_path = base / args.out_public
        public_path.parent.mkdir(parents=True, exist_ok=True)
        public_path.write_text(json.dumps(canonical_sources, indent=2), encoding="utf-8")
        print(f"  web public: {public_path}")

    if getattr(args, "copy_dkp_mob_loot", False):
        src = base / "data" / "dkp_mob_loot.json"
        dst = base / "web" / "public" / "dkp_mob_loot.json"
        if src.exists():
            import shutil
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            print(f"  copied dkp_mob_loot.json -> {dst}")
        else:
            print("  (data/dkp_mob_loot.json not found, skip copy)")

    print("Done.")


if __name__ == "__main__":
    main()
