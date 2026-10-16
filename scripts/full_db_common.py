#!/usr/bin/env python3
"""Shared helpers for the full-database backup.

This module does not read or write the portable guild backup. It refuses
non-local hosts and any PostgreSQL client or server that is not major
version 17.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import tarfile
from pathlib import Path
from urllib.parse import unquote, urlparse

FORMAT_VERSION = "full-db-1"
POSTGRES_MAJOR = 17
ARCHIVE_MEMBERS = (
    "roles.sql",
    "schema.sql",
    "auth-custom.sql",
    "data.sql",
    "history.sql",
    "catalog.json",
    "manifest.json",
    "summary.txt",
)
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
RECIPIENT_ENV = "FULL_DB_BACKUP_AGE_RECIPIENT"
IDENTITY_ENV = "FULL_DB_BACKUP_AGE_IDENTITY"
URL_ENV = "FULL_DB_DATABASE_URL"

# Platform roles. Passwords for these roles are never stored.
RESERVED_ROLES = (
    "anon",
    "authenticated",
    "authenticator",
    "dashboard_user",
    "pgbouncer",
    "postgres",
    "service_role",
)
RESERVED_ROLE_PREFIXES = ("cli_login_", "supabase_", "pgsodium_", "pg_")

# Schemas whose definitions the platform already created. Data may still be captured.
PLATFORM_SCHEMAS = {
    "_analytics",
    "_realtime",
    "_supavisor",
    "auth",
    "cron",
    "dbdev",
    "etl",
    "extensions",
    "graphql",
    "graphql_public",
    "net",
    "pgbouncer",
    "pgmq",
    "pgsodium",
    "pgsodium_masks",
    "pgtle",
    "realtime",
    "storage",
    "supabase_functions",
    "supabase_migrations",
    "vault",
}

# Present on a full logical backup when installed. Restored only into full_db_captured.
INERT_SCHEMAS = {"_realtime", "cron", "net", "pgmq", "realtime", "supabase_functions"}

# Operational schemas the local stack may not have installed. Absence is disclosed.
DISCLOSED_ABSENT = ("cron", "net", "pgmq")

LIVE_DATA_SCHEMAS = {"auth", "public", "storage"}
CAPTURE_ONLY_RELATIONS = {("vault", "secrets")}
PLAINTEXT_VIEWS = {("vault", "decrypted_secrets")}

_COPY_HEADER = re.compile(
    r"^COPY\s+"
    r'(?:"(?P<schema_q>(?:[^"]|"")*)"|(?P<schema_raw>[A-Za-z_][A-Za-z0-9_$]*))'
    r"\."
    r'(?:"(?P<table_q>(?:[^"]|"")*)"|(?P<table_raw>[A-Za-z_][A-Za-z0-9_$]*))'
    r"\s+\((?P<cols>.*)\)\s+FROM stdin;$"
)
_PASSWORD = re.compile(r"\s+PASSWORD\s+'(?:[^']|'')*'")


class FullDbError(Exception):
    """Fail-closed error. The message must not contain secrets."""


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def redact(text: str, secrets: list[str]) -> str:
    redacted = text or ""
    for secret in secrets:
        if secret:
            redacted = redacted.replace(secret, "[redacted]")
    redacted = re.sub(r"AGE-SECRET-KEY-[A-Za-z0-9\-]+", "[redacted]", redacted)
    redacted = re.sub(r"postgresql://[^\s'\"]+", "postgresql://[redacted]", redacted)
    return redacted


def parse_database_url(url: str) -> dict[str, str | int]:
    try:
        parsed = urlparse(url.strip())
    except ValueError as exc:
        raise FullDbError("FULL_DB_DATABASE_URL could not be parsed.") from exc
    if parsed.scheme not in ("postgresql", "postgres"):
        raise FullDbError("FULL_DB_DATABASE_URL must use the postgresql scheme.")
    if not parsed.hostname or not parsed.username or not parsed.path or parsed.path == "/":
        raise FullDbError("FULL_DB_DATABASE_URL is missing a host, user, or database name.")
    host = parsed.hostname
    if host not in LOCAL_HOSTS:
        raise FullDbError("Full-database tools refuse non-local hosts. Hosted inventory is a later read-only procedure.")
    database = parsed.path.lstrip("/").split("/", 1)[0]
    if not database:
        raise FullDbError("FULL_DB_DATABASE_URL is missing a database name.")
    return {
        "host": host,
        "port": parsed.port or 5432,
        "user": unquote(parsed.username),
        "password": unquote(parsed.password or ""),
        "database": database,
    }


def require_major_17(version_text: str, label: str) -> str:
    match = re.search(r"(\d+)\.(\d+)", version_text)
    if not match or int(match.group(1)) != POSTGRES_MAJOR:
        cleaned = " ".join(version_text.split())
        raise FullDbError(f"{label} is not PostgreSQL 17 ({cleaned}). Refusing to continue.")
    return version_text.strip()


def find_age(name: str) -> str:
    found = shutil.which(name)
    if found:
        return found
    local = os.environ.get("LOCALAPPDATA", "")
    root = Path(local) / "Microsoft" / "WinGet" / "Packages"
    matches = sorted(root.glob(f"FiloSottile.age*/age/{name}.exe"))
    if len(matches) == 1:
        return str(matches[0])
    if len(matches) > 1:
        return str(matches[-1])
    raise FullDbError(f"{name} is not on PATH and was not found in the WinGet age install.")


def age_version(binary: str) -> str:
    completed = subprocess.run(
        [binary, "--version"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    text = ((completed.stdout or "") + (completed.stderr or "")).strip()
    if completed.returncode != 0 or not text:
        raise FullDbError("age --version failed.")
    return text.splitlines()[0].strip()


def validate_recipient(recipient: str) -> str:
    value = (recipient or "").strip()
    if not value:
        raise FullDbError(f"Set {RECIPIENT_ENV} to an age public key.")
    if value.startswith("AGE-SECRET-KEY-") or not value.startswith("age1") or any(ch.isspace() for ch in value):
        raise FullDbError(f"{RECIPIENT_ENV} must be an age public key (age1...), not a secret key.")
    return value


def run_command(args: list[str], *, env: dict[str, str] | None, secrets: list[str], label: str, input_bytes: bytes | None = None) -> subprocess.CompletedProcess[str]:
    try:
        completed = subprocess.run(
            args,
            env=env,
            input=input_bytes,
            capture_output=True,
            check=False,
        )
    except FileNotFoundError as exc:
        raise FullDbError(f"{label} is not installed or not on PATH.") from exc
    stdout = (completed.stdout or b"").decode("utf-8", errors="replace")
    stderr = (completed.stderr or b"").decode("utf-8", errors="replace")
    if completed.returncode != 0:
        detail = redact((stderr or stdout).strip(), secrets)
        suffix = f"\n{detail}" if detail else ""
        raise FullDbError(f"{label} failed (exit {completed.returncode}).{suffix}")
    completed.stdout = stdout  # type: ignore[assignment]
    completed.stderr = stderr  # type: ignore[assignment]
    return completed


def container_publishing(port: int) -> str:
    completed = run_command(
        ["docker", "ps", "--format", "{{.Names}}|{{.Ports}}"],
        env=None,
        secrets=[],
        label="docker ps",
    )
    matches: list[str] = []
    needle = f":{port}->"
    for line in (completed.stdout or "").splitlines():
        name, _, ports = line.partition("|")
        if needle in ports:
            matches.append(name.strip())
    if len(matches) != 1:
        raise FullDbError(f"Expected one local container publishing port {port}.")
    return matches[0]


def _pg_version(container: str) -> str:
    completed = run_command(
        ["docker", "exec", container, "pg_dump", "--version"],
        env=None,
        secrets=[],
        label="pg_dump --version",
    )
    return require_major_17(completed.stdout or completed.stderr or "", "pg_dump")


def psql_text(container: str, sql: str, secrets: list[str]) -> str:
    completed = run_command(
        ["docker", "exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At"],
        env=None,
        secrets=secrets,
        label="psql",
        input_bytes=sql.encode("utf-8"),
    )
    return (completed.stdout or "").strip()


def psql_script(container: str, sql: str, secrets: list[str]) -> None:
    run_command(
        [
            "docker",
            "exec",
            "-i",
            container,
            "psql",
            "-U",
            "postgres",
            "-d",
            "postgres",
            "-v",
            "ON_ERROR_STOP=1",
            "--single-transaction",
        ],
        env=None,
        secrets=secrets,
        label="psql",
        input_bytes=sql.encode("utf-8"),
    )


def pg_dump(container: str, args: list[str], secrets: list[str]) -> str:
    _pg_version(container)
    completed = run_command(
        ["docker", "exec", "-e", "PGOPTIONS=-c default_transaction_read_only=on", container, "pg_dump", "-U", "postgres", "-d", "postgres", *args],
        env=None,
        secrets=secrets,
        label="pg_dump",
    )
    return completed.stdout or ""


def is_reserved_role(name: str) -> bool:
    if name in RESERVED_ROLES:
        return True
    return any(name.startswith(prefix) for prefix in RESERVED_ROLE_PREFIXES)


def classify_object(schema: str, name: str, object_type: str) -> tuple[str, str | None, str]:
    """Return classification, exclusion reason, and restore mode.

    restore mode is live, inert, capture_only, schema_only, or omit.
    """
    if schema not in PLATFORM_SCHEMAS and schema != "public":
        if object_type in {"table", "partition", "partitioned_table", "sequence"}:
            return "FULLY_RECOVERABLE", None, "live"
        return "FULLY_RECOVERABLE", None, "schema_only"

    if schema == "public":
        if object_type in {"table", "partition", "partitioned_table", "sequence"}:
            return "FULLY_RECOVERABLE", None, "live"
        return "FULLY_RECOVERABLE", None, "schema_only"

    if (schema, name) in PLAINTEXT_VIEWS or (schema == "vault" and object_type == "view"):
        return (
            "UNSUPPORTED",
            "Vault decrypted_secrets is a view. Dumping it would copy plaintext. The view is not included.",
            "omit",
        )

    if (schema, name) in CAPTURE_ONLY_RELATIONS:
        return (
            "UNSUPPORTED",
            "vault.secrets ciphertext is captured. INSERT as postgres is denied (permission denied for function _crypto_aead_det_noncegen), so restore archives the rows in full_db_captured and does not load them back into vault.",
            "capture_only",
        )

    if schema == "vault":
        return (
            "UNSUPPORTED",
            "Vault objects other than the secrets table are platform-owned and are not recreated.",
            "omit",
        )

    if schema in INERT_SCHEMAS and object_type in {"table", "partition", "partitioned_table"}:
        return (
            "CONDITIONALLY_RECOVERABLE",
            "Rows are captured. Restore loads them into full_db_captured so hooks, queues, cron jobs, and realtime partitions are not reactivated.",
            "inert",
        )

    if schema in LIVE_DATA_SCHEMAS and object_type in {"table", "partition", "partitioned_table", "sequence"}:
        return (
            "CONDITIONALLY_RECOVERABLE",
            "Table data is restored into the schema the platform already created. Definitions are not recreated.",
            "live",
        )

    if schema == "supabase_migrations" and object_type in {"table", "sequence"}:
        return "FULLY_RECOVERABLE", None, "history"

    if object_type == "app_trigger":
        return "CONDITIONALLY_RECOVERABLE", None, "auth_custom"
    if object_type == "platform_trigger":
        return (
            "UNSUPPORTED",
            "Platform trigger whose function does not live in public. It is not recreated.",
            "omit",
        )
    if object_type == "policy" and schema != "public":
        return (
            "UNSUPPORTED",
            "Policy on a platform table is not recreated. The initialized project already has its own policies.",
            "omit",
        )

    return (
        "UNSUPPORTED",
        f"{schema}.{name} ({object_type}) is platform-owned. Its definition is not recreated and its rows are not a separate data copy.",
        "omit",
    )


def absent_schema_entry(name: str) -> dict:
    return {
        "schema": name,
        "name": name,
        "object_type": "schema",
        "classification": "UNSUPPORTED",
        "exclusion_reason": (
            f"Schema {name} is not installed on this server. "
            "No extension created it, so there were no rows to omit."
        ),
        "restore_mode": "omit",
        "row_count": None,
    }


def _json_rows(container: str, sql: str, secrets: list[str]) -> list[dict]:
    text = psql_text(container, sql, secrets)
    if not text:
        return []
    parsed = json.loads(text)
    if not isinstance(parsed, list):
        raise FullDbError("Catalog query did not return a list.")
    return parsed


def collect_catalog(container: str, secrets: list[str]) -> tuple[dict, list[dict]]:
    version = psql_text(container, "SELECT current_setting('server_version');", secrets)
    version_num = int(psql_text(container, "SELECT current_setting('server_version_num');", secrets))
    require_major_17(version, "server")
    if version_num // 10000 != POSTGRES_MAJOR:
        raise FullDbError(f"Server version num {version_num} is not PostgreSQL 17.")
    client = _pg_version(container)
    relations = _json_rows(
        container,
        """
        SELECT coalesce(json_agg(row_to_json(q)), '[]'::json)::text
        FROM (
          SELECT n.nspname AS schema, c.relname AS name,
            CASE
              WHEN c.relkind = 'r' AND c.relispartition THEN 'partition'
              WHEN c.relkind = 'r' THEN 'table'
              WHEN c.relkind = 'p' THEN 'partitioned_table'
              WHEN c.relkind = 'v' THEN 'view'
              WHEN c.relkind = 'm' THEN 'materialized_view'
              WHEN c.relkind = 'S' THEN 'sequence'
              WHEN c.relkind = 'f' THEN 'foreign_table'
              ELSE c.relkind::text
            END AS object_type
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname <> 'information_schema'
            AND n.nspname NOT LIKE 'pg_%'
            AND c.relkind IN ('r','p','v','m','S','f')
          ORDER BY 1, 2
        ) q;
        """,
        secrets,
    )
    counts = _json_rows(
        container,
        """
        SELECT coalesce(json_agg(row_to_json(q)), '[]'::json)::text
        FROM (
          SELECT n.nspname AS schema, c.relname AS name,
            (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint AS row_count
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname <> 'information_schema'
            AND n.nspname NOT LIKE 'pg_%'
            AND c.relkind IN ('r','p')
        ) q;
        """,
        secrets,
    )
    count_map = {(row["schema"], row["name"]): int(row["row_count"]) for row in counts}
    schemas = set(
        psql_text(
            container,
            "SELECT string_agg(nspname, ',' ORDER BY nspname) FROM pg_namespace WHERE nspname <> 'information_schema' AND nspname NOT LIKE 'pg_%';",
            secrets,
        ).split(",")
    )
    schemas.discard("")
    catalog: list[dict] = []
    for row in relations:
        classification, reason, mode = classify_object(row["schema"], row["name"], row["object_type"])
        catalog.append(
            {
                "schema": row["schema"],
                "name": row["name"],
                "object_type": row["object_type"],
                "classification": classification,
                "exclusion_reason": reason,
                "restore_mode": mode,
                "row_count": count_map.get((row["schema"], row["name"])),
            }
        )
    routines = _json_rows(
        container,
        """
        SELECT coalesce(json_agg(row_to_json(q)), '[]'::json)::text
        FROM (
          SELECT n.nspname AS schema, p.proname AS name,
            CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS object_type
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname <> 'information_schema'
            AND n.nspname NOT LIKE 'pg_%'
        ) q;
        """,
        secrets,
    )
    triggers = _json_rows(
        container,
        """
        SELECT coalesce(json_agg(row_to_json(q)), '[]'::json)::text
        FROM (
          SELECT n.nspname AS schema, t.tgname AS name,
            CASE WHEN pn.nspname = 'public' AND n.nspname <> 'public' THEN 'app_trigger' ELSE 'trigger' END AS object_type
          FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_proc p ON p.oid = t.tgfoid
          JOIN pg_namespace pn ON pn.oid = p.pronamespace
          WHERE NOT t.tgisinternal
            AND n.nspname <> 'information_schema'
            AND n.nspname NOT LIKE 'pg_%'
        ) q;
        """,
        secrets,
    )
    policies = _json_rows(
        container,
        """
        SELECT coalesce(json_agg(row_to_json(q)), '[]'::json)::text
        FROM (
          SELECT n.nspname AS schema, pol.polname AS name, 'policy' AS object_type
          FROM pg_policy pol
          JOIN pg_class c ON c.oid = pol.polrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname <> 'information_schema'
            AND n.nspname NOT LIKE 'pg_%'
        ) q;
        """,
        secrets,
    )
    for row in [*routines, *triggers, *policies]:
        object_type = row["object_type"]
        if object_type == "trigger" and row["schema"] != "public":
            object_type = "platform_trigger"
        classification, reason, mode = classify_object(row["schema"], row["name"], object_type)
        catalog.append(
            {
                "schema": row["schema"],
                "name": row["name"],
                "object_type": row["object_type"],
                "classification": classification,
                "exclusion_reason": reason,
                "restore_mode": mode,
                "row_count": None,
            }
        )
    for name in DISCLOSED_ABSENT:
        if name not in schemas:
            catalog.append(absent_schema_entry(name))
    if "supabase_migrations" not in schemas:
        catalog.append(absent_schema_entry("supabase_migrations"))
    extensions = _json_rows(
        container,
        """
        SELECT coalesce(json_agg(row_to_json(q)), '[]'::json)::text
        FROM (SELECT extname AS name, extversion AS version FROM pg_extension ORDER BY 1) q;
        """,
        secrets,
    )
    for row in extensions:
        catalog.append(
            {
                "schema": "pg_extension",
                "name": row["name"],
                "object_type": "extension",
                "classification": "CONDITIONALLY_RECOVERABLE",
                "exclusion_reason": "The initialized target must already provide this extension. The backup does not emit CREATE EXTENSION.",
                "restore_mode": "omit",
                "row_count": None,
                "version": row["version"],
            }
        )
    roles = _json_rows(
        container,
        """
        SELECT coalesce(json_agg(row_to_json(q)), '[]'::json)::text
        FROM (
          SELECT rolname AS name, rolcanlogin AS can_login
          FROM pg_roles
          WHERE rolname !~ '^pg_'
          ORDER BY 1
        ) q;
        """,
        secrets,
    )
    for row in roles:
        reserved = is_reserved_role(row["name"])
        catalog.append(
            {
                "schema": "pg_roles",
                "name": row["name"],
                "object_type": "role",
                "classification": "UNSUPPORTED" if reserved else "CONDITIONALLY_RECOVERABLE",
                "exclusion_reason": "Reserved role. Password is not stored and the role is not recreated."
                if reserved
                else "Custom role attributes are stored without a password. The operator sets a new password after restore.",
                "restore_mode": "omit" if reserved else "roles",
                "row_count": None,
                "can_login": bool(row["can_login"]),
            }
        )
    members = _json_rows(
        container,
        """
        SELECT coalesce(json_agg(row_to_json(q)), '[]'::json)::text
        FROM (
          SELECT pubname AS name, schemaname AS schema, tablename AS table_name
          FROM pg_publication_tables
          ORDER BY 1, 2, 3
        ) q;
        """,
        secrets,
    )
    for row in members:
        catalog.append(
            {
                "schema": row["schema"],
                "name": f"{row['name']}:{row['table_name']}",
                "object_type": "publication_member",
                "classification": "CONDITIONALLY_RECOVERABLE",
                "exclusion_reason": "Membership is re-added to the existing publication. The publication itself is not dropped.",
                "restore_mode": "publication",
                "row_count": None,
                "publication": row["name"],
                "table_name": row["table_name"],
            }
        )
    for entry in catalog:
        if not entry.get("classification"):
            raise FullDbError(f"Unclassified object {entry.get('schema')}.{entry.get('name')}.")
        if entry["restore_mode"] == "omit" and not entry.get("exclusion_reason"):
            raise FullDbError(f"Omitted object {entry['schema']}.{entry['name']} has no exclusion reason.")
    identity = {
        "postgresql_version": version.strip(),
        "server_version_num": version_num,
        "pg_dump_version": client,
        "installed_schemas": sorted(schemas),
    }
    return identity, catalog


def data_schemas(catalog: list[dict]) -> list[str]:
    schemas = {
        entry["schema"]
        for entry in catalog
        if entry["restore_mode"] in {"live", "inert", "capture_only"}
        and entry["object_type"] in {"table", "partition", "partitioned_table"}
    }
    return sorted(schemas)


def public_triggers_on_managed(container: str, secrets: list[str]) -> str:
    sql = psql_text(
        container,
        """
        SELECT coalesce(string_agg(pg_get_triggerdef(t.oid, true) || ';', E'\\n' ORDER BY n.nspname, c.relname, t.tgname), '')
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_proc p ON p.oid = t.tgfoid
        JOIN pg_namespace pn ON pn.oid = p.pronamespace
        WHERE NOT t.tgisinternal
          AND pn.nspname = 'public'
          AND n.nspname <> 'public';
        """,
        secrets,
    )
    if "CREATE SCHEMA" in sql or "CREATE TABLE" in sql:
        raise FullDbError("auth-custom.sql tried to recreate a managed schema.")
    header = "-- Application triggers whose functions live in public.\n"
    return header + (sql + "\n" if sql else "-- none\n")


def roles_sql(catalog: list[dict]) -> str:
    custom = [entry for entry in catalog if entry["object_type"] == "role" and entry["restore_mode"] == "roles"]
    lines = [
        "-- Custom roles only. Reserved roles and every password clause are omitted.",
    ]
    if not custom:
        lines.append("-- No custom roles were present.")
        return "\n".join(lines) + "\n"
    for entry in custom:
        name = quote_ident(entry["name"])
        login = "LOGIN" if entry.get("can_login") else "NOLOGIN"
        lines.append(f"CREATE ROLE {name};")
        lines.append(f"ALTER ROLE {name} WITH {login};")
    text = "\n".join(lines) + "\n"
    assert_no_password_clause(text)
    return text


def assert_no_password_clause(sql: str) -> None:
    if _PASSWORD.search(sql):
        raise FullDbError("SQL contains a role password clause.")


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_checksums(bundle: Path) -> None:
    lines = []
    for name in ARCHIVE_MEMBERS:
        lines.append(f"{sha256_file(bundle / name)}  {name}")
    (bundle / "SHA256SUMS").write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")


def encrypt_bundle(bundle: Path, recipient: str, destination: Path) -> None:
    age = find_age("age")
    tar_path = bundle / "backup.tar.gz"
    with tarfile.open(tar_path, "w:gz") as archive:
        for name in (*ARCHIVE_MEMBERS, "SHA256SUMS"):
            archive.add(bundle / name, arcname=name)
    age_tmp = bundle / "backup.tar.gz.age"
    run_command(
        [age, "--recipient", recipient, "--output", str(age_tmp), str(tar_path)],
        env=os.environ.copy(),
        secrets=[recipient],
        label="age",
    )
    plaintext = tar_path.read_bytes()
    ciphertext = age_tmp.read_bytes()
    if plaintext and plaintext in ciphertext:
        raise FullDbError("Encrypted artifact still contains the plaintext archive.")
    if not ciphertext.startswith(b"age-encryption.org/"):
        raise FullDbError("age did not produce an encrypted file.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    os.replace(age_tmp, destination)


def decrypt_bundle(artifact: Path, identity: Path, destination: Path) -> None:
    age = find_age("age")
    tar_path = destination / "backup.tar.gz"
    run_command(
        [age, "--decrypt", "--identity", str(identity), "--output", str(tar_path), str(artifact)],
        env=os.environ.copy(),
        secrets=[],
        label="age decrypt",
    )
    with tarfile.open(tar_path, "r:gz") as archive:
        archive.extractall(destination)
    sums = (destination / "SHA256SUMS").read_text(encoding="utf-8")
    for line in sums.splitlines():
        if not line.strip():
            continue
        digest, _, name = line.partition("  ")
        if not name:
            raise FullDbError("SHA256SUMS entry is malformed.")
        actual = sha256_file(destination / name)
        if actual != digest:
            raise FullDbError(f"Checksum mismatch for {name}.")


def captured_name(schema: str, table: str) -> str:
    return f"{schema}__{table}"


def rewrite_data_sql(sql_text: str, catalog: list[dict]) -> str:
    modes = {
        (entry["schema"], entry["name"]): entry["restore_mode"]
        for entry in catalog
        if entry["object_type"] in {"table", "partition", "partitioned_table"}
    }
    lines = sql_text.splitlines()
    rewritten: list[str] = []
    creates: list[str] = []
    seen: set[tuple[str, str]] = set()
    index = 0
    while index < len(lines):
        line = lines[index]
        match = _COPY_HEADER.match(line)
        if not match:
            rewritten.append(line)
            index += 1
            continue
        schema = (match.group("schema_q") or match.group("schema_raw") or "").replace('""', '"')
        table = (match.group("table_q") or match.group("table_raw") or "").replace('""', '"')
        mode = modes.get((schema, table), "live")
        if "decrypted_secrets" in table:
            raise FullDbError("data.sql contains vault.decrypted_secrets.")
        block = [line]
        index += 1
        while index < len(lines) and lines[index] != r"\.":
            block.append(lines[index])
            index += 1
        if index >= len(lines):
            raise FullDbError(f"COPY block for {schema}.{table} is truncated.")
        block.append(lines[index])
        index += 1
        if mode in {"inert", "capture_only"}:
            target = captured_name(schema, table)
            if (schema, table) not in seen:
                creates.append(
                    "CREATE TABLE IF NOT EXISTS full_db_captured."
                    + quote_ident(target)
                    + f" AS SELECT * FROM {quote_ident(schema)}.{quote_ident(table)} WITH NO DATA;"
                )
                seen.add((schema, table))
            block[0] = f'COPY "full_db_captured".{quote_ident(target)} ({match.group("cols")}) FROM stdin;'
        rewritten.extend(block)
    prefix = [
        "CREATE SCHEMA IF NOT EXISTS full_db_captured;",
        *creates,
    ]
    return "\n".join(prefix + rewritten) + "\n"


def copy_targets(sql_text: str) -> list[tuple[str, str]]:
    found = []
    for line in sql_text.splitlines():
        match = _COPY_HEADER.match(line)
        if match:
            found.append(
                (
                    (match.group("schema_q") or match.group("schema_raw") or "").replace('""', '"'),
                    (match.group("table_q") or match.group("table_raw") or "").replace('""', '"'),
                )
            )
    return found
