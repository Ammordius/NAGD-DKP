#!/usr/bin/env python3
"""
Parse one raid's detail HTML (raid_{raid_id}.html) and upload events, loot, and
attendance to Supabase so "DKP by tic", loot, and attendance show for that raid.

If you only saved the *attendees* page, you must also save the main raid details page:
  https://azureguardtakp.gamerlaunch.com/rapid_raid/raid_details.php?raid_pool=562569&raidId=1598662&gid=547766
Save As → raids/raid_1598662.html (same folder as raid_1598662_attendees.html).

Then run:
  python scripts/upload_raid_detail_to_supabase.py --raid-id 1598662 [--apply]

Without --apply, prints what would be uploaded (dry run).
Uses .env / web/.env for SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


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
    ap = argparse.ArgumentParser(description="Upload one raid's events, loot, attendance to Supabase")
    ap.add_argument("--raid-id", type=str, default="1598662", help="Raid ID (e.g. 1598662)")
    ap.add_argument("--raids-dir", type=Path, default=ROOT / "raids", help="Directory containing raid_*.html")
    ap.add_argument("--apply", action="store_true", help="Perform upload; without this, dry run only")
    args = ap.parse_args()

    raid_id = args.raid_id.strip()
    raids_dir = args.raids_dir
    detail_file = raids_dir / f"raid_{raid_id}.html"

    if not detail_file.exists():
        print(f"Missing main raid details page: {detail_file}", file=sys.stderr)
        print("", file=sys.stderr)
        print("The attendees page alone does not contain DKP-by-tic or loot.", file=sys.stderr)
        print("Save the main raid details page in your browser:", file=sys.stderr)
        print(f"  https://azureguardtakp.gamerlaunch.com/rapid_raid/raid_details.php?raid_pool=562569&raidId={raid_id}&gid=547766", file=sys.stderr)
        print(f"  Save As -> {detail_file}", file=sys.stderr)
        return 1

    sys.path.insert(0, str(ROOT))
    from extract_structured_data import parse_raid_html

    html = detail_file.read_text(encoding="utf-8")
    parsed = parse_raid_html(html, raid_id)
    events = parsed["events"]
    loot = parsed["loot"]
    attendees = parsed["attendees"]

    print(f"Parsed raid {raid_id}: {len(events)} events, {len(loot)} loot rows, {len(attendees)} attendees")

    if not args.apply:
        print("Dry run. Re-run with --apply to upload to Supabase.")
        return 0

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

    # Delete existing data for this raid so we can re-import cleanly
    for table in ("raid_loot", "raid_attendance", "raid_event_attendance", "raid_events"):
        try:
            client.table(table).delete().eq("raid_id", raid_id).execute()
        except Exception as e:
            print(f"Warning: delete {table}: {e}", file=sys.stderr)

    # Insert raid_events (columns: raid_id, event_id, event_order, event_name, dkp_value, attendee_count, event_time)
    if events:
        rows = [
            {
                "raid_id": r["raid_id"],
                "event_id": str(r["event_id"]),
                "event_order": r["event_order"],
                "event_name": (r.get("event_name") or "") or None,
                "dkp_value": (r.get("dkp_value") or "") or None,
                "attendee_count": (r.get("attendee_count") or "") or None,
                "event_time": (r.get("event_time") or "") or None,
            }
            for r in events
        ]
        client.table("raid_events").insert(rows).execute()
        print(f"Inserted {len(rows)} raid_events")

    # Insert raid_loot
    if loot:
        rows = [
            {
                "raid_id": r["raid_id"],
                "event_id": str(r["event_id"]),
                "item_name": (r.get("item_name") or "") or None,
                "char_id": (r.get("char_id") or "") or None,
                "character_name": (r.get("character_name") or "") or None,
                "cost": (r.get("cost") or "") or None,
            }
            for r in loot
        ]
        client.table("raid_loot").insert(rows).execute()
        print(f"Inserted {len(rows)} raid_loot")

    # Insert raid_attendance
    if attendees:
        rows = [
            {
                "raid_id": r["raid_id"],
                "char_id": (r.get("char_id") or "") or None,
                "character_name": (r.get("character_name") or "") or None,
            }
            for r in attendees
        ]
        client.table("raid_attendance").insert(rows).execute()
        print(f"Inserted {len(rows)} raid_attendance")

    # Per-event attendance from attendees HTML (so DKP earned is by tic).
    # Only one character per account per tic: dedupe by account (keep first occurrence).
    attendees_file = raids_dir / f"raid_{raid_id}_attendees.html"
    if attendees_file.exists() and events:
        from parse_raid_attendees import parse_attendees_html
        # Fetch character_account so we can dedupe by account per event
        char_to_account: dict[str, str] = {}
        ca_from = 0
        ca_page_size = 1000
        while True:
            try:
                r = client.table("character_account").select("char_id, account_id").range(ca_from, ca_from + ca_page_size - 1).execute()
            except Exception as e:
                print(f"Warning: could not fetch character_account: {e}", file=sys.stderr)
                break
            rows = (r.data or []) if hasattr(r, "data") else []
            for row in rows:
                cid = (row.get("char_id") or "").strip()
                aid = (row.get("account_id") or "").strip()
                if cid and aid and cid not in char_to_account:
                    char_to_account[cid] = aid
            if len(rows) < ca_page_size:
                break
            ca_from += ca_page_size
        att_html = attendees_file.read_text(encoding="utf-8")
        sections = parse_attendees_html(att_html, raid_id)
        event_ids = [e["event_id"] for e in events]
        rea_rows = []
        for i, (_, att_list) in enumerate(sections):
            if i >= len(event_ids):
                break
            event_id = event_ids[i]
            seen_account_key: set[str] = set()
            for cid, cname in att_list:
                cid = (cid or "").strip()
                cname = (cname or "").strip() or None
                account_id = char_to_account.get(cid) if cid else None
                account_key = str(account_id) if account_id else (cid or "")
                if account_key in seen_account_key:
                    continue
                seen_account_key.add(account_key)
                rea_rows.append({
                    "raid_id": raid_id,
                    "event_id": event_id,
                    "char_id": cid or None,
                    "character_name": cname,
                })
        if rea_rows:
            client.table("raid_event_attendance").insert(rea_rows).execute()
            print(f"Inserted {len(rea_rows)} raid_event_attendance (one per account per tic)")

    # Refresh DKP totals
    try:
        client.rpc("refresh_dkp_summary").execute()
        print("refresh_dkp_summary() completed.")
    except Exception as e:
        print(f"Warning: refresh_dkp_summary: {e}", file=sys.stderr)

    print("Done. Reload the raid in the Officer page to see tics, loot, and attendance.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
