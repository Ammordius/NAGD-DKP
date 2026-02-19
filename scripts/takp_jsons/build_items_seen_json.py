#!/usr/bin/env python3
"""
Build a JSON list of all distinct item names seen in raid loot (from data/raid_loot.csv).
Output: data/items_seen.json  (array of item name strings, sorted).
"""

from pathlib import Path
import json

import pandas as pd


def main():
    loot_path = Path("data/raid_loot.csv")
    if not loot_path.exists():
        raise SystemExit("Missing data/raid_loot.csv. Run extract_structured_data.py first.")

    df = pd.read_csv(loot_path)
    if "item_name" not in df.columns:
        raise SystemExit("raid_loot.csv must have an item_name column.")

    names = df["item_name"].astype(str).str.strip()
    names = names[names != ""]
    items = sorted(names.unique().tolist())

    out_path = Path("data/items_seen.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(items, indent=2), encoding="utf-8")
    print(f"Wrote {len(items)} item names to {out_path}")


if __name__ == "__main__":
    main()
