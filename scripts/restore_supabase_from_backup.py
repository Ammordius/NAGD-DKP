#!/usr/bin/env python3
"""
Restore Supabase public schema from a backup directory of CSVs (e.g. from a
GitHub backup artifact). Truncates tables then loads CSVs in dependency order.

Requires: SUPABASE_DB_URL (Postgres connection URI) and a backup dir with
one CSV per table as produced by export_supabase_public_tables.py.

  export SUPABASE_DB_URL='postgresql://postgres.[ref]:[PASSWORD]@...'
  python scripts/restore_supabase_from_backup.py --backup-dir backup [--include-profiles]

Used by .github/workflows/db-restore.yml after downloading an artifact.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

# Import order matches export_supabase_public_tables.PUBLIC_TABLES (and FK order)
RESTORE_TABLE_ORDER = [
    "profiles",
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


def run_truncate(conn, truncate_sql_path: Path, include_profiles: bool) -> None:
    sql = truncate_sql_path.read_text(encoding="utf-8")
    with conn.cursor() as cur:
        cur.execute(sql)
        if include_profiles:
            cur.execute("TRUNCATE TABLE profiles CASCADE;")
    conn.commit()


def load_csv(conn, table: str, csv_path: Path) -> int:
    """Load one CSV into table using COPY. Returns row count."""
    with open(csv_path, "rb") as f:
        with conn.cursor() as cur:
            copy_sql = f'COPY public."{table}" FROM STDIN WITH (FORMAT csv, HEADER true)'
            cur.copy_expert(copy_sql, f)
    conn.commit()
    with open(csv_path, encoding="utf-8") as f:
        return sum(1 for _ in f) - 1  # line count minus header


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Restore Supabase from backup CSVs (truncate then COPY)."
    )
    ap.add_argument(
        "--backup-dir",
        type=Path,
        required=True,
        help="Directory containing table CSVs (e.g. backup/)",
    )
    ap.add_argument(
        "--truncate-sql",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "docs" / "supabase-restore-truncate.sql",
        help="Path to truncate SQL file",
    )
    ap.add_argument(
        "--include-profiles",
        action="store_true",
        help="Restore profiles table (default: skip to avoid wiping auth-related data)",
    )
    args = ap.parse_args()

    db_url = os.environ.get("SUPABASE_DB_URL", "").strip()
    if not db_url:
        print("Set SUPABASE_DB_URL (Postgres connection URI)", file=sys.stderr)
        return 1

    try:
        import psycopg2
    except ImportError:
        print("Install psycopg2-binary: pip install psycopg2-binary", file=sys.stderr)
        return 1

    backup_dir = args.backup_dir.resolve()
    if not backup_dir.is_dir():
        print(f"Not a directory: {backup_dir}", file=sys.stderr)
        return 1

    truncate_sql = args.truncate_sql.resolve()
    if not truncate_sql.is_file():
        print(f"Truncate SQL not found: {truncate_sql}", file=sys.stderr)
        return 1

    conn = psycopg2.connect(db_url)
    try:
        run_truncate(conn, truncate_sql, args.include_profiles)
        print("Truncate done.")
    except Exception as e:
        print(f"Truncate failed: {e}", file=sys.stderr)
        return 1

    total = 0
    for table in RESTORE_TABLE_ORDER:
        if table == "profiles" and not args.include_profiles:
            continue
        csv_path = backup_dir / f"{table}.csv"
        if not csv_path.is_file():
            print(f"Skip {table} (no {csv_path})")
            continue
        try:
            n = load_csv(conn, table, csv_path)
            total += n
            print(f"{table}: {n} rows")
        except Exception as e:
            print(f"{table}: error - {e}", file=sys.stderr)
            return 1

    conn.close()
    print(f"Restore done. Total rows: {total}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
