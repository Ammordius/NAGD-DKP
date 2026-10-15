#!/usr/bin/env python3
"""
Restore DKP data tables from a backup directory of CSVs (e.g. from a
GitHub backup artifact). Deletes existing rows via API then inserts from CSVs.

Does not touch profiles or auth—only DKP data tables (characters, raids, loot, etc.).
Uses SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (same as backup workflow).

  export SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...
  python scripts/restore_supabase_from_backup.py --backup-dir backup

Used by .github/workflows/db-restore.yml after downloading an artifact.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from pathlib import Path

BATCH_SIZE = 500
DELETE_BATCH_SIZE = 250  # balance speed vs .in_() limit; on timeout we retry in tiny chunks
DELETE_BATCH_SIZE_FALLBACK = 25  # when statement timeout hits, delete in small chunks
PROGRESS_EVERY = 10  # log progress every N batches

# DKP data tables only (never profiles or auth)
RESTORE_TABLE_ORDER = [
    "characters",
    "accounts",
    "character_account",
    "raids",
    "raid_events",
    "raid_loot",
    "loot_assignment",
    "bid_portfolio_auction_fact",
    "raid_attendance",
    "raid_event_attendance",
    "raid_dkp_totals",
    "raid_attendance_dkp",
    "raid_attendance_dkp_by_account",
    "raid_classifications",
    "dkp_adjustments",
    "dkp_summary",
    "account_dkp_summary",
    "dkp_period_totals",
    "active_raiders",
    "active_accounts",
    "character_loot_assignment_counts",
    "account_class_coverage",
    "officer_audit_log",
]

# Upsert instead of insert. accounts stays (profiles references it). account_class_coverage
# is not truncated, so an older artifact with no CSV cannot wipe it, and a newer one updates in place.
UPSERT_ON = {
    "accounts": "account_id",
    "account_class_coverage": "account_id",
}

# Truncate clears these via CASCADE even when the CSV is absent. Say so in the log.
CLEARED_WHEN_CSV_MISSING = frozenset({"loot_assignment", "bid_portfolio_auction_fact"})

# Do not clear: profiles references accounts. account_class_coverage is upserted and kept when its CSV is absent.
CLEAR_SKIP = frozenset({"accounts", "account_class_coverage"})

# Repopulated by DB triggers/refresh when we load raid_events/raid_event_attendance; skip CSV load to avoid duplicate key.
LOAD_SKIP_TRIGGER_POPULATED = frozenset({"raid_dkp_totals", "raid_attendance_dkp", "raid_attendance_dkp_by_account", "account_dkp_summary"})

# For delete-all via API: column to use for batch delete (first column of PK for composites)
TABLE_KEY_COLUMN: dict[str, str] = {
    "characters": "char_id",
    "accounts": "account_id",
    "character_account": "char_id",
    "raids": "raid_id",
    "raid_events": "id",
    "raid_loot": "id",
    "loot_assignment": "loot_id",
    "bid_portfolio_auction_fact": "loot_id",
    "raid_attendance": "id",
    "raid_event_attendance": "id",
    "raid_dkp_totals": "raid_id",
    "raid_attendance_dkp": "raid_id",
    "raid_attendance_dkp_by_account": "raid_id",
    "raid_classifications": "raid_id",
    "dkp_adjustments": "character_name",
    "dkp_summary": "character_key",
    "account_dkp_summary": "account_id",
    "dkp_period_totals": "period",
    "active_raiders": "character_key",
    "active_accounts": "account_id",
    "character_loot_assignment_counts": "char_id",
    "account_class_coverage": "account_id",
    "officer_audit_log": "id",
}


UNFINISHED_RESTORE = """
CSV restore load committed, but end_restore_load() did not finish.
restore_in_progress stays true, so DKP triggers stay off.
account_dkp_summary is not loaded from the CSV, so it stays empty until that function commits.
A later SQL restore that rolls back leaves this flag as the CSV restore left it.

Finish in the Supabase SQL editor (direct session, not the HTTP API):
  UPDATE restore_in_progress SET in_progress = false WHERE id = 1;
  SELECT fix_serial_sequences_for_restore();
  SELECT refresh_dkp_summary();
  SELECT refresh_all_raid_attendance_totals();
  SELECT refresh_account_dkp_summary();
  SELECT refresh_character_dkp_spent();
""".strip()


def _report_unfinished_restore(detail: str) -> int:
    """Print the stuck-restore failure and mirror it into the Actions summary."""
    print(UNFINISHED_RESTORE, file=sys.stderr)
    if detail:
        print(detail, file=sys.stderr)
    summary_path = (os.environ.get("GITHUB_STEP_SUMMARY") or "").strip()
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as summary:
            summary.write("## CSV restore did not finish\n\n")
            summary.write(UNFINISHED_RESTORE + "\n")
            if detail:
                summary.write("\n```\n" + detail + "\n```\n")
    return 1


def _restore_flag_is_clear(client) -> bool:
    response = client.table("restore_in_progress").select("in_progress").eq("id", 1).limit(1).execute()
    rows = response.data or []
    return bool(rows) and rows[0].get("in_progress") is False


def _is_statement_timeout(err: Exception) -> bool:
    s = str(err).lower()
    if "statement timeout" in s or "57014" in s:
        return True
    if hasattr(err, "code") and getattr(err, "code", None) == "57014":
        return True
    if isinstance(err, dict):
        return err.get("code") == "57014" or "statement timeout" in str(err.get("message", "")).lower()
    return False


def delete_all_rows(client, table: str, key_col: str) -> None:
    """Delete all rows via REST API. Uses smaller batches on statement timeout."""
    total = 0
    batches = 0
    while True:
        resp = (
            client.table(table)
            .select(key_col)
            .limit(DELETE_BATCH_SIZE)
            .execute()
        )
        rows = resp.data or []
        if not rows:
            break
        keys = [r[key_col] for r in rows]
        try:
            client.table(table).delete().in_(key_col, keys).execute()
        except Exception as e:
            if _is_statement_timeout(e):
                print(f"  Statement timeout on {table}, deleting in chunks of {DELETE_BATCH_SIZE_FALLBACK}...", flush=True)
                for i in range(0, len(keys), DELETE_BATCH_SIZE_FALLBACK):
                    chunk = keys[i : i + DELETE_BATCH_SIZE_FALLBACK]
                    client.table(table).delete().in_(key_col, chunk).execute()
            else:
                raise
        total += len(keys)
        batches += 1
        if batches % PROGRESS_EVERY == 0:
            print(f"  Clearing {table}... {total} rows so far", flush=True)
    if total:
        print(f"  Cleared {table}: {total} rows", flush=True)


def truncate_via_rpc(client) -> None:
    """Clear DKP data tables via truncate_dkp_for_restore() RPC (in main schema). Raises if RPC missing."""
    client.rpc("truncate_dkp_for_restore").execute()
    print("  Cleared DKP tables via truncate_dkp_for_restore() RPC.", flush=True)


def clear_tables(client) -> None:
    """Clear DKP data tables only (child first). Skip accounts (profiles references them)."""
    for table in reversed(RESTORE_TABLE_ORDER):
        if table in CLEAR_SKIP:
            print(f"  Skip clear {table} (referenced by profiles)", flush=True)
            continue
        key_col = TABLE_KEY_COLUMN.get(table, "id")
        try:
            delete_all_rows(client, table, key_col)
        except Exception as e:
            print(f"  {table}: clear warning - {e}", file=sys.stderr)


def _coerce_csv_value(key: str, value: str):
    """Turn one CSV cell into a value PostgREST can insert. JSON text becomes an object."""
    if value == "" or value is None:
        return None
    if key == "id" and value.isdigit():
        return int(value)
    if value[:1] in "{[":
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    return value


def _row_from_csv_row(fieldnames: list[str], row: dict) -> dict:
    """Coerce CSV row to API-friendly dict."""
    return {k: _coerce_csv_value(k, row.get(k, "")) for k in fieldnames}


def load_csv_api(client, table: str, csv_path: Path, *, upsert_on: str | None = None) -> int:
    """Load one CSV via REST API. If upsert_on is set (e.g. 'account_id'), use upsert for that table."""
    with open(csv_path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames or []
        rows: list[dict] = []
        count = 0
        batches = 0
        for row in reader:
            rows.append(_row_from_csv_row(fieldnames, row))
            if len(rows) >= BATCH_SIZE:
                if upsert_on:
                    client.table(table).upsert(rows, on_conflict=upsert_on).execute()
                else:
                    client.table(table).insert(rows).execute()
                count += len(rows)
                rows = []
                batches += 1
                if batches % PROGRESS_EVERY == 0:
                    print(f"  Loading {table}... {count} rows so far", flush=True)
        if rows:
            if upsert_on:
                client.table(table).upsert(rows, on_conflict=upsert_on).execute()
            else:
                client.table(table).insert(rows).execute()
            count += len(rows)
    return count


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Restore Supabase from backup CSVs (API: delete then insert)."
    )
    ap.add_argument(
        "--backup-dir",
        type=Path,
        required=True,
        help="Directory containing table CSVs (e.g. backup/)",
    )
    ap.add_argument(
        "--load-only",
        action="store_true",
        help="Skip clear phase (only load from CSVs; tables must already be empty or you will get duplicates)",
    )
    args = ap.parse_args()

    url = (os.environ.get("SUPABASE_URL") or "").strip()
    key = (
        os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        or os.environ.get("SUPABASE_ANON_KEY")
        or ""
    ).strip()
    if not url or not key:
        print(
            "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (same as DB backup workflow).",
            file=sys.stderr,
        )
        return 1

    try:
        from supabase import create_client
    except ImportError:
        print("Install supabase: pip install supabase", file=sys.stderr)
        return 1

    client = create_client(url, key)
    backup_dir = args.backup_dir.resolve()
    if not backup_dir.is_dir():
        print(f"Not a directory: {backup_dir}", file=sys.stderr)
        return 1

    if not args.load_only:
        print("Clearing DKP data tables via truncate_dkp_for_restore() RPC...", flush=True)
        truncate_via_rpc(client)
    else:
        print("Load-only mode: skipping clear.", flush=True)

    fast_load_enabled = False
    try:
        print("Enabling fast load (DKP triggers deferred until end)...", flush=True)
        client.rpc("begin_restore_load").execute()
        fast_load_enabled = True
    except Exception as e:
        code = ""
        if getattr(e, "args", None) and isinstance(e.args[0], dict):
            code = e.args[0].get("code", "")
        msg = str(e).lower()
        if code == "PGRST202" or "could not find the function" in msg or "begin_restore_load" in msg:
            print("  begin_restore_load() not in schema (run latest docs/supabase-schema-full.sql); load will run with triggers on.", flush=True)
        else:
            raise

    total = 0
    load_error: Exception | None = None
    try:
        for table in RESTORE_TABLE_ORDER:
            if table in LOAD_SKIP_TRIGGER_POPULATED:
                print(f"Skip load {table} (repopulated by triggers from raid_events/raid_event_attendance)")
                continue
            csv_path = backup_dir / f"{table}.csv"
            if not csv_path.is_file():
                if table in CLEARED_WHEN_CSV_MISSING:
                    print(
                        f"Skip {table} (no {csv_path}). "
                        "Pre-fix backups omit this file; truncate already cleared it, so those rows stay empty.",
                        flush=True,
                    )
                else:
                    print(f"Skip {table} (no {csv_path})")
                continue
            try:
                upsert_col = UPSERT_ON.get(table)
                n = load_csv_api(client, table, csv_path, upsert_on=upsert_col)
                total += n
                print(f"{table}: {n} rows")
            except Exception as e:
                print(f"{table}: error - {e}", file=sys.stderr)
                raise
    except Exception as e:
        load_error = e

    if fast_load_enabled:
        print("Refreshing DKP summary and raid totals...", flush=True)
        try:
            client.rpc("end_restore_load").execute()
        except Exception as e:
            print(f"end_restore_load() failed: {e}", file=sys.stderr)
            if load_error is not None:
                print(f"CSV load also failed: {load_error}", file=sys.stderr)
            return _report_unfinished_restore(str(e))
        if not _restore_flag_is_clear(client):
            if load_error is not None:
                print(f"CSV load also failed: {load_error}", file=sys.stderr)
            return _report_unfinished_restore("restore_in_progress is still true after end_restore_load().")
    else:
        print("Refreshing DKP summary and raid totals (no fast-load RPC)...", flush=True)
        try:
            client.rpc("refresh_dkp_summary").execute()
            client.rpc("refresh_all_raid_attendance_totals").execute()
            client.rpc("refresh_account_dkp_summary").execute()
        except Exception as e:
            print(f"Refresh failed: {e}", file=sys.stderr)
            if load_error is not None:
                print(f"CSV load also failed: {load_error}", file=sys.stderr)
            return _report_unfinished_restore(str(e))

    if load_error is not None:
        print(f"CSV load failed: {load_error}", file=sys.stderr)
        return 1

    print(f"Restore done. Total rows: {total}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
