#!/usr/bin/env python3
"""
Audit Frinop DKP: compare ledger (frinop.txt) total vs our scraped data (CSV).
Exclude "Time Day 2" 2026-02-19 and its 2 DKP from ledger (already on Supabase, not in local).

  python scripts/pull_parse_dkp_site/audit_frinop_ledger.py [--ledger path] [--data-dir data]
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent.parent

# Raid to exclude from ledger sum (user said it's already on Supabase, ignore in local audit)
EXCLUDE_RAID_NAME = "Time Day 2"
EXCLUDE_RAID_DATE = "2026-02-19"
EXCLUDE_DKP = 2

CHAR_NAME = "Frinop"


def parse_ledger_raid_history(ledger_path: Path) -> list[tuple[str, str, int]]:
    """Return list of (raid_name, raid_date, earned) from Raid History section."""
    text = ledger_path.read_text(encoding="utf-8")
    lines = text.splitlines()
    in_section = False
    rows: list[tuple[str, str, int]] = []
    for line in lines:
        if line.strip() == "Raid Name	Raid Date	Earned" or (in_section and line.startswith("Raid Name\t")):
            in_section = True
            if "\t" in line and not line.strip().endswith("Earned"):
                continue
            continue
        if in_section:
            if not line.strip():
                break
            parts = line.split("\t")
            if len(parts) >= 3:
                name, date, earned_str = parts[0].strip(), parts[1].strip(), parts[2].strip()
                try:
                    earned = int(earned_str.replace(",", ""))
                except ValueError:
                    continue
                rows.append((name, date, earned))
    return rows


def main() -> int:
    import argparse
    ap = argparse.ArgumentParser(description="Audit Frinop ledger vs scraped DKP")
    ap.add_argument("--ledger", type=Path, default=ROOT / "frinop.txt", help="Path to frinop.txt")
    ap.add_argument("--data-dir", type=Path, default=ROOT / "data", help="Directory with raid_events.csv, raid_event_attendance.csv")
    args = ap.parse_args()

    if not args.ledger.exists():
        print(f"Ledger not found: {args.ledger}", file=sys.stderr)
        return 1

    try:
        import pandas as pd
    except ImportError:
        print("pip install pandas", file=sys.stderr)
        return 1

    # --- Parse ledger ---
    rows = parse_ledger_raid_history(args.ledger)
    ledger_total = sum(r[2] for r in rows)
    excluded = [r for r in rows if r[0] == EXCLUDE_RAID_NAME and r[1] == EXCLUDE_RAID_DATE]
    if excluded:
        assert len(excluded) == 1 and excluded[0][2] == EXCLUDE_DKP
    ledger_total_excluding = ledger_total - EXCLUDE_DKP

    print("--- Ledger (frinop.txt) ---")
    print(f"  Raid History rows: {len(rows)}")
    print(f"  Sum of Earned (all): {ledger_total}")
    print(f"  Excluded: '{EXCLUDE_RAID_NAME}' {EXCLUDE_RAID_DATE} ({EXCLUDE_DKP} DKP) - already on Supabase, not in local")
    print(f"  Ledger total for audit (excluding above): {ledger_total_excluding}")

    # --- Scraped DKP from CSV ---
    events_path = args.data_dir / "raid_events.csv"
    rea_path = args.data_dir / "raid_event_attendance.csv"
    if not events_path.exists() or not rea_path.exists():
        print(f"Missing {events_path} or {rea_path}", file=sys.stderr)
        return 1

    events = pd.read_csv(events_path)
    rea = pd.read_csv(rea_path)
    # Normalize character_name for match
    rea["_name"] = rea["character_name"].astype(str).str.strip()
    frinop_rea = rea[rea["_name"].str.lower() == CHAR_NAME.lower()]
    merged = frinop_rea.merge(
        events[["raid_id", "event_id", "dkp_value"]],
        on=["raid_id", "event_id"],
        how="left",
    )
    # dkp_value might be string or float
    merged["dkp_value"] = pd.to_numeric(merged["dkp_value"], errors="coerce").fillna(0)
    scraped_earned = float(merged["dkp_value"].sum())

    print("\n--- Scraped (local CSV) ---")
    print(f"  raid_event_attendance rows for '{CHAR_NAME}': {len(frinop_rea)}")
    print(f"  Sum of event dkp_value (earned): {int(scraped_earned)}")

    # --- Compare ---
    print("\n--- Audit ---")
    diff = ledger_total_excluding - scraped_earned
    if abs(diff) < 0.01:
        print(f"  MATCH: Ledger (excl.) = {ledger_total_excluding}, Scraped = {int(scraped_earned)}")
    else:
        print(f"  LEDGER (excl.): {ledger_total_excluding}")
        print(f"  SCRAPED:       {int(scraped_earned)}")
        print(f"  DIFF:          {diff:+.1f}")
    return 0


if __name__ == "__main__":
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    sys.exit(main())
