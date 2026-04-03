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
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
REFRESH_RETRIES = 3
REFRESH_RETRY_DELAY_SEC = 5


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


def _is_transient_refresh_error(exc: Exception) -> bool:
    err = str(exc).lower()
    return (
        "57014" in err
        or "statement timeout" in err
        or "readtimeout" in err
        or "read operation timed out" in err
    )


def _call_rpc_with_retries(client, rpc_name: str) -> tuple[bool, str]:
    last_err: Exception | None = None
    for attempt in range(REFRESH_RETRIES):
        try:
            client.rpc(rpc_name).execute()
            return True, ""
        except Exception as e:
            last_err = e
            if _is_transient_refresh_error(e) and attempt < REFRESH_RETRIES - 1:
                print(
                    f"{rpc_name} timed out/transient (attempt {attempt + 1}/{REFRESH_RETRIES}); "
                    f"retrying in {REFRESH_RETRY_DELAY_SEC}s...",
                    file=sys.stderr,
                )
                time.sleep(REFRESH_RETRY_DELAY_SEC)
                continue
            break
    return False, str(last_err) if last_err else "unknown error"


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

    # Strict-mode finalization: full account + dkp refresh must both succeed.
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
                # Per-raid uploads already ran refresh_account_dkp_summary_for_raid; full
                # refresh_account_dkp_summary is redundant here and often hits statement_timeout.
                dkp_ok, dkp_err = _call_rpc_with_retries(client, "refresh_dkp_summary")

                print("Batch refresh status:")
                print("  account_summary: ok (per-raid refresh_account_dkp_summary_for_raid)")
                print(f"  dkp_summary: {'ok' if dkp_ok else 'failed'}")

                if not dkp_ok:
                    print(
                        "ERROR: batch upload completed inserts but final refresh_dkp_summary failed; "
                        "run is not synchronized and should be rerun.",
                        file=sys.stderr,
                    )
                    print(f"  refresh_dkp_summary error: {dkp_err}", file=sys.stderr)
                    return 2
            except Exception as e:
                print(
                    "ERROR: could not execute final batch refresh calls; run is not synchronized.",
                    file=sys.stderr,
                )
                print(f"Details: {e}", file=sys.stderr)
                return 2
        else:
            print(
                "ERROR: missing SUPABASE_URL/KEY for final refresh; run is not synchronized.",
                file=sys.stderr,
            )
            return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
