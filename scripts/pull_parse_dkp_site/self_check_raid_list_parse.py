#!/usr/bin/env python3
"""Regression: two data-table blocks on one page both produce raid rows."""

from __future__ import annotations

import sys
from pathlib import Path

# Run from repo root: python scripts/pull_parse_dkp_site/self_check_raid_list_parse.py
_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from pull_raids import parse_raids_from_list_page


def main() -> int:
    fixture = _SCRIPT_DIR / "fixtures" / "two_table_raids_list.html"
    if not fixture.exists():
        print(f"Missing {fixture}", file=sys.stderr)
        return 1
    html = fixture.read_text(encoding="utf-8")
    rows = parse_raids_from_list_page(html, "562569", "547766")
    ids = {r["raid_id"] for r in rows}
    expected = {"1598641", "1599999"}
    if ids != expected:
        print(f"FAIL: expected raid ids {expected}, got {ids}", file=sys.stderr)
        return 1
    print("ok: two-table raid list parse")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
