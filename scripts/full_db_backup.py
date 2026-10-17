#!/usr/bin/env python3
"""Create an age-encrypted full-database backup.

Local mode reads FULL_DB_DATABASE_URL and FULL_DB_BACKUP_AGE_RECIPIENT and
refuses non-local hosts. --hosted-readonly reads SUPABASE_DB_URL and
SQL_BACKUP_AGE_RECIPIENT, checks the configured project identity, and does
not receive the age private key.
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
    HOSTED_RECIPIENT_ENV,
    HOSTED_URL_ENV,
    RECIPIENT_ENV,
    URL_ENV,
    FullDbError,
    assert_hosted_identity,
    assert_hosted_session_read_only,
    assert_no_password_clause,
    assert_required_tables,
    collect_catalog,
    container_publishing,
    data_schemas,
    encrypt_bundle,
    hosted_client_version,
    hosted_pg_dump,
    parse_database_url,
    parse_hosted_database_url,
    pg_dump,
    public_triggers_on_managed,
    redact,
    refuse_long_lived_endpoint,
    repo_root,
    roles_sql,
    run_hosted_inventory,
    schema_dump_targets,
    sha256_bytes,
    sha256_file,
    validate_recipient,
    write_checksums,
)


def _keep_default_privilege(line: str) -> bool:
    """Keep a default-privilege statement only when postgres owns it.

    pg_dump also emits defaults owned by supabase_admin and other platform
    roles. The restoring postgres role cannot change those, so they stay out.
    """
    if "FOR ROLE" not in line:
        return True
    return " FOR ROLE postgres " in line or ' FOR ROLE "postgres" ' in line


def _schema_sql(dump: str) -> str:
    lines = [
        "-- ALTER DEFAULT PRIVILEGES owned by roles other than postgres are omitted.",
        "-- The restoring role cannot change default privileges owned by another role.",
        "-- Defaults owned by postgres, and explicit GRANT statements, are kept.",
        "-- Postgres-owned defaults are applied after CREATE so they do not add",
        "-- privileges that the following GRANT statements do not revoke.",
    ]
    defaults: list[str] = []
    for line in dump.splitlines():
        if line.startswith("ALTER DEFAULT PRIVILEGES"):
            if _keep_default_privilege(line):
                defaults.append(line)
            continue
        if line.startswith("CREATE SCHEMA ") and "IF NOT EXISTS" not in line:
            line = "CREATE SCHEMA IF NOT EXISTS " + line[len("CREATE SCHEMA ") :]
        lines.append(line)
    lines.extend(defaults)
    return "\n".join(lines) + "\n"


def _history_sql(dump, installed: list[str]) -> str:
    if "supabase_migrations" not in installed:
        return (
            "-- supabase_migrations is not installed on the source.\n"
            "-- No migration rows were available to capture.\n"
        )
    schema = dump(["--schema-only", "--no-owner", "--quote-all-identifiers", "--schema=supabase_migrations"])
    data = dump(["--data-only", "--no-owner", "--quote-all-identifiers", "--schema=supabase_migrations"])
    return schema + "\n" + data


def coverage_lines(catalog: list[dict], *, data_ok: bool) -> list[str]:
    tables = {
        (entry.get("schema"), entry.get("name"))
        for entry in catalog
        if entry.get("object_type") in {"table", "partition", "partitioned_table"}
    }
    required = (
        ("auth", "users"),
        ("auth", "identities"),
        ("public", "profiles"),
        ("public", "officer_audit_log"),
    )
    auth_ok = all(item in tables for item in required)
    postgres_ok = data_ok and any(entry.get("schema") == "public" and entry.get("object_type") == "table" for entry in catalog)
    return [
        f"postgresql_data_coverage: {'PASS' if postgres_ok else 'FAIL'}",
        f"auth_user_data_coverage: {'PASS' if auth_ok else 'FAIL'}",
        "storage_object_byte_coverage: NOT INCLUDED",
        "vault_portability: CIPHERTEXT ONLY",
        "external_configuration: NOT INCLUDED",
    ]


def append_summary(text: str) -> None:
    print(text)
    path = os.environ.get("GITHUB_STEP_SUMMARY", "").strip()
    if not path:
        return
    with open(path, "a", encoding="utf-8", newline="\n") as handle:
        handle.write(text + "\n")


def _write_github_output(stamp: str, digest: str, size: int, tables: int) -> None:
    path = os.environ.get("GITHUB_OUTPUT", "").strip()
    if not path:
        return
    with open(path, "a", encoding="utf-8", newline="\n") as handle:
        handle.write(f"stamp={stamp}\n")
        handle.write(f"sha256={digest}\n")
        handle.write(f"bytes={size}\n")
        handle.write(f"tables={tables}\n")


def _seal_bundle(
    out_path: Path,
    *,
    dump,
    query,
    identity: dict,
    catalog: list[dict],
    source_host: str,
    source_port: int,
    source_database: str,
    recipient: str,
    recipient_env: str,
    separate_from_portable_backup: bool,
    secrets: list[str],
) -> dict:
    schemas = data_schemas(catalog)
    if "public" not in schemas and "auth" not in schemas:
        raise FullDbError("Catalog did not include public or auth tables.")
    schema_args = ["--data-only", "--no-owner", "--no-privileges", "--quote-all-identifiers", "--encoding=UTF8"]
    for schema in schemas:
        schema_args.extend(["--schema", schema])
    data_sql = dump(schema_args)
    if "decrypted_secrets" in data_sql:
        raise FullDbError("Refusing to package vault.decrypted_secrets.")
    schema_args = ["--schema-only", "--no-owner", "--quote-all-identifiers", "--encoding=UTF8"]
    for schema in schema_dump_targets(catalog):
        schema_args.extend(["--schema", schema])
    public_schema = _schema_sql(dump(schema_args))
    auth_custom = public_triggers_on_managed("", secrets, query=query)
    history = _history_sql(dump, identity["installed_schemas"])
    roles = roles_sql(catalog)
    assert_no_password_clause(roles)

    created = datetime.now(timezone.utc).replace(microsecond=0)
    created_at = created.strftime("%Y-%m-%dT%H:%M:%SZ")
    bundle = Path(tempfile.mkdtemp(prefix="full-db-backup-"))
    try:
        if os.name == "posix":
            os.chmod(bundle, 0o700)
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
            "source_host": source_host,
            "source_port": source_port,
            "source_database": source_database,
            "postgresql_version": identity["postgresql_version"],
            "server_version_num": identity["server_version_num"],
            "pg_dump_version": identity["pg_dump_version"],
            "encryption": {
                "tool": "age",
                "recipient_env": recipient_env,
                "separate_from_portable_backup": separate_from_portable_backup,
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
            f"source: {source_host}:{source_port}/{source_database}",
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
        manifest["artifact_sha256"] = sha256_file(out_path)
        manifest["stamp"] = created.strftime("%Y%m%dT%H%M%SZ")
        manifest["coverage"] = coverage_lines(catalog, data_ok=True)
        return manifest
    finally:
        import shutil

        shutil.rmtree(bundle, ignore_errors=True)


def build_backup(out_path: Path) -> dict:
    url = os.environ.get(URL_ENV, "")
    recipient_raw = os.environ.get(RECIPIENT_ENV, "")
    missing = [name for name, value in ((URL_ENV, url), (RECIPIENT_ENV, recipient_raw)) if not value.strip()]
    if missing:
        raise FullDbError("Set " + " and ".join(missing) + ".")
    recipient = validate_recipient(recipient_raw)
    conn = parse_database_url(url)
    refuse_long_lived_endpoint(str(conn["host"]), int(conn["port"]))
    secrets = [str(conn["password"]), recipient]
    container = container_publishing(int(conn["port"]))
    identity, catalog = collect_catalog(container, secrets)

    def dump(args: list[str]) -> str:
        return pg_dump(container, args, secrets)

    def query(sql: str) -> str:
        from full_db_common import psql_text

        return psql_text(container, sql, secrets)

    return _seal_bundle(
        out_path,
        dump=dump,
        query=query,
        identity=identity,
        catalog=catalog,
        source_host=str(conn["host"]),
        source_port=int(conn["port"]),
        source_database=str(conn["database"]),
        recipient=recipient,
        recipient_env=RECIPIENT_ENV,
        separate_from_portable_backup=True,
        secrets=secrets,
    )


def build_hosted_backup(out_path: Path) -> dict:
    """Read-only backup of the configured hosted database. Does not decrypt."""
    url = os.environ.get(HOSTED_URL_ENV, "")
    recipient_raw = os.environ.get(HOSTED_RECIPIENT_ENV, "")
    missing = [name for name, value in ((HOSTED_URL_ENV, url), (HOSTED_RECIPIENT_ENV, recipient_raw)) if not value.strip()]
    if missing:
        raise FullDbError("Set " + " and ".join(missing) + ".")
    recipient = validate_recipient(recipient_raw, HOSTED_RECIPIENT_ENV)
    conn = parse_hosted_database_url(url)
    assert_hosted_identity(conn)
    secrets = [str(conn["password"]), recipient]
    inventory = run_hosted_inventory(conn, secrets)
    append_summary("hosted_inventory:")
    for line in inventory.splitlines()[:80]:
        append_summary("  " + line)
    dump_version = hosted_client_version("pg_dump")

    def query(sql: str) -> str:
        from full_db_common import hosted_psql_text

        return hosted_psql_text(conn, sql, secrets)

    identity, catalog = collect_catalog("", secrets, query=query, dump_version=dump_version)
    identity["pg_dump_version"] = dump_version
    assert_required_tables(catalog)

    def dump(args: list[str]) -> str:
        return hosted_pg_dump(conn, args, secrets)

    return _seal_bundle(
        out_path,
        dump=dump,
        query=query,
        identity=identity,
        catalog=catalog,
        source_host=str(conn["host"]),
        source_port=int(conn["port"]),
        source_database=str(conn["database"]),
        recipient=recipient,
        recipient_env=HOSTED_RECIPIENT_ENV,
        separate_from_portable_backup=False,
        secrets=secrets,
    )


def _report_manifest(manifest: dict) -> None:
    print(f"format_version: {manifest['format_version']}")
    print(f"postgresql_version: {manifest['postgresql_version']}")
    print(f"pg_dump_version: {manifest['pg_dump_version']}")
    print(f"artifact_bytes: {manifest['artifact_bytes']}")
    print(f"artifact_sha256: {manifest['artifact_sha256']}")
    print(f"tables_with_counts: {len(manifest['row_counts'])}")
    _write_github_output(
        str(manifest["stamp"]),
        str(manifest["artifact_sha256"]),
        int(manifest["artifact_bytes"]),
        len(manifest["row_counts"]),
    )
    for line in manifest.get("coverage") or []:
        append_summary(line)
    append_summary(f"source: {manifest['source_host']}:{manifest['source_port']}/{manifest['source_database']}")
    append_summary(f"postgresql_version: {manifest['postgresql_version']}")
    append_summary(f"created_at: {manifest['created_at']}")
    append_summary(f"artifact_bytes: {manifest['artifact_bytes']}")
    append_summary(f"artifact_sha256: {manifest['artifact_sha256']}")
    append_summary(f"tables_with_counts: {len(manifest['row_counts'])}")


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Create an age-encrypted full-database backup.")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--out-dir", type=Path)
    parser.add_argument("--hosted-readonly", action="store_true")
    args = parser.parse_args(argv)
    if args.hosted_readonly:
        if args.out_dir is None or args.out is not None:
            print("Hosted backup requires --out-dir and not --out.", file=sys.stderr)
            return 1
        args.out_dir.mkdir(parents=True, exist_ok=True)
        out_path = args.out_dir / "full-db-backup-pending.tar.gz.age"
    else:
        if args.out is None or args.out_dir is not None:
            print("Local backup requires --out.", file=sys.stderr)
            return 1
        out_path = args.out
    try:
        if args.hosted_readonly:
            manifest = build_hosted_backup(out_path)
        else:
            manifest = build_backup(out_path)
    except FullDbError as exc:
        append_summary("postgresql_data_coverage: FAIL")
        append_summary("auth_user_data_coverage: FAIL")
        append_summary("storage_object_byte_coverage: NOT INCLUDED")
        append_summary("vault_portability: CIPHERTEXT ONLY")
        append_summary("external_configuration: NOT INCLUDED")
        if args.hosted_readonly and out_path.is_file():
            out_path.unlink()
        print(redact(str(exc), []), file=sys.stderr)
        return 1
    if args.hosted_readonly:
        final_path = args.out_dir / f"full-db-backup-{manifest['stamp']}.tar.gz.age"
        os.replace(out_path, final_path)
    _report_manifest(manifest)
    return 0


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.exit(main())
