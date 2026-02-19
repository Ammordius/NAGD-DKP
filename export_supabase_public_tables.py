#!/usr/bin/env python3
"""
Export all public-schema tables from Supabase to CSV via the REST API.
Uses only SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (same as loot-to-character CI).
CSV compresses well (e.g. tar.gz); used by the DB backup workflow.

  export SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...
  python export_supabase_public_tables.py --out-dir backup
  # Then tar czf backup-YYYY-MM-DD.tar.gz backup/
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
from pathlib import Path

PAGE_SIZE = 1000

PUBLIC_TABLES = [
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


def export_table(client, table: str, out_path: Path) -> int:
    """Fetch all rows (paginated) and write CSV. Returns row count."""
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
        defaults: dict[str, list[str]] = {
            "profiles": ["id", "email", "role", "created_at", "updated_at", "account_id"],
            "characters": ["char_id", "name", "race", "class_name", "level", "guild_rank", "claim"],
            "accounts": ["account_id", "char_ids", "toon_names", "toon_count", "display_name"],
            "character_account": ["char_id", "account_id"],
            "raids": ["raid_id", "raid_pool", "raid_name", "date", "date_iso", "attendees", "url"],
            "raid_events": ["id", "raid_id", "event_id", "event_order", "event_name", "dkp_value", "attendee_count", "event_time"],
            "raid_loot": ["id", "raid_id", "event_id", "item_name", "char_id", "character_name", "cost"],
            "raid_attendance": ["id", "raid_id", "char_id", "character_name"],
            "raid_event_attendance": ["id", "raid_id", "event_id", "char_id", "character_name"],
            "raid_dkp_totals": ["raid_id", "total_dkp"],
            "raid_attendance_dkp": ["raid_id", "character_key", "character_name", "dkp_earned"],
            "raid_classifications": ["raid_id", "mob", "zone"],
            "dkp_adjustments": ["character_name", "earned_delta", "spent_delta"],
            "dkp_summary": ["character_key", "character_name", "earned", "spent", "earned_30d", "earned_60d", "last_activity_date", "updated_at"],
            "dkp_period_totals": ["period", "total_dkp"],
            "active_raiders": ["character_key"],
            "officer_audit_log": ["id", "created_at", "actor_id", "actor_email", "actor_display_name", "action", "target_type", "target_id", "delta"],
        }
        fieldnames = defaults.get(table, ["id"])
        with open(out_path, "w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
            w.writeheader()
        return 0
    fieldnames = list(all_rows[0].keys())
    with open(out_path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        w.writeheader()
        for row in all_rows:
            out = {k: ("" if v is None else str(v) if isinstance(v, (int, float)) else str(v)) for k, v in row.items()}
            w.writerow(out)
    return len(all_rows)


def main() -> int:
    ap = argparse.ArgumentParser(description="Export Supabase public tables to CSV (REST API).")
    ap.add_argument("--out-dir", type=Path, default=Path("backup"), help="Output directory (one .csv per table)")
    args = ap.parse_args()

    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip() or os.environ.get("SUPABASE_ANON_KEY", "").strip()
    if not url or not key:
        print("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY", file=sys.stderr)
        return 1

    try:
        from supabase import create_client
    except ImportError:
        print("Install supabase: pip install supabase", file=sys.stderr)
        return 1

    client = create_client(url, key)
    total = 0
    for table in PUBLIC_TABLES:
        out_path = args.out_dir / f"{table}.csv"
        try:
            n = export_table(client, table, out_path)
            total += n
            print(f"{table}: {n} rows -> {out_path}")
        except Exception as e:
            print(f"{table}: error - {e}", file=sys.stderr)
            return 1
    print(f"Total: {total} rows in {args.out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
