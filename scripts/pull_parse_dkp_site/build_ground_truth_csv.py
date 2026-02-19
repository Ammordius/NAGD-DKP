#!/usr/bin/env python3
"""
Parse ground_truth_sum.txt (official DKP export) into data/ground_truth_dkp.csv.

This is the canonical ground truth for validation and for redoing the Supabase backend.
Columns: character_name, earned, spent, balance.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pandas as pd


def parse_ground_truth(path: Path) -> list[tuple[str, float, int, float]]:
    """Return list of (name_normalized, earned, spent, balance)."""
    text = path.read_text(encoding="utf-8")
    rows = []
    for line in text.splitlines():
        line = line.rstrip()
        if not line or "\t" not in line:
            continue
        parts = line.split("\t")
        if len(parts) < 7:
            continue
        if re.match(r"^\d+/\d+", (parts[1] or "").strip()):
            continue
        name_raw = (parts[1] or "").strip()
        if not name_raw:
            continue
        name = re.sub(r"\s*\[\+\]\s*$", "", name_raw).strip()
        try:
            earned = float((parts[5] or "0").replace(",", ""))
            spent = int((parts[6] or "0").replace(",", ""))
            balance = float((parts[7] or "0").replace(",", "")) if len(parts) > 7 else earned - spent
        except (ValueError, IndexError):
            continue
        rows.append((name, earned, spent, balance))
    return rows


def main() -> None:
    gt_path = Path("ground_truth_sum.txt")
    out_path = Path("data/ground_truth_dkp.csv")
    if not gt_path.exists():
        print(f"Missing {gt_path}", file=sys.stderr)
        sys.exit(2)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    rows = parse_ground_truth(gt_path)
    df = pd.DataFrame(rows, columns=["character_name", "earned", "spent", "balance"])
    df.to_csv(out_path, index=False)
    print(f"Wrote {out_path} ({len(df)} rows from {gt_path})")


if __name__ == "__main__":
    main()
