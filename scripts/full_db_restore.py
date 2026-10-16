#!/usr/bin/env python3
"""Restore a full-database artifact into a labeled disposable local database.

The destination must be an initialized Postgres 17 server on localhost, and
it must already contain full_db_meta.disposable_marker with the same label
passed to --disposable-label. This command does not touch any other database.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

from full_db_common import (
    FORMAT_VERSION,
    URL_ENV,
    FullDbError,
    assert_can_set_replica,
    assert_catalog_prerequisites,
    assert_disposable_identity,
    assert_no_password_clause,
    decrypt_bundle,
    parse_database_url,
    psql_script,
    publication_sql,
    set_destination_event_triggers,
    quote_ident,
    redact,
    rewrite_data_sql,
)


def _suspend_table_default_privileges() -> str:
    """Stop postgres-owned table defaults from widening ACLs during CREATE TABLE.

    pg_dump emits GRANT for the source ACL. It does not revoke privileges that
    Supabase already grants through ALTER DEFAULT PRIVILEGES when postgres
    creates a table. schema.sql puts the dumped defaults after CREATE.
    """
    return """
DO $$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT n.nspname
    FROM pg_default_acl d
    JOIN pg_namespace n ON n.oid = d.defaclnamespace
    JOIN pg_roles r ON r.oid = d.defaclrole
    WHERE r.rolname = current_user
      AND d.defaclobjtype = 'r'
  LOOP
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated, service_role',
      schema_name
    );
  END LOOP;
END $$;
"""


def _fk_scan() -> str:
    return """
DO $$
DECLARE
  orphan_count bigint;
  rec record;
BEGIN
  FOR rec IN
    SELECT n.nspname AS schema_name,
           c.relname AS table_name,
           a.attname AS column_name,
           fn.nspname AS foreign_schema,
           fc.relname AS foreign_table,
           fa.attname AS foreign_column
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = con.conkey[1]
    JOIN pg_class fc ON fc.oid = con.confrelid
    JOIN pg_namespace fn ON fn.oid = fc.relnamespace
    JOIN pg_attribute fa ON fa.attrelid = fc.oid AND fa.attnum = con.confkey[1]
    WHERE con.contype = 'f'
      AND array_length(con.conkey, 1) = 1
      AND n.nspname IN ('public', 'auth', 'storage')
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I.%I child LEFT JOIN %I.%I parent ON child.%I = parent.%I WHERE child.%I IS NOT NULL AND parent.%I IS NULL',
      rec.schema_name, rec.table_name, rec.foreign_schema, rec.foreign_table,
      rec.column_name, rec.foreign_column, rec.column_name, rec.foreign_column
    ) INTO orphan_count;
    IF orphan_count <> 0 THEN
      RAISE EXCEPTION 'foreign key violation %.%', rec.schema_name, rec.table_name;
    END IF;
  END LOOP;
END $$;
"""


def _truncate_live(catalog: list[dict]) -> str:
    names: list[str] = []
    for entry in catalog:
        if entry.get("restore_mode") != "live":
            continue
        if entry.get("object_type") not in {"table", "partition", "partitioned_table"}:
            continue
        schema = str(entry.get("schema") or "")
        table = str(entry.get("name") or "")
        if not schema or not table:
            raise FullDbError("Catalog live table is missing a name.")
        names.append(f"{quote_ident(schema)}.{quote_ident(table)}")
    if not names:
        return ""
    return "TRUNCATE TABLE " + ", ".join(names) + " CASCADE;\n"


def restore_backup(
    artifact: Path,
    identity: Path,
    disposable_label: str,
    confirm: str,
    project_id: str,
) -> None:
    expected = f"RESTORE FULL {disposable_label}"
    if confirm != expected:
        raise FullDbError("Confirmation must be RESTORE FULL <disposable-label>.")
    url = os.environ.get(URL_ENV, "")
    if not url.strip():
        raise FullDbError(f"Set {URL_ENV}.")
    conn = parse_database_url(url)
    secrets = [str(conn["password"])]
    checked = assert_disposable_identity(
        host=str(conn["host"]),
        port=int(conn["port"]),
        disposable_label=disposable_label,
        project_id=project_id,
        secrets=secrets,
    )
    container = str(checked["container"])
    assert_can_set_replica(container, str(conn["user"]), secrets)
    work = Path(tempfile.mkdtemp(prefix="full-db-restore-"))
    try:
        decrypt_bundle(artifact, identity, work)
        manifest = json.loads((work / "manifest.json").read_text(encoding="utf-8"))
        if manifest.get("format_version") != FORMAT_VERSION:
            raise FullDbError("Artifact format_version is not full-db-1.")
        catalog = json.loads((work / "catalog.json").read_text(encoding="utf-8"))
        for entry in catalog:
            if not entry.get("classification"):
                raise FullDbError("Catalog entry is missing a classification.")
            if entry.get("restore_mode") == "omit" and not entry.get("exclusion_reason"):
                raise FullDbError("Omitted catalog entry has no exclusion reason.")
        assert_catalog_prerequisites(container, catalog, secrets)
        roles = (work / "roles.sql").read_text(encoding="utf-8")
        assert_no_password_clause(roles)
        auth_custom = (work / "auth-custom.sql").read_text(encoding="utf-8")
        statements = "\n".join(line for line in auth_custom.splitlines() if not line.strip().startswith("--"))
        if "CREATE SCHEMA" in statements.upper() or "CREATE TABLE" in statements.upper():
            raise FullDbError("auth-custom.sql tries to recreate a managed object.")
        data_sql = rewrite_data_sql((work / "data.sql").read_text(encoding="utf-8"), catalog)
        script = "\n".join(
            [
                roles,
                _suspend_table_default_privileges(),
                (work / "schema.sql").read_text(encoding="utf-8"),
                "SET search_path TO public;",
                auth_custom,
                "SET session_replication_role = replica;",
                _truncate_live(catalog),
                data_sql,
                (work / "history.sql").read_text(encoding="utf-8"),
                publication_sql(catalog),
                "SET session_replication_role = origin;",
                """
DO $$
BEGIN
  IF to_regclass('public.restore_in_progress') IS NULL THEN
    RETURN;
  END IF;
  BEGIN
    EXECUTE 'ALTER TABLE public.restore_in_progress DISABLE ROW LEVEL SECURITY';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  UPDATE public.restore_in_progress SET in_progress = false;
  IF EXISTS (SELECT 1 FROM public.restore_in_progress WHERE in_progress) THEN
    RAISE EXCEPTION 'restore_in_progress was not cleared';
  END IF;
  BEGIN
    EXECUTE 'ALTER TABLE public.restore_in_progress ENABLE ROW LEVEL SECURITY';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END $$;
""",
                _fk_scan(),
            ]
        )
        set_destination_event_triggers(container, False, secrets)
        try:
            psql_script(container, script, secrets)
        finally:
            set_destination_event_triggers(container, True, secrets)
    finally:
        import shutil

        shutil.rmtree(work, ignore_errors=True)


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Restore a full-database artifact into a disposable local database.")
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--identity", type=Path, required=True)
    parser.add_argument("--disposable-label", required=True)
    parser.add_argument("--project-id", required=True)
    parser.add_argument("--confirm", required=True)
    args = parser.parse_args(argv)
    try:
        restore_backup(args.artifact, args.identity, args.disposable_label, args.confirm, args.project_id)
    except FullDbError as exc:
        print(redact(str(exc), []), file=sys.stderr)
        return 1
    print("restore: committed")
    print(f"disposable_label: {args.disposable_label}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
