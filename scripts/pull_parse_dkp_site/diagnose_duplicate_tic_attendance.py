#!/usr/bin/env python3
"""
Diagnose duplicate TIC attendance for a raid/account.
Example: a character was added to the same tic twice (Earned 6/5 DKP).

Usage:
  Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY).
  python scripts/pull_parse_dkp_site/diagnose_duplicate_tic_attendance.py --raid-id 1598662 --account-id 22036510

Optional: --fix to print SQL to remove duplicate rows (run in Supabase SQL Editor).
"""

import argparse
import os
import sys

def main():
    parser = argparse.ArgumentParser(description="Diagnose duplicate raid_event_attendance for a raid/account")
    parser.add_argument("--raid-id", required=True, help="Raid ID (e.g. 1598662)")
    parser.add_argument("--account-id", required=True, help="Account ID (e.g. 22036510)")
    parser.add_argument("--fix", action="store_true", help="Print SQL to fix duplicates (run in Supabase SQL Editor)")
    args = parser.parse_args()

    try:
        from dotenv import load_dotenv
        load_dotenv()
    except ImportError:
        pass

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
    raid_id = args.raid_id.strip()
    account_id = args.account_id.strip()

    # 1) Characters on this account
    r = client.table("character_account").select("char_id").eq("account_id", account_id).execute()
    char_ids = [row["char_id"] for row in (r.data or []) if row.get("char_id")]
    if not char_ids:
        print(f"No characters found for account_id={account_id}")
        return 0

    # 2) All raid_event_attendance for this raid
    r = client.table("raid_event_attendance").select("id, raid_id, event_id, char_id, character_name").eq("raid_id", raid_id).execute()
    rows = r.data or []

    # 3) Find duplicates: same (raid_id, event_id) + same character (by char_id or by character_name)
    from collections import defaultdict
    by_event_and_char_id = defaultdict(list)  # (event_id, char_id) -> [rows] when char_id set
    by_event_and_name = defaultdict(list)   # (event_id, name) -> [rows]
    for row in rows:
        eid = str(row.get("event_id") or "").strip()
        cid = str(row.get("char_id") or "").strip()
        name = str(row.get("character_name") or "").strip()
        if eid:
            if cid:
                by_event_and_char_id[(eid, cid)].append(row)
            if name:
                by_event_and_name[(eid, name)].append(row)

    duplicates_char_id = {k: v for k, v in by_event_and_char_id.items() if len(v) > 1}
    duplicates_name = {k: v for k, v in by_event_and_name.items() if len(v) > 1}

    # Restrict to this account's characters for reporting
    account_char_ids = set(char_ids)
    def on_account(row):
        cid = str(row.get("char_id") or "").strip()
        name = str(row.get("character_name") or "").strip()
        if cid and cid in account_char_ids:
            return True
        # name match: need char_id in account or character name in account's toons
        if name:
            r2 = client.table("characters").select("char_id").eq("name", name).execute()
            for x in (r2.data or []):
                if str(x.get("char_id", "")).strip() in account_char_ids:
                    return True
        return False

    print(f"Raid ID: {raid_id}")
    print(f"Account ID: {account_id}")
    print(f"Characters on account: {char_ids}")
    print()

    if duplicates_char_id or duplicates_name:
        print("Duplicate TIC attendance found (same event_id + same char_id or same character_name):")
        ids_to_delete = []
        for (eid, cid), list_rows in duplicates_char_id.items():
            print(f"  event_id={eid} char_id={cid}: {len(list_rows)} rows (ids: {[r['id'] for r in list_rows]})")
            sorted_rows = sorted(list_rows, key=lambda r: r["id"])
            for r in sorted_rows[1:]:
                ids_to_delete.append(r["id"])
        for (eid, name), list_rows in duplicates_name.items():
            # Skip if this is the same group as a char_id duplicate (same rows)
            if len(list_rows) <= 1:
                continue
            print(f"  event_id={eid} character_name={name}: {len(list_rows)} rows (ids: {[r['id'] for r in list_rows]})")
            # Keep one: prefer row with char_id set; else keep lowest id
            sorted_rows = sorted(
                list_rows,
                key=lambda r: (1 if (r.get("char_id") and str(r.get("char_id") or "").strip()) else 0, r["id"]),
            )
            for r in sorted_rows[1:]:
                ids_to_delete.append(r["id"])

        ids_to_delete = list(dict.fromkeys(ids_to_delete))

        if args.fix and ids_to_delete:
            print()
            print("-- Run the following in Supabase SQL Editor to remove duplicate attendance rows:")
            print("BEGIN;")
            for iid in ids_to_delete:
                print(f"  DELETE FROM raid_event_attendance WHERE id = {iid};")
            print("  SELECT refresh_raid_attendance_totals(%s);" % repr(raid_id))
            print("  SELECT refresh_dkp_summary();")
            print("COMMIT;")
    else:
        print("No duplicate (raid_id, event_id, char_id) or (raid_id, event_id, character_name) found in raid_event_attendance.")
        print("If DKP still shows 6/5, check: (1) name-only vs char_id double count (run docs/fix_frinop_double_count_remove_name_only_duplicate_tics.sql), (2) raid_attendance_dkp/dkp_summary refresh.")

    # 4) Per-event count for this account's chars (to see 6 vs 5)
    r_events = client.table("raid_events").select("event_id, event_order, dkp_value, event_name").eq("raid_id", raid_id).order("event_order").execute()
    events = r_events.data or []
    print()
    print("Raid events (tics) and DKP:")
    for e in events:
        print(f"  {e.get('event_id')} order={e.get('event_order')} dkp_value={e.get('dkp_value')} {e.get('event_name') or ''}")
    print()
    for cid in char_ids:
        count = sum(1 for row in rows if str(row.get("char_id") or "").strip() == cid)
        if count > 0:
            names = [r.get("character_name") for r in rows if str(r.get("char_id") or "").strip() == cid]
            print(f"  char_id={cid} appears {count} time(s) in raid_event_attendance for this raid (event_ids: {list(set(r['event_id'] for r in rows if str(r.get('char_id') or '').strip() == cid))})")

    return 0


if __name__ == "__main__":
    sys.exit(main())
