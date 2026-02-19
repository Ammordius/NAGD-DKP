#!/usr/bin/env python3
"""
Detect raids that have been saved in raids/ (raid_*_attendees.html or raid_*.html)
but are not yet in Supabase, and optionally upload them to the raids table.

  python scripts/upload_saved_raids_supabase.py [--dry-run] [--apply]
  python scripts/upload_saved_raids_supabase.py --apply   # upload missing raids

Uses raids/ directory (repo root). Reads raids_index.csv if present for metadata.
Parses raid_id and raid_pool from saved HTML (e.g. from "saved from url=...raidId=...&raid_pool=...").

Requires: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY if RLS allows insert).
  Load from .env / web/.env / web/.env.local (VITE_SUPABASE_* also supported).
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent.parent  # repo root (script lives in scripts/pull_parse_dkp_site/)
GID = "547766"
RAID_DETAILS_URL = "https://azureguardtakp.gamerlaunch.com/rapid_raid/raid_details.php"
# Supabase/PostgREST default max rows per request is 1000
PAGE_SIZE = 1000


def _load_env_file(path: Path) -> None:
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


def load_dotenv() -> None:
    for path in (ROOT / ".env", ROOT / "web" / ".env", ROOT / "web" / ".env.local"):
        if path.exists():
            _load_env_file(path)


def parse_date_to_iso(date_str: str) -> str:
    """Parse 'Wed Sep 30, 2020 12:50 am' -> '2020-09-30' or empty."""
    if not date_str or not str(date_str).strip():
        return ""
    s = str(date_str).strip()
    for fmt, max_len in (
        ("%a %b %d, %Y %I:%M %p", 30),
        ("%a %b %d, %Y", 17),
        ("%Y-%m-%d", 10),
    ):
        try:
            part = s[:max_len] if len(s) > max_len else s
            dt = datetime.strptime(part, fmt)
            return dt.strftime("%Y-%m-%d")
        except ValueError:
            continue
    return ""


def parse_raid_id_and_pool_from_attendees_html(html: str) -> tuple[str | None, str | None]:
    """Extract raidId and raid_pool from saved attendees HTML (comment or href)."""
    # First 2KB is enough for the saved-from-url comment
    sample = html[:2048] if len(html) > 2048 else html
    sample = sample.replace("&amp;", "&")
    raid_id = None
    raid_pool = None
    m = re.search(r"raidId=(\d+)", sample, re.IGNORECASE)
    if m:
        raid_id = m.group(1)
    m = re.search(r"raid_pool=(\d+)", sample, re.IGNORECASE)
    if m:
        raid_pool = m.group(1)
    return (raid_id, raid_pool)


def discover_saved_raid_ids(raids_dir: Path) -> set[str]:
    """Return set of raid_id from raid_*_attendees.html and raid_*.html (no _attendees)."""
    ids: set[str] = set()
    for p in raids_dir.glob("raid_*_attendees.html"):
        m = re.match(r"raid_(\d+)_attendees\.html", p.name)
        if m:
            ids.add(m.group(1))
    for p in raids_dir.glob("raid_*.html"):
        if "_attendees" in p.name:
            continue
        m = re.match(r"raid_(\d+)\.html", p.name)
        if m:
            ids.add(m.group(1))
    return ids


def build_raid_row(
    raid_id: str,
    raids_dir: Path,
    index_by_id: dict[str, dict] | None,
) -> dict | None:
    """Build one raid row for Supabase: raid_id, raid_pool, raid_name, date, date_iso, attendees, url."""
    raid_pool = ""
    raid_name = ""
    date_str = ""
    attendees = ""
    url = ""

    # Prefer raids_index.csv
    if index_by_id and raid_id in index_by_id:
        row = index_by_id[raid_id]
        raid_pool = str(row.get("raid_pool") or "").strip()
        raid_name = str(row.get("raid_name") or "").strip()
        date_str = str(row.get("date") or "").strip()
        attendees = str(row.get("attendees") or "").strip()
        url = str(row.get("url") or "").strip()
        if not url and raid_pool:
            url = f"{RAID_DETAILS_URL}?raid_pool={raid_pool}&raidId={raid_id}&gid={GID}"
    else:
        # Try raid detail HTML
        detail_file = raids_dir / f"raid_{raid_id}.html"
        if detail_file.exists():
            try:
                from pull_raids import parse_raid_detail_meta
                meta = parse_raid_detail_meta(detail_file.read_text(encoding="utf-8"))
                raid_name = (meta.get("raid_name") or "").strip()
                date_str = (meta.get("date") or "").strip()
                attendees = (meta.get("attendees") or "").strip()
            except Exception:
                pass

        # Get raid_pool (and optionally fill url) from attendees HTML
        attendees_file = raids_dir / f"raid_{raid_id}_attendees.html"
        if attendees_file.exists():
            try:
                html = attendees_file.read_text(encoding="utf-8")
                parsed_id, parsed_pool = parse_raid_id_and_pool_from_attendees_html(html)
                if parsed_pool:
                    raid_pool = parsed_pool
                if not url and raid_pool:
                    url = f"{RAID_DETAILS_URL}?raid_pool={raid_pool}&raidId={raid_id}&gid={GID}"
            except Exception:
                pass

    if not raid_pool and not url:
        # Need at least raid_pool or url for a useful row; try attendees HTML once more for pool
        attendees_file = raids_dir / f"raid_{raid_id}_attendees.html"
        if attendees_file.exists():
            try:
                _, parsed_pool = parse_raid_id_and_pool_from_attendees_html(
                    attendees_file.read_text(encoding="utf-8")
                )
                if parsed_pool:
                    raid_pool = parsed_pool
                    url = f"{RAID_DETAILS_URL}?raid_pool={raid_pool}&raidId={raid_id}&gid={GID}"
            except Exception:
                pass

    if not url and raid_pool:
        url = f"{RAID_DETAILS_URL}?raid_pool={raid_pool}&raidId={raid_id}&gid={GID}"

    date_iso = parse_date_to_iso(date_str) if date_str else ""

    return {
        "raid_id": raid_id,
        "raid_pool": raid_pool or None,
        "raid_name": raid_name or None,
        "date": date_str or None,
        "date_iso": date_iso or None,
        "attendees": attendees or None,
        "url": url or None,
    }


def fetch_all_raid_ids(client) -> set[str]:
    """Fetch all raid_id from Supabase raids table."""
    out: set[str] = set()
    offset = 0
    while True:
        resp = client.table("raids").select("raid_id").range(offset, offset + PAGE_SIZE - 1).execute()
        rows = resp.data or []
        if not rows:
            break
        for r in rows:
            rid = (r.get("raid_id") or "").strip()
            if rid:
                out.add(rid)
        if len(rows) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
    return out


def main() -> int:
    load_dotenv()
    ap = argparse.ArgumentParser(
        description="Detect saved raids not in Supabase and optionally upload them."
    )
    ap.add_argument("--raids-dir", type=Path, default=ROOT / "raids", help="Directory with raid_*.html files")
    ap.add_argument("--index", type=Path, default=ROOT / "raids_index.csv", help="raids_index.csv for metadata")
    ap.add_argument("--dry-run", action="store_true", help="Only list what would be uploaded")
    ap.add_argument("--apply", action="store_true", help="Insert missing raids into Supabase")
    args = ap.parse_args()

    raids_dir = args.raids_dir
    if not raids_dir.is_dir():
        print(f"Raids directory not found: {raids_dir}", file=sys.stderr)
        return 1

    saved_ids = discover_saved_raid_ids(raids_dir)
    if not saved_ids:
        print("No saved raid files found in", raids_dir)
        return 0

    # Load index if present
    index_by_id: dict[str, dict] = {}
    if args.index.exists():
        try:
            import pandas as pd
            df = pd.read_csv(args.index)
            for _, row in df.iterrows():
                rid = str(row.get("raid_id", "")).strip()
                if rid:
                    index_by_id[rid] = row.to_dict()
        except Exception as e:
            print(f"Warning: could not read {args.index}: {e}", file=sys.stderr)

    to_upload: list[dict] = []
    for raid_id in sorted(saved_ids):
        row = build_raid_row(raid_id, raids_dir, index_by_id if index_by_id else None)
        if row is None:
            print(f"  Skip {raid_id}: could not build row (missing raid_pool/url)", file=sys.stderr)
            continue
        to_upload.append(row)

    if not to_upload:
        print("No raid rows to upload (could not build metadata for any saved raid).")
        return 0

    url = os.environ.get("SUPABASE_URL", "").strip()
    key = (
        os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        or os.environ.get("SUPABASE_ANON_KEY", "").strip()
    )
    if not url or not key:
        print("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY).", file=sys.stderr)
        return 1

    try:
        from supabase import create_client
    except ImportError:
        print("Install supabase: pip install supabase", file=sys.stderr)
        return 1

    client = create_client(url, key)
    existing_ids = fetch_all_raid_ids(client)
    missing = [r for r in to_upload if (r.get("raid_id") or "").strip() not in existing_ids]

    if not missing:
        print(f"All {len(to_upload)} saved raid(s) already in Supabase. Nothing to upload.")
        return 0

    print(f"Saved raids: {len(to_upload)}, already in Supabase: {len(existing_ids)}, to upload: {len(missing)}")
    for r in missing:
        print(f"  {r['raid_id']}  {r.get('raid_name') or '(no name)'}  pool={r.get('raid_pool') or '?'}")

    if args.dry_run:
        print("Dry run: no changes made. Run with --apply to insert these raids into Supabase.")
        return 0

    if not args.apply:
        print("No --apply: skipping insert. Use --dry-run to list, or --apply to upload.")
        return 0

    # Insert; Supabase raids.raid_id is PK so duplicate key will error (we already filtered)
    for r in missing:
        payload = {k: (v if v is not None else "") for k, v in r.items()}
        try:
            client.table("raids").insert(payload).execute()
            print(f"Inserted raid_id={r['raid_id']}")
        except Exception as e:
            print(f"Failed to insert raid_id={r['raid_id']}: {e}", file=sys.stderr)
            return 1
    print(f"Done. Uploaded {len(missing)} raid(s).")
    return 0


if __name__ == "__main__":
    # Allow running from repo root: python scripts/pull_parse_dkp_site/upload_saved_raids_supabase.py
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    sys.exit(main())
