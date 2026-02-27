#!/usr/bin/env python3
"""
Compare regenerated CSVs (raid_events, raid_loot, raid_attendance, raid_event_attendance)
to current Supabase state. Dry run only: prints what would change if we re-uploaded
each raid via upload_raid_detail_to_supabase.py (delete existing + insert from HTML/CSV).

  python scripts/pull_parse_dkp_site/diff_csv_supabase_dry_run.py [--data-dir data]
  python scripts/pull_parse_dkp_site/diff_csv_supabase_dry_run.py --limit 20  # first 20 differing raids

Requires: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env / web/.env.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent.parent
PAGE_SIZE = 1000


def _load_env_file(path: Path) -> None:
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip().strip("'\"")
            if k:
                os.environ.setdefault(k, v)
    for vite, plain in (
        ("VITE_SUPABASE_URL", "SUPABASE_URL"),
        ("VITE_SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY"),
        ("VITE_SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"),
    ):
        if not os.environ.get(plain) and os.environ.get(vite):
            os.environ[plain] = os.environ[vite]


def load_dotenv() -> None:
    for path in (ROOT / ".env", ROOT / "web" / ".env", ROOT / "web" / ".env.local"):
        if path.exists():
            _load_env_file(path)


def fetch_table_raid_counts(client, table: str) -> dict[str, int]:
    """Return {raid_id: count} for the given table (must have raid_id column)."""
    from collections import Counter
    counts: Counter[str] = Counter()
    offset = 0
    while True:
        resp = client.table(table).select("raid_id").range(offset, offset + PAGE_SIZE - 1).execute()
        rows = resp.data or []
        if not rows:
            break
        for r in rows:
            rid = (r.get("raid_id") or "").strip()
            if rid:
                counts[rid] += 1
        if len(rows) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
    return dict(counts)


def main() -> int:
    import argparse
    ap = argparse.ArgumentParser(description="Diff CSV vs Supabase (dry run); show what would be re-uploaded.")
    ap.add_argument("--data-dir", type=Path, default=ROOT / "data", help="Directory with raid_*.csv")
    ap.add_argument("--limit", type=int, default=0, help="Max number of differing raids to list (0 = all)")
    args = ap.parse_args()

    data_dir = args.data_dir
    if not data_dir.is_dir():
        print(f"Data directory not found: {data_dir}", file=sys.stderr)
        return 1

    try:
        import pandas as pd
    except ImportError:
        print("pip install pandas", file=sys.stderr)
        return 1

    # Load CSV counts per raid
    csv_events = data_dir / "raid_events.csv"
    csv_loot = data_dir / "raid_loot.csv"
    csv_att = data_dir / "raid_attendance.csv"
    csv_rea = data_dir / "raid_event_attendance.csv"
    for p in (csv_events, csv_loot, csv_att, csv_rea):
        if not p.exists():
            print(f"Missing {p}. Run extract_structured_data.py and parse_raid_attendees.py first.", file=sys.stderr)
            return 1

    def csv_counts(path: Path) -> dict[str, int]:
        df = pd.read_csv(path)
        if "raid_id" not in df.columns:
            return {}
        return df["raid_id"].astype(str).str.strip().value_counts().to_dict()

    print("Loading CSV counts...")
    csv_events_by_raid = csv_counts(csv_events)
    csv_loot_by_raid = csv_counts(csv_loot)
    csv_att_by_raid = csv_counts(csv_att)
    csv_rea_by_raid = csv_counts(csv_rea)

    raid_ids_csv = set(csv_events_by_raid) | set(csv_loot_by_raid) | set(csv_att_by_raid) | set(csv_rea_by_raid)
    print(f"  CSV: {len(raid_ids_csv)} raids, events={sum(csv_events_by_raid.values())}, loot={sum(csv_loot_by_raid.values())}, attendance={sum(csv_att_by_raid.values())}, event_attendance={sum(csv_rea_by_raid.values())}")

    load_dotenv()
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = (
        os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        or os.environ.get("SUPABASE_ANON_KEY", "").strip()
    )
    if not url or not key:
        print("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY).", file=sys.stderr)
        return 1

    try:
        from supabase import create_client
    except ImportError:
        print("pip install supabase", file=sys.stderr)
        return 1

    client = create_client(url, key)
    print("Fetching Supabase counts...")
    db_events = fetch_table_raid_counts(client, "raid_events")
    db_loot = fetch_table_raid_counts(client, "raid_loot")
    db_att = fetch_table_raid_counts(client, "raid_attendance")
    db_rea = fetch_table_raid_counts(client, "raid_event_attendance")
    raid_ids_db = set(db_events) | set(db_loot) | set(db_att) | set(db_rea)
    print(f"  DB:  {len(raid_ids_db)} raids, events={sum(db_events.values())}, loot={sum(db_loot.values())}, attendance={sum(db_att.values())}, event_attendance={sum(db_rea.values())}")

    # Compare: raids where any count differs (would re-upload)
    def diff(rid: str) -> tuple[int, int, int, int]:
        e = (csv_events_by_raid.get(rid, 0) - db_events.get(rid, 0),
             csv_loot_by_raid.get(rid, 0) - db_loot.get(rid, 0),
             csv_att_by_raid.get(rid, 0) - db_att.get(rid, 0),
             csv_rea_by_raid.get(rid, 0) - db_rea.get(rid, 0))
        return e

    differing: list[tuple[str, tuple[int, int, int, int]]] = []
    for rid in sorted(raid_ids_csv | raid_ids_db):
        de, dl, da, dr = diff(rid)
        if de != 0 or dl != 0 or da != 0 or dr != 0:
            differing.append((rid, (de, dl, da, dr)))

    if not differing:
        print("\nNo diff: CSV and Supabase match. Nothing to push.")
        return 0

    print(f"\n--- Dry run: {len(differing)} raid(s) would be re-uploaded (delete + insert from HTML) ---")
    print("Re-upload would run: upload_raid_detail_to_supabase.py --raid-id <id> --apply")
    print("(Requires raid_<id>.html and raid_<id>_attendees.html in raids/ for each.)\n")
    print(f"{'raid_id':<12} {'d_events':>8} {'d_loot':>8} {'d_att':>8} {'d_ev_att':>10}  (CSV - DB)")
    print("-" * 60)

    limit = args.limit or len(differing)
    for rid, (de, dl, da, dr) in differing[:limit]:
        print(f"{rid:<12} {de:>+8} {dl:>+8} {da:>+8} {dr:>+10}")
    if limit < len(differing):
        print(f"... and {len(differing) - limit} more (use --limit 0 to show all)")

    # Summary by type of diff
    more_att = sum(1 for _, (_, _, da, dr) in differing if da > 0 or dr > 0)
    more_loot = sum(1 for _, (_, dl, _, _) in differing if dl > 0)
    print(f"\nSummary: {more_att} raid(s) would gain attendance/event_attendance; {more_loot} would gain loot.")
    print("Dry run only. To apply, run for each raid: python scripts/pull_parse_dkp_site/upload_raid_detail_to_supabase.py --raid-id <id> --apply")
    return 0


if __name__ == "__main__":
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    sys.exit(main())
