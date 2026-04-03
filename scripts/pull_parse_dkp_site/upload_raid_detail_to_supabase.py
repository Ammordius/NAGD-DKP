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
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent.parent  # repo root

# Batch size for delete-by-id to avoid statement timeout on large tables
DELETE_BATCH_SIZE = 200
DELETE_RETRIES = 3
DELETE_RETRY_DELAY_SEC = 2

# PostgREST timeout; refresh_dkp_summary runs in a separate request after the insert RPC
POSTGREST_TIMEOUT_SEC = 600
RPC_RETRIES = 3
RPC_RETRY_DELAY_SEC = 5
# Per-raid account summary only (no full-table fallback; see _refresh_account_summary_strict).
ACCOUNT_REFRESH_RPC_RETRIES = 5


def _is_transient_refresh_error(exc: Exception) -> bool:
    err = str(exc).lower()
    return (
        "57014" in err
        or "statement timeout" in err
        or "readtimeout" in err
        or "read operation timed out" in err
        or isinstance(exc, httpx.ReadTimeout)
    )


def _refresh_account_summary_strict(client, raid_id: str) -> tuple[bool, str]:
    """Refresh account summary for one raid via refresh_account_dkp_summary_for_raid only.

    Does not call refresh_account_dkp_summary (full TRUNCATE + rebuild): that is slower and
    more likely to hit statement_timeout than the per-raid RPC.
    """
    last_err: Exception | None = None

    for attempt in range(ACCOUNT_REFRESH_RPC_RETRIES):
        try:
            client.rpc("refresh_account_dkp_summary_for_raid", {"p_raid_id": raid_id}).execute()
            return True, "per_raid"
        except Exception as e:
            last_err = e
            err = str(e).lower()
            if "does not exist" in err and "function" in err:
                break
            if _is_transient_refresh_error(e) and attempt < ACCOUNT_REFRESH_RPC_RETRIES - 1:
                print(
                    f"refresh_account_dkp_summary_for_raid timed out/transient "
                    f"(attempt {attempt + 1}/{ACCOUNT_REFRESH_RPC_RETRIES}); "
                    f"retrying in {RPC_RETRY_DELAY_SEC}s...",
                    file=sys.stderr,
                )
                time.sleep(RPC_RETRY_DELAY_SEC)
                continue
            break

    if last_err is None:
        last_err = RuntimeError("unknown refresh_account_dkp_summary_for_raid failure")
    return False, str(last_err)


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


def _delete_raid_from_table(client, table: str, raid_id: str) -> int | None:
    """Delete all rows for raid_id from table. Uses batched delete by id to avoid timeout. Returns total deleted or None on failure."""
    total = 0
    try:
        # Try batched delete by primary key "id" (common in Supabase)
        while True:
            r = client.table(table).select("id").eq("raid_id", raid_id).limit(DELETE_BATCH_SIZE).execute()
            rows = (r.data or []) if hasattr(r, "data") else []
            if not rows:
                return total
            ids = [row["id"] for row in rows if row.get("id") is not None]
            if not ids:
                return total
            client.table(table).delete().in_("id", ids).execute()
            total += len(ids)
    except Exception:
        # Fallback: single delete with retries (may timeout on large tables)
        for attempt in range(DELETE_RETRIES):
            try:
                client.table(table).delete().eq("raid_id", raid_id).execute()
                return total  # count unknown; assume success
            except Exception as e:
                if attempt < DELETE_RETRIES - 1:
                    time.sleep(DELETE_RETRY_DELAY_SEC)
                else:
                    print(f"Warning: delete {table}: {e}", file=sys.stderr)
                    return None
    return total


def _delete_raid_via_rpc(client, raid_id: str) -> bool:
    """Delete all data for one raid via RPC (server-side). Returns True if RPC exists and succeeded."""
    try:
        client.rpc("delete_raid_for_reupload", {"p_raid_id": raid_id}).execute()
        return True
    except Exception as e:
        # RPC might not exist yet (function not deployed)
        err = str(e).lower()
        if "function" in err and "does not exist" in err:
            return False
        print(f"Warning: delete_raid_for_reupload RPC failed: {e}", file=sys.stderr)
        return False


def _insert_raid_event_attendance_rows(client, raid_id: str, rea_rows: list[dict]) -> None:
    """Insert per-tic rows via insert_raid_event_attendance_for_upload.

    Uses begin_restore_load + bulk INSERT (triggers no-op), clears restore flag, then
    refresh_raid_attendance_totals for this raid only. Global refresh_dkp_summary runs
    afterward in main() as a separate API call (avoids Supabase single-statement timeout).
    """
    if not rea_rows:
        return
    payload = [
        {
            "raid_id": str(r.get("raid_id") or raid_id),
            "event_id": str(r.get("event_id", "")),
            "char_id": r.get("char_id") or "",
            "character_name": r.get("character_name") or "",
            "account_id": r.get("account_id") or "",
        }
        for r in rea_rows
    ]
    last_err: Exception | None = None
    for attempt in range(RPC_RETRIES):
        try:
            client.rpc(
                "insert_raid_event_attendance_for_upload",
                {"p_raid_id": raid_id, "p_rows": payload},
            ).execute()
            return
        except Exception as e:
            last_err = e
            err = str(e).lower()
            if "function" in err and "does not exist" in err:
                print(
                    "Missing DB function insert_raid_event_attendance_for_upload. "
                    "Run docs/upload_script_rpcs.sql in the Supabase SQL editor, then retry.",
                    file=sys.stderr,
                )
                raise
            if "57014" in str(e) or "statement timeout" in err:
                print(
                    "insert_raid_event_attendance_for_upload hit statement_timeout. Redeploy the function from "
                    "docs/upload_script_rpcs.sql (it must not call end_restore_load inside one API request). "
                    "If this persists, raise Database statement timeout in Supabase Dashboard → Database → Settings.",
                    file=sys.stderr,
                )
            transient = "readtimeout" in err or "read operation timed out" in err
            if isinstance(e, httpx.ReadTimeout):
                transient = True
            if transient and attempt < RPC_RETRIES - 1:
                print(
                    f"insert_raid_event_attendance_for_upload timed out (attempt {attempt + 1}/{RPC_RETRIES}); "
                    f"retrying in {RPC_RETRY_DELAY_SEC}s...",
                    file=sys.stderr,
                )
                time.sleep(RPC_RETRY_DELAY_SEC)
                # RPC only INSERTs; a timeout after server success would duplicate rows on retry.
                _delete_raid_from_table(client, "raid_event_attendance", raid_id)
                continue
            raise
    if last_err:
        raise last_err


def main() -> int:
    import argparse
    ap = argparse.ArgumentParser(description="Upload one raid's events, loot, attendance to Supabase")
    ap.add_argument("--raid-id", type=str, default="1598662", help="Raid ID (e.g. 1598662)")
    ap.add_argument("--raids-dir", type=Path, default=ROOT / "raids", help="Directory containing raid_*.html")
    ap.add_argument("--apply", action="store_true", help="Perform upload; without this, dry run only")
    ap.add_argument("--skip-dkp-summary-refresh", action="store_true", help="Skip refresh_dkp_summary (caller does one after batch)")
    ap.add_argument(
        "--postgrest-timeout",
        type=int,
        default=POSTGREST_TIMEOUT_SEC,
        metavar="SEC",
        help=f"HTTP read timeout for Supabase PostgREST/RPC calls (default {POSTGREST_TIMEOUT_SEC})",
    )
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
    if loot:
        print("Loot rows to upload:")
        for r in loot:
            print(
                f"  event_id={r['event_id']} "
                f"item={r.get('item_name')!r} "
                f"char_id={r.get('char_id')!r} "
                f"character_name={r.get('character_name')!r} "
                f"cost={r.get('cost')!r}"
            )

    # Dry run: show per-event attendees and loot, but do not touch Supabase.
    if not args.apply:
        attendees_file = raids_dir / f"raid_{raid_id}_attendees.html"
        if attendees_file.exists() and events:
            try:
                from parse_raid_attendees import parse_attendees_html

                att_html = attendees_file.read_text(encoding="utf-8")
                sections = parse_attendees_html(att_html, raid_id)
                event_ids = [e["event_id"] for e in events]
                print("Per-event attendees from HTML (dry run, no account dedupe):")
                for i, (event_name, att_list) in enumerate(sections):
                    eid = event_ids[i] if i < len(event_ids) else "?"
                    names = [name for _, name in att_list]
                    print(f"  #{i+1} event_id={eid} name={event_name!r}: {len(names)} attendees -> {names}")
            except Exception as e:
                print(f"Warning: could not parse attendees HTML for dry run: {e}", file=sys.stderr)
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
        from supabase.lib.client_options import SyncClientOptions
    except ImportError:
        print("pip install supabase", file=sys.stderr)
        return 1

    client = create_client(
        url,
        key,
        options=SyncClientOptions(postgrest_client_timeout=args.postgrest_timeout),
    )

    # Delete existing data for this raid via direct, batched table deletes.
    # Avoid the delete_raid_for_reupload RPC here: it runs full refreshes that are
    # appropriate for bulk restore, but overkill (and slow) for a single-raid upload.
    for table in ("raid_event_attendance", "raid_loot", "raid_attendance", "raid_events"):
        deleted = _delete_raid_from_table(client, table, raid_id)
        if deleted is not None:
            print(f"Deleted {deleted} row(s) from {table}")

    # Insert raid_events
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
        print("Per-event attendees from HTML (raw, before dedupe):")
        for i, (event_name, att_list) in enumerate(sections):
            eid = event_ids[i] if i < len(event_ids) else "?"
            names = [name for _, name in att_list]
            print(f"  #{i+1} event_id={eid} name={event_name!r}: {len(names)} attendees -> {names}")
        rea_rows = []
        event_debug: dict[str, list[tuple[str | None, str | None]]] = {}
        for i, (_, att_list) in enumerate(sections):
            if i >= len(event_ids):
                break
            event_id = event_ids[i]
            seen_account_key: set[str] = set()
            for cid, cname in att_list:
                cid = (cid or "").strip()
                cname = (cname or "").strip() or None
                account_id = char_to_account.get(cid) if cid else None
                # Dedupe priority: account_id (when known) > char_id > character_name.
                if account_id:
                    account_key = f"acct:{account_id}"
                elif cid:
                    account_key = f"char:{cid}"
                elif cname:
                    account_key = f"name:{cname.lower()}"
                else:
                    account_key = ""
                if account_key in seen_account_key:
                    continue
                seen_account_key.add(account_key)
                row = {
                    "raid_id": raid_id,
                    "event_id": event_id,
                    "char_id": cid or None,
                    "character_name": cname,
                    "account_id": account_id or None,
                }
                rea_rows.append(row)
                event_debug.setdefault(event_id, []).append((row["char_id"], row["character_name"]))
        if event_debug:
            print("Per-event attendees after account dedupe (rows to insert):")
            for eid in event_ids:
                rows = event_debug.get(eid, [])
                names = [name for _, name in rows]
                print(f"  event_id={eid}: {len(rows)} rows -> {names}")
        if rea_rows:
            _insert_raid_event_attendance_rows(client, raid_id, rea_rows)
            print(
                f"Inserted {len(rea_rows)} raid_event_attendance (one per account per tic) "
                "via insert_raid_event_attendance_for_upload (restore_load + per-raid attendance totals)"
            )

    # Strict: this upload is considered successful only if account summary refresh succeeds.
    account_refresh_ok, account_refresh_mode_or_error = _refresh_account_summary_strict(client, raid_id)
    if account_refresh_ok:
        print("refresh_account_dkp_summary_for_raid() completed.")
    else:
        print(
            "ERROR: account summary refresh failed; upload is not considered synchronized. "
            "Rerun this upload after deploying the latest refresh_account_dkp_summary_for_raid "
            "(see docs/fix_refresh_account_dkp_summary_for_raid_perf.sql) or fix DB load/timeouts.",
            file=sys.stderr,
        )
        print(f"Details: {account_refresh_mode_or_error}", file=sys.stderr)
        print(
            "Manual full rebuild (officers, SQL editor): "
            "SET statement_timeout = '600s'; SELECT refresh_account_dkp_summary();",
            file=sys.stderr,
        )
        return 2

    # Full dkp_summary refresh (earned_30d/60d). Skip when run from batch — batch script does one at end.
    dkp_refresh_ok = True
    if not args.skip_dkp_summary_refresh:
        try:
            client.rpc("refresh_dkp_summary").execute()
            print("refresh_dkp_summary() completed.")
        except Exception as e:
            dkp_refresh_ok = False
            print(
                "ERROR: refresh_dkp_summary() failed; upload is not considered synchronized. "
                "Rerun this upload after resolving DB timeout/connectivity issues.",
                file=sys.stderr,
            )
            print(f"Details: {e}", file=sys.stderr)
            return 3

    print("Upload status: synchronized")
    if not args.skip_dkp_summary_refresh and dkp_refresh_ok:
        print("  account_summary: ok")
        print("  dkp_summary: ok")
    else:
        print("  account_summary: ok")
        print("  dkp_summary: skipped (batch mode)")

    print("Done. Reload the raid in the Officer page to see tics, loot, and attendance.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
