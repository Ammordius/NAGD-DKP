#!/usr/bin/env python3
"""
Remove duplicate account entries from raid_event_attendance (DKP tics).
Only one character per account per tic is allowed; this script finds any
second (or later) occurrence of the same account on a tic and deletes those rows.

Usage:
  python scripts/dedupe_raid_event_attendance.py [--apply]
  python scripts/dedupe_raid_event_attendance.py --account 22075554   # only show/fix duplicates for this account

Without --apply, prints what would be deleted (dry run).
Uses .env / web/.env for SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent  # repo root


def _load_env(path: Path) -> None:
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
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


def main() -> int:
    import argparse
    ap = argparse.ArgumentParser(description="Remove duplicate account-per-tic from raid_event_attendance")
    ap.add_argument("--apply", action="store_true", help="Perform deletes; without this, dry run only")
    ap.add_argument("--account", type=str, default="", help="If set, only report/remove duplicates for this account_id (e.g. 22075554)")
    ap.add_argument("--date", type=str, default="", help="If set with --apply, only delete duplicates for raids on this date (YYYY-MM-DD, e.g. 2026-02-17)")
    args = ap.parse_args()
    filter_account = (args.account or "").strip()
    filter_date = (args.date or "").strip()

    for path in (ROOT / ".env", ROOT / "web" / ".env", ROOT / "web" / ".env.local"):
        if path.exists():
            _load_env(path)
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip() or os.environ.get("SUPABASE_ANON_KEY", "").strip()
    if not url or not key:
        print("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY).", file=sys.stderr)
        return 1

    try:
        from supabase import create_client
    except ImportError:
        print("pip install supabase", file=sys.stderr)
        return 1

    client = create_client(url, key)

    # Fetch all raid_event_attendance with id, char_id, character_name (name used for same-person dedupe)
    rea_rows = []
    rea_from = 0
    rea_page = 1000
    while True:
        r = client.table("raid_event_attendance").select("id, raid_id, event_id, char_id, character_name").range(rea_from, rea_from + rea_page - 1).execute()
        data = getattr(r, "data", None) or []
        if not data:
            break
        rea_rows.extend(data)
        if len(data) < rea_page:
            break
        rea_from += rea_page

    # Fetch character_account
    char_to_account: dict[str, str] = {}
    ca_from = 0
    ca_page = 1000
    while True:
        r = client.table("character_account").select("char_id, account_id").range(ca_from, ca_from + ca_page - 1).execute()
        data = getattr(r, "data", None) or []
        for row in data:
            cid = (row.get("char_id") or "").strip()
            aid = (row.get("account_id") or "").strip()
            if cid and aid and cid not in char_to_account:
                char_to_account[cid] = aid
        if len(data) < ca_page:
            break
        ca_from += ca_page

    # For each (raid_id, event_id), keep one row per account (smallest id), mark rest for deletion.
    # Track which account and tic each deleted id belongs to (for --account filter).
    ids_to_delete: list[int] = []
    id_to_account: dict[int, str] = {}
    id_to_tic: dict[int, tuple[str, str]] = {}
    id_to_character_name: dict[int, str] = {}
    duplicates_by_tic: dict[tuple[str, str], int] = {}
    by_tic: dict[tuple[str, str], list[dict]] = {}
    for row in rea_rows:
        rid = (row.get("raid_id") or "").strip()
        eid = (row.get("event_id") or "").strip()
        cid = (row.get("char_id") or "").strip()
        row_id = row.get("id")
        if row_id is None:
            continue
        key = (rid, eid)
        if key not in by_tic:
            by_tic[key] = []
        cname = (row.get("character_name") or "").strip()
        by_tic[key].append({"id": row_id, "char_id": cid, "character_name": cname})

    for (raid_id, event_id), rows in by_tic.items():
        # Pass 1: dedupe by account (one row per account per tic)
        account_to_ids: dict[str, list[int]] = {}
        for row in rows:
            cid = row["char_id"]
            account_id = char_to_account.get(cid) if cid else None
            account_key = str(account_id) if account_id else (cid or f"unknown_{row['id']}")
            if account_key not in account_to_ids:
                account_to_ids[account_key] = []
            account_to_ids[account_key].append(row["id"])
        tic_deletes_total = 0
        for account_key, id_list in account_to_ids.items():
            if len(id_list) <= 1:
                continue
            id_list.sort()
            to_del = id_list[1:]
            ids_to_delete.extend(to_del)
            for i in to_del:
                id_to_account[i] = account_key
                id_to_tic[i] = (raid_id, event_id)
                id_to_character_name[i] = next((r.get("character_name") or r.get("char_id") or "" for r in rows if r["id"] == i), "")
            tic_deletes_total += len(to_del)
        # Pass 2: dedupe by same character (same character_name or char_id twice on tic)
        # Catches e.g. same person listed twice when one char isn't linked to account
        person_to_ids: dict[str, list[int]] = {}
        for row in rows:
            name_key = (row.get("character_name") or "").strip().lower() or (row["char_id"] or "") or f"unknown_{row['id']}"
            if name_key not in person_to_ids:
                person_to_ids[name_key] = []
            person_to_ids[name_key].append(row["id"])
        for name_key, id_list in person_to_ids.items():
            if len(id_list) <= 1:
                continue
            id_list.sort()
            to_del = id_list[1:]
            for i in to_del:
                if i not in id_to_tic:  # not already marked by account dedupe
                    ids_to_delete.append(i)
                    id_to_tic[i] = (raid_id, event_id)
                    row_i = next((r for r in rows if r["id"] == i), None)
                    cid = row_i["char_id"] if row_i else None
                    aid = char_to_account.get(cid, "") if cid else ""
                    id_to_account[i] = str(aid) if aid else (cid or name_key)
                    id_to_character_name[i] = (row_i.get("character_name") or row_i.get("char_id") or "") if row_i else ""
                    tic_deletes_total += 1
        if tic_deletes_total:
            duplicates_by_tic[(raid_id, event_id)] = tic_deletes_total
    # If filtering by account, keep only ids for that account and only tics where that account had a duplicate
    if filter_account:
        ids_to_delete = [i for i in ids_to_delete if id_to_account.get(i) == filter_account]
        from collections import Counter
        duplicates_by_tic = dict(Counter(id_to_tic[i] for i in ids_to_delete))
        if not ids_to_delete:
            print(f"No duplicate account-per-tic rows found for account_id={filter_account!r}.")
            return 0
        print(f"Account {filter_account}: found {len(ids_to_delete)} duplicate row(s) on {len(duplicates_by_tic)} tic(s).")
    else:
        if not ids_to_delete:
            print("No duplicate account-per-tic rows found. Nothing to remove.")
            return 0
        print(f"Found {len(ids_to_delete)} duplicate row(s) (same account or same character on same tic more than once).")

    print()
    # Fetch raid and event labels for display
    raid_ids = list({rid for (rid, _) in duplicates_by_tic})
    raids_map: dict[str, dict] = {}
    for rid in raid_ids:
        try:
            r = client.table("raids").select("raid_id, raid_name, date_iso").eq("raid_id", rid).limit(1).execute()
            data = getattr(r, "data", None) or []
            if data:
                raids_map[rid] = data[0]
        except Exception:
            pass
    events_map: dict[tuple[str, str], dict] = {}
    for (rid, eid) in duplicates_by_tic:
        try:
            r = client.table("raid_events").select("event_id, event_name, event_order").eq("raid_id", rid).eq("event_id", eid).limit(1).execute()
            data = getattr(r, "data", None) or []
            if data:
                events_map[(rid, eid)] = data[0]
        except Exception:
            pass
    # Optional: only apply deletes for raids on this date
    ids_to_apply = ids_to_delete
    if filter_date and args.apply:
        ids_to_apply = [i for i in ids_to_delete if (raids_map.get(id_to_tic[i][0]) or {}).get("date_iso") == filter_date]
        print(f"Date filter: only applying deletes for raids on {filter_date!r} ({len(ids_to_apply)} of {len(ids_to_delete)} row(s)).")
        print()
    # Fetch account display names for "by account" listing
    account_ids = list({id_to_account.get(i) for i in ids_to_delete if id_to_account.get(i) and id_to_account.get(i).isdigit()})
    account_display: dict[str, str] = {}
    for aid in account_ids:
        try:
            r = client.table("accounts").select("account_id, display_name").eq("account_id", aid).limit(1).execute()
            data = getattr(r, "data", None) or []
            if data and data[0].get("account_id"):
                account_display[aid] = (data[0].get("display_name") or "").strip() or aid
        except Exception:
            pass
    # List all duplicates by account and character
    print("All duplicates by account and character (row to remove):")
    print("-" * 80)
    from collections import defaultdict
    by_acc: dict[str, list[tuple[str, str, str]]] = defaultdict(list)  # account_key -> [(date_iso, event_name, character_name), ...]
    for i in ids_to_delete:
        rid, eid = id_to_tic[i]
        raid = raids_map.get(rid) or {}
        ev = events_map.get((rid, eid)) or {}
        date_iso = (raid.get("date_iso") or "").strip()
        event_name = (ev.get("event_name") or "").strip() or eid
        cname = (id_to_character_name.get(i) or "").strip() or "(no name)"
        acc = id_to_account.get(i) or "?"
        by_acc[acc].append((date_iso, event_name, cname))
    for acc in sorted(by_acc.keys(), key=lambda a: (account_display.get(a) or a).lower()):
        display = account_display.get(acc) or acc
        label = f"{display} (account {acc})" if acc.isdigit() and display != acc else (display or acc)
        print(f"  Account: {label}")
        for date_iso, event_name, cname in sorted(by_acc[acc], key=lambda x: (x[0], x[1])):
            print(f"    {date_iso}  {event_name!r}  -  character: {cname}")
        print()
    print("-" * 80)
    if not args.apply:
        print("Dry run. Use --apply to delete. Use --date YYYY-MM-DD with --apply to fix only that date.")
        return 0

    # Delete in batches (only ids_to_apply, which may be filtered by --date)
    batch_size = 200
    for i in range(0, len(ids_to_apply), batch_size):
        batch = ids_to_apply[i : i + batch_size]
        try:
            client.table("raid_event_attendance").delete().in_("id", batch).execute()
        except Exception as e:
            print(f"Error deleting batch: {e}", file=sys.stderr)
            return 1
    print(f"Deleted {len(ids_to_apply)} duplicate row(s).")

    try:
        client.rpc("refresh_dkp_summary").execute()
        print("refresh_dkp_summary() completed.")
    except Exception as e:
        print(f"Warning: refresh_dkp_summary: {e}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())
