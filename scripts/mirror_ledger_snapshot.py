#!/usr/bin/env python3
"""Read-only guild + DKP summary snapshot for the mirror change ledger.

Writes one CSV per table plus manifest.json under --out. Never uploads or
publishes these files; callers must keep them ephemeral.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import sql_backup

# Guild authoritative tables plus rebuilt summaries needed for the public report.
SNAPSHOT_TABLES = (
    "characters",
    "accounts",
    "character_account",
    "raids",
    "raid_events",
    "raid_attendance",
    "raid_event_attendance",
    "raid_loot",
    "loot_assignment",
    "dkp_adjustments",
    "raid_classifications",
    "active_raiders",
    "active_accounts",
    "dkp_summary",
    "account_dkp_summary",
)

# Stable ORDER BY so fixtures and local re-runs are deterministic.
TABLE_ORDER_BY = {
    "characters": "char_id",
    "accounts": "account_id",
    "character_account": "char_id, account_id",
    "raids": "raid_id",
    "raid_events": "id",
    "raid_attendance": "id",
    "raid_event_attendance": "id",
    "raid_loot": "id",
    "loot_assignment": "loot_id",
    "dkp_adjustments": "character_name",
    "raid_classifications": "raid_id, mob",
    "active_raiders": "character_key",
    "active_accounts": "account_id",
    "dkp_summary": "character_key",
    "account_dkp_summary": "account_id",
}

EXCLUDED_FROM_SNAPSHOT = frozenset(
    {
        "profiles",
        "officer_audit_log",
        "auth.users",
        "restore_in_progress",
    }
)


class SnapshotError(Exception):
    """Fail-closed snapshot error. Messages must not contain secrets."""


def _child_env(conn: dict[str, str | int]) -> dict[str, str]:
    return sql_backup._child_env(conn)


def _run_psql_copy(conn: dict[str, str | int], table: str, destination: Path) -> int:
    if not shutil.which("psql"):
        raise SnapshotError("psql is not installed or not on PATH.")
    if table in EXCLUDED_FROM_SNAPSHOT or table not in SNAPSHOT_TABLES:
        raise SnapshotError(f"Refusing to snapshot table {table!r}.")
    order = TABLE_ORDER_BY[table]
    # NULL '' so empty CSV fields round-trip as empty strings; loaders map "" → None.
    sql = (
        f"\\copy (SELECT * FROM public.{table} ORDER BY {order}) "
        f"TO STDOUT WITH (FORMAT csv, HEADER true, NULL '')"
    )
    secrets = [str(conn["password"]), str(conn["user"])]
    env = _child_env(conn)
    completed = subprocess.run(
        ["psql", "-X", "-v", "ON_ERROR_STOP=1", "-q", "-c", sql],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        check=False,
    )
    if completed.returncode != 0:
        detail = sql_backup._redact(
            (completed.stderr or completed.stdout or "").strip(), secrets
        )
        suffix = f"\n{detail}" if detail else ""
        raise SnapshotError(f"COPY for {table} failed (exit {completed.returncode}).{suffix}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    text = completed.stdout if completed.stdout is not None else ""
    destination.write_text(text, encoding="utf-8", newline="\n")
    # Header-only file ⇒ 0 data rows.
    lines = [line for line in text.splitlines() if line.strip()]
    return max(0, len(lines) - 1) if lines else 0


def count_csv_rows(path: Path) -> int:
    if not path.exists():
        return 0
    with path.open(encoding="utf-8", newline="") as handle:
        reader = csv.reader(handle)
        try:
            next(reader)
        except StopIteration:
            return 0
        return sum(1 for _ in reader)


def write_snapshot(
    out_dir: Path,
    *,
    database_url: str,
    source_artifact_id: str = "",
    source_repository: str = "",
    mirror_run_id: str = "",
    restore_run_id: str = "",
    label: str = "",
) -> dict:
    """Capture all SNAPSHOT_TABLES into out_dir. Returns the manifest dict."""
    conn = sql_backup.parse_database_url(database_url)
    out_dir = Path(out_dir)
    if out_dir.exists():
        for child in out_dir.iterdir():
            if child.is_file():
                child.unlink()
    else:
        out_dir.mkdir(parents=True, exist_ok=True)

    captured_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    row_counts: dict[str, int] = {}
    for table in SNAPSHOT_TABLES:
        path = out_dir / f"{table}.csv"
        row_counts[table] = _run_psql_copy(conn, table, path)

    manifest = {
        "format": "mirror-ledger-snapshot-v1",
        "captured_at": captured_at,
        "label": label,
        "source_artifact_id": source_artifact_id,
        "source_repository": source_repository,
        "mirror_run_id": mirror_run_id,
        "restore_run_id": restore_run_id,
        "tables": list(SNAPSHOT_TABLES),
        "row_counts": row_counts,
    }
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return manifest


def load_manifest(snap_dir: Path) -> dict:
    path = Path(snap_dir) / "manifest.json"
    if not path.exists():
        raise SnapshotError(f"Missing manifest.json in {snap_dir}")
    return json.loads(path.read_text(encoding="utf-8"))


def verify_snapshot_dir(snap_dir: Path, *, require_manifest: bool = True) -> dict:
    """Ensure required CSVs exist and row counts match the manifest when present."""
    snap_dir = Path(snap_dir)
    if not snap_dir.is_dir():
        raise SnapshotError(f"Snapshot directory missing: {snap_dir}")
    missing = [t for t in SNAPSHOT_TABLES if not (snap_dir / f"{t}.csv").exists()]
    if missing:
        raise SnapshotError(f"Incomplete snapshot; missing tables: {', '.join(missing)}")
    manifest: dict = {}
    if require_manifest:
        manifest = load_manifest(snap_dir)
        counts = manifest.get("row_counts") or {}
        for table in SNAPSHOT_TABLES:
            actual = count_csv_rows(snap_dir / f"{table}.csv")
            expected = counts.get(table)
            if expected is not None and int(expected) != actual:
                raise SnapshotError(
                    f"Row count mismatch for {table}: manifest={expected} csv={actual}"
                )
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Capture a read-only mirror ledger snapshot (CSV + manifest)."
    )
    parser.add_argument("--out", type=Path, required=True, help="Output directory")
    parser.add_argument(
        "--database-url-env",
        default="SUPABASE_DB_URL",
        help="Env var holding the Postgres URI (default SUPABASE_DB_URL)",
    )
    parser.add_argument("--source-artifact-id", default="")
    parser.add_argument("--source-repository", default="")
    parser.add_argument("--mirror-run-id", default="")
    parser.add_argument("--restore-run-id", default="")
    parser.add_argument("--label", default="")
    args = parser.parse_args(argv)

    url = os.environ.get(args.database_url_env, "")
    try:
        manifest = write_snapshot(
            args.out,
            database_url=url,
            source_artifact_id=args.source_artifact_id,
            source_repository=args.source_repository,
            mirror_run_id=args.mirror_run_id,
            restore_run_id=args.restore_run_id,
            label=args.label,
        )
    except (SnapshotError, sql_backup.BackupError) as exc:
        print(str(exc), file=sys.stderr)
        return 1

    print(
        f"Snapshot {args.label or args.out.name}: "
        f"{sum(manifest['row_counts'].values())} rows across "
        f"{len(manifest['tables'])} tables → {args.out}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
