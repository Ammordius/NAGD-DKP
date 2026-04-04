#!/usr/bin/env python3
"""
Compute bid_portfolio_auction_fact rows (+ optional officer_bid_portfolio_for_loot payload)
from a Supabase CSV backup folder.

Runner-up uses the unified Python pipeline (same eligibility as second_bidder_model:
item_stats.json + dkp_mob_loot / raid_item_sources + character CSVs via BackupSnapshot),
then max_pool or scored ranking. Iterates guild sales in chronological order so
KnowledgeState matches sequential second-bidder batch.

JSONL format (one object per line):
  With --include-payload: {"fact": {...}, "payload": {...}}
  Otherwise: {"fact": {...}}  (fact row has no "payload" key; upload as SQL NULL)

Environment (optional): loads web/.env then web/.env.local via dotenv.

Usage:
  python scripts/compute_bid_portfolio_from_csv.py --backup-dir C:/TAKP/dkp/backup/backup --out data/bpf.jsonl
  python scripts/compute_bid_portfolio_from_csv.py --backup-dir ... --out out.jsonl --min-loot-id 1 --max-loot-id 500
  python scripts/compute_bid_portfolio_from_csv.py --backup-dir ... --out out.jsonl --loot-ids-file ids.txt --include-payload
  python scripts/compute_bid_portfolio_from_csv.py ... --checkpoint data/bpf.checkpoint.txt
  python scripts/compute_bid_portfolio_from_csv.py ... --runner-up-rank scored
  python scripts/compute_bid_portfolio_from_csv.py ... --no-require-item-eligibility-bundle
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
from bid_portfolio_local.guild_loot_enriched import (
    build_guild_loot_sale_enriched,
    enriched_guild_sale_sort_key,
)
from bid_portfolio_local.load_csv import load_backup
from bid_portfolio_local.portfolio import (
    build_portfolio_indexes,
    fact_row,
    officer_bid_portfolio_for_loot_payload,
)
from second_bidder_model.config import SecondBidderConfig
from second_bidder_model.item_stats_eligibility import try_load_item_eligibility_bundle
from second_bidder_model.prepare import prepare_second_bidder_events
from second_bidder_model.runner_up_unified import resolve_runner_up_for_event
from second_bidder_model.state import KnowledgeState, empty_state, update_knowledge_state


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
    ap.add_argument(
        "--runner-up-rank",
        choices=("max_pool", "scored"),
        default="max_pool",
        help="How to rank within the unified eligible candidate pool (default: max_pool).",
    )
    ap.add_argument(
        "--no-require-item-eligibility-bundle",
        action="store_true",
        help="Allow missing item_stats.json / mob_loot (class gates disabled; permissive).",
    )
    args = ap.parse_args()

    _load_env_from_web()

    require_bundle = not args.no_require_item_eligibility_bundle
    bundle = try_load_item_eligibility_bundle(REPO_ROOT)
    if require_bundle and bundle is None:
        print(
            "ERROR: item eligibility bundle not loaded (need data/item_stats.json and data/dkp_mob_loot.json). "
            "Use --no-require-item-eligibility-bundle to override.",
            file=sys.stderr,
        )
        return 1

    snap = load_backup(args.backup_dir.resolve())
    enriched_list, enriched_by_id = build_guild_loot_sale_enriched(snap)
    enriched_sorted = sorted(enriched_list, key=enriched_guild_sale_sort_key)
    pf_indexes = build_portfolio_indexes(enriched_sorted)
    bc = BalanceCalculator(snap)

    events_full = prepare_second_bidder_events(snap, item_eligibility_bundle=bundle)
    event_by_loot = {e.loot_id: e for e in events_full}

    if args.loot_ids_file is not None:
        want = set(_load_ids_from_file(args.loot_ids_file.resolve()))
    else:
        want = None
        if args.min_loot_id is not None or args.max_loot_id is not None:
            want = set(enriched_by_id.keys())
            if args.min_loot_id is not None:
                want = {i for i in want if i >= args.min_loot_id}
            if args.max_loot_id is not None:
                want = {i for i in want if i <= args.max_loot_id}

    done: set[int] = set()
    if args.checkpoint:
        done = _load_checkpoint(args.checkpoint.resolve())

    sb_cfg = SecondBidderConfig()
    state: KnowledgeState = empty_state()

    args.out.parent.mkdir(parents=True, exist_ok=True)
    mode = "a" if args.checkpoint and done else "w"
    n = 0
    with args.out.open(mode, encoding="utf-8") as fout:
        for ev in events_full:
            gle = enriched_by_id.get(ev.loot_id)
            if gle is None:
                update_knowledge_state(state, ev)
                continue

            emit = want is None or ev.loot_id in want
            if emit and ev.loot_id not in done:
                r_acc, r_char = resolve_runner_up_for_event(
                    ev, state, bc, sb_cfg, rank_mode=args.runner_up_rank
                )
                payload = None
                if args.include_payload:
                    payload = officer_bid_portfolio_for_loot_payload(
                        snap,
                        bc,
                        gle,
                        pf_indexes,
                        runner_up_account_guess=r_acc,
                        runner_up_char_guess=r_char,
                        event_by_loot_id=event_by_loot,
                        state=state,
                        config=sb_cfg,
                        runner_up_rank_mode=args.runner_up_rank,
                    )
                computed_at = datetime.now(timezone.utc).isoformat()
                fact = fact_row(
                    gle,
                    r_acc,
                    payload if args.include_payload else None,
                    computed_at,
                    runner_char=r_char,
                )
                rec: dict = {"fact": fact}
                if args.include_payload:
                    rec["payload"] = payload
                fout.write(json.dumps(rec, default=str) + "\n")
                n += 1
                if args.checkpoint:
                    _append_checkpoint(args.checkpoint.resolve(), ev.loot_id)
                if args.progress_every > 0 and n % args.progress_every == 0:
                    print(f"... wrote {n} row(s), last loot_id={ev.loot_id}", file=sys.stderr)

            update_knowledge_state(state, ev)

    print(f"Wrote {n} JSONL record(s) to {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
