#!/usr/bin/env python3
"""
Estimate Supabase public-schema backup size using the REST API (no pg_dump needed).
Loads credentials from web/.env.local (VITE_SUPABASE_*), web/.env, or .env so the web app's
env can be used. Connects to Supabase, gets row counts and sample row sizes per table, and
estimates uncompressed and gzipped backup size.

Usage (from repo root):
  python estimate_backup_size.py

Requires: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in web/.env.local (or SUPABASE_URL +
SUPABASE_SERVICE_ROLE_KEY in .env). For full counts under RLS, use the service role key.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent

# Public schema tables we backup (from docs/supabase-schema.sql)
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
]


def load_web_env() -> None:
    """Load .env from .env, web/.env, then web/.env.local so web env overrides; map VITE_ vars for script."""
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    for p in (SCRIPT_DIR / ".env", SCRIPT_DIR / "web" / ".env", SCRIPT_DIR / "web" / ".env.local"):
        if p.exists():
            load_dotenv(p, override=True)
    # Prefer web env: VITE_ vars may be the only ones set
    url = os.environ.get("SUPABASE_URL", "").strip() or os.environ.get("VITE_SUPABASE_URL", "").strip()
    key = (
        os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        or os.environ.get("SUPABASE_ANON_KEY", "").strip()
        or os.environ.get("VITE_SUPABASE_SERVICE_ROLE_KEY", "").strip()
        or os.environ.get("VITE_SUPABASE_ANON_KEY", "").strip()
    )
    if url:
        os.environ["SUPABASE_URL"] = url
    if key:
        os.environ["SUPABASE_SERVICE_ROLE_KEY"] = key


def main() -> int:
    load_web_env()
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = (
        os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        or os.environ.get("SUPABASE_ANON_KEY", "").strip()
    )
    if not url or not key:
        print(
            "Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in web/.env.local (or SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env).",
            file=sys.stderr,
        )
        return 1

    try:
        from supabase import create_client
    except ImportError:
        print("Install supabase: pip install supabase", file=sys.stderr)
        return 1

    client = create_client(url, key)
    total_rows = 0
    total_data_bytes = 0
    schema_overhead = 80 * 1024  # ~80 KB for schema DDL

    print("Table              rows      avg B/row   data (KB)")
    print("-" * 55)

    for table in PUBLIC_TABLES:
        try:
            # Row count (exact)
            resp = client.table(table).select("*", count="exact").limit(0).execute()
            count = getattr(resp, "count", None) or getattr(resp, "total", None) or 0
            # Sample one row for size
            sample = client.table(table).select("*").limit(1).execute()
            row_bytes = 0
            if sample.data and len(sample.data) > 0:
                row_bytes = len(json.dumps(sample.data[0], default=str).encode("utf-8"))
            # pg_dump uses COPY text format; approximate bytes per row (slightly larger than JSON)
            avg_per_row = int(row_bytes * 1.15) if row_bytes else 100
            data_bytes = count * avg_per_row
            total_rows += count
            total_data_bytes += data_bytes
            print(f"{table:<20} {count:>8}   {avg_per_row:>8}   {data_bytes / 1024:>10.1f}")
        except Exception as e:
            print(f"{table:<20}   error: {e}", file=sys.stderr)

    uncompressed = total_data_bytes + schema_overhead
    # Typical gzip ratio for SQL dump text
    gzip_ratio = 0.22
    compressed = int(uncompressed * gzip_ratio)

    print("-" * 55)
    print(f"Total rows: {total_rows}")
    print(f"Estimated uncompressed backup: {uncompressed / (1024*1024):.2f} MB")
    print(f"Estimated gzipped backup:       {compressed / (1024*1024):.2f} MB (≈{gzip_ratio*100:.0f}% of uncompressed)")
    print()
    print("Use this for CI artifact sizing (rolling + weekly + monthly).")

    return 0


if __name__ == "__main__":
    sys.exit(main())
