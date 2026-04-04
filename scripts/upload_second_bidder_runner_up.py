#!/usr/bin/env python3
"""
Patch bid_portfolio_auction_fact.runner_up_account_guess and runner_up_char_guess from
second_bidder JSONL (produced by run_second_bidder_batch.py / serialize.prediction_result_to_json_dict).

Uses the **model's** top non-buyer candidate (candidates[0].account_id) and optional
top_eligible_char_id (item-eligible attending lane). That is **not** the same algorithm
as SQL public.bid_portfolio_runner_up_guess (max pool among attendees who could clear price).

Uses SUPABASE_SERVICE_ROLE_KEY (or VITE_SUPABASE_SERVICE_ROLE_KEY) and SUPABASE_URL /
VITE_SUPABASE_URL from web/.env (same pattern as scripts/upload_bid_portfolio_fact.py).

PostgREST upsert: only columns in the JSON body are updated on conflict, so other
bid_portfolio_auction_fact columns on existing rows should be preserved (verify in your
environment once).

Usage:
  python scripts/upload_second_bidder_runner_up.py --in data/second_bidder.jsonl
  python scripts/upload_second_bidder_runner_up.py --in data/second_bidder.jsonl --batch-size 200
  python scripts/upload_second_bidder_runner_up.py --in data/second_bidder.jsonl --dry-run
  python scripts/upload_second_bidder_runner_up.py --in data/second_bidder.jsonl --empty-candidates null

By default, rows whose loot_id is not in the remote raid_loot table are skipped (FK).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
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


def _row_from_record(
    rec: dict,
    *,
    empty_candidates: str,
    computed_at: str,
) -> dict | None:
    """
    Build a PostgREST row dict, or None if this JSONL line should not produce an upsert.
    """
    event = rec.get("event")
    if not isinstance(event, dict):
        return None
    try:
        lid = int(event["loot_id"])
    except (KeyError, TypeError, ValueError):
        return None

    cands = rec.get("candidates")
    if not isinstance(cands, list):
        cands = []

    if not cands:
        if empty_candidates == "skip":
            return None
        return {
            "loot_id": lid,
            "runner_up_account_guess": None,
            "runner_up_char_guess": None,
            "computed_at": computed_at,
        }

    first = cands[0]
    if not isinstance(first, dict):
        return None
    aid = first.get("account_id")
    runner = None if aid is None else str(aid)
    char_guess = first.get("top_eligible_char_id")
    runner_char = None if char_guess is None else str(char_guess).strip() or None

    return {
        "loot_id": lid,
        "runner_up_account_guess": runner,
        "runner_up_char_guess": runner_char,
        "computed_at": computed_at,
    }


def _flush_batch(
    client,
    batch_by_id: dict[int, dict],
    *,
    dry_run: bool,
) -> int:
    if not batch_by_id:
        return 0
    rows = list(batch_by_id.values())
    batch_by_id.clear()
    if dry_run:
        return len(rows)
    client.table("bid_portfolio_auction_fact").upsert(rows, on_conflict="loot_id").execute()
    return len(rows)


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Upsert runner_up_account_guess / runner_up_char_guess on bid_portfolio_auction_fact from second_bidder JSONL."
    )
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
        help="Page size when listing raid_loot.id for FK filter (default 1000)",
    )
    ap.add_argument(
        "--empty-candidates",
        choices=("skip", "null"),
        default="skip",
        help="When candidates is empty: skip line (default) or upsert runner_up as NULL",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Parse file and print stats; no Supabase calls",
    )
    args = ap.parse_args()

    computed_at = datetime.now(timezone.utc).isoformat()

    if not args.dry_run:
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
    else:
        client = None

    existing_loot: set[int] | None = None
    if not args.dry_run and not args.no_skip_missing_loot:
        print("Loading raid_loot ids from Supabase (for FK filter)...", file=sys.stderr)
        existing_loot = _fetch_remote_raid_loot_ids(
            client, page_size=max(1, args.loot_id_page_size)
        )
        print(f"... found {len(existing_loot)} raid_loot row(s)", file=sys.stderr)

    batch_by_id: dict[int, dict] = {}
    total_upserted = 0
    skipped_fk = 0
    skipped_invalid = 0
    skipped_empty = 0
    sample: list[dict] = []

    with args.in_path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                skipped_invalid += 1
                continue
            if not isinstance(rec, dict):
                skipped_invalid += 1
                continue

            ev = rec.get("event")
            loot_ok: int | None = None
            if isinstance(ev, dict):
                try:
                    loot_ok = int(ev["loot_id"])
                except (KeyError, TypeError, ValueError):
                    loot_ok = None

            row = _row_from_record(
                rec,
                empty_candidates=args.empty_candidates,
                computed_at=computed_at,
            )
            if row is None:
                cands = rec.get("candidates")
                cands_list = cands if isinstance(cands, list) else []
                if (
                    loot_ok is not None
                    and not cands_list
                    and args.empty_candidates == "skip"
                ):
                    skipped_empty += 1
                else:
                    skipped_invalid += 1
                continue

            lid = int(row["loot_id"])
            if existing_loot is not None and lid not in existing_loot:
                skipped_fk += 1
                continue

            batch_by_id[lid] = row
            if args.dry_run and len(sample) < 3:
                sample.append(dict(row))

            if len(batch_by_id) >= max(1, args.batch_size):
                n = _flush_batch(client, batch_by_id, dry_run=args.dry_run)
                total_upserted += n
                if not args.dry_run:
                    print(f"... upserted {total_upserted} row(s)", file=sys.stderr)

    n = _flush_batch(client, batch_by_id, dry_run=args.dry_run)
    total_upserted += n
    if not args.dry_run and n:
        print(f"... upserted {total_upserted} row(s)", file=sys.stderr)

    print(
        f"Done. {'Would upsert' if args.dry_run else 'Upserted'} {total_upserted} row(s).",
        file=sys.stderr,
    )
    if skipped_fk:
        print(f"Skipped {skipped_fk} row(s) (loot_id not in remote raid_loot).", file=sys.stderr)
    if skipped_empty:
        print(f"Skipped {skipped_empty} row(s) (empty candidates, --empty-candidates skip).", file=sys.stderr)
    if skipped_invalid:
        print(f"Skipped {skipped_invalid} line(s) (invalid JSON or missing event/candidates[0]).", file=sys.stderr)

    if args.dry_run:
        print(f"[dry-run] sample rows (up to 3): {json.dumps(sample, indent=2)}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
