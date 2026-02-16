#!/usr/bin/env python3
"""
Fetch all raid_loot rows from Supabase and write data/raid_loot.csv (with id).
Used by CI so the assign script has ids and can then run update_raid_loot_assignments_supabase.py.

Requires: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY if RLS allows read).
  export SUPABASE_URL=https://xxx.supabase.co
  export SUPABASE_SERVICE_ROLE_KEY=eyJ...
  python fetch_raid_loot_from_supabase.py [--out data/raid_loot.csv]
  python fetch_raid_loot_from_supabase.py --count-only   # print total row count only (for CI skip check)
  python fetch_raid_loot_from_supabase.py --all-tables  # also fetch characters, character_account, raids to data/ (for account linking in assign)
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR = SCRIPT_DIR / "data"
DEFAULT_OUT = DATA_DIR / "raid_loot.csv"
PAGE_SIZE = 1000


def _fetch_table_to_csv(client, table: str, out_path: Path) -> int:
    """Fetch all rows from table (paginated) and write CSV. Returns row count."""
    all_rows: list[dict] = []
    offset = 0
    while True:
        resp = client.table(table).select("*").range(offset, offset + PAGE_SIZE - 1).execute()
        rows = resp.data or []
        if not rows:
            break
        all_rows.extend(rows)
        if len(rows) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if not all_rows:
        # Header-only; use known columns per table so assign script can read empty files
        defaults = {"characters": ["char_id", "name", "race", "class_name", "level", "guild_rank", "claim"],
                    "character_account": ["char_id", "account_id"],
                    "raids": ["raid_id", "raid_pool", "raid_name", "date", "date_iso", "attendees", "url"]}
        fieldnames = defaults.get(table, ["id"])
        with open(out_path, "w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
            w.writeheader()
        return 0
    fieldnames = list(all_rows[0].keys())
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        w.writeheader()
        for row in all_rows:
            out = {k: ("" if v is None else str(v) if isinstance(v, (int, float)) else str(v)) for k, v in row.items()}
            w.writerow(out)
    return len(all_rows)


def main() -> int:
    ap = argparse.ArgumentParser(description="Fetch raid_loot from Supabase to CSV (with id).")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT, help="Output CSV path")
    ap.add_argument("--count-only", action="store_true", help="Only print total raid_loot row count (for CI skip check)")
    ap.add_argument("--all-tables", action="store_true", help="Also fetch characters, character_account, raids to data/ (for assign script account linking)")
    args = ap.parse_args()

    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip() or os.environ.get("SUPABASE_ANON_KEY", "").strip()
    if not url or not key:
        print("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY)", file=sys.stderr)
        return 1

    try:
        from supabase import create_client
    except ImportError:
        print("Install supabase: pip install supabase", file=sys.stderr)
        return 1

    client = create_client(url, key)

    if args.count_only:
        # Lightweight count for CI: skip Magelo pull if no new loot (count unchanged)
        resp = client.table("raid_loot").select("*", count="exact").limit(0).execute()
        count = getattr(resp, "count", None)
        if count is None:
            count = getattr(resp, "total", None)
        if count is None:
            # Client didn't expose count; force CI to run by printing 0 (never equals stored count)
            count = 0
        print(count)
        return 0

    all_rows: list[dict] = []
    offset = 0
    while True:
        resp = client.table("raid_loot").select("*").range(offset, offset + PAGE_SIZE - 1).execute()
        rows = resp.data or []
        if not rows:
            break
        all_rows.extend(rows)
        if len(rows) < PAGE_SIZE:
            break
        offset += PAGE_SIZE

    if not all_rows:
        print("No raid_loot rows in Supabase.", file=sys.stderr)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        # Write header-only so assign script sees id column
        fieldnames = ["id", "raid_id", "event_id", "item_name", "char_id", "character_name", "cost",
                      "assigned_char_id", "assigned_character_name", "assigned_via_magelo"]
        with open(args.out, "w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
            w.writeheader()
        return 0

    fieldnames = list(all_rows[0].keys())
    # Prefer column order: id first, then core, then assignment
    preferred = ["id", "raid_id", "event_id", "item_name", "char_id", "character_name", "cost",
                 "assigned_char_id", "assigned_character_name", "assigned_via_magelo"]
    fieldnames = [c for c in preferred if c in fieldnames] + [c for c in fieldnames if c not in preferred]

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        w.writeheader()
        for row in all_rows:
            out = {}
            for k, v in row.items():
                if v is None:
                    out[k] = ""
                elif k == "id" and isinstance(v, (int, float)):
                    # Write id as integer string so update script never sees "123.0"
                    try:
                        out[k] = str(int(v))
                    except (ValueError, OverflowError):
                        out[k] = str(v)
                elif isinstance(v, (int, float)):
                    out[k] = str(v)
                else:
                    out[k] = str(v)
            w.writerow(out)

    print(f"Fetched {len(all_rows)} raid_loot rows to {args.out}")

    if getattr(args, "all_tables", False):
        for table, filename in [("characters", "characters.csv"), ("character_account", "character_account.csv"), ("raids", "raids.csv")]:
            path = DATA_DIR / filename
            n = _fetch_table_to_csv(client, table, path)
            print(f"Fetched {n} {table} rows to {path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
