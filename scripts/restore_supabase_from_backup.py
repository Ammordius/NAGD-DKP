#!/usr/bin/env python3
"""
Restore DKP data tables from a backup directory of CSVs (e.g. from a
GitHub backup artifact). Deletes existing rows via API then inserts from CSVs.

Does not touch profiles or auth—only DKP data tables (characters, raids, loot, etc.).
Uses SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (same as backup workflow).

  export SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...
  python scripts/restore_supabase_from_backup.py --backup-dir backup

Used by .github/workflows/db-restore.yml after downloading an artifact.
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
from pathlib import Path

BATCH_SIZE = 500
PROGRESS_EVERY = 10  # log progress every N batches (every 5000 rows with BATCH_SIZE=500)

# DKP data tables only (never profiles or auth)
RESTORE_TABLE_ORDER = [
    "characters",
    "accounts",
    "character_account",
    "raids",
    "raid_events",
    "raid_loot",
    "raid_attendance",
    "raid_event_attendance",
    "raid_dkp_totals",
    "raid_attendance_dkp",
    "raid_classifications",
    "dkp_adjustments",
    "dkp_summary",
    "dkp_period_totals",
    "active_raiders",
    "officer_audit_log",
]

# For delete-all via API: column to use for batch delete (first column of PK for composites)
TABLE_KEY_COLUMN: dict[str, str] = {
    "characters": "char_id",
    "accounts": "account_id",
    "character_account": "char_id",
    "raids": "raid_id",
    "raid_events": "id",
    "raid_loot": "id",
    "raid_attendance": "id",
    "raid_event_attendance": "id",
    "raid_dkp_totals": "raid_id",
    "raid_attendance_dkp": "raid_id",
    "raid_classifications": "raid_id",
    "dkp_adjustments": "character_name",
    "dkp_summary": "character_key",
    "dkp_period_totals": "period",
    "active_raiders": "character_key",
    "officer_audit_log": "id",
}


def delete_all_rows(client, table: str, key_col: str) -> None:
    """Delete all rows from table via REST API in batches."""
    total = 0
    batches = 0
    while True:
        resp = (
            client.table(table)
            .select(key_col)
            .limit(BATCH_SIZE)
            .execute()
        )
        rows = resp.data or []
        if not rows:
            break
        keys = [r[key_col] for r in rows]
        client.table(table).delete().in_(key_col, keys).execute()
        total += len(keys)
        batches += 1
        if batches % PROGRESS_EVERY == 0:
            print(f"  Clearing {table}... {total} rows so far", flush=True)
    if total:
        print(f"  Cleared {table}: {total} rows", flush=True)


def clear_tables(client) -> None:
    """Clear DKP data tables only (child first). Never touches profiles or auth."""
    for table in reversed(RESTORE_TABLE_ORDER):
        key_col = TABLE_KEY_COLUMN.get(table, "id")
        try:
            delete_all_rows(client, table, key_col)
        except Exception as e:
            print(f"  {table}: clear warning - {e}", file=sys.stderr)


def load_csv_api(client, table: str, csv_path: Path) -> int:
    """Load one CSV into table via REST API insert. Returns row count."""
    with open(csv_path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames or []
        rows: list[dict] = []
        count = 0
        batches = 0
        for row in reader:
            # Coerce for API: keep nulls, stringify numbers if needed for Supabase
            out = {}
            for k in fieldnames:
                v = row.get(k, "")
                if v == "" or v is None:
                    out[k] = None
                elif k in ("id",) and v.isdigit():
                    out[k] = int(v)
                else:
                    out[k] = v
            rows.append(out)
            if len(rows) >= BATCH_SIZE:
                client.table(table).insert(rows).execute()
                count += len(rows)
                rows = []
                batches += 1
                if batches % PROGRESS_EVERY == 0:
                    print(f"  Loading {table}... {count} rows so far", flush=True)
        if rows:
            client.table(table).insert(rows).execute()
            count += len(rows)
    return count


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Restore Supabase from backup CSVs (API: delete then insert)."
    )
    ap.add_argument(
        "--backup-dir",
        type=Path,
        required=True,
        help="Directory containing table CSVs (e.g. backup/)",
    )
    args = ap.parse_args()

    url = (os.environ.get("SUPABASE_URL") or "").strip()
    key = (
        os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        or os.environ.get("SUPABASE_ANON_KEY")
        or ""
    ).strip()
    if not url or not key:
        print(
            "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (same as DB backup workflow).",
            file=sys.stderr,
        )
        return 1

    try:
        from supabase import create_client
    except ImportError:
        print("Install supabase: pip install supabase", file=sys.stderr)
        return 1

    client = create_client(url, key)
    backup_dir = args.backup_dir.resolve()
    if not backup_dir.is_dir():
        print(f"Not a directory: {backup_dir}", file=sys.stderr)
        return 1

    print("Clearing DKP data tables only (child first); profiles and auth are never touched...")
    clear_tables(client)

    total = 0
    for table in RESTORE_TABLE_ORDER:
        csv_path = backup_dir / f"{table}.csv"
        if not csv_path.is_file():
            print(f"Skip {table} (no {csv_path})")
            continue
        try:
            n = load_csv_api(client, table, csv_path)
            total += n
            print(f"{table}: {n} rows")
        except Exception as e:
            print(f"{table}: error - {e}", file=sys.stderr)
            return 1

    print(f"Restore done. Total rows: {total}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
