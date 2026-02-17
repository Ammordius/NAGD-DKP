#!/usr/bin/env python3
"""
Inspect raid_loot assignment results locally. Use to verify e.g. "Platinum Cloak of War"
bought by Ammordius is assigned to badammo (not namesake).

  python inspect_loot_assignment.py --item "Platinum Cloak of War"
  python inspect_loot_assignment.py --buyer Ammordius
  python inspect_loot_assignment.py --assigned badammo
  python inspect_loot_assignment.py --csv data/raid_loot.csv --item "Platinum Cloak"
"""

from __future__ import annotations

import argparse
import csv
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR = SCRIPT_DIR / "data"
DEFAULT_CSV = DATA_DIR / "raid_loot.csv"


def main() -> int:
    ap = argparse.ArgumentParser(description="Inspect assigned_char_id/assigned_character_name in raid_loot CSV.")
    ap.add_argument("--csv", type=Path, default=DEFAULT_CSV, help="raid_loot.csv path")
    ap.add_argument("--item", type=str, default="", help="Filter by item_name (substring, case-insensitive)")
    ap.add_argument("--buyer", type=str, default="", help="Filter by buyer character_name (substring)")
    ap.add_argument("--assigned", type=str, default="", help="Filter by assigned_character_name (substring)")
    ap.add_argument("-n", type=int, default=20, help="Max rows to print (default 20)")
    args = ap.parse_args()

    if not args.csv.exists():
        print(f"CSV not found: {args.csv}")
        return 1

    item_lower = args.item.strip().lower() if args.item else ""
    buyer_lower = args.buyer.strip().lower() if args.buyer else ""
    assigned_lower = args.assigned.strip().lower() if args.assigned else ""

    rows: list[dict] = []
    with open(args.csv, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if item_lower and item_lower not in (row.get("item_name") or "").lower():
                continue
            if buyer_lower and buyer_lower not in (row.get("character_name") or "").lower():
                continue
            if assigned_lower and assigned_lower not in (row.get("assigned_character_name") or "").lower():
                continue
            rows.append(row)

    if not rows:
        print("No matching rows.")
        return 0

    print(f"Found {len(rows)} row(s). Showing up to {args.n}:\n")
    for i, r in enumerate(rows[: args.n]):
        item = r.get("item_name") or "—"
        buyer = r.get("character_name") or r.get("char_id") or "—"
        assigned = r.get("assigned_character_name") or r.get("assigned_char_id") or "—"
        cost = r.get("cost") or "—"
        via = " (via Magelo)" if (r.get("assigned_via_magelo") or "").strip() == "1" else ""
        print(f"  {item}  buyer={buyer}  assigned_to={assigned}{via}  {cost} DKP")
    if len(rows) > args.n:
        print(f"  ... and {len(rows) - args.n} more.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
