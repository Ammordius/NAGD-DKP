#!/usr/bin/env python3
"""Decrypt and verify a full-database artifact, or print the hosted inventory procedure.

Verification reads the artifact only. It does not connect to a database.
--hosted-procedure prints the read-only SQL path and does not connect either.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

from full_db_common import (
    FORMAT_VERSION,
    REQUIRED_TABLES,
    FullDbError,
    assert_hosted_identity,
    assert_no_password_clause,
    decrypt_bundle,
    find_age,
    parse_hosted_database_url,
    redact,
    repo_root,
    run_hosted_inventory,
)

HOSTED_PROCEDURE = "docs/full-db-hosted-inventory.sql"


def inspect_artifact(artifact: Path, identity: Path) -> dict:
    if not artifact.is_file():
        raise FullDbError("Artifact file was not found.")
    raw = artifact.read_bytes()
    if not raw.startswith(b"age-encryption.org/"):
        raise FullDbError("Artifact is not an age-encrypted file.")
    work = Path(tempfile.mkdtemp(prefix="full-db-inspect-"))
    try:
        decrypt_bundle(artifact, identity, work)
        manifest = json.loads((work / "manifest.json").read_text(encoding="utf-8"))
        if manifest.get("format_version") != FORMAT_VERSION:
            raise FullDbError("Artifact format_version is not full-db-1.")
        catalog = json.loads((work / "catalog.json").read_text(encoding="utf-8"))
        data_sql = (work / "data.sql").read_text(encoding="utf-8")
        roles = (work / "roles.sql").read_text(encoding="utf-8")
        assert_no_password_clause(roles)
        if "decrypted_secrets" in data_sql:
            raise FullDbError("data.sql contains vault.decrypted_secrets.")
        missing_reason = [
            f"{entry.get('schema')}.{entry.get('name')}"
            for entry in catalog
            if not entry.get("classification")
            or (entry.get("restore_mode") == "omit" and not entry.get("exclusion_reason"))
        ]
        if missing_reason:
            raise FullDbError("Catalog entries missing classification or an exclusion reason: " + ", ".join(missing_reason[:8]))
        version = str(manifest.get("postgresql_version", ""))
        if not version.startswith("17"):
            raise FullDbError(f"Manifest server version is not PostgreSQL 17 ({version}).")
        client = str(manifest.get("pg_dump_version", ""))
        if "17." not in client and not client.startswith("pg_dump (PostgreSQL) 17"):
            raise FullDbError(f"Manifest pg_dump version is not PostgreSQL 17 ({client}).")
        tables = {
            (entry.get("schema"), entry.get("name"))
            for entry in catalog
            if entry.get("object_type") in {"table", "partition", "partitioned_table"}
        }
        missing = [f"{schema}.{name}" for schema, name in REQUIRED_TABLES if (schema, name) not in tables]
        if manifest.get("artifact_kind") not in (None, "full-database"):
            raise FullDbError("Artifact is not a full-database backup.")
        return {
            "format_version": manifest["format_version"],
            "artifact_kind": manifest.get("artifact_kind") or "full-database",
            "postgresql_version": version,
            "pg_dump_version": client,
            "catalog_entries": len(catalog),
            "source_host": manifest.get("source_host"),
            "source_database": manifest.get("source_database"),
            "created_at": manifest.get("created_at"),
            "table_count": len(tables),
            "missing_required_tables": missing,
            "omitted_schemas": sorted(
                entry["name"] for entry in catalog if entry.get("object_type") == "schema" and entry.get("restore_mode") == "omit"
            ),
            "age": find_age("age"),
            "auth_user_data_coverage": "FAIL" if missing else "PASS",
            "postgresql_data_coverage": "PASS" if any(schema == "public" for schema, _name in tables) else "FAIL",
        }
    finally:
        import shutil

        shutil.rmtree(work, ignore_errors=True)


def recovery_lines(report: dict) -> list[str]:
    data_ok = report.get("postgresql_data_coverage") == "PASS" and report.get("auth_user_data_coverage") == "PASS"
    headline = "PROJECT_RECOVERY_CONDITIONAL" if data_ok else "RECOVERY_FAILED"
    lines = [
        headline,
        "DATABASE_RECOVERY_PASS" if data_ok else "DATABASE_RECOVERY_FAIL",
        f"postgresql_data_coverage: {report.get('postgresql_data_coverage')}",
        f"auth_user_data_coverage: {report.get('auth_user_data_coverage')}",
        "storage_object_byte_coverage: NOT INCLUDED",
        "vault_portability: CIPHERTEXT ONLY",
        "external_configuration: NOT INCLUDED",
        "storage_object_bytes: not recovered",
        "vault_plaintext: not portable",
        "external_jwt_oauth_dashboard: not recovered",
    ]
    return lines


def append_summary(text: str) -> None:
    print(text)
    path = os.environ.get("GITHUB_STEP_SUMMARY", "").strip()
    if not path:
        return
    with open(path, "a", encoding="utf-8", newline="\n") as handle:
        handle.write(text + "\n")


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Verify a full-database artifact or print the hosted inventory procedure.")
    parser.add_argument("--artifact", type=Path)
    parser.add_argument("--identity", type=Path)
    parser.add_argument("--identity-env", action="store_true")
    parser.add_argument("--readiness", action="store_true")
    parser.add_argument("--hosted-procedure", action="store_true")
    args = parser.parse_args(argv)
    if args.hosted_procedure:
        path = repo_root() / HOSTED_PROCEDURE
        print(f"hosted_procedure: {path}")
        print("connection: refused")
        print("This SQL is read-only and is not executed by this command.")
        return 0 if path.is_file() else 1
    identity_path = args.identity
    temporary = None
    if args.identity_env:
        secret = os.environ.get("SQL_BACKUP_AGE_IDENTITY", "")
        if "AGE-SECRET-KEY-" not in secret:
            print("Set SQL_BACKUP_AGE_IDENTITY.", file=sys.stderr)
            return 1
        temporary = Path(tempfile.mkdtemp(prefix="full-db-identity-"))
        identity_path = temporary / "age-identity.txt"
        identity_path.write_text(secret, encoding="utf-8")
        if os.name == "posix":
            os.chmod(identity_path, 0o600)
    if args.artifact is None or identity_path is None:
        if temporary is not None:
            import shutil

            shutil.rmtree(temporary, ignore_errors=True)
        print("Pass --artifact and --identity, or --hosted-procedure.", file=sys.stderr)
        return 1
    try:
        report = inspect_artifact(args.artifact, identity_path)
        if args.readiness and report.get("missing_required_tables"):
            raise FullDbError(
                "Required table is missing: " + ", ".join(report["missing_required_tables"]) + "."
            )
        if args.readiness:
            url = os.environ.get("SUPABASE_DB_URL", "")
            if not url.strip():
                raise FullDbError("Set SUPABASE_DB_URL.")
            conn = parse_hosted_database_url(url)
            assert_hosted_identity(conn)
            inventory = run_hosted_inventory(conn, [str(conn["password"])])
            append_summary("destination_inventory:")
            for line in inventory.splitlines()[:80]:
                append_summary("  " + line)
    except FullDbError as exc:
        append_summary("RECOVERY_FAILED")
        print(redact(str(exc), []), file=sys.stderr)
        return 1
    finally:
        if temporary is not None:
            import shutil

            shutil.rmtree(temporary, ignore_errors=True)
    print(f"format_version: {report['format_version']}")
    print(f"postgresql_version: {report['postgresql_version']}")
    print(f"pg_dump_version: {report['pg_dump_version']}")
    print(f"catalog_entries: {report['catalog_entries']}")
    print("disclosed_absent_schemas: " + ", ".join(report["omitted_schemas"]))
    print("checksums: ok")
    for line in recovery_lines(report):
        append_summary(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
