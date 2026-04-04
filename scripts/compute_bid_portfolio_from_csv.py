#!/usr/bin/env python3
"""
Compute bid_portfolio_auction_fact rows (+ optional officer_bid_portfolio_for_loot payload)
from a Supabase CSV backup folder (parity with docs/supabase-schema-full.sql).

Runner-up here is the max-pool heuristic only (same family as SQL bid_portfolio_runner_up_guess), not the Python second-bidder model; see docs/HANDOFF_SECOND_BIDDER_MVP.md.

JSONL format (one object per line):
  With --include-payload: {"fact": {...}, "payload": {...}}
  Otherwise: {"fact": {...}}  (fact row has no "payload" key; upload as SQL NULL)

Environment (optional, for consistency with other scripts): loads web/.env then web/.env.local via dotenv.

Usage:
  python scripts/compute_bid_portfolio_from_csv.py --backup-dir C:/TAKP/dkp/backup-2026-04-02/backup --out data/bpf.jsonl
  python scripts/compute_bid_portfolio_from_csv.py --backup-dir ... --out out.jsonl --min-loot-id 1 --max-loot-id 500
  python scripts/compute_bid_portfolio_from_csv.py --backup-dir ... --out out.jsonl --loot-ids-file ids.txt --include-payload
  python scripts/compute_bid_portfolio_from_csv.py ... --checkpoint data/bpf.checkpoint.txt
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))

from bid_portfolio_local.balance_before_loot import BalanceCalculator
from bid_portfolio_local.guild_loot_enriched import build_guild_loot_sale_enriched
from bid_portfolio_local.load_csv import load_backup
from bid_portfolio_local.portfolio import (
    build_portfolio_indexes,
    enriched_guild_sale_sort_key,
    fact_row,
    officer_bid_portfolio_for_loot_payload,
    runner_up_account_guess,
)


def _load_env_from_web() -> None:
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    web = REPO_ROOT / "web"
    load_dotenv(web / ".env")
    load_dotenv(web / ".env.local", override=True)


def _load_ids_from_file(path: Path) -> list[int]:
    ids: list[int] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        ids.append(int(s))
    return ids


def _load_checkpoint(path: Path) -> set[int]:
    if not path.is_file():
        return set()
    out: set[int] = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if s.isdigit():
            out.add(int(s))
    return out


def _append_checkpoint(path: Path, loot_id: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(f"{loot_id}\n")


def main() -> int:
    ap = argparse.ArgumentParser(description="Compute bid portfolio facts from CSV backup.")
    ap.add_argument(
        "--backup-dir",
        type=Path,
        required=True,
        help="Folder containing raid_loot.csv, raids.csv, attendance CSVs, etc.",
    )
    ap.add_argument("--out", type=Path, required=True, help="Output JSONL path")
    ap.add_argument("--min-loot-id", type=int, default=None)
    ap.add_argument("--max-loot-id", type=int, default=None)
    ap.add_argument("--loot-ids-file", type=Path, default=None)
    ap.add_argument(
        "--include-payload",
        action="store_true",
        help="Include full officer_bid_portfolio_for_loot JSON in fact.payload",
    )
    ap.add_argument(
        "--checkpoint",
        type=Path,
        default=None,
        help="Append each completed loot_id; skip ids listed on resume",
    )
    ap.add_argument("--progress-every", type=int, default=200)
    args = ap.parse_args()

    _load_env_from_web()

    snap = load_backup(args.backup_dir.resolve())
    enriched_list, enriched_by_id = build_guild_loot_sale_enriched(snap)
    enriched_sorted = sorted(enriched_list, key=enriched_guild_sale_sort_key)
    pf_indexes = build_portfolio_indexes(enriched_sorted)
    bc = BalanceCalculator(snap)

    if args.loot_ids_file is not None:
        want = set(_load_ids_from_file(args.loot_ids_file.resolve()))
        to_process = [enriched_by_id[i] for i in sorted(want) if i in enriched_by_id]
    else:
        to_process = list(enriched_list)
        if args.min_loot_id is not None:
            to_process = [e for e in to_process if e.loot_id >= args.min_loot_id]
        if args.max_loot_id is not None:
            to_process = [e for e in to_process if e.loot_id <= args.max_loot_id]
        to_process.sort(key=lambda e: e.loot_id)

    done: set[int] = set()
    if args.checkpoint:
        done = _load_checkpoint(args.checkpoint.resolve())

    args.out.parent.mkdir(parents=True, exist_ok=True)
    mode = "a" if args.checkpoint and done else "w"
    n = 0
    with args.out.open(mode, encoding="utf-8") as fout:
        for gle in to_process:
            if gle.loot_id in done:
                continue
            runner = runner_up_account_guess(bc, snap, gle)
            payload = None
            if args.include_payload:
                payload = officer_bid_portfolio_for_loot_payload(
                    snap, bc, gle, pf_indexes
                )
            computed_at = datetime.now(timezone.utc).isoformat()
            fact = fact_row(gle, runner, payload if args.include_payload else None, computed_at)
            rec: dict = {"fact": fact}
            if args.include_payload:
                rec["payload"] = payload
            fout.write(json.dumps(rec, default=str) + "\n")
            n += 1
            if args.checkpoint:
                _append_checkpoint(args.checkpoint.resolve(), gle.loot_id)
            if args.progress_every > 0 and n % args.progress_every == 0:
                print(f"... wrote {n} row(s), last loot_id={gle.loot_id}", file=sys.stderr)

    print(f"Wrote {n} JSONL record(s) to {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
