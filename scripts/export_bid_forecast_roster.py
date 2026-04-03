#!/usr/bin/env python3
"""
Export active-roster character keys for bid_forecast precompute (guild scope).
Mirrors active_account_ids + roster join in docs/supabase-officer-global-bid-forecast.sql.
Uses SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (same as loot-to-character CI).

Does NOT call officer_global_bid_forecast (RPC requires is_officer(); service role is not an officer).

Usage:
  python scripts/export_bid_forecast_roster.py --out data/bid_forecast_roster.json
  python scripts/export_bid_forecast_roster.py --activity-days 90 --out data/bid_forecast_roster.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date, timedelta
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
DEFAULT_OUT = REPO_ROOT / "data" / "bid_forecast_roster.json"
PAGE_SIZE = 1000

# Default matches web/src/lib/dkpLeaderboard.js ACTIVE_DAYS
DEFAULT_ACTIVITY_DAYS = 120


def _fetch_all(client, table: str, select: str = "*") -> list[dict]:
    rows: list[dict] = []
    offset = 0
    while True:
        resp = client.table(table).select(select).range(offset, offset + PAGE_SIZE - 1).execute()
        batch = resp.data or []
        rows.extend(batch)
        if len(batch) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
    return rows


def main() -> int:
    ap = argparse.ArgumentParser(description="Export active roster JSON for bid forecast CI.")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT, help="Output JSON path")
    ap.add_argument(
        "--activity-days",
        type=int,
        default=DEFAULT_ACTIVITY_DAYS,
        help=f"Days for last_activity_date window (default {DEFAULT_ACTIVITY_DAYS}, max 730)",
    )
    args = ap.parse_args()
    days = max(1, min(730, args.activity_days))

    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip() or os.environ.get(
        "SUPABASE_ANON_KEY", ""
    ).strip()
    if not url or not key:
        print("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY", file=sys.stderr)
        return 1

    try:
        from supabase import create_client
    except ImportError:
        print("Install supabase: pip install supabase", file=sys.stderr)
        return 1

    client = create_client(url, key)
    today = date.today()
    cutoff = today - timedelta(days=days)

    summaries = _fetch_all(client, "account_dkp_summary", "account_id, last_activity_date")
    accounts = _fetch_all(client, "accounts", "account_id, inactive")
    pinned = _fetch_all(client, "active_accounts", "account_id")

    inactive = {a["account_id"] for a in accounts if a.get("inactive")}
    active_by_date: set[str] = set()
    for s in summaries:
        aid = (s.get("account_id") or "").strip()
        if not aid or aid in inactive:
            continue
        lad = s.get("last_activity_date")
        if not lad:
            continue
        # ISO date string YYYY-MM-DD
        try:
            if isinstance(lad, str):
                d = date.fromisoformat(lad[:10])
            else:
                continue
        except ValueError:
            continue
        if d >= cutoff:
            active_by_date.add(aid)

    pinned_ids = {
        (r.get("account_id") or "").strip()
        for r in pinned
        if (r.get("account_id") or "").strip() and (r.get("account_id") or "").strip() not in inactive
    }

    active_account_ids = active_by_date | pinned_ids
    if not active_account_ids:
        roster: list[dict] = []
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(
            json.dumps(
                {"activity_days": days, "generated_at": date.today().isoformat(), "characters": roster},
                indent=2,
            ),
            encoding="utf-8",
        )
        print(f"Wrote {args.out} (0 characters, no active accounts)")
        return 0

    char_accounts = _fetch_all(client, "character_account", "char_id, account_id")
    ca_for_active = [
        r
        for r in char_accounts
        if (r.get("account_id") or "").strip() in active_account_ids
        and (r.get("char_id") or "").strip()
    ]
    char_ids = list({(r.get("char_id") or "").strip() for r in ca_for_active})
    if not char_ids:
        roster = []
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(
            json.dumps(
                {
                    "activity_days": days,
                    "generated_at": date.today().isoformat(),
                    "characters": roster,
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        print(f"Wrote {args.out} (0 characters, no character_account rows)")
        return 0

    characters_rows = _fetch_all(client, "characters", "char_id, name, class_name")
    by_cid = {str(r.get("char_id", "")).strip(): r for r in characters_rows if r.get("char_id")}

    roster = []
    seen: set[tuple[str, str]] = set()
    for r in ca_for_active:
        cid = (r.get("char_id") or "").strip()
        row = by_cid.get(cid)
        name = (row.get("name") or "").strip() if row else ""
        class_name = (row.get("class_name") or "").strip() if row else ""
        if not name:
            continue
        key = (name.lower(), class_name.lower())
        if key in seen:
            continue
        seen.add(key)
        roster.append({"char_id": cid, "name": name, "class_name": class_name})

    roster.sort(key=lambda x: (x["name"].lower(), x["class_name"].lower()))

    args.out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "activity_days": days,
        "generated_at": date.today().isoformat(),
        "characters": roster,
    }
    args.out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote {args.out} ({len(roster)} characters)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
