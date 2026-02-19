#!/usr/bin/env python3
"""
Parse ground_truth_sum.txt and compare to data/dkp_totals.csv.
Prints a table: name, GT earned, ours earned, diff, GT spent, ours spent, GT balance, ours balance.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import List, Tuple

import pandas as pd


def parse_ground_truth(path: Path) -> List[Tuple[str, float, int, float]]:
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
        # Skip fraction lines like "33/35 (94%)"
        if re.match(r"^\d+/\d+", parts[1].strip()):
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
    csv_path = Path("data/dkp_totals.csv")
    if not gt_path.exists():
        print(f"Missing {gt_path}", file=sys.stderr)
        sys.exit(2)
    if not csv_path.exists():
        print(f"Missing {csv_path}. Run compute_dkp.py first.", file=sys.stderr)
        sys.exit(2)

    gt = parse_ground_truth(gt_path)
    df = pd.read_csv(csv_path)
    # Normalize our names for match: strip "(*)" prefix
    df["name_norm"] = df["character_name"].astype(str).str.replace(r"^\(\*\)\s*", "", regex=True).str.strip()

    print("Comparison: ground truth vs computed (per-event attendance)\n")
    print(f"{'Name':<25} {'GT earned':>10} {'Ours':>10} {'Diff':>8} {'GT spent':>9} {'Ours':>6} {'GT bal':>8} {'Ours':>8}")
    print("-" * 100)
    matched = 0
    total_earned_diff = 0.0
    for name_gt, e_gt, s_gt, b_gt in gt:
        # Match by name (ours may have "(*) " prefix or no [+])
        name_clean = re.sub(r"\s*\[\+\]\s*$", "", name_gt).strip()
        ours = df[df["name_norm"].str.strip().str.lower() == name_clean.lower()]
        if ours.empty:
            ours = df[df["character_name"].astype(str).str.strip().str.lower() == name_clean.lower()]
        if ours.empty:
            continue
        row = ours.iloc[0]
        e_ours = float(row["earned"])
        s_ours = int(row["spent"])
        b_ours = float(row["balance"])
        diff_e = e_ours - e_gt
        total_earned_diff += diff_e
        matched += 1
        print(f"{name_clean[:24]:<25} {e_gt:>10.0f} {e_ours:>10.1f} {diff_e:>+8.1f} {s_gt:>9} {s_ours:>6} {b_gt:>8.0f} {b_ours:>8.1f}")
    print("-" * 100)
    print(f"Matched {matched} / {len(gt)} ground truth rows.")
    print(f"Total earned diff (ours - GT) sum: {total_earned_diff:+.1f}")


if __name__ == "__main__":
    main()
