#!/usr/bin/env python3
"""
Classify raids by type for DKP analysis (earned/spent by raid type over time).

Primary source: raid_name (keyword matching).
Secondary source: raid loot (many elemental loots drop in multiple places — use only as hint for unclassified).

Outputs:
- data/raid_type_assignments.csv  (raid_id, raid_type, raid_name, date_iso, source)
- data/raid_type_summary.json     (counts by type, by year; DKP by type for last 3 years)
- Optional: print summary and sample unclassified names for tuning.

Usage:
  # From repo root, using existing data/raids.csv and data/raid_loot.csv
  python scripts/classify_raid_types.py

  # Using extracted backup (extract zip then: tar -xzf backup_2_28/backup-2026-02-28.tar.gz -C backup_2_28)
  python scripts/classify_raid_types.py --raids backup_2_28/backup/raids.csv --loot backup_2_28/backup/raid_loot.csv --dkp-totals backup_2_28/backup/raid_dkp_totals.csv --out-dir data

  # Focus on last N days for summary (default 3 years)
  python scripts/classify_raid_types.py --recent-days 1095
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from datetime import datetime, timedelta


# Raid type taxonomy. Order matters: first match wins (more specific patterns first).
# Patterns are case-insensitive; we match against raid_name and optionally event names.
RAID_TYPE_RULES: list[tuple[str, str]] = [
    # Plane of Time (be specific first)
    (r"\b(?:plane of )?time\b", "PoTime"),
    (r"\bpotime\b", "PoTime"),
    (r"\bp1[- ]?p?[34]\b", "PoTime"),  # P1-3, P1-4, P1P3
    (r"\b(?:time )?day\s*1\b", "PoTime"),  # "Time Day 1"
    (r"\bslinkytime\b", "PoTime"),
    (r"\btime\s+raid\b", "PoTime"),
    (r"\btime\s+for\s+time\b", "PoTime"),
    (r"\btime\s+day\b", "PoTime"),
    (r"\b(?:poe?2?|plane of earth 2)\b", "PoTime"),  # PoE2 kill = Plane of Time entry
    # Vex Thal
    (r"\bvex\s*thal\b", "Vex Thal"),
    (r"\bvt\b", "Vex Thal"),
    # Elemental planes (group as "Elemental" or could split; we use Elemental for combined)
    (r"\bfire\s*minis?\b", "Elemental"),
    (r"\bwater\s*minis?\b", "Elemental"),
    (r"\bearth\s*(?:minis?|stuff)?\b", "Elemental"),
    (r"\bair\s*minis?\b", "Elemental"),
    (r"\bfennin\b", "Elemental"),
    (r"\bcoirnav\b", "Elemental"),
    (r"\b(?:poe|plane of earth)\b", "Elemental"),  # PoE = Plane of Earth (not Time)
    (r"\b(?:pow|plane of water)\b", "Elemental"),
    (r"\b(?:pof|plane of fire)\b", "Elemental"),
    (r"\b(?:poa|plane of air)\b", "Elemental"),
    (r"\belemental\b", "Elemental"),
    (r"\bcorinav\b", "Elemental"),
    # Generic fire/water keywords as a fallback when more specific rules do not match.
    # This will classify things like "FireFeast" or "Rangers Hate Water" nights as Elemental.
    (r"\bfire\b", "Elemental"),
    (r"\bflames?\b", "Elemental"),
    (r"\bwater\b", "Elemental"),
    # Temple of Veeshan / ToV
    (r"\btov\b", "ToV"),
    (r"\btemple of veeshan\b", "ToV"),
    (r"\bveeshan'?s? peak\b", "ToV"),
    (r"\bphara\s*dar\b", "ToV"),
    # Kael / Dozekar / AOW / Statue
    (r"\bdoze(?:kar)?\b", "Kael"),
    (r"\baow\b", "Kael"),
    (r"\bstatue\b", "Kael"),
    (r"\bkt\b", "Kael"),
    (r"\bkael\b", "Kael"),
    (r"\brallos\b", "Kael"),
    (r"\btormax\b", "Kael"),
    (r"\b(?:derakor|dain)\b", "Kael"),
    # God raids (TVX = Tunare / Vallon Zek / Xegony, etc.)
    (r"\btvx\b", "God"),
    (r"\btunare\b", "God"),
    (r"\bvallon\s*zek\b", "God"),
    (r"\bxegony\b", "God"),
    (r"\bterris\s*thule\b", "God"),
    (r"\bsoluse?k\b", "God"),
    (r"\bnagafen\b", "God"),
    (r"\bvox\b", "God"),
    (r"\bbertox\b", "God"),
    (r"\brhags\b", "God"),  # Rallos Zek
    (r"\bsaryrn\b", "God"),
    # Sleeper's Tomb
    (r"\bsleeper\b", "Sleeper"),
    (r"\bst\b", "Sleeper"),
    # Rathe Council
    (r"\brathe\s*council\b", "Rathe Council"),
    # Praesertum / Seru
    (r"\bpraes(?:ertum)?\b", "Praesertum"),
    (r"\bseru\b", "Praesertum"),
    # Burrower / other named
    (r"\bburrower\b", "Burrower"),
    (r"\bdeep\s*burrower\b", "Burrower"),
    # Ssra / Ssraeshza
    (r"\bssra\b", "Ssra"),
    # Akheva / VT-related
    (r"\bakheva\b", "Akheva"),
    # HP = High Priest (Ssra?)
    (r"\bhp\s*snek\b", "Ssra"),
    # Yeli = Yelinak
    (r"\byeli\b", "ToV"),
    (r"\bvelk\b", "ToV"),
    # More abbreviations and variants
    (r"\bsleepers?\s*tomb\b", "Sleeper"),
    (r"\b(?:udb|trakanon|trak)\b", "Sleeper"),
    (r"\bntov\b", "ToV"),
    (r"\bwtov\b", "ToV"),
    (r"\bvulak\b", "ToV"),
    (r"\bzlandicar\b", "ToV"),
    (r"\bquarm\b", "PoTime"),
    (r"\bp[45]\b", "PoTime"),  # P4, P5
    (r"\bp1\s*[-–]\s*p3\b", "PoTime"),
    (r"\bsolro\b", "God"),
    (r"\bsaryn\b", "God"),
    (r"\bbert(?:ox)?\b", "God"),
    (r"\bcarprin\b", "God"),
    (r"\bxmastime\b", "PoTime"),
    (r"\bcurse[- ]?emp\b", "Elemental"),
]

# Loot item name substrings that *suggest* a raid type (only for unclassified raids; not definitive)
LOOT_HINT_TYPE: list[tuple[str, str]] = [
    (r"elemental\s+(?:chain|leather|silk|boot|bracer|vambrace|gauntlet|helm)\s*(?:pattern|mold)?", "Elemental"),
    (r"essence of (?:water|fire|earth)", "Elemental"),
    (r"ancient: (?:chaotic|destruction|greater|legacy|scourge)", "Vex Thal"),
    (r"time phased|timeless coral|ossein of limitless", "PoTime"),
    (r"cloak of wishes|dagger of distraction", "PoTime"),
    (r"umbracite|vex thal|aten ha ra", "Vex Thal"),
    (r"reaver|hammer of battle|rallos zek", "Kael"),
    (r"horn of hsagra|tormax|kael drakkel", "Kael"),
]


def normalize(s: str) -> str:
    if not s or not isinstance(s, str):
        return ""
    return " ".join(s.split()).strip()


def parse_iso_date(s: str) -> datetime | None:
    if not s:
        return None
    s = normalize(s)[:10]
    try:
        return datetime.strptime(s, "%Y-%m-%d")
    except ValueError:
        return None


def classify_from_name(raid_name: str) -> str | None:
    """Return raid_type if raid_name matches any rule, else None."""
    if not raid_name:
        return None
    name_lower = raid_name.lower()
    for pattern, raid_type in RAID_TYPE_RULES:
        if re.search(pattern, name_lower, re.IGNORECASE):
            return raid_type
    return None


def classify_from_loot(item_names: list[str]) -> str | None:
    """Return suggested raid_type from loot (only for unclassified). One match wins."""
    for item_name in item_names:
        if not item_name:
            continue
        item_lower = item_name.lower()
        for pattern, raid_type in LOOT_HINT_TYPE:
            if re.search(pattern, item_lower, re.IGNORECASE):
                return raid_type
    return None


def load_raids(path: Path) -> list[dict]:
    rows = []
    with open(path, "r", encoding="utf-8", newline="") as f:
        r = csv.DictReader(f)
        for row in r:
            rows.append({k.strip(): v for k, v in row.items()})
    return rows


def load_loot_by_raid(path: Path) -> dict[str, list[str]]:
    """raid_id -> list of item_name."""
    by_raid: dict[str, list[str]] = defaultdict(list)
    with open(path, "r", encoding="utf-8", newline="") as f:
        r = csv.DictReader(f)
        for row in r:
            raid_id = (row.get("raid_id") or "").strip()
            item = (row.get("item_name") or "").strip()
            if raid_id and item:
                by_raid[raid_id].append(item)
    return dict(by_raid)


def load_dkp_totals(path: Path) -> dict[str, float]:
    """raid_id -> total_dkp."""
    out = {}
    if not path or not path.exists():
        return out
    with open(path, "r", encoding="utf-8", newline="") as f:
        r = csv.DictReader(f)
        for row in r:
            raid_id = (row.get("raid_id") or "").strip()
            raw = row.get("total_dkp") or "0"
            try:
                out[raid_id] = float(raw)
            except ValueError:
                out[raid_id] = 0.0
    return out


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Classify raids by type (raid_name primary, loot secondary) for DKP-by-type analysis."
    )
    ap.add_argument("--raids", type=Path, default=Path("data/raids.csv"), help="raids CSV")
    ap.add_argument("--loot", type=Path, default=Path("data/raid_loot.csv"), help="raid_loot CSV")
    ap.add_argument("--dkp-totals", type=Path, default=None, help="raid_dkp_totals CSV (optional)")
    ap.add_argument("--out-dir", type=Path, default=Path("data"), help="Output directory")
    ap.add_argument("--recent-days", type=int, default=1095, help="Consider 'recent' for summary (default 3 years)")
    ap.add_argument("--show-unclassified", type=int, default=40, help="Print N sample unclassified raid names (0=off)")
    args = ap.parse_args()

    if not args.raids.exists():
        print(f"Missing {args.raids}. Run from repo root or pass --raids.", file=sys.stderr)
        return 1

    raids = load_raids(args.raids)
    loot_by_raid = load_loot_by_raid(args.loot) if args.loot.exists() else {}
    dkp_totals = load_dkp_totals(args.dkp_totals) if args.dkp_totals else {}

    assignments: list[dict] = []
    by_type: defaultdict[str, list[str]] = defaultdict(list)
    unclassified_names: list[str] = []

    for r in raids:
        raid_id = normalize(r.get("raid_id") or "")
        raid_name = normalize(r.get("raid_name") or "")
        date_iso = normalize(r.get("date_iso") or "")
        raid_type = classify_from_name(raid_name)
        source = "name"
        if raid_type is None:
            items = loot_by_raid.get(raid_id, [])
            raid_type = classify_from_loot(items)
            if raid_type is not None:
                source = "loot"
            else:
                raid_type = "Unclassified"
                if raid_name:
                    unclassified_names.append(raid_name)
        assignments.append({
            "raid_id": raid_id,
            "raid_type": raid_type,
            "raid_name": raid_name,
            "date_iso": date_iso,
            "source": source,
        })
        by_type[raid_type].append(raid_id)

    args.out_dir.mkdir(parents=True, exist_ok=True)
    out_assignments = args.out_dir / "raid_type_assignments.csv"
    with open(out_assignments, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["raid_id", "raid_type", "raid_name", "date_iso", "source"])
        w.writeheader()
        w.writerows(assignments)
    print(f"Wrote {len(assignments)} assignments -> {out_assignments}")

    # Summary: counts by type
    type_counts = {t: len(ids) for t, ids in sorted(by_type.items(), key=lambda x: -len(x[1]))}
    cutoff = datetime.now() - timedelta(days=args.recent_days)
    recent_assignments = [a for a in assignments if parse_iso_date(a["date_iso"]) and parse_iso_date(a["date_iso"]) >= cutoff]
    recent_by_type: defaultdict[str, int] = defaultdict(int)
    for a in recent_assignments:
        recent_by_type[a["raid_type"]] += 1

    # DKP by type (recent only, using dkp_totals when available)
    dkp_by_type: defaultdict[str, float] = defaultdict(float)
    for a in assignments:
        if parse_iso_date(a["date_iso"]) and parse_iso_date(a["date_iso"]) >= cutoff:
            total = dkp_totals.get(a["raid_id"], 0.0)
            dkp_by_type[a["raid_type"]] += total

    # DKP by type by month (recent) for trend analysis
    dkp_by_month_type: defaultdict[str, defaultdict[str, float]] = defaultdict(lambda: defaultdict(float))
    for a in assignments:
        dt = parse_iso_date(a["date_iso"])
        if dt and dt >= cutoff:
            total = dkp_totals.get(a["raid_id"], 0.0)
            month_key = dt.strftime("%Y-%m")
            dkp_by_month_type[month_key][a["raid_type"]] += total
    dkp_series = []
    for month in sorted(dkp_by_month_type.keys(), reverse=True)[:24]:
        for t, dkp in dkp_by_month_type[month].items():
            if dkp > 0:
                dkp_series.append({"month": month, "raid_type": t, "dkp": round(dkp, 2)})

    summary = {
        "total_raids": len(assignments),
        "recent_days": args.recent_days,
        "counts_by_type": type_counts,
        "recent_counts_by_type": dict(recent_by_type),
        "dkp_by_type_recent": {k: round(v, 2) for k, v in sorted(dkp_by_type.items(), key=lambda x: -x[1])},
        "dkp_by_month_and_type": dkp_series,
    }
    out_summary = args.out_dir / "raid_type_summary.json"
    with open(out_summary, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)
    print(f"Wrote summary -> {out_summary}")

    print("\n--- Counts by type (all time) ---")
    for t, c in list(type_counts.items())[:20]:
        print(f"  {t}: {c}")
    print("\n--- Recent (last {} days) counts ---".format(args.recent_days))
    for t, c in sorted(recent_by_type.items(), key=lambda x: -x[1]):
        dkp = dkp_by_type.get(t, 0)
        print(f"  {t}: {c} raids, DKP total: {dkp:.0f}")
    if args.show_unclassified and unclassified_names:
        seen = set()
        unique = [n for n in unclassified_names if n and n not in seen and not seen.add(n)]
        print(f"\n--- Sample unclassified raid names (up to {args.show_unclassified}) ---")
        for n in unique[: args.show_unclassified]:
            print(f"  {n!r}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
