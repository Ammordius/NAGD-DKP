#!/usr/bin/env python3
"""Print a sample second-bidder report from a Supabase CSV backup folder."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))

from second_bidder_model import (
    SecondBidderConfig,
    format_event_report,
    run_from_backup,
)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("backup_dir", type=Path, help="Folder with raids.csv, raid_loot.csv, …")
    p.add_argument("--index", type=int, default=-1, help="Event index in chronological list (default: last)")
    p.add_argument("--debug", action="store_true", help="Include pool-threshold debug on first event only")
    p.add_argument(
        "--no-character-detail",
        action="store_true",
        help="Omit per-character lines in the text report",
    )
    p.add_argument(
        "--eligibility-json",
        type=Path,
        default=None,
        help="Optional JSON for eligible_by_loot_id / eligible_chars_by_loot_id (see HANDOFF_SECOND_BIDDER_MVP)",
    )
    p.add_argument(
        "--no-item-stats",
        action="store_true",
        help="Do not load repo data/item_stats.json for class/level eligibility",
    )
    args = p.parse_args()

    cfg = SecondBidderConfig()
    prep_kw = {}
    if args.eligibility_json is not None:
        from second_bidder_model.eligibility_io import load_eligibility_json

        ea, ec = load_eligibility_json(args.eligibility_json.resolve())
        if ea is not None:
            prep_kw["eligible_by_loot_id"] = ea
        if ec is not None:
            prep_kw["eligible_chars_by_loot_id"] = ec
    item_bundle = None
    if not args.no_item_stats:
        from second_bidder_model.item_stats_eligibility import try_load_item_eligibility_bundle

        item_bundle = try_load_item_eligibility_bundle(REPO_ROOT)
    preds = run_from_backup(
        str(args.backup_dir.resolve()),
        cfg,
        debug_first_n=1 if args.debug else 0,
        item_eligibility_bundle=item_bundle,
        **prep_kw,
    )
    if not preds:
        print("No positive-price sales with buyer resolved.", file=sys.stderr)
        sys.exit(1)
    i = args.index if args.index >= 0 else len(preds) + args.index
    i = max(0, min(i, len(preds) - 1))
    print(format_event_report(preds[i], verbose_characters=not args.no_character_detail))


if __name__ == "__main__":
    main()
