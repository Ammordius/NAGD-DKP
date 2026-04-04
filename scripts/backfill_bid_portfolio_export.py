#!/usr/bin/env python3
"""
One-off export of officer_bid_portfolio_for_loot JSON per raid_loot row (JSONL).

Requires an **officer** Supabase session: `is_officer()` checks profiles.role for auth.uid().
Service role JWT does **not** satisfy that check.

Environment (by default loaded from `web/.env` then `web/.env.local` via python-dotenv):
  SUPABASE_URL or VITE_SUPABASE_URL — project URL
  SUPABASE_ANON_KEY or VITE_SUPABASE_ANON_KEY — anon key (JSONL export path)
  SUPABASE_ACCESS_TOKEN — JWT from a signed-in **officer** (e.g. Application → Local Storage →
                          supabase.auth.token in browser, use access_token value)
  SUPABASE_SERVICE_ROLE_KEY or VITE_SUPABASE_SERVICE_ROLE_KEY — for `--db-batch` only

Optional:
  POSTGREST_TIMEOUT_SEC — default 120 (seconds for slow per-loot RPC)
  POSTGREST_TIMEOUT_PAYLOAD_SEC — default 600 (HTTP client timeout for --db-batch with include_payload=true)
  BID_PORTFOLIO_PAYLOAD_MAX_CHUNK — default 1; max loot ids per RPC when include_payload=true (raise only if your DB statement_timeout allows it)

Usage:
  python scripts/backfill_bid_portfolio_export.py --out data/bid_portfolio_history.jsonl
  python scripts/backfill_bid_portfolio_export.py --min-loot-id 1 --max-loot-id 500 --out out.jsonl
  python scripts/backfill_bid_portfolio_export.py --loot-ids-file data/loot_ids.txt --out out.jsonl
  python scripts/backfill_bid_portfolio_export.py --db-batch 1 400 false
  python scripts/backfill_bid_portfolio_export.py --db-batch 1 400 true

`--db-batch` uses SUPABASE_SERVICE_ROLE_KEY and calls `officer_backfill_bid_portfolio_batch` (third arg: true/false for include_payload).
The script **splits** `[MIN_ID, MAX_ID]` into chunks of `--db-batch-chunk` (default 50) so each RPC stays under the DB **statement_timeout**.
With **include_payload=true**, each loot row runs `officer_bid_portfolio_for_loot` inside the batch; the script caps chunk size to **BID_PORTFOLIO_PAYLOAD_MAX_CHUNK** (default **1**) so a single statement does not time out.

For very large backfills, prefer the DB procedure (COMMIT between chunks): in Supabase SQL Editor,
`CALL public.dba_backfill_bid_portfolio_range(min, max, chunk_size, include_payload);` — see docs/HANDOFF_OFFICER_LOOT_BID_FORECAST.md.

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


def _load_env_from_web() -> None:
    """Populate os.environ from Vite env files (same values as the web app)."""
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    web = REPO_ROOT / "web"
    load_dotenv(web / ".env")
    load_dotenv(web / ".env.local", override=True)


def _env_first(*names: str) -> str:
    for n in names:
        v = os.environ.get(n, "").strip()
        if v:
            return v
    return ""


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
    ap.add_argument(
        "--db-batch-chunk",
        type=int,
        default=50,
        metavar="N",
        help="Max loot ids per RPC when using --db-batch (default 50; ignored beyond BID_PORTFOLIO_PAYLOAD_MAX_CHUNK when include_payload=true)",
    )
    args = ap.parse_args()
    if args.db_batch is None and args.out is None:
        print("Provide --out for JSONL export or use --db-batch.", file=sys.stderr)
        return 1

    _load_env_from_web()

    url = _env_first("SUPABASE_URL", "VITE_SUPABASE_URL")
    anon = _env_first("SUPABASE_ANON_KEY", "VITE_SUPABASE_ANON_KEY")
    token = _env_first("SUPABASE_ACCESS_TOKEN")
    service = _env_first("SUPABASE_SERVICE_ROLE_KEY", "VITE_SUPABASE_SERVICE_ROLE_KEY")
    timeout = int(os.environ.get("POSTGREST_TIMEOUT_SEC", "120"))

    if not url:
        print(
            "Set SUPABASE_URL (or VITE_SUPABASE_URL) in web/.env or the environment.",
            file=sys.stderr,
        )
        return 1

    try:
        from supabase import create_client
        from supabase.lib.client_options import SyncClientOptions
    except ImportError:
        print("pip install supabase", file=sys.stderr)
        return 1

    if args.db_batch is not None:
        if not service:
            print(
                "Set SUPABASE_SERVICE_ROLE_KEY (or VITE_SUPABASE_SERVICE_ROLE_KEY) for --db-batch.",
                file=sys.stderr,
            )
            return 1
        lo, hi, inc = args.db_batch
        include_payload = str(inc).lower() in ("1", "true", "yes", "t")
        try:
            mn, mx = int(lo), int(hi)
        except ValueError:
            print("MIN_ID and MAX_ID must be integers.", file=sys.stderr)
            return 1
        chunk = max(1, int(args.db_batch_chunk))
        if include_payload:
            cap = int(os.environ.get("BID_PORTFOLIO_PAYLOAD_MAX_CHUNK", "1"))
            cap = max(1, cap)
            if chunk > cap:
                print(
                    f"include_payload=true: capping --db-batch-chunk from {chunk} to {cap} "
                    f"(each row runs officer_bid_portfolio_for_loot; set BID_PORTFOLIO_PAYLOAD_MAX_CHUNK to allow larger batches).",
                    file=sys.stderr,
                )
                chunk = cap
        rest_timeout = max(timeout, 300)
        if include_payload:
            rest_timeout = max(
                rest_timeout,
                int(os.environ.get("POSTGREST_TIMEOUT_PAYLOAD_SEC", "600")),
            )
        opts = SyncClientOptions(postgrest_client_timeout=rest_timeout)
        client = create_client(url, service, options=opts)
        total_ok = 0
        total_bad = 0
        cur = mn
        while cur <= mx:
            hi = min(cur + chunk - 1, mx)
            resp = client.rpc(
                "officer_backfill_bid_portfolio_batch",
                {
                    "p_min_loot_id": cur,
                    "p_max_loot_id": hi,
                    "p_include_payload": include_payload,
                },
            ).execute()
            row = resp.data
            if isinstance(row, list):
                row = row[0] if row else {}
            if not isinstance(row, dict):
                row = {}
            ok = int(row.get("rows_upserted", 0) or 0)
            bad = int(row.get("rows_errored", 0) or 0)
            total_ok += ok
            total_bad += bad
            print(
                f"... chunk loot_id {cur}–{hi}: upserted={ok} errored={bad}",
                file=sys.stderr,
            )
            cur = hi + 1
            if args.sleep_ms > 0:
                time.sleep(args.sleep_ms / 1000.0)
        print(
            {"rows_upserted": total_ok, "rows_errored": total_bad},
            file=sys.stderr,
        )
        return 0

    if not anon:
        print(
            "Set SUPABASE_ANON_KEY (or VITE_SUPABASE_ANON_KEY) in web/.env or the environment.",
            file=sys.stderr,
        )
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
