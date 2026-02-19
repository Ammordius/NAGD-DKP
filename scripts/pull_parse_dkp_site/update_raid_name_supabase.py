#!/usr/bin/env python3
"""Update a single raid's name (and optionally date) in Supabase. Uses same .env as other scripts."""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent  # repo root


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
    for path in (ROOT / ".env", ROOT / "web" / ".env", ROOT / "web" / ".env.local"):
        if path.exists():
            _load_env(path)

    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip() or os.environ.get("SUPABASE_ANON_KEY", "").strip()
    if not url or not key:
        print("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY).", file=sys.stderr)
        return 1

    try:
        from supabase import create_client
    except ImportError:
        print("pip install supabase", file=sys.stderr)
        return 1

    client = create_client(url, key)
    raid_id = "1598662"
    # Time Day 1; date from saved HTML (Feb 17, 2026) so it appears in raid calendar (ordered by date_iso)
    payload = {
        "raid_name": "Time Day 1",
        "date": "Tue Feb 17, 2026 5:26 pm",
        "date_iso": "2026-02-17",
    }
    resp = client.table("raids").update(payload).eq("raid_id", raid_id).execute()
    if getattr(resp, "data", None) is not None and len(resp.data) > 0:
        print(f"Updated raid {raid_id}: raid_name='Time Day 1', date_iso=2026-02-17")
    else:
        # update() may return empty data on success
        print(f"Update sent for raid {raid_id}. Check Supabase if the calendar still doesn't show it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
