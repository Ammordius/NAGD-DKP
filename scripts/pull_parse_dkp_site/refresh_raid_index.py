#!/usr/bin/env python3
"""
Update raids_index.csv from existing HTML files in raids/.

Use this after you manually save a raid details page (e.g. when pull_raids.py
gets 403). For each row in raids_index.csv, if raids/raid_{raid_id}.html exists,
we parse it and update that row's raid_name, date, and attendees.
"""

import sys
from pathlib import Path

import pandas as pd

# Reuse the same parser as pull_raids
from pull_raids import RAID_DETAILS_URL, parse_raid_detail_meta


def main() -> None:
    index_path = Path("raids_index.csv")
    raids_dir = Path("raids")
    gid = "547766"

    if not index_path.exists():
        print(f"Missing {index_path}. Run pull_raids.py first to create the index.", file=sys.stderr)
        sys.exit(2)
    if not raids_dir.is_dir():
        print(f"Missing {raids_dir}/ directory.", file=sys.stderr)
        sys.exit(2)

    df = pd.read_csv(index_path)
    updated = 0
    for i, row in df.iterrows():
        raw = row["raid_id"]
        rid = str(int(raw)) if isinstance(raw, (int, float)) and not pd.isna(raw) else str(raw).strip()
        html_file = raids_dir / f"raid_{rid}.html"
        if not html_file.exists():
            continue
        html = html_file.read_text(encoding="utf-8")
        meta = parse_raid_detail_meta(html)
        if meta.get("raid_name"):
            df.at[i, "raid_name"] = meta["raid_name"]
        if meta.get("date"):
            df.at[i, "date"] = meta["date"]
        if meta.get("attendees"):
            df.at[i, "attendees"] = meta["attendees"]
        raid_pool = row.get("raid_pool", "")
        if pd.notna(raid_pool):
            df.at[i, "url"] = f"{RAID_DETAILS_URL}?raid_pool={raid_pool}&raidId={rid}&gid={gid}"
        updated += 1
        print(f"Updated index from {html_file.name}")

    if updated:
        df.to_csv(index_path, index=False)
        print(f"Wrote {index_path} ({updated} rows updated from HTML).")
    else:
        print("No raid HTML files found in raids/; index unchanged.")


if __name__ == "__main__":
    main()
