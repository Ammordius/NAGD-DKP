#!/usr/bin/env python3
"""Build a portable, age-encrypted SQL backup of guild DKP tables.

Reads SUPABASE_DB_URL and SQL_BACKUP_AGE_RECIPIENT from the environment.
Writes one sql-backup-<utc>.tar.gz.age file. Does not print the database
URL, password, backup rows, or encryption key.

The dump is pg_dump --data-only --format=plain for an explicit table
allowlist. docs/supabase-schema-full.sql stays the only schema source and
is not copied into the artifact.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urlparse

FORMAT_VERSION = "1"
CANONICAL_SCHEMA = "docs/supabase-schema-full.sql"

INCLUDED_TABLES = [
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
]

# Columns the portable backup expects on the source. Extra columns stay compatible.
# This is a code contract, not a byte comparison with the schema file.
REQUIRED_SOURCE_COLUMNS = {
    "characters": ("char_id", "name", "race", "class_name", "level", "guild_rank", "claim"),
    "accounts": ("account_id", "char_ids", "toon_names", "toon_count", "display_name", "inactive"),
    "character_account": ("char_id", "account_id"),
    "raids": ("raid_id", "raid_pool", "raid_name", "date", "date_iso", "attendees", "url"),
    "raid_events": ("id", "raid_id", "event_id", "event_order", "event_name", "dkp_value", "attendee_count", "event_time"),
    "raid_attendance": ("id", "raid_id", "char_id", "character_name"),
    "raid_event_attendance": ("id", "raid_id", "event_id", "char_id", "character_name", "account_id"),
    "raid_loot": ("id", "raid_id", "event_id", "item_name", "char_id", "character_name", "cost"),
    "loot_assignment": ("loot_id", "assigned_char_id", "assigned_character_name", "assigned_via_magelo"),
    "dkp_adjustments": ("character_name", "earned_delta", "spent_delta", "account_id"),
    "raid_classifications": ("raid_id", "mob", "zone"),
    "active_raiders": ("character_key",),
    "active_accounts": ("account_id",),
}

SOURCE_RESTORE_FUNCTIONS = (
    "begin_restore_load",
    "end_restore_load",
    "fix_serial_sequences_for_restore",
    "refresh_dkp_summary",
    "refresh_all_raid_attendance_totals",
    "refresh_account_dkp_summary_internal",
    "refresh_character_dkp_spent",
    "refresh_dkp_period_totals",
)

EXCLUDED_TABLES = [
    {"name": "auth.users", "reason": "Supabase-managed identity"},
    {"name": "profiles", "reason": "auth-linked identity"},
    {"name": "officer_audit_log", "reason": "auth-linked personal data"},
    {"name": "restore_in_progress", "reason": "environment-specific operational flag"},
    {"name": "raid_dkp_totals", "reason": "rebuilt by refresh_all_raid_attendance_totals()"},
    {"name": "raid_attendance_dkp", "reason": "rebuilt by refresh_all_raid_attendance_totals()"},
    {"name": "raid_attendance_dkp_by_account", "reason": "rebuilt by refresh_all_raid_attendance_totals()"},
    {"name": "dkp_summary", "reason": "rebuilt by refresh_dkp_summary()"},
    {"name": "account_dkp_summary", "reason": "rebuilt by refresh_account_dkp_summary_internal()"},
    {"name": "dkp_period_totals", "reason": "rebuilt by refresh_dkp_period_totals()"},
    {"name": "character_dkp_spent", "reason": "rebuilt by refresh_character_dkp_spent()"},
    {"name": "character_loot_assignment_counts", "reason": "rebuilt from loot_assignment"},
    {"name": "bid_portfolio_auction_fact", "reason": "rebuilt by the bidding backfill"},
    {"name": "account_class_coverage", "reason": "Magelo rankings cache refreshed by CI"},
]

# Tables export_supabase_public_tables.py writes that this portable backup leaves out.
CSV_NOT_IN_PORTABLE_BACKUP = (
    "profiles",
    "account_class_coverage",
    "bid_portfolio_auction_fact",
    "raid_dkp_totals",
    "raid_attendance_dkp",
    "raid_attendance_dkp_by_account",
    "dkp_summary",
    "account_dkp_summary",
    "dkp_period_totals",
    "character_loot_assignment_counts",
    "officer_audit_log",
)


def retention_tiers(existing_names: set[str], now: datetime, force: bool) -> list[tuple[str, int]]:
    """Weekly and monthly artifact names to upload, with retention days.

    existing_names are this repository's own non-expired Actions artifact names.
    A fork does not inherit another repository's list. force uploads both tiers
    even when that period already has a copy.
    """
    weekly = f"sql-backup-weekly-{now.strftime('%G-W%V')}"
    monthly = f"sql-backup-monthly-{now.strftime('%Y-%m')}"
    chosen: list[tuple[str, int]] = []
    if force or weekly not in existing_names:
        chosen.append((weekly, 90))
    if force or monthly not in existing_names:
        chosen.append((monthly, 90))
    return chosen

_COPY_HEADER = re.compile(
    r'^COPY\s+(?:"(?P<schema>[^"]+)"\."(?P<table>[^"]+)"|(?P<schema2>[A-Za-z_]\w*)\.(?P<table2>[A-Za-z_]\w*))\s+\((?P<cols>.*)\)\s+FROM stdin;$'
)
_VERSION_HEADER = re.compile(r"(?m)^-- Dumped from database version (.+)$")
_CREATE_TABLE = re.compile(r"(?m)^CREATE TABLE\b")


class BackupError(Exception):
    """Fail-closed backup error. The message must not contain secrets."""


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def schema_fingerprint(schema_path: Path) -> str:
    digest = hashlib.sha256()
    with schema_path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def unevaluated_live_schema() -> dict:
    return {
        "status": "not_assessed",
        "fingerprint": None,
        "compared_to_repository_file": False,
    }


def live_schema_record(manifest: dict) -> dict:
    """Read the manifest's live-catalog status. A missing block is not assessed."""
    has_status = "live_schema_status" in manifest
    has_fingerprint = "live_schema_fingerprint" in manifest
    has_compared = "live_schema_compared_to_repository_file" in manifest
    if not has_status and not has_fingerprint and not has_compared:
        return unevaluated_live_schema()
    status = manifest.get("live_schema_status")
    if status not in ("not_assessed", "compatible", "incompatible"):
        raise BackupError("Manifest live_schema_status is invalid.")
    if manifest.get("live_schema_compared_to_repository_file") is not False:
        raise BackupError("Manifest claims the live schema was compared to the repository file.")
    fingerprint = manifest.get("live_schema_fingerprint")
    if status == "not_assessed":
        if fingerprint not in (None, ""):
            raise BackupError("An unassessed live schema cannot carry a fingerprint.")
        fingerprint = None
    elif not isinstance(fingerprint, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", fingerprint):
        raise BackupError("Manifest live_schema_fingerprint is invalid.")
    return {
        "status": status,
        "fingerprint": fingerprint,
        "compared_to_repository_file": False,
    }


def _sql_literal(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", value):
        raise BackupError("Rejected an unexpected SQL identifier.")
    return "'" + value + "'"


def source_catalog_sql() -> str:
    tables = ", ".join(_sql_literal(name) for name in INCLUDED_TABLES)
    functions = ", ".join(_sql_literal(name) for name in SOURCE_RESTORE_FUNCTIONS)
    return f"""
SET default_transaction_read_only = on;
SELECT json_build_object(
  'tables', COALESCE((
    SELECT json_object_agg(table_name, cols)
    FROM (
      SELECT c.table_name, json_agg(c.column_name ORDER BY c.ordinal_position) AS cols
      FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name IN ({tables})
      GROUP BY c.table_name
    ) present
  ), '{{}}'::json),
  'functions', COALESCE((
    SELECT json_agg(p.proname ORDER BY p.proname)
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.pronargs = 0 AND p.proname IN ({functions})
  ), '[]'::json)
)::text;
"""


def catalog_fingerprint(payload: dict) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def interpret_source_catalog(payload: dict) -> dict:
    tables = payload.get("tables")
    functions = payload.get("functions")
    if not isinstance(tables, dict) or not isinstance(functions, list):
        tables = {}
        functions = []
        compatible = False
    else:
        compatible = True
    observed_tables: dict[str, list[str]] = {}
    for name in INCLUDED_TABLES:
        present = tables.get(name) if isinstance(tables, dict) else None
        columns = [column for column in present if isinstance(column, str)] if isinstance(present, list) else []
        observed_tables[name] = sorted(set(columns))
        required = set(REQUIRED_SOURCE_COLUMNS[name])
        if not required.issubset(columns):
            compatible = False
    observed_functions = sorted({item for item in functions if isinstance(item, str)})
    if not set(SOURCE_RESTORE_FUNCTIONS).issubset(observed_functions):
        compatible = False
    return {
        "status": "compatible" if compatible else "incompatible",
        "fingerprint": catalog_fingerprint({"functions": observed_functions, "tables": observed_tables}),
        "compared_to_repository_file": False,
    }


def assess_live_schema(conn: dict[str, str | int]) -> dict:
    """Read the source catalog. Does not apply schema and does not hash the repository file."""
    if not shutil.which("psql"):
        raise BackupError("psql is not installed or not on PATH.")
    sql = source_catalog_sql()
    upper = sql.upper()
    for forbidden in ("CREATE", "ALTER", "DROP", "INSERT", "UPDATE", "DELETE", "TRUNCATE"):
        if forbidden in upper:
            raise BackupError("Live schema probe is not read-only.")
    secrets = [str(conn["password"]), str(conn["user"])]
    with tempfile.TemporaryDirectory(prefix="sql-backup-schema-") as tmp:
        script = Path(tmp) / "probe.sql"
        script.write_text(sql, encoding="utf-8", newline="\n")
        if os.name == "posix":
            os.chmod(script, 0o600)
        completed = _run(
            ["psql", "-X", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A", "-f", str(script)],
            _child_env(conn),
            secrets,
            "psql",
        )
    text = (completed.stdout or "").strip()
    if not text:
        raise BackupError("Live schema probe returned no rows.")
    try:
        payload = json.loads(text.splitlines()[-1])
    except json.JSONDecodeError as exc:
        raise BackupError("Live schema probe returned unexpected data.") from exc
    if not isinstance(payload, dict):
        raise BackupError("Live schema probe returned unexpected data.")
    return interpret_source_catalog(payload)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_database_url(url: str) -> dict[str, str | int]:
    """Split a postgresql URI into libpq fields. Never include the URL in errors."""
    if not url or not url.strip():
        raise BackupError("Set SUPABASE_DB_URL to the session-mode Postgres URI.")
    try:
        parsed = urlparse(url.strip())
    except ValueError as exc:
        raise BackupError("SUPABASE_DB_URL could not be parsed.") from exc
    if parsed.scheme not in ("postgresql", "postgres"):
        raise BackupError("SUPABASE_DB_URL must use the postgresql scheme.")
    if not parsed.hostname or not parsed.username or not parsed.path or parsed.path == "/":
        raise BackupError("SUPABASE_DB_URL is missing a host, user, or database name.")
    database = parsed.path.lstrip("/").split("/", 1)[0]
    if not database:
        raise BackupError("SUPABASE_DB_URL is missing a database name.")
    sslmode = ""
    if parsed.query:
        for part in parsed.query.split("&"):
            key, _, value = part.partition("=")
            if key == "sslmode" and value:
                sslmode = unquote(value)
                break
    return {
        "host": parsed.hostname,
        "port": parsed.port or 5432,
        "user": unquote(parsed.username),
        "password": unquote(parsed.password or ""),
        "database": database,
        "sslmode": sslmode,
    }


def validate_recipient(recipient: str) -> str:
    value = (recipient or "").strip()
    if not value:
        raise BackupError("Set SQL_BACKUP_AGE_RECIPIENT to an age public key.")
    if value.startswith("AGE-SECRET-KEY-") or not value.startswith("age1") or any(ch.isspace() for ch in value):
        raise BackupError("SQL_BACKUP_AGE_RECIPIENT must be an age public key (age1...), not a secret key.")
    return value


def _decode_copy_field(raw: str) -> str | None:
    if raw == r"\N":
        return None
    out: list[str] = []
    index = 0
    mapping = {"\\": "\\", "t": "\t", "n": "\n", "r": "\r", "b": "\b", "f": "\f", "v": "\v"}
    while index < len(raw):
        if raw[index] == "\\" and index + 1 < len(raw):
            out.append(mapping.get(raw[index + 1], raw[index + 1]))
            index += 2
            continue
        out.append(raw[index])
        index += 1
    return "".join(out)


def split_copy_fields(line: str) -> list[str | None]:
    raw_fields: list[str] = []
    buf: list[str] = []
    index = 0
    while index < len(line):
        if line[index] == "\\":
            buf.append(line[index : index + 2])
            index += 2
            continue
        if line[index] == "\t":
            raw_fields.append("".join(buf))
            buf = []
            index += 1
            continue
        buf.append(line[index])
        index += 1
    raw_fields.append("".join(buf))
    return [_decode_copy_field(raw) for raw in raw_fields]


def _parse_columns(cols: str) -> list[str]:
    names: list[str] = []
    for part in cols.split(","):
        name = part.strip()
        if name.startswith('"') and name.endswith('"'):
            name = name[1:-1].replace('""', '"')
        names.append(name)
    return names


def parse_copy_blocks(sql_text: str) -> dict[str, dict]:
    """Return {table: {columns, rows}} for each COPY block. Rows use None for NULL."""
    blocks: dict[str, dict] = {}
    lines = sql_text.splitlines()
    index = 0
    while index < len(lines):
        line = lines[index]
        if not line.startswith("COPY "):
            index += 1
            continue
        header = _COPY_HEADER.match(line)
        if not header:
            raise BackupError("pg_dump produced a COPY statement this backup cannot inventory.")
        table = header.group("table") or header.group("table2")
        if table in blocks:
            raise BackupError(f"pg_dump emitted {table} more than once.")
        columns = _parse_columns(header.group("cols"))
        index += 1
        rows: list[list[str | None]] = []
        while index < len(lines) and lines[index] != r"\.":
            rows.append(split_copy_fields(lines[index]))
            index += 1
        if index >= len(lines) or lines[index] != r"\.":
            raise BackupError(f"COPY block for {table} is truncated.")
        blocks[table] = {"columns": columns, "rows": rows}
        index += 1
    return blocks


def postgresql_version(sql_text: str) -> str:
    match = _VERSION_HEADER.search(sql_text)
    if not match:
        raise BackupError("pg_dump output is missing the database version header.")
    return match.group(1).strip()


def require_allowlist(blocks: dict[str, dict]) -> dict[str, int]:
    found = set(blocks)
    allowed = set(INCLUDED_TABLES)
    extra = sorted(found - allowed)
    missing = [name for name in INCLUDED_TABLES if name not in found]
    if extra:
        raise BackupError("Dump includes tables outside the allowlist: " + ", ".join(extra))
    if missing:
        raise BackupError("Dump is missing required tables: " + ", ".join(missing))
    return {name: len(blocks[name]["rows"]) for name in INCLUDED_TABLES}


def _redact(text: str, secrets: list[str]) -> str:
    redacted = text
    for secret in secrets:
        if secret:
            redacted = redacted.replace(secret, "[redacted]")
    return redacted


def _run(args: list[str], env: dict[str, str], secrets: list[str], label: str) -> subprocess.CompletedProcess[str]:
    try:
        completed = subprocess.run(
            args,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
    except FileNotFoundError as exc:
        raise BackupError(f"{label} is not installed or not on PATH.") from exc
    if completed.returncode != 0:
        detail = _redact((completed.stderr or completed.stdout or "").strip(), secrets)
        suffix = f"\n{detail}" if detail else ""
        raise BackupError(f"{label} failed (exit {completed.returncode}).{suffix}")
    return completed


def _child_env(conn: dict[str, str | int]) -> dict[str, str]:
    env = os.environ.copy()
    for key in list(env):
        if key.startswith("BACKUP_ARTIFACT_READ_TOKEN") or key in (
            "SUPABASE_DB_URL",
            "SQL_BACKUP_AGE_RECIPIENT",
            "DATABASE_URL",
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "BACKUP_ARTIFACT_TOKEN_SECRET",
        ):
            env.pop(key, None)
    env["PGHOST"] = str(conn["host"])
    env["PGPORT"] = str(conn["port"])
    env["PGUSER"] = str(conn["user"])
    env["PGPASSWORD"] = str(conn["password"])
    env["PGDATABASE"] = str(conn["database"])
    env["PGOPTIONS"] = "-c default_transaction_read_only=on"
    env["PGCLIENTENCODING"] = "UTF8"
    env["LC_ALL"] = "C"
    env["PGPASSFILE"] = "NUL" if os.name == "nt" else os.devnull
    if conn["sslmode"]:
        env["PGSSLMODE"] = str(conn["sslmode"])
    else:
        env.pop("PGSSLMODE", None)
    return env


def dump_data(conn: dict[str, str | int], destination: Path) -> None:
    if not shutil.which("pg_dump"):
        raise BackupError("pg_dump is not installed or not on PATH.")
    args = [
        "pg_dump",
        "--data-only",
        "--format=plain",
        "--no-owner",
        "--no-privileges",
        "--no-tablespaces",
        "--quote-all-identifiers",
        "--encoding=UTF8",
        "--file",
        str(destination),
    ]
    help_text = subprocess.run(
        ["pg_dump", "--help"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if "--strict-names" in (help_text.stdout or ""):
        args.insert(-2, "--strict-names")
    for table in INCLUDED_TABLES:
        args.append(f"--table=public.{table}")
    secrets = [str(conn["password"]), str(conn["user"])]
    _run(args, _child_env(conn), secrets, "pg_dump")


def write_summary(path: Path, manifest: dict) -> None:
    lines = [
        f"format_version: {manifest['format_version']}",
        f"created_at: {manifest['created_at']}",
        f"source_repository: {manifest['source_repository']}",
        f"workflow_run_id: {manifest['workflow_run_id']}",
        *(
            [f"source_repository_id: {manifest['source_repository_id']}"]
            if manifest.get("source_repository_id")
            else []
        ),
        f"source_commit_sha: {manifest['source_commit_sha']}",
        f"canonical_schema_source: {manifest['canonical_schema_source']}",
        f"source_schema_fingerprint: {manifest['canonical_schema_sha256']}",
        f"canonical_schema_sha256: {manifest['canonical_schema_sha256']}",
        f"live_schema_status: {manifest['live_schema_status']}",
        "live_schema_compared_to_repository_file: false",
        f"postgresql_version: {manifest['postgresql_version']}",
        f"included_tables: {len(manifest['included_tables'])}",
        f"total_rows: {sum(manifest['row_counts'].values())}",
        "row_counts:",
    ]
    for name, count in manifest["row_counts"].items():
        lines.append(f"  {name}: {count}")
    lines.append("excluded_tables:")
    for item in manifest["excluded_tables"]:
        lines.append(f"  {item['name']}: {item['reason']}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")


def build_bundle(
    bundle: Path,
    sql_text: str,
    *,
    schema_path: Path,
    source_repository: str,
    workflow_run_id: str,
    source_commit_sha: str,
    created_at: str,
    live_schema: dict | None = None,
    source_repository_id: str = "",
) -> dict:
    if _CREATE_TABLE.search(sql_text):
        raise BackupError("Refusing to package a dump that contains CREATE TABLE.")
    blocks = parse_copy_blocks(sql_text)
    row_counts = require_allowlist(blocks)
    data_path = bundle / "data.sql"
    data_path.write_bytes(sql_text.encode("utf-8"))
    assessed = dict(live_schema or unevaluated_live_schema())
    assessed["compared_to_repository_file"] = False
    live = live_schema_record(
        {
            "live_schema_status": assessed.get("status"),
            "live_schema_fingerprint": assessed.get("fingerprint"),
            "live_schema_compared_to_repository_file": False,
        }
    )
    manifest = {
        "format_version": FORMAT_VERSION,
        "source_repository": source_repository,
        "workflow_run_id": workflow_run_id,
        "source_commit_sha": source_commit_sha,
        "created_at": created_at,
        "canonical_schema_source": CANONICAL_SCHEMA,
        "canonical_schema_sha256": schema_fingerprint(schema_path),
        "live_schema_status": live["status"],
        "live_schema_fingerprint": live["fingerprint"],
        "live_schema_compared_to_repository_file": False,
        "postgresql_version": postgresql_version(sql_text),
        "included_tables": list(INCLUDED_TABLES),
        "excluded_tables": [dict(item) for item in EXCLUDED_TABLES],
        "row_counts": row_counts,
        "checksums": {"data.sql": "sha256:" + sha256_file(data_path)},
    }
    if re.fullmatch(r"[1-9][0-9]*", source_repository_id or ""):
        manifest["source_repository_id"] = source_repository_id
    manifest_path = bundle / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8", newline="\n")
    sums = bundle / "SHA256SUMS"
    data_hex = manifest["checksums"]["data.sql"].removeprefix("sha256:")
    manifest_hex = sha256_file(manifest_path)
    sums.write_text(f"{data_hex}  data.sql\n{manifest_hex}  manifest.json\n", encoding="utf-8", newline="\n")
    write_summary(bundle / "summary.txt", manifest)
    return manifest


def encrypt_archive(bundle: Path, recipient: str, destination: Path) -> None:
    if not shutil.which("age"):
        raise BackupError("age is not installed or not on PATH.")
    tar_path = bundle / "backup.tar.gz"
    with tarfile.open(tar_path, "w:gz") as archive:
        for name in ("data.sql", "manifest.json", "SHA256SUMS", "summary.txt"):
            archive.add(bundle / name, arcname=name)
    age_tmp = bundle / "backup.tar.gz.age"
    env = os.environ.copy()
    for key in ("SUPABASE_DB_URL", "PGPASSWORD", "PGHOST", "PGUSER", "PGDATABASE", "DATABASE_URL"):
        env.pop(key, None)
    _run(
        ["age", "--recipient", recipient, "--output", str(age_tmp), str(tar_path)],
        env,
        [recipient],
        "age",
    )
    plaintext = tar_path.read_bytes()
    ciphertext = age_tmp.read_bytes()
    if plaintext and plaintext in ciphertext:
        raise BackupError("Encrypted artifact still contains the plaintext archive.")
    if not ciphertext.startswith(b"age-encryption.org/"):
        raise BackupError("age did not produce an encrypted file.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    os.replace(age_tmp, destination)


def _git_sha(root: Path) -> str:
    if os.environ.get("GITHUB_SHA", "").strip():
        return os.environ["GITHUB_SHA"].strip()
    try:
        completed = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=root,
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError as exc:
        raise BackupError("Set GITHUB_SHA or run from a git checkout.") from exc
    sha = (completed.stdout or "").strip()
    if completed.returncode != 0 or not sha:
        raise BackupError("Set GITHUB_SHA or run from a git checkout.")
    return sha


def run_backup(out_path: Path) -> dict:
    url = os.environ.get("SUPABASE_DB_URL", "")
    recipient_raw = os.environ.get("SQL_BACKUP_AGE_RECIPIENT", "")
    missing = []
    if not url.strip():
        missing.append("SUPABASE_DB_URL")
    if not recipient_raw.strip():
        missing.append("SQL_BACKUP_AGE_RECIPIENT")
    if missing:
        raise BackupError("Set " + " and ".join(missing) + ".")
    recipient = validate_recipient(recipient_raw)
    conn = parse_database_url(url)
    root = repo_root()
    schema_path = root / CANONICAL_SCHEMA
    if not schema_path.is_file():
        raise BackupError(f"Missing canonical schema file {CANONICAL_SCHEMA}.")
    if not shutil.which("pg_dump"):
        raise BackupError("pg_dump is not installed or not on PATH.")
    if not shutil.which("age"):
        raise BackupError("age is not installed or not on PATH.")

    created = datetime.now(timezone.utc).replace(microsecond=0)
    created_at = created.strftime("%Y-%m-%dT%H:%M:%SZ")
    bundle = Path(tempfile.mkdtemp(prefix="sql-backup-"))
    try:
        if os.name == "posix":
            os.chmod(bundle, 0o700)
        data_path = bundle / "data.sql"
        dump_data(conn, data_path)
        live_schema = assess_live_schema(conn)
        sql_text = data_path.read_text(encoding="utf-8")
        manifest = build_bundle(
            bundle,
            sql_text,
            schema_path=schema_path,
            source_repository=os.environ.get("GITHUB_REPOSITORY", "").strip() or "local",
            workflow_run_id=os.environ.get("GITHUB_RUN_ID", "").strip() or "local",
            source_commit_sha=_git_sha(root),
            created_at=created_at,
            live_schema=live_schema,
            source_repository_id=os.environ.get("GITHUB_REPOSITORY_ID", "").strip(),
        )
        encrypt_archive(bundle, recipient, out_path)
        return manifest
    finally:
        shutil.rmtree(bundle, ignore_errors=True)


def _write_github_output(stamp: str, artifact_name: str) -> None:
    path = os.environ.get("GITHUB_OUTPUT", "").strip()
    if not path:
        return
    with open(path, "a", encoding="utf-8", newline="\n") as handle:
        handle.write(f"stamp={stamp}\n")
        handle.write(f"artifact={artifact_name}\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Create an age-encrypted portable SQL backup.")
    parser.add_argument("--out", type=Path, help="Exact output path for the .tar.gz.age file")
    parser.add_argument("--out-dir", type=Path, help="Directory for sql-backup-<utc>.tar.gz.age")
    args = parser.parse_args(argv)
    if (args.out is None) == (args.out_dir is None):
        print("Pass exactly one of --out or --out-dir.", file=sys.stderr)
        return 1

    created = datetime.now(timezone.utc).replace(microsecond=0)
    stamp = created.strftime("%Y%m%dT%H%M%SZ")
    if args.out is not None:
        out_path = args.out
    else:
        out_path = args.out_dir / f"sql-backup-{stamp}.tar.gz.age"

    try:
        manifest = run_backup(out_path)
    except BackupError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    _write_github_output(stamp, out_path.name)
    summary_lines = [
        f"format_version: {manifest['format_version']}",
        f"created_at: {manifest['created_at']}",
        f"source_repository: {manifest['source_repository']}",
        f"workflow_run_id: {manifest['workflow_run_id']}",
        *(
            [f"source_repository_id: {manifest['source_repository_id']}"]
            if manifest.get("source_repository_id")
            else []
        ),
        f"source_commit_sha: {manifest['source_commit_sha']}",
        f"source_schema_fingerprint: {manifest['canonical_schema_sha256']}",
        f"canonical_schema_sha256: {manifest['canonical_schema_sha256']}",
        f"live_schema_status: {manifest['live_schema_status']}",
        "live_schema_compared_to_repository_file: false",
        f"postgresql_version: {manifest['postgresql_version']}",
        f"artifact_bytes: {out_path.stat().st_size}",
        "row_counts:",
    ]
    for name, count in manifest["row_counts"].items():
        summary_lines.append(f"  {name}: {count}")
    summary = "\n".join(summary_lines)
    print(summary)
    step_summary = os.environ.get("GITHUB_STEP_SUMMARY", "").strip()
    if step_summary:
        with open(step_summary, "a", encoding="utf-8", newline="\n") as handle:
            handle.write("## SQL backup\n\n```\n" + summary + "\n```\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
