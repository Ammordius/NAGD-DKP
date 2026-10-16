#!/usr/bin/env python3
"""Create an age-encrypted full-database backup of a local Postgres 17 server.

Reads FULL_DB_DATABASE_URL and FULL_DB_BACKUP_AGE_RECIPIENT. Does not read
the portable guild backup secrets and does not connect to a non-local host.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from full_db_common import (
    FORMAT_VERSION,
    RECIPIENT_ENV,
    URL_ENV,
    FullDbError,
    collect_catalog,
    container_publishing,
    data_schemas,
    encrypt_bundle,
    parse_database_url,
    pg_dump,
    public_triggers_on_managed,
    redact,
    repo_root,
    assert_no_password_clause,
    roles_sql,
    sha256_bytes,
    validate_recipient,
    write_checksums,
)


def _schema_sql(dump: str) -> str:
    lines = [
        "-- ALTER DEFAULT PRIVILEGES statements are omitted.",
        "-- The restoring role cannot change default privileges owned by another role.",
        "-- Explicit GRANT statements for existing objects are kept.",
    ]
    for line in dump.splitlines():
        if line.startswith("ALTER DEFAULT PRIVILEGES"):
            continue
        if line.startswith("CREATE SCHEMA ") and "IF NOT EXISTS" not in line:
            line = "CREATE SCHEMA IF NOT EXISTS " + line[len("CREATE SCHEMA ") :]
        lines.append(line)
    return "\n".join(lines) + "\n"


def _history_sql(container: str, secrets: list[str], installed: list[str]) -> str:
    if "supabase_migrations" not in installed:
        return (
            "-- supabase_migrations is not installed on the source.\n"
            "-- No migration rows were available to capture.\n"
        )
    schema = pg_dump(container, ["--schema-only", "--no-owner", "--quote-all-identifiers", "--schema=supabase_migrations"], secrets)
    data = pg_dump(container, ["--data-only", "--no-owner", "--quote-all-identifiers", "--schema=supabase_migrations"], secrets)
    return schema + "\n" + data


def build_backup(out_path: Path) -> dict:
    url = os.environ.get(URL_ENV, "")
    recipient_raw = os.environ.get(RECIPIENT_ENV, "")
    missing = [name for name, value in ((URL_ENV, url), (RECIPIENT_ENV, recipient_raw)) if not value.strip()]
    if missing:
        raise FullDbError("Set " + " and ".join(missing) + ".")
    recipient = validate_recipient(recipient_raw)
    conn = parse_database_url(url)
    secrets = [str(conn["password"]), recipient]
    container = container_publishing(int(conn["port"]))
    identity, catalog = collect_catalog(container, secrets)
    schemas = data_schemas(catalog)
    if "public" not in schemas and "auth" not in schemas:
        raise FullDbError("Catalog did not include public or auth tables.")
    schema_args = ["--data-only", "--no-owner", "--no-privileges", "--quote-all-identifiers", "--encoding=UTF8"]
    for schema in schemas:
        schema_args.extend(["--schema", schema])
    data_sql = pg_dump(container, schema_args, secrets)
    if "decrypted_secrets" in data_sql:
        raise FullDbError("Refusing to package vault.decrypted_secrets.")
    public_schema = _schema_sql(
        pg_dump(
            container,
            ["--schema-only", "--no-owner", "--quote-all-identifiers", "--encoding=UTF8", "--schema", "public"],
            secrets,
        )
    )
    auth_custom = public_triggers_on_managed(container, secrets)
    history = _history_sql(container, secrets, identity["installed_schemas"])
    roles = roles_sql(catalog)
    assert_no_password_clause(roles)

    created = datetime.now(timezone.utc).replace(microsecond=0)
    created_at = created.strftime("%Y-%m-%dT%H:%M:%SZ")
    bundle = Path(tempfile.mkdtemp(prefix="full-db-backup-"))
    try:
        (bundle / "roles.sql").write_text(roles, encoding="utf-8", newline="\n")
        (bundle / "schema.sql").write_text(public_schema, encoding="utf-8", newline="\n")
        (bundle / "auth-custom.sql").write_text(auth_custom, encoding="utf-8", newline="\n")
        (bundle / "data.sql").write_text(data_sql, encoding="utf-8", newline="\n")
        (bundle / "history.sql").write_text(history, encoding="utf-8", newline="\n")
        (bundle / "catalog.json").write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8", newline="\n")
        row_counts = {
            f"{entry['schema']}.{entry['name']}": entry["row_count"]
            for entry in catalog
            if entry["row_count"] is not None and entry["restore_mode"] in {"live", "inert", "capture_only"}
        }
        manifest = {
            "format_version": FORMAT_VERSION,
            "artifact_kind": "full-database",
            "created_at": created_at,
            "source_host": conn["host"],
            "source_port": conn["port"],
            "source_database": conn["database"],
            "postgresql_version": identity["postgresql_version"],
            "server_version_num": identity["server_version_num"],
            "pg_dump_version": identity["pg_dump_version"],
            "encryption": {
                "tool": "age",
                "recipient_env": RECIPIENT_ENV,
                "separate_from_portable_backup": True,
            },
            "data_schemas": schemas,
            "row_counts": row_counts,
            "repository_root_name": repo_root().name,
        }
        (bundle / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8", newline="\n")
        summary = [
            f"format_version: {FORMAT_VERSION}",
            f"created_at: {created_at}",
            f"postgresql_version: {identity['postgresql_version']}",
            f"pg_dump_version: {identity['pg_dump_version']}",
            f"source: {conn['host']}:{conn['port']}/{conn['database']}",
            "row_counts:",
        ]
        for name, count in sorted(row_counts.items()):
            summary.append(f"  {name}: {count}")
        omitted = [entry for entry in catalog if entry["restore_mode"] == "omit" and entry["object_type"] == "schema"]
        summary.append("disclosed_absent_schemas:")
        for entry in omitted:
            summary.append(f"  {entry['name']}: {entry['exclusion_reason']}")
        (bundle / "summary.txt").write_text("\n".join(summary) + "\n", encoding="utf-8", newline="\n")
        write_checksums(bundle)
        encrypt_bundle(bundle, recipient, out_path)
        manifest["artifact_bytes"] = out_path.stat().st_size
        manifest["data_sha256"] = sha256_bytes(data_sql.encode("utf-8"))
        return manifest
    finally:
        import shutil

        shutil.rmtree(bundle, ignore_errors=True)


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Create an age-encrypted full-database backup.")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        manifest = build_backup(args.out)
    except FullDbError as exc:
        print(redact(str(exc), []), file=sys.stderr)
        return 1
    print(f"format_version: {manifest['format_version']}")
    print(f"postgresql_version: {manifest['postgresql_version']}")
    print(f"pg_dump_version: {manifest['pg_dump_version']}")
    print(f"artifact_bytes: {manifest['artifact_bytes']}")
    print(f"tables_with_counts: {len(manifest['row_counts'])}")
    return 0


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.exit(main())
