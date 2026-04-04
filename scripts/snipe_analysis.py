#!/usr/bin/env python3
"""
Snipe list analysis: classify loot by mob (from item_sources_lookup), attach last-3
average DKP cost from Supabase/raid_loot data, output loot CSV and player totals.
Second output: Raids CSV with DKP earned (VT 9h = 6+3 or 4+3+2 over days, PoE 3 mobs = 2, Seru = 2, Cursed = 2).

Analysis only; does not commit. Uses data/raid_loot.csv + data/raids.csv for last-3 costs
(export from Supabase). Item -> mob/zone from data/item_sources_lookup.json.
"""

from __future__ import annotations

import csv
import json
import math
import re
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path


def parse_snipe(path: Path) -> list[tuple[str, str, str]]:
    """Return list of (date_time_str, item_name, player)."""
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        dt_str = (parts[0] or "").strip()
        item = (parts[1] or "").strip()
        player = (parts[2] or "").strip()
        if not item or not player:
            continue
        rows.append((dt_str, item, player))
    return rows


def load_item_sources(path: Path) -> dict[str, tuple[str, str]]:
    """item_name_lower -> (mob, zone). First source only."""
    data = json.loads(path.read_text(encoding="utf-8"))
    out = {}
    for key, sources in data.items():
        if not isinstance(sources, list) or not sources:
            continue
        s = sources[0]
        mob = (s.get("mob") or "").strip()
        zone = (s.get("zone") or "").strip()
        out[key.lower()] = (mob, zone)
    return out


def load_raids(path: Path) -> dict[str, str]:
    """raid_id -> date_iso."""
    out = {}
    with open(path, "r", encoding="utf-8", newline="") as f:
        r = csv.DictReader(f)
        for row in r:
            raid_id = (row.get("raid_id") or "").strip()
            date_iso = (row.get("date_iso") or "").strip()
            if raid_id and date_iso:
                out[raid_id] = date_iso
    return out


def load_raid_loot(path: Path) -> list[tuple[str, str, str]]:
    """(raid_id, item_name, cost)."""
    out = []
    with open(path, "r", encoding="utf-8", newline="") as f:
        r = csv.DictReader(f)
        for row in r:
            raid_id = (row.get("raid_id") or "").strip()
            item_name = (row.get("item_name") or "").strip()
            cost = (row.get("cost") or "").strip()
            if not item_name:
                continue
            out.append((raid_id, item_name, cost))
    return out


def build_last3_avg_by_item(
    raid_loot: list[tuple[str, str, str]],
    raid_id_to_date: dict[str, str],
) -> dict[str, tuple[list[int], float]]:
    """item_name (normalized for grouping) -> (last 3 costs as ints, average rounded up).
    Order by date_iso desc, then take last 3 cost values per item. Cost parsed as int; non-numeric skipped."""
    # (date_iso, cost_int) per row
    by_item: dict[str, list[tuple[str, int]]] = defaultdict(list)
    for raid_id, item_name, cost_str in raid_loot:
        date_iso = raid_id_to_date.get(raid_id)
        if not date_iso:
            continue
        try:
            c = int(cost_str)
        except (ValueError, TypeError):
            continue
        key = item_name.strip()
        by_item[key].append((date_iso, c))

    result = {}
    for item, pairs in by_item.items():
        # sort by date desc, take first 3 (most recent)
        pairs.sort(key=lambda x: x[0], reverse=True)
        last3 = [p[1] for p in pairs[:3]]
        if not last3:
            result[item] = ([], 0.0)
            continue
        avg = sum(last3) / len(last3)
        result[item] = (last3, math.ceil(avg))
    return result


def normalize_item_for_lookup(name: str) -> str:
    return name.strip().lower()


# Canonical raid type and DKP per date (from snipe list). Dates as YYYY-MM-DD.
# PoEb/PoEB = 2 DKP; Cursed = 2; Seru = 2; VT single = 9; VT 2-day = 6+3; VT 3-day = 4+3+2; VT 4-day = 4+3+2+0.
RAID_DATE_MAP: dict[str, tuple[str, int]] = {
    "2025-10-15": ("PoEb", 2),
    "2025-10-18": ("PoEB", 2),
    "2025-11-07": ("Cursed", 2),
    "2025-11-08": ("PoEb", 2),
    "2025-11-12": ("PoEb", 2),
    "2025-11-16": ("PoEb", 2),
    "2025-11-19": ("PoEB", 2),
    "2025-12-02": ("VT", 9),
    "2025-12-10": ("PoEB", 2),
    "2025-12-17": ("VT day 1", 4),
    "2025-12-18": ("VT day 1 (cont.)", 0),  # same raid ran over midnight
    "2025-12-19": ("VT day 2", 3),
    "2025-12-20": ("VT day 3", 2),
    "2026-01-21": ("Seru", 2),
    "2026-01-24": ("PoEB", 2),
    "2026-02-01": ("PoEb", 2),
    "2026-02-07": ("PoEb", 2),
    "2026-02-11": ("VT day 1", 6),
    "2026-02-13": ("VT day 2", 3),
    "2026-02-18": ("VT day 1", 4),
    "2026-02-19": ("VT day 2", 3),
    "2026-02-20": ("VT day 3", 2),
    "2026-03-07": ("PoEB", 2),
}


def _parse_datetime(dt_str: str) -> datetime | None:
    """Parse to datetime if possible. Handles M/D with or without year and time."""
    s = dt_str.strip()
    date_part = s.split()[0] if s else ""
    if not date_part:
        return None
    # With time
    for fmt in ("%m/%d/%Y %H:%M:%S", "%m/%d/%Y %H:%M", "%m/%d %H:%M:%S", "%m/%d %H:%M"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    # Date only
    try:
        t = datetime.strptime(date_part, "%m/%d/%Y")
        return t
    except ValueError:
        pass
    if re.match(r"^\d{1,2}/\d{1,2}$", date_part):
        try:
            m, d = date_part.split("/")
            mo, day = int(m), int(d)
            year = 2026 if mo <= 3 else 2025
            return datetime(year, mo, day)
        except ValueError:
            pass
    return None


def parse_date(dt_str: str) -> str | None:
    """Return calendar date_iso (YYYY-MM-DD) or None."""
    t = _parse_datetime(dt_str)
    return t.strftime("%Y-%m-%d") if t else None


def raid_date(dt_str: str) -> str | None:
    """Return the raid date for this timestamp. When a raid runs over midnight (e.g. 23:30 on 12/17
    then 00:15 on 12/18), both belong to the same raid night: we attribute 00:00–05:59 to the
    *previous* calendar day. Only do this when the string has an explicit time (e.g. '12/18 00:03');
    date-only entries like '10/15' stay on that calendar date."""
    t = _parse_datetime(dt_str)
    if not t:
        return None
    s = dt_str.strip()
    has_time = ":" in s and (" " in s or re.search(r"\d{1,2}:\d{2}", s))
    if has_time and t.hour < 6:  # 00:00–05:59 = same raid as previous calendar day
        prev = t - timedelta(days=1)
        return prev.strftime("%Y-%m-%d")
    return t.strftime("%Y-%m-%d")


def main() -> int:
    repo = Path(__file__).resolve().parent.parent
    snipe_path = repo / "snipe.txt"
    data_dir = repo / "data"
    sources_path = data_dir / "item_sources_lookup.json"
    raids_path = data_dir / "raids.csv"
    loot_path = data_dir / "raid_loot.csv"

    if not snipe_path.exists():
        print(f"Missing {snipe_path}")
        return 1
    if not sources_path.exists():
        print(f"Missing {sources_path}")
        return 1
    if not raids_path.exists() or not loot_path.exists():
        print("Missing raids.csv or raid_loot.csv (export from Supabase for last-3 DKP costs)")
        return 1

    snipe_rows = parse_snipe(snipe_path)
    item_sources = load_item_sources(sources_path)
    raid_id_to_date = load_raids(raids_path)
    raid_loot_rows = load_raid_loot(loot_path)
    last3_by_item = build_last3_avg_by_item(raid_loot_rows, raid_id_to_date)

    # Match item name to last3: try exact then normalized
    def get_last3(item_name: str):
        n = normalize_item_for_lookup(item_name)
        for key, (costs, avg) in last3_by_item.items():
            if key.lower() == n:
                return costs, avg
        return [], 0.0

    out_dir = repo / "data"
    out_dir.mkdir(parents=True, exist_ok=True)
    loot_csv = out_dir / "snipe_loot_analysis.csv"
    raids_csv = out_dir / "snipe_raids_dkp.csv"

    # ---- Loot CSV ---- Use raid_date() so timestamps after midnight (00:00–05:59) count as previous day (same raid).
    loot_rows = []
    player_loot_dkp: dict[str, float] = defaultdict(float)
    for dt_str, item, player in snipe_rows:
        mob, zone = item_sources.get(normalize_item_for_lookup(item), ("", ""))
        costs, avg_dkp = get_last3(item)
        dkp_used = avg_dkp
        rd = raid_date(dt_str)
        raid_type, raid_dkp = RAID_DATE_MAP.get(rd, ("", 0)) if rd else ("", 0)
        player_loot_dkp[player] += dkp_used
        loot_rows.append({
            "timestamp": dt_str,
            "raid_date": rd or "",
            "raid_type": raid_type,
            "raid_dkp_earned": raid_dkp,
            "item": item,
            "player": player,
            "mob": mob,
            "zone": zone,
            "cost_1": costs[0] if len(costs) > 0 else "",
            "cost_2": costs[1] if len(costs) > 1 else "",
            "cost_3": costs[2] if len(costs) > 2 else "",
            "last3_avg_dkp": avg_dkp,
        })

    with open(loot_csv, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(
            f,
            fieldnames=["timestamp", "raid_date", "raid_type", "raid_dkp_earned", "item", "player", "mob", "zone", "cost_1", "cost_2", "cost_3", "last3_avg_dkp"],
        )
        w.writeheader()
        w.writerows(loot_rows)
    print(f"Wrote {loot_csv} ({len(loot_rows)} rows)")

    total_loot_dkp = sum(player_loot_dkp.values())
    print("\n--- Loot DKP (last3 avg) by player ---")
    for player in sorted(player_loot_dkp.keys()):
        print(f"  {player}: {player_loot_dkp[player]:.0f}")
    print(f"  TOTAL: {total_loot_dkp:.0f}")

    # ---- Raids CSV: from canonical RAID_DATE_MAP (one row per raid day). No Cursed row; 11/7 is Cursed in map.
    raid_rows = [{"date": d, "raid_type": rt, "dkp_earned": dkp} for d, (rt, dkp) in sorted(RAID_DATE_MAP.items())]
    with open(raids_csv, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["date", "raid_type", "dkp_earned"])
        w.writeheader()
        w.writerows(raid_rows)
    print(f"\nWrote {raids_csv}")
    total_raid_dkp = sum(dk for _, dk in RAID_DATE_MAP.values())
    print(f"  TOTAL raid DKP: {total_raid_dkp}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
