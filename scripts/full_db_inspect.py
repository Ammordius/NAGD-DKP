#!/usr/bin/env python3
"""Decrypt and verify a full-database artifact, or print the hosted inventory procedure.

Verification reads the artifact only. It does not connect to a database.
--hosted-procedure prints the read-only SQL path and does not connect either.
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

from full_db_common import (
    FORMAT_VERSION,
    FullDbError,
    assert_no_password_clause,
    decrypt_bundle,
    find_age,
    redact,
    repo_root,
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
        return {
            "format_version": manifest["format_version"],
            "postgresql_version": version,
            "pg_dump_version": client,
            "catalog_entries": len(catalog),
            "omitted_schemas": sorted(
                entry["name"] for entry in catalog if entry.get("object_type") == "schema" and entry.get("restore_mode") == "omit"
            ),
            "age": find_age("age"),
        }
    finally:
        import shutil

        shutil.rmtree(work, ignore_errors=True)


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Verify a full-database artifact or print the hosted inventory procedure.")
    parser.add_argument("--artifact", type=Path)
    parser.add_argument("--identity", type=Path)
    parser.add_argument("--hosted-procedure", action="store_true")
    args = parser.parse_args(argv)
    if args.hosted_procedure:
        path = repo_root() / HOSTED_PROCEDURE
        print(f"hosted_procedure: {path}")
        print("connection: refused")
        print("This SQL is read-only and is not executed by this command.")
        return 0 if path.is_file() else 1
    if args.artifact is None or args.identity is None:
        print("Pass --artifact and --identity, or --hosted-procedure.", file=sys.stderr)
        return 1
    try:
        report = inspect_artifact(args.artifact, args.identity)
    except FullDbError as exc:
        print(redact(str(exc), []), file=sys.stderr)
        return 1
    print(f"format_version: {report['format_version']}")
    print(f"postgresql_version: {report['postgresql_version']}")
    print(f"pg_dump_version: {report['pg_dump_version']}")
    print(f"catalog_entries: {report['catalog_entries']}")
    print("disclosed_absent_schemas: " + ", ".join(report["omitted_schemas"]))
    print("checksums: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
