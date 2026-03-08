#!/usr/bin/env python3
"""
Upload events, loot, and attendance for every raid in raids_index.csv that has
both raid_{id}.html and raid_{id}_attendees.html. Used by the local Makefile.

  python scripts/pull_parse_dkp_site/upload_all_raid_details_from_index.py [--raids-dir raids] [--index raids_index.csv]
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent


def _load_env(path: Path) -> None:
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip().strip("'\"")
        if k:
            os.environ.setdefault(k, v)
    for vite, plain in (
        ("VITE_SUPABASE_URL", "SUPABASE_URL"),
        ("VITE_SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY"),
        ("VITE_SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"),
    ):
        if not os.environ.get(plain) and os.environ.get(vite):
            os.environ[plain] = os.environ[vite]


def main() -> int:
    ap = argparse.ArgumentParser(description="Upload each raid's detail from index to Supabase")
    ap.add_argument("--raids-dir", type=Path, default=Path("raids"), help="Directory with raid_*.html")
    ap.add_argument("--index", type=Path, default=Path("raids_index.csv"), help="CSV with raid_id column")
    ap.add_argument("--raid-ids", type=str, default="", help="Comma-separated raid IDs to upload (default: all in index that have both HTML files)")
    ap.add_argument("--apply", action="store_true", default=True, help="Pass --apply to upload script (default true)")
    args = ap.parse_args()

    script_dir = Path(__file__).resolve().parent
    root = script_dir.parent.parent
    upload_script = script_dir / "upload_raid_detail_to_supabase.py"
    if not upload_script.exists():
        print(f"Missing {upload_script}", file=sys.stderr)
        return 1
    if not args.index.exists():
        print(f"Missing index {args.index}. Run pull-raids first.", file=sys.stderr)
        return 1

    only_ids = {x.strip() for x in args.raid_ids.split(",") if x.strip()} if args.raid_ids else None

    with open(args.index, encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    n = 0
    for row in rows:
        rid = (row.get("raid_id") or "").strip().strip('"')
        if not rid:
            continue
        if only_ids is not None and rid not in only_ids:
            continue
        detail = args.raids_dir / f"raid_{rid}.html"
        attendees = args.raids_dir / f"raid_{rid}_attendees.html"
        if not detail.exists() or not attendees.exists():
            continue
        n += 1
        print(f"Uploading raid {rid}...")
        r = subprocess.run(
            [
                sys.executable,
                str(upload_script),
                "--raid-id",
                rid,
                "--raids-dir",
                str(args.raids_dir),
                "--apply",
                "--skip-dkp-summary-refresh",
            ],
            cwd=str(root),
        )
        if r.returncode != 0:
            return r.returncode
    print(f"Uploaded {n} raid(s).")

    # One full dkp_summary refresh after batch (avoids N× full rebuilds when uploading many raids).
    if n > 0:
        for path in (ROOT / ".env", ROOT / "web" / ".env", ROOT / "web" / ".env.local"):
            if path.exists():
                _load_env(path)
        url = os.environ.get("SUPABASE_URL", "").strip()
        key = (
            os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
            or os.environ.get("SUPABASE_ANON_KEY", "").strip()
        )
        if url and key:
            try:
                from supabase import create_client
                client = create_client(url, key)
                client.rpc("refresh_dkp_summary").execute()
                print("refresh_dkp_summary() completed.")
            except Exception as e:
                print(f"Warning: refresh_dkp_summary: {e}", file=sys.stderr)
        else:
            print("Skipping refresh_dkp_summary (SUPABASE_URL/KEY not set).", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
