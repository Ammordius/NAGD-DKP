#!/usr/bin/env python3
"""
Link CSV char_ids to existing accounts by character name.

The diff script treats "unlinked" = char_id from the CSV is not in character_account.
So even if "Abomination" (name) is already linked under account Abomination, the CSV
uses char_id 21973208 — and if 21973208 is not in character_account, the diff puts
Abomination in the 226. This script links those CSV char_ids to the existing account
for that character name (so they drop out of the 226).

  python scripts/pull_parse_dkp_site/link_csv_char_ids_to_existing_accounts.py [--dry-run] [--apply]

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY; data/raid_event_attendance.csv and data/raid_loot.csv.
"""

from __future__ import annotations

import os
import sys
from collections import defaultdict
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent.parent
PAGE_SIZE = 1000
DATA_DIR = ROOT / "data"


def _load_env(path: Path) -> None:
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip("'\""))
    except Exception:
        pass


def _norm(s) -> str:
    if s is None:
        return ""
    try:
        if isinstance(s, float) and s != s:
            return ""
    except Exception:
        pass
    return (str(s) or "").strip()


def fetch_all(client, table: str, columns: str = "*") -> list[dict]:
    out = []
    offset = 0
    while True:
        r = client.table(table).select(columns).range(offset, offset + PAGE_SIZE - 1).execute()
        rows = r.data or []
        if not rows:
            break
        out.extend(rows)
        if len(rows) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
    return out


def main() -> int:
    import argparse
    ap = argparse.ArgumentParser(description="Link CSV char_ids to existing accounts by character name.")
    ap.add_argument("--data-dir", type=Path, default=DATA_DIR)
    ap.add_argument("--dry-run", action="store_true", help="Only print what would be done")
    ap.add_argument("--apply", action="store_true", help="Write to Supabase")
    args = ap.parse_args()
    if not args.apply:
        args.dry_run = True

    for p in (ROOT / ".env", ROOT / "web" / ".env", ROOT / "web" / ".env.local"):
        if p.exists():
            _load_env(p)
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip() or os.environ.get("SUPABASE_ANON_KEY", "").strip()
    if not url or not key:
        print("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.", file=sys.stderr)
        return 1

    try:
        import pandas as pd
        from supabase import create_client
    except ImportError as e:
        print(f"Need pandas and supabase: {e}", file=sys.stderr)
        return 1

    client = create_client(url, key)
    rea_path = args.data_dir / "raid_event_attendance.csv"
    loot_path = args.data_dir / "raid_loot.csv"
    if not rea_path.exists():
        print(f"Missing {rea_path}", file=sys.stderr)
        return 1

    # Unique (char_id, character_name) from CSV
    df_rea = pd.read_csv(rea_path)
    csv_pairs = set()
    for _, r in df_rea.iterrows():
        cid, cname = _norm(r.get("char_id", "")), _norm(r.get("character_name", ""))
        if cid and cname:
            csv_pairs.add((cid, cname))
    if loot_path.exists():
        df_loot = pd.read_csv(loot_path)
        for _, r in df_loot.iterrows():
            cid, cname = _norm(r.get("char_id", "")), _norm(r.get("character_name", ""))
            if cid and cname:
                csv_pairs.add((cid, cname))
    print(f"CSV: {len(csv_pairs)} unique (char_id, character_name) pairs")

    # Supabase: same name->account logic as diff_inactive_tic_loot_dry_run
    accounts = fetch_all(client, "accounts", "account_id, display_name, toon_names")
    ca_list = fetch_all(client, "character_account", "char_id, account_id")
    characters = fetch_all(client, "characters", "char_id, name")

    known_char_ids = {_norm(r.get("char_id", "")) for r in ca_list if _norm(r.get("char_id", ""))}
    char_id_to_name = {_norm(r["char_id"]): _norm(r.get("name", "")) for r in characters if _norm(r.get("char_id", ""))}

    account_to_names = defaultdict(set)
    for r in accounts:
        aid = _norm(r.get("account_id", ""))
        if not aid:
            continue
        dn = _norm(r.get("display_name", ""))
        if dn:
            account_to_names[aid].add(dn)
        tn = _norm(r.get("toon_names", ""))
        if tn:
            for part in tn.split(","):
                account_to_names[aid].add(part.strip())
    for r in ca_list:
        aid, cid = _norm(r.get("account_id", "")), _norm(r.get("char_id", ""))
        if aid and cid:
            name = char_id_to_name.get(cid, "")
            if name:
                account_to_names[aid].add(name)

    name_to_account_ids = defaultdict(list)
    for aid, names in account_to_names.items():
        for n in names:
            if n and aid not in name_to_account_ids[n]:
                name_to_account_ids[n].append(aid)

    # Characters table: which char_ids exist
    existing_char_ids = set(char_id_to_name.keys())

    to_link = []
    for cid, cname in csv_pairs:
        if cid in known_char_ids:
            continue
        accs = name_to_account_ids.get(cname)
        if not accs:
            continue
        to_link.append((cid, cname, accs[0]))

    if not to_link:
        print("No (char_id, name) pairs from CSV need linking: all CSV char_ids are already linked or name has no existing account.")
        return 0

    print(f"Would link {len(to_link)} CSV char_ids to existing accounts (dry run: no writes).")
    for cid, cname, acc_id in sorted(to_link, key=lambda x: (x[1], x[0]))[:30]:
        print(f"  {cid!r} ({cname!r}) -> account {acc_id!r}")
    if len(to_link) > 30:
        print(f"  ... and {len(to_link) - 30} more")

    if args.dry_run:
        print("\nRe-run with --apply to insert into characters (if missing) and character_account.")
        return 0

    BATCH = 100
    chars_ins = 0
    links_ins = 0
    for cid, cname, acc_id in to_link:
        if cid not in existing_char_ids:
            client.table("characters").upsert([{"char_id": cid, "name": cname}], on_conflict="char_id").execute()
            existing_char_ids.add(cid)
            chars_ins += 1
        client.table("character_account").upsert([{"char_id": cid, "account_id": acc_id}], on_conflict="char_id,account_id").execute()
        links_ins += 1
    print(f"\nDone. Characters inserted: {chars_ins}, character_account links: {links_ins}")
    print("Re-run diff: python scripts/pull_parse_dkp_site/diff_inactive_tic_loot_dry_run.py --data-dir data [--write]")
    return 0


if __name__ == "__main__":
    sys.exit(main())
