#!/usr/bin/env python3
"""
Update existing raid_loot rows in Supabase with assigned_char_id, assigned_character_name, assigned_via_magelo.
Reads data/raid_loot.csv (must include an 'id' column from a Supabase export). Calls update_raid_loot_assignments
RPC so conflicts are resolved (existing rows updated), never ignored. Requires the function from
docs/supabase-loot-to-character.sql.

Requires: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY if RLS allows).
  export SUPABASE_URL=https://xxx.supabase.co
  export SUPABASE_SERVICE_ROLE_KEY=eyJ...
  python update_raid_loot_assignments_supabase.py [--csv path/to/raid_loot.csv] [--batch 1000]
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR = SCRIPT_DIR / "data"
DEFAULT_CSV = DATA_DIR / "raid_loot.csv"
BATCH = 1000  # fewer RPC round-trips; 15 batches for ~15k rows


def main() -> int:
    print("Starting update_raid_loot_assignments_supabase...", flush=True)
    ap = argparse.ArgumentParser(description="Apply raid_loot assignment columns to Supabase by id (no duplicates).")
    ap.add_argument("--csv", type=Path, default=DEFAULT_CSV, help="raid_loot.csv with id and assignment columns")
    ap.add_argument("--batch", type=int, default=BATCH, help="Upsert batch size")
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

    if not args.csv.exists():
        print(f"CSV not found: {args.csv}", file=sys.stderr)
        return 1

    print(f"Reading CSV {args.csv}...", flush=True)
    rows = []
    with open(args.csv, "r", encoding="utf-8") as f:
        r = csv.DictReader(f)
        if "id" not in (r.fieldnames or []):
            print("CSV must include an 'id' column (export raid_loot from Supabase first).", file=sys.stderr)
            return 1
        for row in r:
            id_val = (row.get("id") or "").strip()
            if not id_val:
                continue
            # Accept integer id as "123" or "123.0" (Supabase/JSON may return numbers as float)
            try:
                row_id = int(float(id_val))
            except (ValueError, OverflowError):
                continue
            if row_id <= 0:
                continue
            raw = (row.get("assigned_via_magelo") or "").strip()
            via_magelo = 1 if raw == "1" else 0
            rows.append({
                "id": row_id,
                "assigned_char_id": (row.get("assigned_char_id") or "").strip() or None,
                "assigned_character_name": (row.get("assigned_character_name") or "").strip() or None,
                "assigned_via_magelo": via_magelo,
            })

    if not rows:
        print("No rows with valid id found in CSV.")
        return 0

    num_batches = (len(rows) + args.batch - 1) // args.batch
    print(f"Loaded {len(rows)} rows. Connecting to Supabase...", flush=True)
    client = create_client(url, key)
    print(f"Updating {len(rows)} rows in {num_batches} batches (batch size {args.batch})...", flush=True)
    n = 0
    for i in range(0, len(rows), args.batch):
        chunk = rows[i : i + args.batch]
        batch_num = i // args.batch + 1
        print(f"RPC batch {batch_num}/{num_batches}...", end=" ", flush=True)
        # Use RPC so conflicts are resolved (UPDATE), not ignored. Requires update_raid_loot_assignments(jsonb) in DB.
        resp = client.rpc("update_raid_loot_assignments", {"data": chunk}).execute()
        count = None
        if hasattr(resp, "data") and resp.data is not None:
            try:
                d = resp.data
                count = int(d[0] if isinstance(d, list) and d else d)
            except (TypeError, ValueError, IndexError):
                pass
        if count is not None:
            n += count
        else:
            n += len(chunk)
        print(f"ok ({len(chunk)} rows)", flush=True)
    print(f"Done. Updated {n} raid_loot rows.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
