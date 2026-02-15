#!/usr/bin/env python3
"""
Parse ground_truth.txt (or ground_truth_sum.txt) and output expected DKP values
so you can verify the website matches ground truth.

Usage:
  python verify_website_vs_ground_truth.py [ground_truth.txt]
  python verify_website_vs_ground_truth.py --csv data/expected_for_website.csv

Output: table of Name, Earned, Spent, Balance. Optionally write CSV with --csv path.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path


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
    args = []
    csv_out = None
    i = 1
    while i < len(sys.argv):
        if sys.argv[i] == "--csv" and i + 1 < len(sys.argv):
            csv_out = Path(sys.argv[i + 1])
            i += 2
            continue
        if not sys.argv[i].startswith("--"):
            args.append(sys.argv[i])
        i += 1

    gt_path = Path(args[0]) if args else Path("ground_truth.txt")
    if not gt_path.exists():
        gt_path = Path("ground_truth_sum.txt")
    if not gt_path.exists():
        print(f"Missing {gt_path} (or pass path)", file=sys.stderr)
        sys.exit(2)

    rows = parse_ground_truth(gt_path)
    if not rows:
        print("No rows parsed.", file=sys.stderr)
        sys.exit(1)

    if csv_out:
        csv_out.parent.mkdir(parents=True, exist_ok=True)
        with open(csv_out, "w", encoding="utf-8") as f:
            f.write("character_name,earned,spent,balance\n")
            for name, earned, spent, balance in rows:
                f.write(f"{name},{earned:.0f},{spent},{balance:.0f}\n")
        print(f"Wrote {csv_out} ({len(rows)} rows). Use this to verify the website.\n")

    print("Expected values (ground truth) – verify these on the DKP website:\n")
    print(f"{'Name':<24} {'Earned':>8} {'Spent':>6} {'Balance':>8}")
    print("-" * 50)
    for name, earned, spent, balance in rows[:60]:
        print(f"{name[:23]:<24} {earned:>8.0f} {spent:>6} {balance:>8.0f}")
    if len(rows) > 60:
        print(f"... and {len(rows) - 60} more (see --csv for full list)")
    print("-" * 50)
    print(f"Total rows: {len(rows)}")


if __name__ == "__main__":
    main()
