#!/usr/bin/env python3
"""
Verify dkp_adjustments against ground truth and our computed base (dkp_totals.csv).

- Our app does: displayed = base + adjustment (add earned_delta to earned, spent_delta to spent).
- So the correct adjustment is: (earned_delta, spent_delta) = (GT_earned - base_earned, GT_spent - base_spent).
- If base has drifted (e.g. after re-import), current adjustment may over- or under-correct.

Run after: python compute_dkp.py (so data/dkp_totals.csv is current).
Reads: data/ground_truth_dkp.csv, data/dkp_totals.csv, data/dkp_adjustments.csv.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd


def norm_name(s: str) -> str:
    return (s or "").strip().lower()


def main() -> None:
    data_dir = Path("data")
    gt_path = data_dir / "ground_truth_dkp.csv"
    base_path = data_dir / "dkp_totals.csv"
    adj_path = data_dir / "dkp_adjustments.csv"

    for p in (gt_path, base_path, adj_path):
        if not p.exists():
            print(f"Missing {p}", file=sys.stderr)
            sys.exit(2)

    gt = pd.read_csv(gt_path)
    base_df = pd.read_csv(base_path)
    adj_df = pd.read_csv(adj_path)

    gt["name_norm"] = gt["character_name"].astype(str).map(norm_name)
    base_df["name_norm"] = base_df["character_name"].astype(str).map(norm_name)
    # Build lookup: name_norm -> (earned, spent) for first match
    base_by_name = {}
    for _, row in base_df.iterrows():
        n = norm_name(str(row["character_name"]))
        if n not in base_by_name:
            base_by_name[n] = (float(row["earned"]), int(row["spent"]))

    adj_by_name = {}
    for _, row in adj_df.iterrows():
        n = norm_name(str(row["character_name"]))
        adj_by_name[n] = (float(row["earned_delta"]), int(row["spent_delta"]))

    print("=== Adjustment verification (recommended = GT - base) ===\n")
    print(f"{'Name':<22} {'Base (e,s)':>14} {'GT (e,s)':>14} {'Recommended (e,s)':>18} {'Current (e,s)':>14} {'Status':<12}")
    print("-" * 95)

    issues = []
    for _, row in gt.iterrows():
        name = (row["character_name"] or "").strip()
        n = norm_name(name)
        e_gt = float(row["earned"])
        s_gt = int(row["spent"])

        base_val = base_by_name.get(n)
        if base_val is None:
            continue
        e_base, s_base = base_val
        rec_e = round(e_gt - e_base, 0)
        rec_s = s_gt - s_base
        rec = (int(rec_e), rec_s)

        current = adj_by_name.get(n, (0, 0))
        current = (int(current[0]), int(current[1]))

        if current != (0, 0) or rec != (0, 0):
            if current == rec:
                status = "OK"
            elif current != (0, 0) and rec == (0, 0):
                status = "REMOVE (base=GT)"
                issues.append((name, "remove", current, rec))
            else:
                status = "UPDATE"
                issues.append((name, "update", current, rec))
        else:
            status = ""

        if status or rec != (0, 0) or current != (0, 0):
            bstr = f"({e_base:.0f},{s_base})"
            gstr = f"({e_gt:.0f},{s_gt})"
            rstr = f"({rec_e:.0f},{rec_s})"
            print(f"{name[:21]:<22} {bstr:>14} {gstr:>14} {rstr:>18} {str(current):>14} {status:<12}")

    print("-" * 95)
    if issues:
        print("\nActions suggested:")
        for name, action, current, rec in issues:
            if action == "remove":
                print(f"  {name}: remove adjustment {current} (base now matches GT)")
            else:
                print(f"  {name}: current {current} -> recommended {rec}")
    else:
        print("\nAll current adjustments match recommended (GT - base).")

    # Warn if any character has an adjustment but base now matches GT (over-correction)
    print("\n=== Over-correction check (adjustment present but base already = GT) ===")
    over = [
        (row["character_name"].strip(), adj_by_name.get(norm_name(row["character_name"]), (0, 0)))
        for _, row in gt.iterrows()
        if base_by_name.get(norm_name((row["character_name"] or "").strip())) == (float(row["earned"]), int(row["spent"]))
        and adj_by_name.get(norm_name((row["character_name"] or "").strip()), (0, 0)) != (0, 0)
    ]
    if over:
        for name, cur in over:
            print(f"  REMOVE {name}: current adjustment {cur} (base already matches GT)")
    else:
        print("  None (all adjustments are needed or removed).")

    # Characters in adjustments but not in GT (or name mismatch)
    print("\n=== Adjustments for names not in ground truth (check spelling) ===")
    for _, row in adj_df.iterrows():
        n = norm_name(str(row["character_name"]))
        if n not in gt["name_norm"].values:
            print(f"  {row['character_name']}: (earned_delta={row['earned_delta']}, spent_delta={row['spent_delta']})")


if __name__ == "__main__":
    main()
