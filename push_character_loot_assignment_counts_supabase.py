#!/usr/bin/env python3
"""
Push data/character_loot_assignment_counts.csv to Supabase table character_loot_assignment_counts.
Run after assign_loot_to_characters.py so the Table Editor shows per-character counts.
Replaces all rows (delete then insert) so the table matches the CSV.

Requires: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY if RLS allows).
"""

from __future__ import annotations

import csv
import os
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR = SCRIPT_DIR / "data"
DEFAULT_CSV = DATA_DIR / "character_loot_assignment_counts.csv"
BATCH = 200


def main() -> int:
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

    path = DEFAULT_CSV
    if not path.exists():
        print(f"CSV not found: {path}", file=sys.stderr)
        return 1

    rows = []
    with open(path, "r", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            cid = (row.get("char_id") or "").strip()
            if not cid:
                continue
            items = row.get("items_assigned") or "0"
            try:
                n = int(items)
            except ValueError:
                n = 0
            rows.append({
                "char_id": cid,
                "character_name": (row.get("character_name") or "").strip() or None,
                "items_assigned": n,
            })

    if not rows:
        print("No rows in CSV.")
        return 0

    client = create_client(url, key)

    # Replace table contents: fetch existing char_ids, delete in batches, then insert CSV rows
    existing = client.table("character_loot_assignment_counts").select("char_id").limit(10000).execute()
    ids_to_delete = [r["char_id"] for r in (existing.data or []) if r.get("char_id")]
    for i in range(0, len(ids_to_delete), BATCH):
        batch = ids_to_delete[i : i + BATCH]
        if batch:
            client.table("character_loot_assignment_counts").delete().in_("char_id", batch).execute()
    if ids_to_delete:
        print(f"Deleted {len(ids_to_delete)} existing rows.")

    # Insert CSV rows in batches
    for i in range(0, len(rows), BATCH):
        chunk = rows[i : i + BATCH]
        client.table("character_loot_assignment_counts").insert(chunk).execute()
    print(f"Inserted {len(rows)} rows into character_loot_assignment_counts.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
