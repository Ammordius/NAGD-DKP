#!/usr/bin/env python3
"""
Upsert bid_portfolio_auction_fact rows from JSONL produced by compute_bid_portfolio_from_csv.py.

Uses SUPABASE_SERVICE_ROLE_KEY (or VITE_SUPABASE_SERVICE_ROLE_KEY) and VITE_SUPABASE_URL / SUPABASE_URL
from web/.env (same pattern as scripts/backfill_bid_portfolio_export.py).

Usage:
  python scripts/upload_bid_portfolio_fact.py --in data/bpf.jsonl
  python scripts/upload_bid_portfolio_fact.py --in data/bpf.jsonl --batch-size 150
  python scripts/upload_bid_portfolio_fact.py --in data/bpf.jsonl --no-skip-missing-loot

By default, rows whose loot_id is not in the remote raid_loot table are skipped (FK
bid_portfolio_auction_fact_loot_id_fkey). CSV snapshots often include ids deleted later
or from another environment.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent


def _load_env_from_web() -> None:
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


def _fact_for_postgrest(fact: dict) -> dict:
    """Ensure payload is explicit null when absent (clean upsert)."""
    row = dict(fact)
    if "payload" not in row:
        row["payload"] = None
    return row


def _fetch_remote_raid_loot_ids(client, *, page_size: int = 1000) -> set[int]:
    """All raid_loot.id values visible to the client (paginated)."""
    ids: set[int] = set()
    offset = 0
    ps = max(1, min(page_size, 1000))
    while True:
        resp = (
            client.table("raid_loot")
            .select("id")
            .order("id", desc=False)
            .range(offset, offset + ps - 1)
            .execute()
        )
        rows = resp.data or []
        for r in rows:
            ids.add(int(r["id"]))
        if len(rows) < ps:
            break
        offset += ps
    return ids


def main() -> int:
    ap = argparse.ArgumentParser(description="Upsert bid_portfolio_auction_fact from JSONL.")
    ap.add_argument("--in", dest="in_path", type=Path, required=True, help="Input JSONL")
    ap.add_argument("--batch-size", type=int, default=150)
    ap.add_argument(
        "--no-skip-missing-loot",
        action="store_true",
        help="Upsert every row (fail on FK if loot_id missing from raid_loot)",
    )
    ap.add_argument(
        "--loot-id-page-size",
        type=int,
        default=1000,
        help="Page size when listing raid_loot.id for --skip-missing-loot (default 1000)",
    )
    args = ap.parse_args()

    _load_env_from_web()
    url = _env_first("SUPABASE_URL", "VITE_SUPABASE_URL")
    key = _env_first("SUPABASE_SERVICE_ROLE_KEY", "VITE_SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        print(
            "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or VITE_* in web/.env).",
            file=sys.stderr,
        )
        return 1

    try:
        from supabase import create_client
        from supabase.lib.client_options import SyncClientOptions
    except ImportError:
        print("pip install supabase", file=sys.stderr)
        return 1

    timeout = max(120, int(os.environ.get("POSTGREST_TIMEOUT_SEC", "120")))
    client = create_client(url, key, options=SyncClientOptions(postgrest_client_timeout=timeout))

    existing_loot: set[int] | None = None
    if not args.no_skip_missing_loot:
        print("Loading raid_loot ids from Supabase (for FK filter)...", file=sys.stderr)
        existing_loot = _fetch_remote_raid_loot_ids(
            client, page_size=max(1, args.loot_id_page_size)
        )
        print(f"... found {len(existing_loot)} raid_loot row(s)", file=sys.stderr)

    batch: list[dict] = []
    total = 0
    skipped = 0
    with args.in_path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            fact = rec.get("fact")
            if not isinstance(fact, dict):
                continue
            if existing_loot is not None:
                try:
                    lid = int(fact["loot_id"])
                except (KeyError, TypeError, ValueError):
                    skipped += 1
                    continue
                if lid not in existing_loot:
                    skipped += 1
                    continue
            batch.append(_fact_for_postgrest(fact))
            if len(batch) >= max(1, args.batch_size):
                client.table("bid_portfolio_auction_fact").upsert(
                    batch, on_conflict="loot_id"
                ).execute()
                total += len(batch)
                print(f"... upserted {total} row(s)", file=sys.stderr)
                batch = []
        if batch:
            client.table("bid_portfolio_auction_fact").upsert(
                batch, on_conflict="loot_id"
            ).execute()
            total += len(batch)

    if skipped:
        print(
            f"Skipped {skipped} JSONL row(s) (loot_id not in remote raid_loot or invalid).",
            file=sys.stderr,
        )
    print(f"Done. Upserted {total} row(s).", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
