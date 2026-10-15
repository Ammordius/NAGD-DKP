#!/usr/bin/env python3
"""Restore a portable SQL backup into a destination database.

Dry-run is the default and performs no writes. An actual restore loads the
allowlisted COPY blocks into temporary tables, then replaces guild DKP rows
in one psql transaction. Destination auth users, profiles, and the officer
audit log stay in place. A hosted destination is accepted when its configured
name, host, database, and Supabase project reference match the connection.
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
from datetime import date, timedelta
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

import sql_backup
import sql_backup_fetch

MAX_DATA_SQL_BYTES = 512 * 1024 * 1024
MIN_POSTGRES_MAJOR = 15
TRANSACTION_POOLER_PORT = 6543
SESSION_PORT = 5432
LOCAL_DESTINATION_HOSTS = frozenset({"localhost", "127.0.0.1"})

REQUIRED_FUNCTIONS = sql_backup.SOURCE_RESTORE_FUNCTIONS

DELETE_ORDER = (
    "bid_portfolio_auction_fact",
    "loot_assignment",
    "character_dkp_spent",
    "character_loot_assignment_counts",
    "raid_attendance_dkp_by_account",
    "raid_attendance_dkp",
    "raid_dkp_totals",
    "raid_event_attendance",
    "raid_loot",
    "raid_attendance",
    "raid_events",
    "raid_classifications",
    "dkp_adjustments",
    "active_raiders",
    "active_accounts",
    "character_account",
    "account_dkp_summary",
    "dkp_summary",
    "dkp_period_totals",
    "raids",
    "characters",
)

INSERT_ORDER = (
    "characters",
    "character_account",
    "raids",
    "raid_events",
    "raid_attendance",
    "raid_loot",
    "raid_classifications",
    "dkp_adjustments",
    "active_raiders",
    "active_accounts",
    "raid_event_attendance",
    "loot_assignment",
)

LOCK_ORDER = DELETE_ORDER + ("account_class_coverage", "accounts")

PRIMARY_KEYS = {
    "characters": ("char_id",),
    "accounts": ("account_id",),
    "character_account": ("char_id", "account_id"),
    "raids": ("raid_id",),
    "raid_events": ("id",),
    "raid_attendance": ("id",),
    "raid_event_attendance": ("id",),
    "raid_loot": ("id",),
    "loot_assignment": ("loot_id",),
    "dkp_adjustments": ("character_name",),
    "raid_classifications": ("raid_id", "mob"),
    "active_raiders": ("character_key",),
    "active_accounts": ("account_id",),
}

# Child table, referenced schema, referenced table.
EXPECTED_FOREIGN_KEYS = {
    ("profiles", "auth", "users"),
    ("profiles", "public", "accounts"),
    ("officer_audit_log", "auth", "users"),
    ("character_account", "public", "characters"),
    ("character_account", "public", "accounts"),
    ("raid_events", "public", "raids"),
    ("raid_attendance", "public", "raids"),
    ("raid_event_attendance", "public", "accounts"),
    ("raid_classifications", "public", "raids"),
    ("raid_dkp_totals", "public", "raids"),
    ("raid_attendance_dkp", "public", "raids"),
    ("raid_attendance_dkp_by_account", "public", "raids"),
    ("raid_attendance_dkp_by_account", "public", "accounts"),
    ("dkp_adjustments", "public", "accounts"),
    ("active_accounts", "public", "accounts"),
    ("account_dkp_summary", "public", "accounts"),
    ("loot_assignment", "public", "raid_loot"),
    ("bid_portfolio_auction_fact", "public", "raid_loot"),
    ("account_class_coverage", "public", "accounts"),
}

CATALOG_TABLES = tuple(
    dict.fromkeys(
        list(sql_backup.INCLUDED_TABLES)
        + list(DELETE_ORDER)
        + ["profiles", "accounts", "officer_audit_log", "restore_in_progress", "account_class_coverage"]
    )
)

_IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*$")
_POOLER_HOST = re.compile(r"^[a-z0-9-]+\.pooler\.supabase\.com$")
_DIRECT_HOST = re.compile(r"^db\.([a-z0-9]+)\.supabase\.co$")
_POOLER_USER = re.compile(r"^postgres\.([a-z0-9]+)$")
_CREATE_TABLE = re.compile(r"(?im)^[ \t]*CREATE[ \t]+TABLE\b")
_VERSION_MAJOR = re.compile(r"(\d+)")


class RestoreError(Exception):
    """Fail-closed restore error. The message must not contain secrets."""


def repo_root() -> Path:
    return sql_backup.repo_root()


def denylist_path() -> Path:
    return Path(__file__).resolve().parent / "sql_restore_production_denylist.txt"


def load_denylist(path: Path | None = None) -> set[str]:
    file_path = path or denylist_path()
    if not file_path.is_file():
        raise RestoreError("Production host denylist is missing.")
    hosts: set[str] = set()
    for line in file_path.read_text(encoding="utf-8").splitlines():
        text = line.strip().lower()
        if not text or text.startswith("#"):
            continue
        if any(ch.isspace() for ch in text) or "://" in text:
            raise RestoreError("Production host denylist has an invalid line.")
        hosts.add(text)
    return hosts


def assert_host_not_denied(host: str, denied_hosts: set[str]) -> None:
    # SQL_RESTORE_ALLOW_PRODUCTION does not grant access and does not bypass this list.
    if host.lower() in denied_hosts:
        raise RestoreError("Destination host is refused.")


def proven_project_ref(host: str, user: str) -> str:
    """Return the Supabase project reference this connection proves."""
    host_name = host.lower()
    user_name = user.lower()
    if _POOLER_HOST.fullmatch(host_name):
        match = _POOLER_USER.fullmatch(user_name)
        if not match:
            raise RestoreError("Session pooler username does not include a project reference.")
        return match.group(1)
    direct = _DIRECT_HOST.fullmatch(host_name)
    if direct:
        if user_name != "postgres":
            raise RestoreError("Direct connection username does not match the Supabase project.")
        return direct.group(1)
    raise RestoreError("Destination identity is not an approved restore target.")


def assert_destination_identity(
    name: str,
    host: str,
    database: str,
    user: str = "postgres",
    *,
    port: int = SESSION_PORT,
    sslmode: str = "",
) -> None:
    """Allow localhost for tests, or a hosted destination whose configuration matches."""
    if host.lower() in LOCAL_DESTINATION_HOSTS:
        if os.environ.get("GITHUB_ACTIONS") == "true":
            raise RestoreError("Destination identity is not an approved restore target.")
        return
    if port == TRANSACTION_POOLER_PORT:
        raise RestoreError("Refusing the transaction pooler. Use the session pooler on port 5432.")
    if port != SESSION_PORT:
        raise RestoreError("Hosted restore requires the session pooler on port 5432.")
    if sslmode != "require":
        raise RestoreError("Hosted restore requires sslmode=require.")
    expected_name, expected_host, expected_db = destination_settings()
    if name != expected_name:
        raise RestoreError("Destination name does not match SQL_RESTORE_DESTINATION_NAME.")
    if host.lower() != expected_host.lower():
        raise RestoreError("Connected host does not match SQL_RESTORE_DESTINATION_HOST.")
    if database != expected_db:
        raise RestoreError("Connected database does not match SQL_RESTORE_DATABASE_NAME.")
    expected_ref = os.environ.get("SQL_RESTORE_PROJECT_REF", "").strip().lower()
    if not expected_ref:
        raise RestoreError("Set SQL_RESTORE_PROJECT_REF.")
    proven = proven_project_ref(host, user)
    if proven != expected_ref:
        raise RestoreError("Connected project reference does not match SQL_RESTORE_PROJECT_REF.")


def assert_actions_context(*, execute: bool) -> None:
    if os.environ.get("GITHUB_ACTIONS") != "true":
        return
    if os.environ.get("GITHUB_EVENT_NAME") != "workflow_dispatch":
        raise RestoreError("Restore workflow must be started manually.")
    if execute and os.environ.get("GITHUB_REF") != "refs/heads/main":
        raise RestoreError("Restore workflow must run from main.")


def quote_ident(name: str) -> str:
    if not _IDENT.fullmatch(name):
        raise RestoreError(f"Rejected an unexpected SQL identifier {name}.")
    return '"' + name.replace('"', '""') + '"'


def sql_text(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _redact(text: str, secrets: list[str]) -> str:
    redacted = text
    for secret in secrets:
        if secret:
            redacted = redacted.replace(secret, "[redacted]")
    return redacted


def _psql_env(conn: dict[str, str | int], *, read_only: bool) -> dict[str, str]:
    env = os.environ.copy()
    for key in list(env):
        if key.startswith("BACKUP_ARTIFACT_READ_TOKEN") or key == "BACKUP_ARTIFACT_TOKEN_SECRET":
            env.pop(key, None)
    for key in (
        "SUPABASE_DB_URL",
        "SQL_RESTORE_DB_URL",
        "SQL_BACKUP_AGE_RECIPIENT",
        "SQL_BACKUP_AGE_IDENTITY",
        "DATABASE_URL",
        "PGPASSWORD",
        "GH_TOKEN",
        "GITHUB_TOKEN",
    ):
        env.pop(key, None)
    env["PGHOST"] = str(conn["host"])
    env["PGPORT"] = str(conn["port"])
    env["PGUSER"] = str(conn["user"])
    env["PGPASSWORD"] = str(conn["password"])
    env["PGDATABASE"] = str(conn["database"])
    env["PGCLIENTENCODING"] = "UTF8"
    env["LC_ALL"] = "C"
    env["PGPASSFILE"] = "NUL" if os.name == "nt" else os.devnull
    if read_only:
        env["PGOPTIONS"] = "-c default_transaction_read_only=on"
    else:
        env.pop("PGOPTIONS", None)
    if conn["sslmode"]:
        env["PGSSLMODE"] = str(conn["sslmode"])
    else:
        env.pop("PGSSLMODE", None)
    return env


def run_psql(conn: dict[str, str | int], sql: str, *, read_only: bool) -> str:
    if not shutil.which("psql"):
        raise RestoreError("psql is not installed or not on PATH.")
    secrets = [str(conn["password"]), str(conn["user"])]
    with tempfile.TemporaryDirectory(prefix="sql-restore-") as tmp:
        script = Path(tmp) / "restore.sql"
        script.write_text(sql, encoding="utf-8", newline="\n")
        if os.name == "posix":
            os.chmod(script, 0o600)
        completed = subprocess.run(
            ["psql", "-X", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A", "-f", str(script)],
            env=_psql_env(conn, read_only=read_only),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
    if completed.returncode != 0:
        detail = _redact((completed.stderr or completed.stdout or "").strip(), secrets)
        suffix = f"\n{detail}" if detail else ""
        raise RestoreError(f"psql failed (exit {completed.returncode}).{suffix}")
    return completed.stdout


def destination_settings() -> tuple[str, str, str]:
    name = os.environ.get("SQL_RESTORE_DESTINATION_NAME", "").strip()
    host = os.environ.get("SQL_RESTORE_DESTINATION_HOST", "").strip()
    database = os.environ.get("SQL_RESTORE_DATABASE_NAME", "").strip()
    if not name or not host or not database:
        raise RestoreError(
            "Set SQL_RESTORE_DESTINATION_NAME, SQL_RESTORE_DESTINATION_HOST, and SQL_RESTORE_DATABASE_NAME."
        )
    return name, host, database


def connect_destination() -> dict[str, str | int]:
    url = os.environ.get("SQL_RESTORE_DB_URL", "").strip()
    if not url:
        raise RestoreError("Set SQL_RESTORE_DB_URL to the destination session-mode Postgres URI.")
    try:
        conn = sql_backup.parse_database_url(url)
    except sql_backup.BackupError as exc:
        raise RestoreError(str(exc)) from None
    if int(conn["port"]) == TRANSACTION_POOLER_PORT:
        raise RestoreError("Refusing the transaction pooler. Use the session pooler on port 5432.")
    expected_name, expected_host, expected_db = destination_settings()
    if str(conn["host"]).lower() != expected_host.lower():
        raise RestoreError("Connected host does not match SQL_RESTORE_DESTINATION_HOST.")
    if str(conn["database"]) != expected_db:
        raise RestoreError("Connected database does not match SQL_RESTORE_DATABASE_NAME.")
    assert_destination_identity(
        expected_name,
        str(conn["host"]),
        str(conn["database"]),
        str(conn["user"]),
        port=int(conn["port"]),
        sslmode=str(conn["sslmode"]),
    )
    return conn


def _extract_tar(archive: tarfile.TarFile, destination: Path) -> None:
    try:
        archive.extractall(destination, filter="data")
    except TypeError:
        archive.extractall(destination)


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _read_bundle_files(directory: Path) -> dict[str, bytes]:
    found: dict[str, bytes] = {}
    for name in sql_backup_fetch.ARCHIVE_NAMES:
        path = directory / name
        if not path.is_file():
            raise RestoreError("Backup bundle is missing an expected file.")
        found[name] = path.read_bytes()
    return found


def verify_bundle_bytes(
    files: dict[str, bytes],
    *,
    source: str,
    schema_path: Path,
    origin: sql_backup_fetch.RepositoryIdentity | None = None,
    client=None,
    run_id: str = "",
) -> tuple[str, dict]:
    if len(files["data.sql"]) > MAX_DATA_SQL_BYTES:
        raise RestoreError("data.sql exceeds the restore size limit.")
    try:
        sums = sql_backup_fetch._parse_sums(files["SHA256SUMS"].decode("utf-8"))
    except (UnicodeError, sql_backup_fetch.FetchError) as exc:
        raise RestoreError("SHA256SUMS could not be verified.") from exc
    data_hex = _sha256(files["data.sql"])
    manifest_hex = _sha256(files["manifest.json"])
    if sums["data.sql"] != data_hex or sums["manifest.json"] != manifest_hex:
        raise RestoreError("Checksum does not match the backup bundle.")
    try:
        manifest = json.loads(files["manifest.json"].decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise RestoreError("Manifest is not valid JSON.") from exc
    if not isinstance(manifest, dict):
        raise RestoreError("Manifest is not valid JSON.")
    if manifest.get("format_version") != sql_backup.FORMAT_VERSION:
        raise RestoreError("Artifact format_version is not supported.")
    if manifest.get("included_tables") != list(sql_backup.INCLUDED_TABLES):
        raise RestoreError("Artifact table list does not match the allowlist.")
    checksums = manifest.get("checksums")
    if not isinstance(checksums, dict) or checksums.get("data.sql") != "sha256:" + data_hex:
        raise RestoreError("Manifest checksum does not match data.sql.")
    try:
        manifest_source = sql_backup_fetch._require_text(
            manifest.get("source_repository"), "source_repository", sql_backup_fetch._REPO
        )
        if origin is not None and client is not None:
            sql_backup_fetch.assert_manifest_origin(
                manifest,
                origin=origin,
                selected_name=source,
                client=client,
                run_id=run_id or str(manifest.get("workflow_run_id") or ""),
            )
        elif manifest_source != source:
            raise sql_backup_fetch.FetchError(
                "Manifest source_repository does not match the selected repository.\n"
                f"selected_repository: {source}\n"
                f"manifest_source_repository: {manifest_source}"
            )
    except sql_backup_fetch.FetchError as exc:
        raise RestoreError(str(exc)) from None
    try:
        sql_backup_fetch._require_text(manifest.get("workflow_run_id"), "workflow_run_id", sql_backup_fetch._DIGITS)
        sql_backup_fetch._require_text(manifest.get("source_commit_sha"), "source_commit_sha", sql_backup_fetch._COMMIT)
        sql_backup_fetch._require_text(manifest.get("created_at"), "created_at", sql_backup_fetch._CREATED)
    except sql_backup_fetch.FetchError as exc:
        raise RestoreError(str(exc)) from None
    if manifest.get("canonical_schema_source") != sql_backup.CANONICAL_SCHEMA:
        raise RestoreError("Manifest schema source is invalid.")
    if not schema_path.is_file():
        raise RestoreError(f"Missing canonical schema file {sql_backup.CANONICAL_SCHEMA}.")
    try:
        sql_backup_fetch.assess_schema_compatibility(manifest, schema_path, client, source)
    except sql_backup_fetch.FetchError as exc:
        raise RestoreError(str(exc)) from None
    require_restorable_live_schema(manifest)
    version = manifest.get("postgresql_version")
    if not isinstance(version, str) or not version.strip() or len(version) > 200 or "\n" in version:
        raise RestoreError("Manifest postgresql_version is invalid.")
    counts = manifest.get("row_counts")
    if not isinstance(counts, dict) or set(counts) != set(sql_backup.INCLUDED_TABLES):
        raise RestoreError("Manifest row_counts do not match the allowlist.")
    for table, count in counts.items():
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            raise RestoreError(f"Manifest row count for {table} is invalid.")
    try:
        sql_text = files["data.sql"].decode("utf-8")
    except UnicodeError as exc:
        raise RestoreError("data.sql is not valid UTF-8.") from exc
    if _CREATE_TABLE.search(sql_text):
        raise RestoreError("data.sql contains schema SQL.")
    return sql_text, manifest


def require_restorable_live_schema(manifest: dict) -> dict:
    """Separate the repository file hash from the live catalog. Do not apply schema."""
    try:
        live = sql_backup.live_schema_record(manifest)
    except sql_backup.BackupError as exc:
        raise RestoreError(str(exc)) from None
    if live["status"] == "incompatible":
        raise RestoreError(
            "Live schema status is incompatible. "
            "The source-code fingerprint is not live verification, and restore does not apply schema."
        )
    return live


def load_bundle_dir(
    directory: Path,
    source: str,
    *,
    origin: sql_backup_fetch.RepositoryIdentity | None = None,
    client=None,
    run_id: str = "",
) -> tuple[str, dict]:
    files = _read_bundle_files(directory)
    return verify_bundle_bytes(
        files,
        source=source,
        schema_path=repo_root() / sql_backup.CANONICAL_SCHEMA,
        origin=origin,
        client=client,
        run_id=run_id,
    )


def pin_from_summary(summary: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    for line in summary.splitlines():
        if line.startswith(" ") or ":" not in line:
            continue
        key, value = line.split(":", 1)
        fields[key.strip()] = value.strip()
    required = ("artifact_id", "artifact_name", "workflow_run_id", "artifact_sha256", "source_repository")
    for key in required:
        if not fields.get(key):
            raise RestoreError(f"Verified artifact is missing {key}.")
    if sql_backup_fetch._DIGITS.fullmatch(fields["artifact_id"]) is None:
        raise RestoreError("Verified artifact id is invalid.")
    if sql_backup_fetch._DIGITS.fullmatch(fields["workflow_run_id"]) is None:
        raise RestoreError("Verified artifact is missing its workflow run.")
    if not re.fullmatch(r"[0-9a-f]{64}", fields["artifact_sha256"]):
        raise RestoreError("Verified artifact digest is invalid.")
    pin = {key: fields[key] for key in required}
    if fields.get("selected_repository"):
        pin["selected_repository"] = fields["selected_repository"]
    if fields.get("repository_id"):
        pin["repository_id"] = fields["repository_id"]
    return pin


def require_execution_pin(name: str, run_id: str, digest: str) -> None:
    if not name.strip() or not run_id.strip() or not digest.strip():
        raise RestoreError(
            "Restore requires the pinned artifact name, workflow run, and digest from preflight."
        )
    if not re.fullmatch(r"[0-9a-f]{64}", digest.strip().lower()):
        raise RestoreError("Pinned artifact digest is invalid.")


def assert_pinned_artifact(
    pin: dict[str, str],
    *,
    source: str,
    artifact_id: str,
    expect_name: str,
    expect_run: str,
    expect_sha256: str,
    require_digest: bool,
) -> None:
    if require_digest:
        require_execution_pin(expect_name, expect_run, expect_sha256)
    if pin["artifact_id"] != artifact_id:
        raise RestoreError(
            "Fetched artifact id does not match the pinned checkpoint. Refusing to restore a different backup."
        )
    selected = pin.get("selected_repository", "")
    if pin["source_repository"] != source and selected != source:
        raise RestoreError(
            "Fetched artifact repository does not match the pinned checkpoint. "
            "Refusing to restore a different backup.\n"
            f"selected_repository: {source}\n"
            f"artifact_repository: {pin['source_repository']}"
        )
    if expect_name and pin["artifact_name"] != expect_name:
        raise RestoreError(
            "Fetched artifact name does not match the pinned checkpoint. Refusing to restore a different backup."
        )
    if expect_run and pin["workflow_run_id"] != expect_run:
        raise RestoreError(
            "Fetched workflow run does not match the pinned checkpoint. Refusing to restore a different backup."
        )
    if expect_sha256 and pin["artifact_sha256"] != expect_sha256.strip().lower():
        raise RestoreError(
            "Fetched artifact digest does not match the pinned checkpoint. Refusing to restore a different backup."
        )


def pinned_snapshot_line(manifest: dict, *, artifact_id: str, artifact_name: str) -> str:
    created = manifest.get("created_at", "")
    name = artifact_name or "bundle"
    ident = artifact_id or "bundle"
    return (
        f"pinned_snapshot: {created} artifact {name} id {ident} "
        "replaces guild DKP data. Destination auth, profiles, claims, and the officer audit log are kept."
    )


def load_from_fetch(
    source: str,
    current_repository: str,
    artifact_id: str,
    other_name: str = "",
) -> tuple[str, dict, dict[str, str]]:
    if not sql_backup_fetch._DIGITS.fullmatch(artifact_id or ""):
        raise RestoreError("Select an exact artifact id.")
    identity = sql_backup_fetch._identity_from_env()
    if not identity:
        raise RestoreError("Set SQL_BACKUP_AGE_IDENTITY to verify the backup.")
    try:
        _secret_name, token, client, origin = sql_backup_fetch.open_source(
            source, current_repository, other_name
        )
    except sql_backup_fetch.FetchError as exc:
        raise RestoreError(str(exc)) from None
    work = Path(tempfile.mkdtemp(prefix="sql-restore-fetch-"))
    try:
        try:
            summary = sql_backup_fetch.fetch(
                source=source,
                current_repository=current_repository,
                token=token,
                client=client,
                out_dir=work,
                artifact_id=artifact_id,
                identity=identity,
            )
        except sql_backup_fetch.FetchError as exc:
            raise RestoreError(str(exc)) from None
        if "inner_verified: true" not in summary:
            raise RestoreError("Artifact was not verified.")
        pin = pin_from_summary(summary)
        match = re.search(r"(?m)^workflow_run_id: ([0-9]+)$", summary)
        if match is None:
            raise RestoreError("Verified artifact is missing its workflow run.")
        age_files = sorted(work.glob("*.tar.gz.age"))
        if len(age_files) != 1:
            raise RestoreError("Fetch did not leave one encrypted backup.")
        tar_path = work / "backup.tar.gz"
        try:
            sql_backup_fetch.decrypt_age(age_files[0], identity, tar_path)
            sql_backup_fetch.verify_plaintext(
                tar_path,
                source=origin.full_name,
                run_id=match.group(1),
                schema_path=repo_root() / sql_backup.CANONICAL_SCHEMA,
                origin=origin,
                client=client,
                selected_name=source,
            )
        except sql_backup_fetch.FetchError as exc:
            raise RestoreError(str(exc)) from None
        extract = work / "bundle"
        extract.mkdir()
        try:
            with tarfile.open(tar_path, "r:gz") as archive:
                _extract_tar(archive, extract)
        except (tarfile.TarError, OSError) as exc:
            raise RestoreError("Archive is malformed.") from exc
        sql_text, manifest = load_bundle_dir(
            extract,
            source,
            origin=origin,
            client=client,
            run_id=match.group(1),
        )
        return sql_text, manifest, pin
    finally:
        shutil.rmtree(work, ignore_errors=True)


def copy_sections(sql_text: str) -> dict[str, dict]:
    sections: dict[str, dict] = {}
    lines = sql_text.splitlines()
    index = 0
    while index < len(lines):
        line = lines[index]
        if not line.startswith("COPY "):
            index += 1
            continue
        header = sql_backup._COPY_HEADER.match(line)
        if not header:
            raise RestoreError("data.sql contains a COPY statement this restore cannot read.")
        table = header.group("table") or header.group("table2")
        if table in sections:
            raise RestoreError(f"data.sql emitted {table} more than once.")
        columns = sql_backup._parse_columns(header.group("cols"))
        for column in columns:
            if not _IDENT.fullmatch(column):
                raise RestoreError(f"data.sql has an unexpected column on {table}.")
        index += 1
        body: list[str] = []
        while index < len(lines) and lines[index] != r"\.":
            body.append(lines[index])
            index += 1
        if index >= len(lines) or lines[index] != r"\.":
            raise RestoreError(f"COPY block for {table} is truncated.")
        sections[table] = {"columns": columns, "body": body}
        index += 1
    return sections


def parsed_blocks(sql_text: str) -> dict[str, dict]:
    try:
        blocks = sql_backup.parse_copy_blocks(sql_text)
        counts = sql_backup.require_allowlist(blocks)
    except sql_backup.BackupError as exc:
        raise RestoreError(str(exc)) from None
    for table, block in blocks.items():
        width = len(block["columns"])
        for row in block["rows"]:
            if len(row) != width:
                raise RestoreError(f"{table} has a row with the wrong number of columns.")
        if counts[table] != len(block["rows"]):
            raise RestoreError(f"{table} row count could not be read.")
    return blocks


def require_parsed_counts(blocks: dict[str, dict], manifest: dict) -> None:
    for table in sql_backup.INCLUDED_TABLES:
        if manifest["row_counts"][table] != len(blocks[table]["rows"]):
            raise RestoreError(f"Manifest row count does not match {table}.")


def _rows(blocks: dict[str, dict], table: str) -> list[dict[str, str | None]]:
    columns = blocks[table]["columns"]
    return [dict(zip(columns, row)) for row in blocks[table]["rows"]]


def _raw(value: str | None) -> str:
    return "" if value is None else value


def _norm(value: str | None) -> str:
    return "" if value is None else value.strip()


def _parse_int(value: str | None, label: str) -> int:
    text = _norm(value)
    if not text:
        raise RestoreError(f"{label} is missing.")
    try:
        return int(text)
    except ValueError as exc:
        raise RestoreError(f"{label} is not an integer.") from exc


def _parse_decimal(value: str | None, label: str) -> Decimal:
    text = _norm(value)
    if not text:
        return Decimal(0)
    try:
        return Decimal(text)
    except Exception as exc:
        raise RestoreError(f"{label} is not numeric.") from exc


def _sql_int(value: Decimal) -> int:
    return int(value.to_integral_value(rounding=ROUND_HALF_UP))


def _parse_date(value: str | None) -> date | None:
    text = _norm(value)
    if len(text) < 10 or text[4] != "-" or text[7] != "-":
        return None
    try:
        return date.fromisoformat(text[:10])
    except ValueError:
        return None


def _mapping_indexes(blocks: dict[str, dict]) -> tuple[dict[str, set[str]], dict[str, set[str]], set[str]]:
    characters = {_raw(row.get("char_id")): row for row in _rows(blocks, "characters")}
    char_accounts: dict[str, set[str]] = {}
    name_accounts: dict[str, set[str]] = {}
    linked: set[str] = set()
    for link in _rows(blocks, "character_account"):
        char_id = _norm(link.get("char_id"))
        account_id = _norm(link.get("account_id"))
        if not char_id or not account_id:
            continue
        linked.add(char_id)
        char_accounts.setdefault(char_id, set()).add(account_id)
        character = characters.get(char_id) or characters.get(_raw(link.get("char_id")))
        name = _norm(None if character is None else character.get("name"))
        if name:
            name_accounts.setdefault(name, set()).add(account_id)
    return char_accounts, name_accounts, linked


def resolve_account_id(
    account_id: str | None,
    char_id: str | None,
    character_name: str | None,
    char_accounts: dict[str, set[str]],
    name_accounts: dict[str, set[str]],
    linked_chars: set[str],
) -> str | None:
    stamped = _norm(account_id)
    if stamped:
        return stamped
    cid = _norm(char_id)
    linked_accounts = char_accounts.get(cid, set()) if cid else set()
    if cid and len(linked_accounts) == 1:
        return next(iter(linked_accounts))
    if cid and cid in linked_chars:
        return None
    name = _norm(character_name)
    named = name_accounts.get(name, set()) if name else set()
    if name and len(named) == 1:
        return next(iter(named))
    return None


def _tic_values(blocks: dict[str, dict]) -> dict[tuple[str, str], Decimal]:
    grouped: dict[tuple[str, str], list[dict[str, str | None]]] = {}
    for event in _rows(blocks, "raid_events"):
        grouped.setdefault((_raw(event.get("raid_id")), _raw(event.get("event_id"))), []).append(event)
    values: dict[tuple[str, str], Decimal] = {}
    for key, events in grouped.items():
        def sort_key(item: dict[str, str | None]) -> tuple:
            order_text = _norm(item.get("event_order"))
            order = int(order_text) if order_text else None
            event_id = int(_norm(item.get("id")) or "0")
            return (
                order is not None,
                order or 0,
                _norm(item.get("event_name")).lower(),
                event_id,
            )

        seen: set[tuple[int | None, str]] = set()
        total = Decimal(0)
        for event in sorted(events, key=sort_key):
            order_text = _norm(event.get("event_order"))
            order = int(order_text) if order_text else None
            distinct = (order, _norm(event.get("event_name")).lower())
            if distinct in seen:
                continue
            seen.add(distinct)
            total += _parse_decimal(event.get("dkp_value"), "raid_events.dkp_value")
        values[key] = total
    return values


def snapshot_foreign_keys(blocks: dict[str, dict]) -> None:
    _require_unique(blocks)
    accounts = {_raw(row.get("account_id")) for row in _rows(blocks, "accounts")}
    characters = {_raw(row.get("char_id")) for row in _rows(blocks, "characters")}
    raids = {_raw(row.get("raid_id")) for row in _rows(blocks, "raids")}
    loot_ids = {_raw(row.get("id")) for row in _rows(blocks, "raid_loot")}
    for link in _rows(blocks, "character_account"):
        if _raw(link.get("char_id")) not in characters or _raw(link.get("account_id")) not in accounts:
            raise RestoreError("Snapshot character_account rows fail foreign keys.")
    for table in ("raid_events", "raid_attendance", "raid_classifications"):
        for row in _rows(blocks, table):
            if _raw(row.get("raid_id")) not in raids:
                raise RestoreError(f"Snapshot {table} rows fail foreign keys.")
    for row in _rows(blocks, "raid_event_attendance"):
        account_id = _raw(row.get("account_id"))
        if account_id and account_id not in accounts:
            raise RestoreError("Snapshot raid_event_attendance rows fail foreign keys.")
    for row in _rows(blocks, "dkp_adjustments"):
        account_id = _raw(row.get("account_id"))
        if account_id and account_id not in accounts:
            raise RestoreError("Snapshot dkp_adjustments rows fail foreign keys.")
    for row in _rows(blocks, "active_accounts"):
        if _raw(row.get("account_id")) not in accounts:
            raise RestoreError("Snapshot active_accounts rows fail foreign keys.")
    for row in _rows(blocks, "loot_assignment"):
        if _raw(row.get("loot_id")) not in loot_ids:
            raise RestoreError("Snapshot loot_assignment rows fail foreign keys.")


def _require_unique(blocks: dict[str, dict]) -> None:
    for table, keys in PRIMARY_KEYS.items():
        seen: set[tuple[str, ...]] = set()
        for row in _rows(blocks, table):
            identity = tuple(_raw(row.get(key)) for key in keys)
            if identity in seen:
                raise RestoreError(f"Snapshot {table} has a duplicate primary key.")
            seen.add(identity)


def expected_account_totals(blocks: dict[str, dict], as_of: date) -> dict[str, dict[str, str]]:
    """Account earned, spent, and windows from the published attendance and loot rules."""
    snapshot_foreign_keys(blocks)
    char_accounts, name_accounts, linked = _mapping_indexes(blocks)
    tic_values = _tic_values(blocks)
    raid_dates = {_raw(row.get("raid_id")): _parse_date(row.get("date_iso")) for row in _rows(blocks, "raids")}
    earned: dict[str, Decimal] = {}
    earned_30: dict[str, Decimal] = {}
    earned_60: dict[str, Decimal] = {}
    spent: dict[str, Decimal] = {}
    credited: set[tuple[str, str, str]] = set()
    for row in _rows(blocks, "raid_event_attendance"):
        account_id = resolve_account_id(
            row.get("account_id"),
            row.get("char_id"),
            row.get("character_name"),
            char_accounts,
            name_accounts,
            linked,
        )
        if not account_id:
            continue
        raid_id = _raw(row.get("raid_id"))
        event_id = _raw(row.get("event_id"))
        credit = (raid_id, event_id, account_id)
        if credit in credited:
            continue
        credited.add(credit)
        value = tic_values.get((raid_id, event_id), Decimal(0))
        earned[account_id] = earned.get(account_id, Decimal(0)) + value
        raid_date = raid_dates.get(raid_id)
        if raid_date is not None and raid_date >= as_of - timedelta(days=30):
            earned_30[account_id] = earned_30.get(account_id, Decimal(0)) + value
        if raid_date is not None and raid_date >= as_of - timedelta(days=60):
            earned_60[account_id] = earned_60.get(account_id, Decimal(0)) + value
    unique_char = {char_id: next(iter(ids)) for char_id, ids in char_accounts.items() if len(ids) == 1}
    unique_name = {name: next(iter(ids)) for name, ids in name_accounts.items() if len(ids) == 1}
    loot_accounts: set[str] = set()
    for row in _rows(blocks, "raid_loot"):
        account_id = resolve_account_id(None, row.get("char_id"), row.get("character_name"), char_accounts, name_accounts, linked)
        if account_id:
            loot_accounts.add(account_id)
        cost = _parse_decimal(row.get("cost"), "raid_loot.cost")
        char_id = _norm(row.get("char_id"))
        name = _norm(row.get("character_name"))
        if char_id and char_id in unique_char:
            buyer = unique_char[char_id]
        elif name and name in unique_name and char_id not in linked:
            buyer = unique_name[name]
        else:
            buyer = None
        if buyer:
            spent[buyer] = spent.get(buyer, Decimal(0)) + cost
    totals: dict[str, dict[str, str]] = {}
    for account_id in sorted(set(earned) | loot_accounts | set(spent)):
        account_earned = earned.get(account_id, Decimal(0))
        account_spent = spent.get(account_id, Decimal(0))
        account_30 = _sql_int(earned_30.get(account_id, Decimal(0)))
        account_60 = _sql_int(earned_60.get(account_id, Decimal(0)))
        if account_earned == 0 and account_spent == 0 and account_30 == 0 and account_60 == 0:
            continue
        totals[account_id] = {
            "earned": format(account_earned, "f"),
            "spent": format(account_spent, "f"),
            "balance": format(account_earned - account_spent, "f"),
            "earned_30d": str(account_30),
            "earned_60d": str(account_60),
        }
    return totals


def postgres_major(text: str) -> int:
    match = _VERSION_MAJOR.match(text.strip())
    if match is None:
        raise RestoreError("PostgreSQL version is missing.")
    return int(match.group(1))


def _json_query(conn: dict[str, str | int], sql: str) -> object:
    output = run_psql(conn, sql, read_only=True).strip()
    if not output:
        raise RestoreError("Destination preflight returned no rows.")
    try:
        return json.loads(output.splitlines()[-1])
    except json.JSONDecodeError as exc:
        raise RestoreError("Destination preflight returned unexpected data.") from exc


def _preflight_sql() -> str:
    tables = ", ".join(sql_text(name) for name in CATALOG_TABLES)
    functions = ", ".join(sql_text(name) for name in REQUIRED_FUNCTIONS)
    return f"""
SET default_transaction_read_only = on;
SELECT 'meta|' || json_build_object(
  'version_num', current_setting('server_version_num'),
  'in_recovery', pg_is_in_recovery(),
  'database', current_database(),
  'today', current_date,
  'max_connections', current_setting('max_connections'),
  'connections', (SELECT count(*) FROM pg_stat_activity),
  'database_bytes', pg_database_size(current_database()),
  'restore_flag', (SELECT in_progress FROM public.restore_in_progress WHERE id = 1),
  'auth_users', to_regclass('auth.users') IS NOT NULL,
  'auth_identities', to_regclass('auth.identities') IS NOT NULL
)::text;
SELECT 'functions|' || COALESCE((
  SELECT json_agg(p.proname ORDER BY p.proname)
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.pronargs = 0 AND p.proname IN ({functions})
), '[]'::json)::text;
SELECT 'columns|' || COALESCE((
  SELECT json_object_agg(table_name, cols)
  FROM (
    SELECT c.table_name, json_agg(c.column_name ORDER BY c.ordinal_position) AS cols
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name IN ({tables})
    GROUP BY c.table_name
  ) present
), '{{}}'::json)::text;
SELECT 'counts|' || json_build_object(
  {", ".join(
      f"{sql_text(name)}, (SELECT count(*) FROM public.{quote_ident(name)})"
      for name in sql_backup.INCLUDED_TABLES
  )}
)::text;
SELECT 'claims|' || COALESCE((
  SELECT json_agg(account_id ORDER BY account_id)
  FROM public.profiles
  WHERE account_id IS NOT NULL
), '[]'::json)::text;
SELECT 'profile_fk|' || COALESCE((
  SELECT json_agg(pg_get_constraintdef(c.oid))
  FROM pg_constraint c
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
  WHERE c.conrelid = 'public.profiles'::regclass
    AND c.contype = 'f'
    AND a.attname = 'account_id'
), '[]'::json)::text;
SELECT 'foreign_keys|' || COALESCE((
  SELECT json_agg(json_build_array(child.relname, parent_ns.nspname, parent.relname) ORDER BY child.relname, parent.relname)
  FROM pg_constraint c
  JOIN pg_class child ON child.oid = c.conrelid
  JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
  JOIN pg_class parent ON parent.oid = c.confrelid
  JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
  WHERE child_ns.nspname = 'public' AND c.contype = 'f'
), '[]'::json)::text;
SELECT 'column_types|' || COALESCE((
  SELECT json_object_agg(table_name, cols)
  FROM (
    SELECT c.table_name, json_object_agg(c.column_name, c.data_type) AS cols
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name IN ({tables})
    GROUP BY c.table_name
  ) typed
), '{{}}'::json)::text;
SELECT 'primary_keys|' || COALESCE((
  SELECT json_object_agg(relname, cols)
  FROM (
    SELECT child.relname, json_agg(a.attname ORDER BY u.ord) AS cols
    FROM pg_constraint c
    JOIN pg_class child ON child.oid = c.conrelid
    JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
    JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum
    WHERE child_ns.nspname = 'public' AND c.contype = 'p'
      AND child.relname IN ({tables})
    GROUP BY child.relname
  ) keyed
), '{{}}'::json)::text;
"""


def _labeled_json(conn: dict[str, str | int]) -> dict[str, object]:
    output = run_psql(conn, _preflight_sql(), read_only=True)
    found: dict[str, object] = {}
    for line in output.splitlines():
        if "|" not in line:
            continue
        label, payload = line.split("|", 1)
        try:
            found[label] = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise RestoreError("Destination preflight returned unexpected data.") from exc
    expected = {
        "meta",
        "functions",
        "columns",
        "counts",
        "claims",
        "profile_fk",
        "foreign_keys",
        "column_types",
        "primary_keys",
    }
    if set(found) != expected:
        raise RestoreError("Destination preflight did not return the expected checks.")
    return found


def _expected_column_types() -> dict[str, dict[str, str]]:
    text = (repo_root() / sql_backup.CANONICAL_SCHEMA).read_text(encoding="utf-8")
    expected: dict[str, dict[str, str]] = {}
    for table, columns in sql_backup.REQUIRED_SOURCE_COLUMNS.items():
        create_sql = sql_backup.extract_create_table(text, table)
        if create_sql is None:
            raise RestoreError(f"Canonical schema is missing table {table}.")
        parsed, _constraints = sql_backup.parse_table_parts(create_sql)
        types: dict[str, str] = {}
        for column in columns:
            definition = parsed.get(column.lower())
            if definition is None:
                continue
            types[column] = sql_backup.sql_type_name(definition)
        expected[table] = types
    return expected


def _require_column_types(payload: object) -> None:
    if not isinstance(payload, dict):
        raise RestoreError("Destination column types could not be read.")
    for table, columns in _expected_column_types().items():
        present = payload.get(table)
        if not isinstance(present, dict):
            raise RestoreError(f"Destination is missing table {table}.")
        for column, expected_type in columns.items():
            live = present.get(column)
            if not isinstance(live, str):
                raise RestoreError(f"Destination {table} is missing column {column}.")
            if live != expected_type:
                raise RestoreError(
                    f"Destination {table}.{column} type {live} is incompatible with {expected_type}."
                )


def _require_primary_keys(payload: object) -> None:
    if not isinstance(payload, dict):
        raise RestoreError("Destination primary keys could not be read.")
    for table, columns in PRIMARY_KEYS.items():
        present = payload.get(table)
        if not isinstance(present, list) or tuple(present) != columns:
            raise RestoreError(f"Destination primary key for {table} does not match the restore contract.")


def _require_catalog(payload: dict[str, object], blocks: dict[str, dict]) -> None:
    meta = payload["meta"]
    if not isinstance(meta, dict):
        raise RestoreError("Destination metadata could not be read.")
    if meta.get("in_recovery") is not False:
        raise RestoreError("Destination is in recovery.")
    if meta.get("restore_flag") is not False:
        raise RestoreError("Destination restore flag is already set.")
    if meta.get("auth_users") is not True or meta.get("auth_identities") is not True:
        raise RestoreError("Destination auth identities could not be read.")
    version_num = str(meta.get("version_num", ""))
    if not version_num.isdigit():
        raise RestoreError("Destination PostgreSQL version could not be read.")
    functions = payload["functions"]
    if not isinstance(functions, list) or set(REQUIRED_FUNCTIONS) - set(functions):
        missing = sorted(set(REQUIRED_FUNCTIONS) - set(functions or []))
        raise RestoreError("Destination is missing restore functions: " + ", ".join(missing))
    columns = payload["columns"]
    if not isinstance(columns, dict):
        raise RestoreError("Destination columns could not be read.")
    for table in CATALOG_TABLES:
        present = columns.get(table)
        if not isinstance(present, list) or not present:
            raise RestoreError(f"Destination is missing table {table}.")
    for table in sql_backup.INCLUDED_TABLES:
        present = set(columns[table])
        missing = [column for column in blocks[table]["columns"] if column not in present]
        if missing:
            raise RestoreError(f"Destination {table} is missing columns from the snapshot.")
    for column in ("id", "email", "role", "display_name", "account_id", "ui_preferences", "unclaim_count", "unclaim_cooldown_until"):
        if column not in columns["profiles"]:
            raise RestoreError("Destination profiles schema is missing a required column.")
    profile_fk = payload["profile_fk"]
    if not isinstance(profile_fk, list) or len(profile_fk) != 1:
        raise RestoreError("Destination profiles.account_id foreign key could not be read.")
    definition = str(profile_fk[0]).upper()
    if "REFERENCES" not in definition or "ACCOUNTS" not in definition:
        raise RestoreError("Destination profiles.account_id does not reference accounts.")
    if "ON DELETE CASCADE" in definition:
        raise RestoreError("Destination profiles.account_id uses ON DELETE CASCADE.")
    foreign_keys = payload["foreign_keys"]
    if not isinstance(foreign_keys, list):
        raise RestoreError("Destination foreign keys could not be read.")
    found = set()
    for item in foreign_keys:
        if not isinstance(item, list) or len(item) != 3:
            raise RestoreError("Destination foreign keys could not be read.")
        found.add((item[0], item[1], item[2]))
    if found != EXPECTED_FOREIGN_KEYS:
        extra = sorted(found - EXPECTED_FOREIGN_KEYS)
        missing = sorted(EXPECTED_FOREIGN_KEYS - found)
        if extra:
            raise RestoreError("Destination has a foreign key this restore does not handle.")
        raise RestoreError("Destination is missing an expected foreign key.")
    _require_column_types(payload.get("column_types"))
    _require_primary_keys(payload.get("primary_keys"))
    counts = payload["counts"]
    if not isinstance(counts, dict) or set(counts) != set(sql_backup.INCLUDED_TABLES):
        raise RestoreError("Destination table counts could not be read.")
    claims = payload["claims"]
    if not isinstance(claims, list) or not all(isinstance(item, str) for item in claims):
        raise RestoreError("Destination profile claims could not be read.")
    try:
        connections = int(meta["connections"])
        max_connections = int(meta["max_connections"])
        database_bytes = int(meta["database_bytes"])
    except (KeyError, TypeError, ValueError) as exc:
        raise RestoreError("Destination resource counts could not be read.") from exc
    if connections >= max_connections - 5:
        raise RestoreError("Destination does not have enough free connections.")
    meta["database_bytes"] = database_bytes
    meta["connections"] = connections
    meta["max_connections"] = max_connections


def claim_classes(claims: list[str], blocks: dict[str, dict]) -> tuple[list[str], list[str]]:
    snapshot_accounts = {_norm(row.get("account_id")) for row in _rows(blocks, "accounts")}
    absent = sorted(account_id for account_id in claims if account_id not in snapshot_accounts)
    present = sorted(account_id for account_id in claims if account_id in snapshot_accounts)
    return absent, present


def format_report(lines: list[str]) -> str:
    return "\n".join(lines) + "\n"


def build_report(
    *,
    mode: str,
    source: str,
    artifact_id: str,
    manifest: dict,
    meta: dict,
    blocks: dict[str, dict],
    destination_counts: dict,
    absent_claims: list[str],
    present_claims: list[str],
    totals: dict[str, dict[str, str]],
    destination_name: str,
    artifact_name: str = "",
    artifact_sha256: str = "",
) -> str:
    lines = [
        f"mode: {mode}",
        f"format_version: {manifest['format_version']}",
        f"source_repository: {source}",
        f"workflow_run_id: {manifest['workflow_run_id']}",
        f"artifact_id: {artifact_id or 'bundle'}",
        f"artifact_name: {artifact_name or 'bundle'}",
        f"artifact_sha256: {artifact_sha256 or 'bundle'}",
        f"snapshot_created_at: {manifest['created_at']}",
        pinned_snapshot_line(
            manifest,
            artifact_id=artifact_id,
            artifact_name=artifact_name,
        ),
        f"canonical_schema_sha256: {manifest['canonical_schema_sha256']}",
        f"source_schema_fingerprint: {manifest['canonical_schema_sha256']}",
        f"destination_schema_fingerprint: {manifest.get('_destination_schema_sha256', '')}",
        f"schema_compatibility: {manifest.get('_schema_compatibility', '')}",
        f"live_schema_status: {sql_backup.live_schema_record(manifest)['status']}",
        "live_schema_compared_to_repository_file: false",
        "restore_compatibility: compatible",
        f"postgresql_source: {manifest['postgresql_version']}",
        f"postgresql_destination_major: {int(meta['version_num']) // 10000}",
        f"destination_name: {destination_name}",
        f"destination_database: {meta['database']}",
        f"destination_host: {os.environ.get('SQL_RESTORE_DESTINATION_HOST', '').strip()}",
        "in_recovery: false",
        "restore_flag: false",
        "profiles_account_fk: accounts without ON DELETE CASCADE",
        "schema_apply: false",
        f"data_sql_rows: {sum(len(blocks[name]['rows']) for name in sql_backup.INCLUDED_TABLES)}",
        f"database_bytes: {meta['database_bytes']}",
        f"connections: {meta['connections']}/{meta['max_connections']}",
        "source_counts:",
    ]
    for name in sql_backup.INCLUDED_TABLES:
        lines.append(f"  {name}: {len(blocks[name]['rows'])}")
    lines.append("destination_counts:")
    for name in sql_backup.INCLUDED_TABLES:
        lines.append(f"  {name}: {destination_counts[name]}")
    lines.append("claims_preserved_absent:")
    lines.extend(f"  {account_id}" for account_id in absent_claims)
    if not absent_claims:
        lines.append("  (none)")
    lines.append("claims_preserved_present:")
    lines.extend(f"  {account_id}" for account_id in present_claims)
    if not present_claims:
        lines.append("  (none)")
    lines.append("expected_dkp:")
    if not totals:
        lines.append("  (none)")
    for account_id in sorted(totals):
        item = totals[account_id]
        lines.append(
            f"  {account_id} earned={item['earned']} spent={item['spent']} "
            f"balance={item['balance']} earned_30d={item['earned_30d']} earned_60d={item['earned_60d']}"
        )
    lines.append("bidding_facts: cleared and left empty")
    lines.append("writes: none" if mode == "dry-run" else "writes: committed")
    return format_report(lines)


def preflight(
    conn: dict[str, str | int],
    sql_text: str,
    manifest: dict,
    blocks: dict[str, dict],
) -> tuple[dict, dict[str, dict[str, str]], list[str], list[str]]:
    source_major = postgres_major(str(manifest["postgresql_version"]))
    payload = _labeled_json(conn)
    _require_catalog(payload, blocks)
    meta = payload["meta"]
    assert isinstance(meta, dict)
    destination_major = int(str(meta["version_num"])) // 10000
    if destination_major < MIN_POSTGRES_MAJOR or destination_major < source_major:
        raise RestoreError("Destination PostgreSQL version is older than this backup requires.")
    if str(meta.get("database")) != str(conn["database"]):
        raise RestoreError("Connected database does not match SQL_RESTORE_DATABASE_NAME.")
    today = str(meta.get("today", ""))
    try:
        as_of = date.fromisoformat(today)
    except ValueError as exc:
        raise RestoreError("Destination date could not be read.") from exc
    totals = expected_account_totals(blocks, as_of)
    claims = payload["claims"]
    assert isinstance(claims, list)
    absent, present = claim_classes([str(item) for item in claims], blocks)
    if len(sql_text.encode("utf-8")) > MAX_DATA_SQL_BYTES:
        raise RestoreError("data.sql exceeds the restore size limit.")
    return payload, totals, absent, present


def _digest(kind: str, projection: str, relation: str) -> str:
    return f"""
INSERT INTO pg_temp.restore_identity_guard (kind, digest)
SELECT {sql_text(kind)}, md5(COALESCE(string_agg(row_text, E'\\n' ORDER BY row_text), ''))
FROM (
  SELECT concat_ws(E'\\x1f', {projection}) AS row_text
  FROM {relation}
) guard_rows;
"""


def _digest_check(kind: str, projection: str, relation: str) -> str:
    return f"""
SELECT md5(COALESCE(string_agg(row_text, E'\\n' ORDER BY row_text), ''))
  INTO guard_digest
FROM (
  SELECT concat_ws(E'\\x1f', {projection}) AS row_text
  FROM {relation}
) guard_rows;
IF guard_digest IS DISTINCT FROM (
  SELECT digest FROM pg_temp.restore_identity_guard WHERE kind = {sql_text(kind)}
) THEN
  RAISE EXCEPTION '{kind} changed during restore';
END IF;
"""


def _copy_stdin(table: str, columns: list[str], body: list[str]) -> str:
    """Serialize one staged COPY. An empty body is zero rows, not a blank data line."""
    column_sql = ", ".join(quote_ident(column) for column in columns)
    header = f"COPY pg_temp.stage_{table} ({column_sql}) FROM stdin;"
    if not body:
        return f"{header}\n\\."
    return header + "\n" + "\n".join(body) + "\n\\."


def _agreed_row_counts(sections: dict[str, dict], blocks: dict[str, dict], manifest: dict) -> dict[str, int]:
    recorded = manifest.get("row_counts")
    if not isinstance(recorded, dict) or set(recorded) != set(sql_backup.INCLUDED_TABLES):
        raise RestoreError("Manifest row_counts do not match the allowlist.")
    if set(blocks) != set(sql_backup.INCLUDED_TABLES):
        raise RestoreError("data.sql table list does not match the allowlist.")
    agreed: dict[str, int] = {}
    for table in sql_backup.INCLUDED_TABLES:
        parsed = len(blocks[table]["rows"])
        copied = len(sections[table]["body"])
        manifest_count = recorded[table]
        if isinstance(manifest_count, bool) or not isinstance(manifest_count, int) or manifest_count < 0:
            raise RestoreError(f"Manifest row count for {table} is invalid.")
        if copied != parsed or manifest_count != parsed:
            raise RestoreError(f"Staged row count does not match the backup for {table}.")
        agreed[table] = parsed
    return agreed


def _staged_count_checks(expected: dict[str, int]) -> str:
    comparisons: list[str] = []
    for table in sql_backup.INCLUDED_TABLES:
        count = expected[table]
        relation = quote_ident(f"stage_{table}")
        comparisons.append(
            f"""
SELECT count(*) INTO stage_count FROM pg_temp.{relation};
IF stage_count IS DISTINCT FROM {count} THEN
  RAISE EXCEPTION 'staged {table} count does not match the backup';
END IF;
"""
        )
    return f"""
DO $$
DECLARE
  stage_count bigint;
BEGIN
  {"".join(comparisons)}
END $$;
"""


def build_restore_sql(
    sql_text: str,
    blocks: dict[str, dict],
    totals: dict[str, dict[str, str]],
    *,
    manifest: dict,
    fail_before_commit: bool,
) -> str:
    sections = copy_sections(sql_text)
    if set(sections) != set(sql_backup.INCLUDED_TABLES):
        raise RestoreError("data.sql table list does not match the allowlist.")
    expected_counts = _agreed_row_counts(sections, blocks, manifest)
    statements = [
        "\\set ON_ERROR_STOP on",
        "BEGIN;",
        "SET LOCAL statement_timeout = '600s';",
        "SET LOCAL lock_timeout = '60s';",
        "SET LOCAL search_path = pg_temp, public;",
        "LOCK TABLE public.profiles IN SHARE MODE;",
        "LOCK TABLE auth.users IN SHARE MODE;",
        "LOCK TABLE auth.identities IN SHARE MODE;",
        "LOCK TABLE public.officer_audit_log IN SHARE MODE;",
        "CREATE TEMP TABLE restore_identity_guard (kind text PRIMARY KEY, digest text NOT NULL);",
        _digest(
            "profiles",
            "id::text, COALESCE(email, ''), role, COALESCE(display_name, ''), COALESCE(account_id, ''), ui_preferences::text, unclaim_count::text, COALESCE(unclaim_cooldown_until::text, '')",
            "public.profiles",
        ),
        _digest(
            "auth.users",
            "id::text, COALESCE(email, '')",
            "auth.users",
        ),
        _digest(
            "auth.identities",
            "id::text, user_id::text, COALESCE(provider, ''), COALESCE(identity_data::text, '')",
            "auth.identities",
        ),
        _digest(
            "officer_audit_log",
            "id::text, COALESCE(actor_id::text, ''), COALESCE(actor_email, ''), action, target_type, COALESCE(target_id, '')",
            "public.officer_audit_log",
        ),
    ]
    for table in sql_backup.INCLUDED_TABLES:
        statements.append(
            f"CREATE TEMP TABLE stage_{table} (LIKE public.{quote_ident(table)} INCLUDING DEFAULTS);"
        )
        statements.append(_copy_stdin(table, sections[table]["columns"], sections[table]["body"]))
    statements.append(_staged_count_checks(expected_counts))
    statements.append(_staging_checks())
    statements.append("SELECT public.begin_restore_load();")
    for table in LOCK_ORDER:
        statements.append(f"LOCK TABLE public.{quote_ident(table)} IN ACCESS EXCLUSIVE MODE;")
    for table in DELETE_ORDER:
        statements.append(f"DELETE FROM public.{quote_ident(table)};")
    statements.append(
        """
DELETE FROM public.account_class_coverage AS coverage
WHERE NOT EXISTS (
  SELECT 1 FROM public.profiles AS profile
  WHERE profile.account_id = coverage.account_id
)
AND NOT EXISTS (
  SELECT 1 FROM pg_temp.stage_accounts AS snapshot
  WHERE snapshot.account_id = coverage.account_id
);
DELETE FROM public.accounts AS destination
WHERE NOT EXISTS (
  SELECT 1 FROM public.profiles AS profile
  WHERE profile.account_id = destination.account_id
)
AND NOT EXISTS (
  SELECT 1 FROM pg_temp.stage_accounts AS snapshot
  WHERE snapshot.account_id = destination.account_id
);
"""
    )
    account_columns = sections["accounts"]["columns"]
    mutable = [column for column in account_columns if column != "account_id"]
    if "account_id" not in account_columns or not mutable:
        raise RestoreError("Snapshot accounts columns cannot be merged.")
    assignments = ", ".join(
        f"{quote_ident(column)} = snapshot.{quote_ident(column)}" for column in mutable
    )
    column_list = ", ".join(quote_ident(column) for column in account_columns)
    statements.append(
        f"""
ALTER TABLE public.accounts DISABLE TRIGGER accounts_display_name_guard;
UPDATE public.accounts AS destination
SET {assignments}
FROM pg_temp.stage_accounts AS snapshot
WHERE destination.account_id = snapshot.account_id;
ALTER TABLE public.accounts ENABLE TRIGGER accounts_display_name_guard;
INSERT INTO public.accounts ({column_list})
SELECT {column_list}
FROM pg_temp.stage_accounts AS snapshot
WHERE NOT EXISTS (
  SELECT 1 FROM public.accounts AS destination
  WHERE destination.account_id = snapshot.account_id
);
"""
    )
    for table in INSERT_ORDER:
        columns = ", ".join(quote_ident(column) for column in sections[table]["columns"])
        statements.append(
            f"INSERT INTO public.{quote_ident(table)} ({columns}) "
            f"SELECT {columns} FROM pg_temp.stage_{table};"
        )
    statements.append(
        """
INSERT INTO public.character_loot_assignment_counts (char_id, character_name, items_assigned)
SELECT assigned_char_id, assigned_character_name, COUNT(*)::bigint
FROM public.loot_assignment
WHERE assigned_char_id IS NOT NULL AND btrim(assigned_char_id) <> ''
GROUP BY assigned_char_id, assigned_character_name;
SELECT public.end_restore_load();
"""
    )
    statements.append(_postconditions(blocks, totals))
    if fail_before_commit:
        statements.append("DO $$ BEGIN RAISE EXCEPTION 'intentional restore failure'; END $$;")
    statements.append("COMMIT;")
    for statement in statements:
        head = statement.lstrip().splitlines()[0] if statement.strip() else ""
        if head.startswith("COPY "):
            continue
        upper = statement.upper()
        if "DISABLE TRIGGER" in upper and "DISABLE TRIGGER ACCOUNTS_DISPLAY_NAME_GUARD" not in upper:
            raise RestoreError("Restore SQL refused an unsafe statement.")
        if (
            " CASCADE" in upper
            or "TRUNCATE" in upper
            or "SESSION_REPLICATION_ROLE" in upper
            or "TRUNCATE_DKP_FOR_RESTORE" in upper
        ):
            raise RestoreError("Restore SQL refused an unsafe statement.")
    joined = "\n".join(statements) + "\n"
    if joined.upper().count("DISABLE TRIGGER ACCOUNTS_DISPLAY_NAME_GUARD") != joined.upper().count(
        "ENABLE TRIGGER ACCOUNTS_DISPLAY_NAME_GUARD"
    ):
        raise RestoreError("Restore SQL left the display-name guard disabled.")
    return joined


def _staging_checks() -> str:
    return """
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_temp.stage_character_account link
    WHERE NOT EXISTS (SELECT 1 FROM pg_temp.stage_characters character_row WHERE character_row.char_id = link.char_id)
       OR NOT EXISTS (SELECT 1 FROM pg_temp.stage_accounts account_row WHERE account_row.account_id = link.account_id)
  ) THEN
    RAISE EXCEPTION 'snapshot character_account rows fail foreign keys';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_temp.stage_raid_events event_row
    WHERE NOT EXISTS (SELECT 1 FROM pg_temp.stage_raids raid_row WHERE raid_row.raid_id = event_row.raid_id)
  ) OR EXISTS (
    SELECT 1 FROM pg_temp.stage_raid_attendance attendance_row
    WHERE NOT EXISTS (SELECT 1 FROM pg_temp.stage_raids raid_row WHERE raid_row.raid_id = attendance_row.raid_id)
  ) OR EXISTS (
    SELECT 1 FROM pg_temp.stage_raid_classifications classification_row
    WHERE NOT EXISTS (SELECT 1 FROM pg_temp.stage_raids raid_row WHERE raid_row.raid_id = classification_row.raid_id)
  ) THEN
    RAISE EXCEPTION 'snapshot raid rows fail foreign keys';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_temp.stage_raid_event_attendance attendance_row
    WHERE NULLIF(btrim(attendance_row.account_id), '') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM pg_temp.stage_accounts account_row
        WHERE account_row.account_id = attendance_row.account_id
      )
  ) OR EXISTS (
    SELECT 1 FROM pg_temp.stage_dkp_adjustments adjustment_row
    WHERE NULLIF(btrim(adjustment_row.account_id), '') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM pg_temp.stage_accounts account_row
        WHERE account_row.account_id = adjustment_row.account_id
      )
  ) OR EXISTS (
    SELECT 1 FROM pg_temp.stage_active_accounts active_row
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_temp.stage_accounts account_row
      WHERE account_row.account_id = active_row.account_id
    )
  ) OR EXISTS (
    SELECT 1 FROM pg_temp.stage_loot_assignment assignment_row
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_temp.stage_raid_loot loot_row
      WHERE loot_row.id = assignment_row.loot_id
    )
  ) THEN
    RAISE EXCEPTION 'snapshot guild rows fail foreign keys';
  END IF;
END $$;
"""


def _postconditions(blocks: dict[str, dict], totals: dict[str, dict[str, str]]) -> str:
    comparisons = []
    for table in sql_backup.INCLUDED_TABLES:
        if table == "accounts":
            continue
        comparisons.append(
            f"""
SELECT count(*) INTO guard_count FROM public.{quote_ident(table)};
IF guard_count <> (SELECT count(*) FROM pg_temp.stage_{table}) THEN
  RAISE EXCEPTION '{table} count mismatch';
END IF;
"""
        )
    account_checks = """
IF EXISTS (
  SELECT 1 FROM public.accounts AS destination
  WHERE NOT EXISTS (SELECT 1 FROM pg_temp.stage_accounts AS snapshot WHERE snapshot.account_id = destination.account_id)
    AND NOT EXISTS (SELECT 1 FROM public.profiles AS profile WHERE profile.account_id = destination.account_id)
) THEN
  RAISE EXCEPTION 'unclaimed account survived outside the snapshot';
END IF;
IF EXISTS (
  SELECT 1 FROM public.profiles AS profile
  WHERE profile.account_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.accounts AS destination WHERE destination.account_id = profile.account_id)
) THEN
  RAISE EXCEPTION 'profile claim has no account row';
END IF;
IF EXISTS (
  SELECT 1 FROM pg_temp.stage_accounts AS snapshot
  WHERE NOT EXISTS (SELECT 1 FROM public.accounts AS destination WHERE destination.account_id = snapshot.account_id)
) THEN
  RAISE EXCEPTION 'snapshot account was not loaded';
END IF;
"""
    if totals:
        expected_ids = ", ".join(sql_text(account_id) for account_id in sorted(totals))
        match_rows = []
        for account_id, item in sorted(totals.items()):
            match_rows.append(
                f"""
IF NOT EXISTS (
  SELECT 1 FROM public.account_dkp_summary
  WHERE account_id = {sql_text(account_id)}
    AND earned = {item['earned']}::numeric
    AND spent = {item['spent']}::numeric
    AND earned_30d = {int(item['earned_30d'])}
    AND earned_60d = {int(item['earned_60d'])}
) THEN
  RAISE EXCEPTION 'account DKP mismatch';
END IF;
"""
            )
        dkp_sql = "".join(match_rows) + f"""
IF EXISTS (
  SELECT 1 FROM public.account_dkp_summary
  WHERE account_id NOT IN ({expected_ids})
) THEN
  RAISE EXCEPTION 'unexpected account DKP row';
END IF;
"""
    else:
        dkp_sql = """
IF EXISTS (SELECT 1 FROM public.account_dkp_summary) THEN
  RAISE EXCEPTION 'unexpected account DKP row';
END IF;
"""
    identity_checks = "\n".join(
        [
            _digest_check(
                "profiles",
                "id::text, COALESCE(email, ''), role, COALESCE(display_name, ''), COALESCE(account_id, ''), ui_preferences::text, unclaim_count::text, COALESCE(unclaim_cooldown_until::text, '')",
                "public.profiles",
            ),
            _digest_check(
                "auth.users",
                "id::text, COALESCE(email, '')",
                "auth.users",
            ),
            _digest_check(
                "auth.identities",
                "id::text, user_id::text, COALESCE(provider, ''), COALESCE(identity_data::text, '')",
                "auth.identities",
            ),
            _digest_check(
                "officer_audit_log",
                "id::text, COALESCE(actor_id::text, ''), COALESCE(actor_email, ''), action, target_type, COALESCE(target_id, '')",
                "public.officer_audit_log",
            ),
        ]
    )
    return f"""
DO $$
DECLARE
  guard_count bigint;
  guard_digest text;
  seq_name text;
  seq_last bigint;
  max_id bigint;
  rel text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.restore_in_progress WHERE id = 1 AND in_progress = false) THEN
    RAISE EXCEPTION 'restore flag is not clear';
  END IF;
  IF (SELECT tgenabled FROM pg_trigger WHERE tgname = 'accounts_display_name_guard') IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'display name guard was left disabled';
  END IF;
  IF EXISTS (SELECT 1 FROM public.bid_portfolio_auction_fact) THEN
    RAISE EXCEPTION 'bidding facts were not cleared';
  END IF;
  {"".join(comparisons)}
  {account_checks}
  {dkp_sql}
  {identity_checks}
  FOREACH rel IN ARRAY ARRAY['raid_events', 'raid_loot', 'raid_attendance', 'raid_event_attendance']
  LOOP
    seq_name := pg_get_serial_sequence(format('public.%I', rel), 'id');
    IF seq_name IS NULL THEN
      RAISE EXCEPTION 'missing sequence';
    END IF;
    EXECUTE format('SELECT COALESCE(MAX(id), 0) FROM %I', rel) INTO max_id;
    EXECUTE format('SELECT last_value FROM %s', seq_name) INTO seq_last;
    IF max_id > 0 AND seq_last < max_id THEN
      RAISE EXCEPTION 'sequence is behind max id';
    END IF;
  END LOOP;
END $$;
"""


def write_report(report: str, path: Path | None, *, heading: str) -> None:
    sys.stdout.write(report)
    if path is not None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(report, encoding="utf-8", newline="\n")
    step_summary = os.environ.get("GITHUB_STEP_SUMMARY", "").strip()
    if step_summary:
        with open(step_summary, "a", encoding="utf-8", newline="\n") as handle:
            handle.write(f"## {heading}\n\n```\n" + report + "```\n")


def announce_pinned_restore(line: str) -> None:
    print(line, flush=True)
    step_summary = os.environ.get("GITHUB_STEP_SUMMARY", "").strip()
    if step_summary:
        with open(step_summary, "a", encoding="utf-8", newline="\n") as handle:
            handle.write("## Pinned SQL restore snapshot\n\n" + line + "\n\n")


def write_pin_outputs(pin: dict[str, str], manifest: dict) -> None:
    try:
        sql_backup_fetch.write_github_output(
            {
                "artifact_id": pin["artifact_id"],
                "source_repository": pin["source_repository"],
                "artifact_name": pin["artifact_name"],
                "workflow_run_id": pin["workflow_run_id"],
                "artifact_sha256": pin["artifact_sha256"],
                "snapshot_created_at": str(manifest["created_at"]),
            }
        )
    except sql_backup_fetch.FetchError as exc:
        raise RestoreError(str(exc)) from None


def assert_destination_name(destination_name: str) -> str:
    """The destination label comes from the protected environment, not the operator."""
    expected_name, _, _ = destination_settings()
    if destination_name and destination_name != expected_name:
        raise RestoreError("Destination name does not match SQL_RESTORE_DESTINATION_NAME.")
    return expected_name


def assert_environment_protection(environment: dict, branch_policies: list) -> None:
    """Refuse a destructive restore unless reviewers and a main-only branch policy exist."""
    rules = environment.get("protection_rules") if isinstance(environment, dict) else None
    reviewers = []
    if isinstance(rules, list):
        reviewers = [
            rule
            for rule in rules
            if isinstance(rule, dict) and rule.get("type") == "required_reviewers"
        ]
    reviewer_count = 0
    for rule in reviewers:
        people = rule.get("reviewers")
        if isinstance(people, list):
            reviewer_count += len(people)
    if reviewer_count < 1:
        raise RestoreError(
            "sql-restore has no required reviewers. "
            "Add required reviewers and a deployment branch policy that allows only main. "
            "Refusing a destructive restore."
        )
    policy = environment.get("deployment_branch_policy") if isinstance(environment, dict) else None
    custom = isinstance(policy, dict) and policy.get("custom_branch_policies") is True
    names = [
        item.get("name")
        for item in branch_policies
        if isinstance(item, dict) and isinstance(item.get("name"), str)
    ]
    if not custom or names != ["main"]:
        shown = ", ".join(names) if names else "(none)"
        raise RestoreError(
            "sql-restore deployment branch policy must allow only main. "
            f"Configured branches: {shown}. Refusing a destructive restore."
        )


def read_restore_protection() -> tuple[dict, list]:
    token = (os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or "").strip()
    repo = os.environ.get("GITHUB_REPOSITORY", "").strip()
    if not token or "/" not in repo:
        raise RestoreError(
            "sql-restore protection could not be read. Refusing a destructive restore."
        )
    client = sql_backup_fetch.UrllibGitHub(token)
    try:
        environment = client.get_json(f"/repos/{repo}/environments/sql-restore")
        policies = client.get_json(
            f"/repos/{repo}/environments/sql-restore/deployment-branch-policies"
        )
    except sql_backup_fetch.FetchError as exc:
        raise RestoreError(
            "sql-restore protection could not be read. Refusing a destructive restore. " + str(exc)
        ) from None
    branch_policies = policies.get("branch_policies") if isinstance(policies, dict) else None
    if not isinstance(branch_policies, list):
        branch_policies = []
    return environment, branch_policies


def require_destructive_approval() -> None:
    if os.environ.get("GITHUB_ACTIONS") != "true":
        return
    assert_environment_protection(*read_restore_protection())


def run_restore(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Dry-run or restore a portable SQL backup.")
    parser.add_argument("--bundle-dir", type=Path)
    parser.add_argument("--source", default="")
    parser.add_argument("--source-name", default="")
    parser.add_argument("--current-repository", default=os.environ.get("GITHUB_REPOSITORY", ""))
    parser.add_argument("--artifact-id", default="")
    parser.add_argument("--expect-artifact-name", default="")
    parser.add_argument("--expect-workflow-run-id", default="")
    parser.add_argument("--expect-sha256", default="")
    parser.add_argument("--destination-name", default="")
    parser.add_argument("--confirm", default="")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--check-protection", action="store_true")
    parser.add_argument("--report", type=Path)
    parser.add_argument("--fail-before-commit", action="store_true")
    args = parser.parse_args(argv)

    if args.check_protection:
        assert_environment_protection(*read_restore_protection())
        print("sql-restore protection: required reviewers and main-only branch policy")
        return 0

    assert_actions_context(execute=args.execute)
    if os.environ.get("GITHUB_ACTIONS") == "true" and args.bundle_dir is not None:
        raise RestoreError("GitHub Actions must select an artifact id.")
    if args.fail_before_commit and os.environ.get("DKP_SQL_RESTORE_TEST_FAIL") != "1":
        raise RestoreError("Refusing an injected failure outside the restore test.")
    if not args.source.strip():
        raise RestoreError("Pass --source.")
    if (args.bundle_dir is None) == (not args.artifact_id.strip()):
        raise RestoreError("Pass exactly one of --bundle-dir or --artifact-id.")
    if args.execute:
        require_destructive_approval()
    destination_name = assert_destination_name(args.destination_name)
    if args.execute and args.confirm != f"RESTORE {destination_name}":
        raise RestoreError("Confirmation does not match the destination.")
    if args.execute and args.artifact_id.strip():
        require_execution_pin(
            args.expect_artifact_name,
            args.expect_workflow_run_id,
            args.expect_sha256,
        )

    denied = load_denylist()
    conn = connect_destination()
    assert_host_not_denied(str(conn["host"]), denied)
    if args.bundle_dir is not None:
        try:
            selection = sql_backup_fetch.selection_target(
                args.source, args.source_name, args.current_repository
            )
            if selection.kind != "name":
                raise sql_backup_fetch.FetchError("A local bundle requires an owner/name source.")
            source = selection.value
        except sql_backup_fetch.FetchError as exc:
            raise RestoreError(str(exc)) from None
        sql_text, manifest = load_bundle_dir(args.bundle_dir, source)
        artifact_id = ""
        artifact_name = ""
        artifact_sha256 = ""
        pin = None
    else:
        artifact_id = args.artifact_id.strip()
        sql_text, manifest, pin = load_from_fetch(
            args.source, args.current_repository, artifact_id, args.source_name
        )
        source = pin["source_repository"]
        assert_pinned_artifact(
            pin,
            source=source,
            artifact_id=artifact_id,
            expect_name=args.expect_artifact_name.strip(),
            expect_run=args.expect_workflow_run_id.strip(),
            expect_sha256=args.expect_sha256.strip().lower(),
            require_digest=args.execute,
        )
        artifact_name = pin["artifact_name"]
        artifact_sha256 = pin["artifact_sha256"]

    blocks = parsed_blocks(sql_text)
    require_parsed_counts(blocks, manifest)
    if set(copy_sections(sql_text)) != set(blocks):
        raise RestoreError("data.sql COPY blocks do not match the parsed tables.")
    payload, totals, absent, present = preflight(conn, sql_text, manifest, blocks)
    meta = payload["meta"]
    assert isinstance(meta, dict)
    report = build_report(
        mode="dry-run" if not args.execute else "restore",
        source=source,
        artifact_id=artifact_id,
        manifest=manifest,
        meta=meta,
        blocks=blocks,
        destination_counts=payload["counts"],
        absent_claims=absent,
        present_claims=present,
        totals=totals,
        destination_name=destination_name,
        artifact_name=artifact_name,
        artifact_sha256=artifact_sha256,
    )
    if not args.execute:
        report = report.replace("writes: committed", "writes: none")
        write_report(report, args.report, heading="SQL restore preflight")
        if pin is not None:
            write_pin_outputs(pin, manifest)
        return 0

    announce_pinned_restore(
        pinned_snapshot_line(manifest, artifact_id=artifact_id, artifact_name=artifact_name)
    )
    script = build_restore_sql(
        sql_text, blocks, totals, manifest=manifest, fail_before_commit=args.fail_before_commit
    )
    run_psql(conn, script, read_only=False)
    report = report.replace("writes: none", "writes: committed")
    if "writes: committed" not in report:
        report = report.replace("writes: none", "writes: committed")
    write_report(report, args.report, heading="SQL restore")
    return 0


def main(argv: list[str] | None = None) -> int:
    try:
        return run_restore(argv)
    except RestoreError as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
