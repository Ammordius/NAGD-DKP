#!/usr/bin/env python3
"""
Run second-bidder inference on every positive-price guild sale in a CSV backup.

Writes one JSON object per line (JSONL). Scoring is strictly sequential; use
``--checkpoint`` + ``--resume`` to continue after interrupt.

Examples (repo root, PowerShell):

  $env:PYTHONPATH = "scripts"
  python scripts/run_second_bidder_batch.py "C:\\TAKP\\dkp\\backup-2026-04-02\\backup" `
    --out data/second_bidder.jsonl --progress-every 500 --checkpoint-every 200

Resume after Ctrl+C (same backup path and --out):

  python scripts/run_second_bidder_batch.py "C:\\TAKP\\dkp\\backup-2026-04-02\\backup" `
    --out data/second_bidder.jsonl --resume

Start over (delete checkpoint, overwrite JSONL):

  python scripts/run_second_bidder_batch.py ... --out data/second_bidder.jsonl --fresh

Optional Magelo-style eligibility (see docs/HANDOFF_SECOND_BIDDER_MVP.md):

  python scripts/run_second_bidder_batch.py ... --out data/second_bidder.jsonl `
    --eligibility-json data/second_bidder_eligibility.json
"""
from __future__ import annotations

import argparse
import json
import os
import pickle
import signal
import sys
import time
from pathlib import Path
from typing import Any, Dict, Optional

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))

from bid_portfolio_local.load_csv import load_backup

from second_bidder_model import SecondBidderConfig
from second_bidder_model.eligibility_io import load_eligibility_json
from second_bidder_model.item_stats_eligibility import try_load_item_eligibility_bundle
from second_bidder_model.pipeline import iter_sequential_predictions
from second_bidder_model.prepare import prepare_second_bidder_events
from second_bidder_model.serialize import prediction_result_to_json_dict
from second_bidder_model.state import KnowledgeState, empty_state

_CHECKPOINT_VERSION = 3


def _migrate_knowledge_state(st: KnowledgeState) -> None:
    """Best-effort upgrade for pickles from older model versions."""
    if not hasattr(st, "char_win_history") or st.char_win_history is None:
        st.char_win_history = {}
    if not hasattr(st, "account_loot_events_attended") or st.account_loot_events_attended is None:
        st.account_loot_events_attended = {}
    if not hasattr(st, "account_paid_to_ref_ewma") or st.account_paid_to_ref_ewma is None:
        st.account_paid_to_ref_ewma = {}


def _atomic_pickle_dump(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("wb") as f:
        pickle.dump(obj, f, protocol=4)
    tmp.replace(path)


def _load_checkpoint(path: Path) -> Optional[Dict[str, Any]]:
    if not path.is_file():
        return None
    with path.open("rb") as f:
        return pickle.load(f)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("backup_dir", type=Path, help="Folder with raids.csv, raid_loot.csv, …")
    ap.add_argument("--out", type=Path, required=True, help="Output JSONL path")
    ap.add_argument(
        "--checkpoint",
        type=Path,
        default=None,
        help="Pickle path for resume (default: <out>.second_bidder_checkpoint.pkl)",
    )
    ap.add_argument(
        "--resume",
        action="store_true",
        help="Continue from --checkpoint if it exists (append to --out)",
    )
    ap.add_argument(
        "--fresh",
        action="store_true",
        help="Ignore checkpoint and overwrite --out",
    )
    ap.add_argument(
        "--progress-every",
        type=int,
        default=250,
        metavar="N",
        help="Print progress to stderr every N events (0 = quiet)",
    )
    ap.add_argument(
        "--checkpoint-every",
        type=int,
        default=200,
        metavar="N",
        help="Write resume pickle every N finished events (0 = only SIGINT / end)",
    )
    ap.add_argument(
        "--top-candidates",
        type=int,
        default=25,
        help="Max ranked candidates per line in JSONL",
    )
    ap.add_argument(
        "--include-feature-vectors",
        action="store_true",
        help="Include per-candidate normalized feature dicts (much larger files)",
    )
    ap.add_argument(
        "--include-character-debug",
        action="store_true",
        help="Include per-candidate character breakdown and player_debug (larger JSONL)",
    )
    ap.add_argument(
        "--eligibility-json",
        type=Path,
        default=None,
        help=(
            "Optional JSON with eligible_by_loot_id and/or eligible_chars_by_loot_id "
            "(see docs/HANDOFF_SECOND_BIDDER_MVP.md). Merged with item-stats pairs via intersection."
        ),
    )
    ap.add_argument(
        "--no-item-stats",
        action="store_true",
        help="Do not load repo data/item_stats.json + dkp_mob_loot for class/level eligibility",
    )
    ap.add_argument(
        "--item-stats",
        type=Path,
        default=None,
        help="Override path to item_stats.json (default: <repo>/data/item_stats.json)",
    )
    ap.add_argument(
        "--mob-loot-json",
        type=Path,
        default=None,
        help="Override path to dkp_mob_loot.json (default: <repo>/data/dkp_mob_loot.json)",
    )
    ap.add_argument(
        "--raid-sources-json",
        type=Path,
        default=None,
        help="Optional raid_item_sources.json (default: <repo>/raid_item_sources.json if present)",
    )
    ap.add_argument(
        "--permissive-missing-char-class-level",
        action="store_true",
        help=(
            "If item_stats gate is on: treat missing CSV class_name mapping or missing level as "
            "eligible (legacy backups). Default is fail-closed when item has class/level rules."
        ),
    )
    ap.add_argument(
        "--require-attending-eligible-lane",
        action="store_true",
        help=(
            "When item eligibility pairs are in use: only keep accounts that have an item-eligible "
            "character on this raid's attendance (stricter than default plausibility-set gate)."
        ),
    )
    args = ap.parse_args()

    ck_path = args.checkpoint or Path(str(args.out) + ".second_bidder_checkpoint.pkl")
    backup = args.backup_dir.resolve()

    if args.fresh:
        if ck_path.is_file():
            ck_path.unlink()
        out_mode = "w"
        start_index = 0
        initial_state: Optional[KnowledgeState] = None
    elif args.resume and ck_path.is_file():
        blob = _load_checkpoint(ck_path)
        cv = blob.get("v") if blob else None
        if not blob or cv not in (1, _CHECKPOINT_VERSION):
            print("Checkpoint missing or version mismatch; starting from 0.", file=sys.stderr)
            out_mode = "w"
            start_index = 0
            initial_state = None
        else:
            start_index = int(blob["next_index"])
            initial_state = blob["state"]
            out_mode = "a"
            print(
                f"Resuming at event_index={start_index} (checkpoint {ck_path})",
                file=sys.stderr,
            )
    else:
        out_mode = "w"
        start_index = 0
        initial_state = None
        if ck_path.is_file() and not args.fresh:
            print(
                f"Note: existing checkpoint {ck_path} not used (pass --resume).",
                file=sys.stderr,
            )

    cfg = SecondBidderConfig(
        require_item_eligible_attending_lane_for_pool=args.require_attending_eligible_lane,
    )
    t0 = time.perf_counter()
    snap = load_backup(backup)
    elig_acc = elig_chars = None
    if args.eligibility_json is not None:
        p = args.eligibility_json.resolve()
        if not p.is_file():
            print(f"Eligibility file not found: {p}", file=sys.stderr)
            return 1
        elig_acc, elig_chars = load_eligibility_json(p)
    item_bundle = None
    if not args.no_item_stats:
        item_bundle = try_load_item_eligibility_bundle(
            REPO_ROOT,
            item_stats_path=args.item_stats.resolve() if args.item_stats else None,
            mob_loot_path=args.mob_loot_json.resolve() if args.mob_loot_json else None,
            raid_sources_path=args.raid_sources_json.resolve() if args.raid_sources_json else None,
            permissive_missing_char_class_level=args.permissive_missing_char_class_level,
        )
        if item_bundle is None:
            print(
                "WARNING: item eligibility bundle not loaded (missing data/item_stats.json or "
                "data/dkp_mob_loot.json under repo root). Runner-up candidate pools skip class/level "
                "gates from item_stats unless --eligibility-json supplies pairs. Fix paths or pass "
                "--no-item-stats only if intentional.",
                file=sys.stderr,
            )
    events = prepare_second_bidder_events(
        snap,
        eligible_by_loot_id=elig_acc,
        eligible_chars_by_loot_id=elig_chars,
        item_eligibility_bundle=item_bundle,
    )
    total = len(events)
    if total == 0:
        print("No positive-price sales with buyer resolved.", file=sys.stderr)
        return 1
    if start_index > total:
        print("Checkpoint next_index past end of events; nothing to do.", file=sys.stderr)
        return 0

    state_arg = empty_state() if initial_state is None else initial_state
    _migrate_knowledge_state(state_arg)
    ctx: Dict[str, Any] = {
        "next_index": start_index,
        "state": state_arg,
        "ck_path": ck_path,
    }
    checkpoint_every = max(0, args.checkpoint_every)

    def save_ckpt() -> None:
        _atomic_pickle_dump(
            ck_path,
            {"v": _CHECKPOINT_VERSION, "next_index": ctx["next_index"], "state": ctx["state"]},
        )

    def on_sigint(_signum: int, _frame: Any) -> None:
        print("\nInterrupted; writing checkpoint…", file=sys.stderr)
        save_ckpt()
        print(f"Saved {ck_path} next_index={ctx['next_index']}", file=sys.stderr)
        sys.exit(130)

    signal.signal(signal.SIGINT, on_sigint)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    with args.out.open(out_mode, encoding="utf-8") as fout:
        gen = iter_sequential_predictions(
            events,
            snap,
            cfg,
            start_index=start_index,
            initial_state=state_arg,
        )
        for i, pred, kstate in gen:
            row = prediction_result_to_json_dict(
                pred,
                top_candidates=args.top_candidates,
                include_feature_vectors=args.include_feature_vectors,
                include_character_debug=args.include_character_debug,
            )
            fout.write(json.dumps(row, ensure_ascii=False) + "\n")
            fout.flush()
            os.fsync(fout.fileno())
            written += 1
            ctx["next_index"] = i + 1
            ctx["state"] = kstate
            pe = args.progress_every
            if pe and written % pe == 0:
                elapsed = time.perf_counter() - t0
                print(
                    f"progress event_index={i + 1}/{total} "
                    f"({100.0 * (i + 1) / total:.1f}%) elapsed={elapsed:.1f}s",
                    file=sys.stderr,
                )
            if checkpoint_every and written % checkpoint_every == 0:
                save_ckpt()

    if ck_path.is_file():
        ck_path.unlink()
    elapsed = time.perf_counter() - t0
    print(
        f"Done: wrote {written} lines to {args.out} in {elapsed:.1f}s",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
