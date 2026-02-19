#!/usr/bin/env python3
"""
Update Supabase raid_events.event_time from CSV (no truncate, no re-import).

Reads data/raid_events_event_time_backfill.csv or data/raid_events.csv (if it has
event_time populated) and calls the update_raid_event_times RPC in batches.

Requires: run docs/supabase-update-event-times-rpc.sql once in Supabase SQL Editor.

Credentials (one of):
  - Environment: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
  - .env in repo root: same names (loads via python-dotenv if installed)

  cp .env.example .env
  # Edit .env with your Supabase URL and service_role key from Settings → API

  python update_supabase_event_times.py [--csv path] [--batch 500]
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent.parent  # repo root


def _load_env_file(path: Path) -> None:
    """Parse KEY=VALUE lines and set os.environ (no quotes stripping for values)."""
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip().strip("'\"")
            if k:
                os.environ.setdefault(k, v)
    # Map VITE_ to non-VITE so one set of names works
    for vite, plain in (("VITE_SUPABASE_URL", "SUPABASE_URL"), ("VITE_SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY")):
        if not os.environ.get(plain) and os.environ.get(vite):
            os.environ[plain] = os.environ[vite]


def load_dotenv() -> None:
    """Load .env from repo root and/or web/.env.local; accept VITE_ prefixed vars."""
    for path in (ROOT / ".env", ROOT / "web" / ".env.local"):
        if path.exists():
            _load_env_file(path)


def main() -> int:
    load_dotenv()

    ap = argparse.ArgumentParser(description="Update Supabase raid_events.event_time from CSV (no truncate).")
    ap.add_argument(
        "--csv",
        type=Path,
        default=ROOT / "data" / "raid_events_event_time_backfill.csv",
        help="CSV with raid_id, event_id, event_time (or raid_events.csv with event_time column)",
    )
    ap.add_argument("--batch", type=int, default=500, help="RPC batch size")
    ap.add_argument("--dry-run", action="store_true", help="Load CSV and show what would be updated; do not call Supabase")
    args = ap.parse_args()

    if not args.csv.exists():
        print(f"CSV not found: {args.csv}", file=sys.stderr)
        print("  Run backfill_event_times.py first (or use --dry-run-local to build from raids/*.html), then re-run extract or use the backfill CSV.", file=sys.stderr)
        return 1

    rows: list[dict] = []
    with open(args.csv, "r", encoding="utf-8") as f:
        r = csv.DictReader(f)
        fields = r.fieldnames or []
        if "event_time" not in fields:
            print("CSV must have an event_time column.", file=sys.stderr)
            return 1
        for row in r:
            raid_id = (row.get("raid_id") or "").strip()
            event_id = (row.get("event_id") or "").strip()
            event_time = (row.get("event_time") or "").strip()
            if not raid_id or not event_id or not event_time:
                continue
            rows.append({"raid_id": raid_id, "event_id": event_id, "event_time": event_time})

    if not rows:
        print("No rows with (raid_id, event_id, event_time) to update.")
        return 0

    num_batches = (len(rows) + args.batch - 1) // args.batch

    if args.dry_run:
        print(f"[DRY RUN] Would update {len(rows)} raid_events.event_time rows in {num_batches} batch(es) (batch size {args.batch}).")
        print("  RPC: update_raid_event_times(data) — UPDATE raid_events SET event_time FROM payload WHERE raid_id AND event_id match. No truncate, no insert.")
        print("  Sample rows (first 5):")
        for r in rows[:5]:
            print(f"    raid_id={r['raid_id']} event_id={r['event_id']} event_time={r['event_time']!r}")
        print("  Run without --dry-run to apply (requires .env or SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).")
        return 0

    url = os.environ.get("SUPABASE_URL", "").strip()
    key = (
        os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        or os.environ.get("SUPABASE_ANON_KEY", "").strip()
    )
    if not url or not key:
        missing = []
        if not url:
            missing.append("SUPABASE_URL (or VITE_SUPABASE_URL in web/.env.local)")
        if not key:
            missing.append("SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY (or VITE_SUPABASE_ANON_KEY in web/.env.local)")
        print("Missing:", ", ".join(missing), file=sys.stderr)
        print("  Use dkp/.env or web/.env.local with values from Supabase → Settings → API", file=sys.stderr)
        return 1

    try:
        from supabase import create_client
    except ImportError:
        print("Install supabase: pip install supabase", file=sys.stderr)
        return 1

    print(f"Loaded {len(rows)} event_time rows from {args.csv}. Connecting to Supabase...", flush=True)
    client = create_client(url, key)
    print(f"Updating in {num_batches} batches (batch size {args.batch})...", flush=True)

    total_updated = 0
    for i in range(0, len(rows), args.batch):
        chunk = rows[i : i + args.batch]
        batch_num = i // args.batch + 1
        print(f"  Batch {batch_num}/{num_batches}...", end=" ", flush=True)
        try:
            resp = client.rpc("update_raid_event_times", {"data": chunk}).execute()
            if hasattr(resp, "data") and resp.data is not None:
                total_updated += int(resp.data) if isinstance(resp.data, (int, float)) else len(chunk)
            else:
                total_updated += len(chunk)
            print("ok", flush=True)
        except Exception as e:
            print(f"error: {e}", flush=True)
            if "update_raid_event_times" in str(e) and "does not exist" in str(e).lower():
                print("  Run docs/supabase-update-event-times-rpc.sql in Supabase SQL Editor first.", file=sys.stderr)
            return 1

    print(f"Done. Updated {total_updated} raid_events.event_time rows.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
