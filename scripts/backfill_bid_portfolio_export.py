#!/usr/bin/env python3
"""
One-off export of officer_bid_portfolio_for_loot JSON per raid_loot row (JSONL).

Requires an **officer** Supabase session: `is_officer()` checks profiles.role for auth.uid().
Service role JWT does **not** satisfy that check.

Environment:
  SUPABASE_URL          — project URL
  SUPABASE_ANON_KEY     — anon key (used as client key; not for privilege escalation)
  SUPABASE_ACCESS_TOKEN — JWT from a signed-in **officer** (e.g. Application → Local Storage →
                          supabase.auth.token in browser, use access_token value)

Optional:
  POSTGREST_TIMEOUT_SEC — default 120 (seconds for slow per-loot RPC)

Usage:
  python scripts/backfill_bid_portfolio_export.py --out data/bid_portfolio_history.jsonl
  python scripts/backfill_bid_portfolio_export.py --min-loot-id 1 --max-loot-id 500 --out out.jsonl
  python scripts/backfill_bid_portfolio_export.py --loot-ids-file data/loot_ids.txt --out out.jsonl
  python scripts/backfill_bid_portfolio_export.py --db-batch 1 400 false
  python scripts/backfill_bid_portfolio_export.py --db-batch 401 800 true

`--db-batch` uses SUPABASE_SERVICE_ROLE_KEY and calls `officer_backfill_bid_portfolio_batch` (third arg: true/false for include_payload).

Use small id ranges or modest --loot-ids-file lists to avoid hitting PostgREST/statement timeouts.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent


def _load_ids_from_file(path: Path) -> list[int]:
    ids: list[int] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        ids.append(int(s))
    return ids


def _fetch_loot_ids_paginated(
    client,
    *,
    min_id: int | None,
    max_id: int | None,
    page_size: int,
) -> list[int]:
    """Return sorted loot ids from raid_loot (non-null item_name), optionally bounded."""
    ids: list[int] = []
    offset = 0
    while True:
        q = (
            client.table("raid_loot")
            .select("id")
            .not_.is_("item_name", "null")
            .order("id", desc=False)
        )
        if min_id is not None:
            q = q.gte("id", min_id)
        if max_id is not None:
            q = q.lte("id", max_id)
        resp = q.range(offset, offset + page_size - 1).execute()
        batch = resp.data or []
        for row in batch:
            ids.append(int(row["id"]))
        if len(batch) < page_size:
            break
        offset += page_size
    return ids


def main() -> int:
    ap = argparse.ArgumentParser(description="Export bid portfolio JSONL via officer RPC.")
    ap.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Output JSONL path (required unless using --db-batch)",
    )
    ap.add_argument("--min-loot-id", type=int, default=None, help="Lower bound raid_loot.id (inclusive)")
    ap.add_argument("--max-loot-id", type=int, default=None, help="Upper bound raid_loot.id (inclusive)")
    ap.add_argument(
        "--loot-ids-file",
        type=Path,
        default=None,
        help="Optional file: one loot id per line (ignores # comments and blanks)",
    )
    ap.add_argument("--page-size", type=int, default=1000, help="Page size when listing raid_loot ids")
    ap.add_argument(
        "--sleep-ms",
        type=int,
        default=0,
        help="Sleep between RPC calls (reduce rate / load)",
    )
    ap.add_argument(
        "--continue-on-error",
        action="store_true",
        help="Log RPC failures and continue (default: exit non-zero on first error)",
    )
    ap.add_argument(
        "--db-batch",
        nargs=3,
        metavar=("MIN_ID", "MAX_ID", "INCLUDE_PAYLOAD"),
        default=None,
        help="Upsert bid_portfolio_auction_fact via officer_backfill_bid_portfolio_batch using SUPABASE_SERVICE_ROLE_KEY (INCLUDE_PAYLOAD: true/false)",
    )
    args = ap.parse_args()
    if args.db_batch is None and args.out is None:
        print("Provide --out for JSONL export or use --db-batch.", file=sys.stderr)
        return 1

    url = os.environ.get("SUPABASE_URL", "").strip()
    anon = os.environ.get("SUPABASE_ANON_KEY", "").strip()
    token = os.environ.get("SUPABASE_ACCESS_TOKEN", "").strip()
    service = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    timeout = int(os.environ.get("POSTGREST_TIMEOUT_SEC", "120"))

    if not url:
        print("Set SUPABASE_URL.", file=sys.stderr)
        return 1

    try:
        from supabase import create_client
        from supabase.lib.client_options import SyncClientOptions
    except ImportError:
        print("pip install supabase", file=sys.stderr)
        return 1

    if args.db_batch is not None:
        if not service:
            print("Set SUPABASE_SERVICE_ROLE_KEY for --db-batch.", file=sys.stderr)
            return 1
        lo, hi, inc = args.db_batch
        include_payload = str(inc).lower() in ("1", "true", "yes", "t")
        try:
            mn, mx = int(lo), int(hi)
        except ValueError:
            print("MIN_ID and MAX_ID must be integers.", file=sys.stderr)
            return 1
        opts = SyncClientOptions(postgrest_client_timeout=max(timeout, 300))
        client = create_client(url, service, options=opts)
        resp = client.rpc(
            "officer_backfill_bid_portfolio_batch",
            {
                "p_min_loot_id": mn,
                "p_max_loot_id": mx,
                "p_include_payload": include_payload,
            },
        ).execute()
        print(resp.data, file=sys.stderr)
        return 0

    if not anon:
        print("Set SUPABASE_ANON_KEY.", file=sys.stderr)
        return 1
    if not token:
        print(
            "Set SUPABASE_ACCESS_TOKEN to an officer user's JWT (see script docstring).",
            file=sys.stderr,
        )
        return 1

    opts = SyncClientOptions(
        headers={"Authorization": f"Bearer {token}"},
        postgrest_client_timeout=timeout,
    )
    client = create_client(url, anon, options=opts)

    assert args.out is not None

    if args.loot_ids_file is not None:
        loot_ids = _load_ids_from_file(args.loot_ids_file)
    else:
        loot_ids = _fetch_loot_ids_paginated(
            client,
            min_id=args.min_loot_id,
            max_id=args.max_loot_id,
            page_size=max(1, min(args.page_size, 1000)),
        )

    if not loot_ids:
        print("No loot ids to export.", file=sys.stderr)
        return 1

    args.out.parent.mkdir(parents=True, exist_ok=True)
    ok = 0
    failed = 0
    with args.out.open("w", encoding="utf-8") as f:
        for i, lid in enumerate(loot_ids):
            try:
                resp = client.rpc("officer_bid_portfolio_for_loot", {"p_loot_id": lid}).execute()
                row = resp.data
                if row is None:
                    raise RuntimeError("empty response")
                f.write(json.dumps(row, default=str) + "\n")
                ok += 1
            except Exception as e:
                failed += 1
                print(f"loot_id={lid} error: {e}", file=sys.stderr)
                if not args.continue_on_error:
                    return 1
            if args.sleep_ms > 0:
                time.sleep(args.sleep_ms / 1000.0)
            if (i + 1) % 100 == 0:
                print(f"... {i + 1}/{len(loot_ids)} (ok={ok} failed={failed})", file=sys.stderr)

    print(f"Wrote {ok} line(s) to {args.out} (failed={failed}).", file=sys.stderr)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
