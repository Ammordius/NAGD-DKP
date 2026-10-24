#!/usr/bin/env python3
"""Disposable checks for the portable SQL backup.

Credential failures run without Docker. The snapshot test needs Docker,
pg_dump, and age. Set DKP_PG_TEST=1 to fail when those tools are missing.
This test never reads SUPABASE_DB_URL from the parent environment.
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import sql_backup

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = Path(__file__).resolve().parent / "sql_backup.py"
REQUIRED = os.environ.get("DKP_PG_TEST") == "1"

EXPECTED_INCLUDED = (
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
)
FORBIDDEN_COPY_TABLES = (
    "profiles",
    "officer_audit_log",
    "users",
    "restore_in_progress",
    "raid_dkp_totals",
    "raid_attendance_dkp",
    "raid_attendance_dkp_by_account",
    "dkp_summary",
    "account_dkp_summary",
    "dkp_period_totals",
    "character_dkp_spent",
    "character_loot_assignment_counts",
    "bid_portfolio_auction_fact",
    "account_class_coverage",
)
SECRET_EMAIL = "audit-only@example.test"
CACHE_MARKER = "cache-marker-should-not-export"
FIXTURE_PASSWORD = "fixture-password-not-for-logs"

FIXTURE_SQL = f"""
INSERT INTO auth.users (id, email)
VALUES ('11111111-1111-4111-8111-111111111111', '{SECRET_EMAIL}');

INSERT INTO public.characters (char_id, name, class_name)
VALUES ('char-hist-1', 'Histtoon', 'Warrior');
INSERT INTO public.accounts (account_id, display_name, toon_count)
VALUES ('acct-hist-1', 'Histtoon', 1);
INSERT INTO public.character_account (char_id, account_id)
VALUES ('char-hist-1', 'acct-hist-1');

INSERT INTO public.raids (raid_id, raid_name, date_iso)
VALUES ('raid-hist-1', 'Old Raid', '2020-01-15');
INSERT INTO public.raid_events (raid_id, event_id, event_order, event_name, dkp_value)
VALUES ('raid-hist-1', '1', 1, 'Ancient', '10');
INSERT INTO public.raid_attendance (raid_id, char_id, character_name)
VALUES ('raid-hist-1', 'char-hist-1', 'Histtoon');
INSERT INTO public.raid_event_attendance (raid_id, event_id, char_id, character_name, account_id)
VALUES ('raid-hist-1', '1', 'char-hist-1', 'Histtoon', NULL);
INSERT INTO public.raid_loot (raid_id, event_id, item_name, char_id, character_name, cost)
VALUES ('raid-hist-1', '1', 'PortableBlade', 'char-hist-1', 'Histtoon', '5');
INSERT INTO public.loot_assignment (loot_id, assigned_char_id, assigned_character_name)
SELECT id, 'char-hist-1', 'Histtoon' FROM public.raid_loot WHERE item_name = 'PortableBlade';
INSERT INTO public.dkp_adjustments (character_name, earned_delta, spent_delta, account_id)
VALUES ('Histtoon', 1, 0, 'acct-hist-1');
INSERT INTO public.raid_classifications (raid_id, mob, zone)
VALUES ('raid-hist-1', 'Ancient', 'Old Zone');
INSERT INTO public.active_raiders (character_key) VALUES ('char-hist-1');
INSERT INTO public.active_accounts (account_id) VALUES ('acct-hist-1');

INSERT INTO public.officer_audit_log (
  actor_id, actor_email, actor_display_name, action, target_type, target_id
) VALUES (
  '11111111-1111-4111-8111-111111111111',
  '{SECRET_EMAIL}',
  'Audit Person',
  'siteadmin_delete_user',
  'profile',
  '11111111-1111-4111-8111-111111111111'
);
INSERT INTO public.account_class_coverage (account_id, classes, meta)
VALUES ('acct-hist-1', '[]'::jsonb, jsonb_build_object('secret', '{CACHE_MARKER}'));
INSERT INTO public.bid_portfolio_auction_fact (loot_id, item_name)
SELECT id, '{CACHE_MARKER}' FROM public.raid_loot WHERE item_name = 'PortableBlade';
"""


def fail(message: str) -> None:
    raise SystemExit(message)


def check(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


def base_env() -> dict[str, str]:
    env = os.environ.copy()
    for key in (
        "SUPABASE_DB_URL",
        "SQL_BACKUP_AGE_RECIPIENT",
        "DATABASE_URL",
        "PGHOST",
        "PGPORT",
        "PGUSER",
        "PGPASSWORD",
        "PGDATABASE",
        "PGSSLMODE",
    ):
        env.pop(key, None)
    env["GITHUB_REPOSITORY"] = "example/dkp"
    env["GITHUB_RUN_ID"] = "123456789"
    env["GITHUB_SHA"] = "abc123deadbeef"
    return env


def run_script(env: dict[str, str], out_dir: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--out-dir", str(out_dir)],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )


def files_in(directory: Path) -> list[str]:
    if not directory.exists():
        return []
    return [path.name for path in directory.rglob("*") if path.is_file()]


def test_copy_parser() -> None:
    sql = (
        'COPY "public"."raid_event_attendance" '
        '("id", "raid_id", "account_id") FROM stdin;\n'
        "1\traid-hist-1\t\\N\n"
        "\\.\n"
        'COPY "public"."characters" ("char_id") FROM stdin;\n'
        "char-hist-1\n"
        "\\.\n"
    )
    blocks = sql_backup.parse_copy_blocks(sql)
    row = blocks["raid_event_attendance"]["rows"][0]
    check(row[2] is None, "COPY parser did not preserve a NULL account_id")
    check(len(blocks["characters"]["rows"]) == 1, "COPY parser miscounted rows")


def test_allowlist_contract() -> None:
    check(
        tuple(sql_backup.INCLUDED_TABLES) == EXPECTED_INCLUDED,
        "Included table allowlist does not match the portable backup contract",
    )
    excluded = {item["name"] for item in sql_backup.EXCLUDED_TABLES}
    for name in ("auth.users", "profiles", "officer_audit_log", "dkp_summary", "account_class_coverage"):
        check(name in excluded, f"{name} is missing from the exclusion list")


def test_csv_coverage() -> None:
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    from export_supabase_public_tables import PUBLIC_TABLES

    included = set(sql_backup.INCLUDED_TABLES)
    left_out = set(sql_backup.CSV_NOT_IN_PORTABLE_BACKUP)
    excluded = {item["name"] for item in sql_backup.EXCLUDED_TABLES}
    check(not (included & left_out), "A portable table is also marked as a CSV-only exclusion")
    check(left_out <= excluded, "A CSV exclusion is missing from EXCLUDED_TABLES")
    check(
        set(PUBLIC_TABLES) == included | left_out,
        "CSV exporter tables are not classified as portable or intentionally excluded",
    )


def test_publish_file_across_directories() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        source = root / "tmp" / "backup.tar.gz.age"
        source.parent.mkdir()
        payload = b"age-encryption.org/v1\nsealed"
        source.write_bytes(payload)
        destination = root / "sql-backup-out" / "sql-backup-20261024T032421Z.tar.gz.age"
        real_replace = os.replace

        def replace(src, dst, *args, **kwargs):
            if Path(src).parent != Path(dst).parent:
                raise OSError(18, "Invalid cross-device link")
            return real_replace(src, dst, *args, **kwargs)

        os.replace = replace
        try:
            sql_backup._publish_file(source, destination)
        finally:
            os.replace = real_replace
        check(destination.read_bytes() == payload, "published bytes differ")
        check(source.is_file(), "source was removed before the temp bundle cleanup")
        partial = destination.with_name(f".{destination.name}.partial")
        check(not partial.exists(), "partial file left behind")


def test_retention_tiers() -> None:
    now = datetime(2026, 10, 14, tzinfo=timezone.utc)
    weekly = f"sql-backup-weekly-{now.strftime('%G-W%V')}"
    monthly = f"sql-backup-monthly-{now.strftime('%Y-%m')}"
    check(weekly == "sql-backup-weekly-2026-W42", weekly)
    check(monthly == "sql-backup-monthly-2026-10", monthly)
    fresh = sql_backup.retention_tiers(set(), now, False)
    check(fresh == [(weekly, 90), (monthly, 90)], str(fresh))
    present = sql_backup.retention_tiers({weekly, monthly}, now, False)
    check(present == [], str(present))
    forced = sql_backup.retention_tiers({weekly, monthly}, now, True)
    check(forced == fresh, str(forced))
    monthly_only = sql_backup.retention_tiers({weekly}, now, False)
    check(monthly_only == [(monthly, 90)], str(monthly_only))


def test_missing_credentials() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        out_dir = Path(tmp)
        missing = run_script(base_env(), out_dir)
        combined = missing.stdout + missing.stderr
        check(missing.returncode != 0, "Missing credentials exited 0")
        check("SUPABASE_DB_URL" in combined, "Missing URL was not reported")
        check("SQL_BACKUP_AGE_RECIPIENT" in combined, "Missing recipient was not reported")
        check(files_in(out_dir) == [], f"Missing credentials wrote files: {files_in(out_dir)}")

        env = base_env()
        env["SUPABASE_DB_URL"] = "postgresql://postgres:pw@127.0.0.1:9/postgres?sslmode=disable"
        env["SQL_BACKUP_AGE_RECIPIENT"] = "AGE-SECRET-KEY-1this-must-not-appear-in-logs"
        rejected = run_script(env, out_dir)
        rejected_text = rejected.stdout + rejected.stderr
        check(rejected.returncode != 0, "A secret key was accepted as a recipient")
        check("this-must-not-appear-in-logs" not in rejected_text, "Recipient secret was printed")
        check("age public key" in rejected_text, "Secret-key rejection was not explained")
        check(files_in(out_dir) == [], "Secret-key rejection wrote an artifact")


def command_exists(name: str) -> bool:
    from shutil import which

    return which(name) is not None


def test_failed_dump() -> None:
    if not command_exists("pg_dump") or not command_exists("age"):
        message = "Failed-dump check was not run (pg_dump or age is missing)."
        if REQUIRED:
            fail(message)
        print(message)
        return
    with tempfile.TemporaryDirectory() as tmp:
        out_dir = Path(tmp)
        env = base_env()
        env["SUPABASE_DB_URL"] = (
            f"postgresql://postgres:{FIXTURE_PASSWORD}@127.0.0.1:1/postgres?sslmode=disable"
        )
        env["SQL_BACKUP_AGE_RECIPIENT"] = "age1placeholderxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
        # A syntactically shaped key is enough: pg_dump fails before encryption.
        # age format is checked only as a prefix, so use a generated key when possible.
        key_text = subprocess.run(
            ["age-keygen"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
        public = ""
        for line in (key_text.stdout or "").splitlines():
            if line.startswith("# public key:"):
                public = line.split(":", 1)[1].strip()
        if public.startswith("age1"):
            env["SQL_BACKUP_AGE_RECIPIENT"] = public
        completed = run_script(env, out_dir)
        combined = completed.stdout + completed.stderr
        check(completed.returncode != 0, "pg_dump connection failure exited 0")
        check(FIXTURE_PASSWORD not in combined, "Database password was printed")
        check("postgresql://" not in combined, "Database URL was printed")
        check(not any(name.endswith(".age") for name in files_in(out_dir)), "Failed dump wrote an encrypted artifact")
        check(not any(name.endswith((".sql", ".tar.gz", ".json")) for name in files_in(out_dir)), "Failed dump left plaintext")


def docker_ok() -> bool:
    result = subprocess.run(["docker", "info"], capture_output=True, text=True, check=False)
    return result.returncode == 0


def run_docker(args: list[str], stdin: str | None = None, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["docker", *args],
        input=stdin,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=False,
    )


def psql(container: str, sql: str, timeout: int = 300) -> subprocess.CompletedProcess[str]:
    return run_docker(
        ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
        stdin=sql,
        timeout=timeout,
    )


def wait_for_postgres(container: str) -> None:
    for _ in range(60):
        result = run_docker(
            ["exec", container, "psql", "-U", "postgres", "-d", "postgres", "-c", "SELECT 1"],
            timeout=30,
        )
        if result.returncode == 0:
            return
        time.sleep(1)
    fail("Postgres did not become ready")


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def age_public_key(key_path: Path) -> str:
    text = key_path.read_text(encoding="utf-8")
    for line in text.splitlines():
        if line.startswith("# public key:"):
            return line.split(":", 1)[1].strip()
    fail("age-keygen did not write a public key")
    return ""


def test_disposable_snapshot() -> None:
    missing_tools = [
        name
        for name, present in (
            ("psql", command_exists("psql")),
            ("docker", docker_ok()),
            ("pg_dump", command_exists("pg_dump")),
            ("age", command_exists("age")),
            ("age-keygen", command_exists("age-keygen")),
        )
        if not present
    ]
    if missing_tools:
        message = "Snapshot test was not run (missing: " + ", ".join(missing_tools) + ")."
        if REQUIRED:
            fail(message)
        print(message)
        return

    container = f"nagddkp-sqlbk-{os.getpid()}"
    port = free_port()
    run_docker(["rm", "-f", container], timeout=60)
    started = run_docker(
        [
            "run",
            "-d",
            "--name",
            container,
            "-e",
            "POSTGRES_HOST_AUTH_METHOD=trust",
            "-e",
            "POSTGRES_PASSWORD=postgres",
            "-p",
            f"127.0.0.1:{port}:5432",
            "postgres:16",
        ],
        timeout=180,
    )
    if started.returncode != 0:
        fail(started.stderr or started.stdout or "could not start Postgres")
    try:
        wait_for_postgres(container)
        auth_stub = (ROOT / "web" / "test" / "pg" / "auth-stub.sql").read_text(encoding="utf-8")
        schema = (ROOT / "docs" / "supabase-schema-full.sql").read_text(encoding="utf-8")
        applied_auth = psql(container, auth_stub)
        check(applied_auth.returncode == 0, "auth stub failed:\n" + (applied_auth.stderr or applied_auth.stdout))
        applied_schema = psql(container, schema, timeout=300)
        if applied_schema.returncode != 0:
            detail = (applied_schema.stderr or applied_schema.stdout)[-4000:]
            fail("canonical schema failed:\n" + detail)
        loaded = psql(container, FIXTURE_SQL)
        if loaded.returncode != 0:
            fail("fixture insert failed:\n" + (loaded.stderr or loaded.stdout)[-4000:])
        before = psql(
            container,
            "SELECT CASE WHEN account_id IS NULL THEN 'null' ELSE 'set' END FROM raid_event_attendance WHERE char_id = 'char-hist-1';",
        )
        check("null" in before.stdout, "Fixture did not keep a NULL account_id")
        excluded_rows = psql(
            container,
            "SELECT CASE WHEN "
            f"EXISTS (SELECT 1 FROM profiles WHERE email = '{SECRET_EMAIL}') "
            f"AND EXISTS (SELECT 1 FROM officer_audit_log WHERE actor_email = '{SECRET_EMAIL}') "
            "THEN 'present' ELSE 'missing' END;",
        )
        check("present" in excluded_rows.stdout, "Fixture did not store excluded auth-linked rows")

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            key_path = tmp_path / "age-key.txt"
            generated = subprocess.run(
                ["age-keygen", "-o", str(key_path)],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                check=False,
            )
            check(generated.returncode == 0, "age-keygen failed:\n" + (generated.stderr or ""))
            out_dir = tmp_path / "out"
            out_dir.mkdir()
            env = base_env()
            env["SUPABASE_DB_URL"] = (
                f"postgresql://postgres:{FIXTURE_PASSWORD}@127.0.0.1:{port}/postgres?sslmode=disable"
            )
            env["SQL_BACKUP_AGE_RECIPIENT"] = age_public_key(key_path)
            completed = run_script(env, out_dir)
            combined = completed.stdout + completed.stderr
            check(completed.returncode == 0, "Backup failed:\n" + combined[-4000:])
            check(FIXTURE_PASSWORD not in combined, "Database password was printed")
            check(SECRET_EMAIL not in combined, "Audit email was printed")
            check("Histtoon" not in combined, "Row data was printed")
            artifacts = list(out_dir.glob("sql-backup-*.tar.gz.age"))
            check(len(artifacts) == 1, f"Expected one encrypted artifact, found {files_in(out_dir)}")
            age_file = artifacts[0]
            raw = age_file.read_bytes()
            check(raw.startswith(b"age-encryption.org/"), "Artifact is not an age file")
            for secret in (SECRET_EMAIL.encode(), CACHE_MARKER.encode(), b"Histtoon", b"PortableBlade", b"CREATE TABLE"):
                check(secret not in raw, f"Encrypted artifact contains plaintext {secret!r}")

            tar_path = tmp_path / "backup.tar.gz"
            decrypted = subprocess.run(
                ["age", "--decrypt", "--identity", str(key_path), "--output", str(tar_path), str(age_file)],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                check=False,
            )
            check(decrypted.returncode == 0, "age decrypt failed:\n" + (decrypted.stderr or ""))
            with tarfile.open(tar_path, "r:gz") as archive:
                names = sorted(archive.getnames())
                check(
                    names == ["SHA256SUMS", "data.sql", "manifest.json", "summary.txt"],
                    f"Unexpected archive members: {names}",
                )
                data_sql = archive.extractfile("data.sql").read().decode("utf-8")
                manifest_bytes = archive.extractfile("manifest.json").read()
                sums = archive.extractfile("SHA256SUMS").read().decode("utf-8")
                summary = archive.extractfile("summary.txt").read().decode("utf-8")

            check("CREATE TABLE" not in data_sql, "Dump contains schema SQL")
            check(SECRET_EMAIL not in data_sql, "Dump contains the audit email")
            check(CACHE_MARKER not in data_sql, "Dump contains cache-only data")
            check("PortableBlade" in data_sql, "Dump is missing included loot")
            blocks = sql_backup.parse_copy_blocks(data_sql)
            for table in EXPECTED_INCLUDED:
                check(table in blocks, f"Dump is missing COPY for {table}")
            for table in FORBIDDEN_COPY_TABLES:
                check(table not in blocks, f"Dump included excluded table {table}")
            attendance = blocks["raid_event_attendance"]
            account_index = attendance["columns"].index("account_id")
            check(attendance["rows"][0][account_index] is None, "Historical NULL account_id was not preserved")
            link = blocks["character_account"]["rows"][0]
            check("char-hist-1" in link and "acct-hist-1" in link, "character_account link was not preserved")

            import hashlib
            import json

            data_hex = hashlib.sha256(data_sql.encode("utf-8")).hexdigest()
            manifest_hex = hashlib.sha256(manifest_bytes).hexdigest()
            manifest = json.loads(manifest_bytes.decode("utf-8"))
            check(manifest["format_version"] == "1", "format_version is not 1")
            check(manifest["source_repository"] == "example/dkp", "source_repository mismatch")
            check(manifest["workflow_run_id"] == "123456789", "workflow_run_id mismatch")
            check(manifest["source_commit_sha"] == "abc123deadbeef", "source_commit_sha mismatch")
            check(manifest["created_at"].endswith("Z"), "created_at is not UTC")
            check(manifest["canonical_schema_source"] == "docs/supabase-schema-full.sql", "schema source mismatch")
            check(
                manifest["canonical_schema_sha256"] == sql_backup.schema_fingerprint(ROOT / "docs" / "supabase-schema-full.sql"),
                "schema fingerprint mismatch",
            )
            file_hash = manifest["canonical_schema_sha256"]
            check(manifest["live_schema_status"] == "compatible", "live schema was not assessed as compatible")
            check(manifest["live_schema_compared_to_repository_file"] is False, "live schema was compared to the repository file")
            check(manifest["live_schema_fingerprint"] != file_hash, "live fingerprint reused the repository file hash")
            check("live_schema_status: compatible" in combined, "summary omitted the live schema status")
            check("live_schema_compared_to_repository_file: false" in combined, "summary claimed a file comparison")
            check(manifest["postgresql_version"], "postgresql_version is empty")
            check(manifest["included_tables"] == list(EXPECTED_INCLUDED), "included_tables mismatch")
            excluded_names = [item["name"] for item in manifest["excluded_tables"]]
            check("profiles" in excluded_names and "auth.users" in excluded_names, "manifest exclusions are incomplete")
            check(manifest["row_counts"]["raid_event_attendance"] == 1, "attendance row count mismatch")
            check(manifest["row_counts"]["characters"] == 1, "characters row count mismatch")
            check(manifest["checksums"]["data.sql"] == "sha256:" + data_hex, "manifest checksum mismatch")
            check(f"{data_hex}  data.sql" in sums, "SHA256SUMS is missing data.sql")
            check(f"{manifest_hex}  manifest.json" in sums, "SHA256SUMS is missing manifest.json")
            check(SECRET_EMAIL not in summary and "Histtoon" not in summary, "Summary contains row data")
            check("Histtoon" not in manifest_bytes.decode("utf-8"), "Manifest contains row data")

        after = psql(
            container,
            "SELECT CASE WHEN account_id IS NULL THEN 'null' ELSE 'set' END FROM raid_event_attendance WHERE char_id = 'char-hist-1';",
        )
        check("null" in after.stdout, "Backup modified historical attendance")

        file_hash = sql_backup.schema_fingerprint(ROOT / "docs" / "supabase-schema-full.sql")
        dropped = psql(container, "ALTER TABLE public.characters DROP COLUMN guild_rank CASCADE;")
        check(dropped.returncode == 0, "could not drop a column for the drift check:\n" + (dropped.stderr or dropped.stdout))
        drifted = sql_backup.assess_live_schema(
            sql_backup.parse_database_url(
                f"postgresql://postgres:{FIXTURE_PASSWORD}@127.0.0.1:{port}/postgres?sslmode=disable"
            )
        )
        check(drifted["status"] == "incompatible", "dropped column was still compatible")
        check(drifted["compared_to_repository_file"] is False, "drift assessment compared the repository file")
        check(sql_backup.schema_fingerprint(ROOT / "docs" / "supabase-schema-full.sql") == file_hash, "schema file hash changed")
        check(drifted["fingerprint"] != file_hash, "drift fingerprint reused the repository file hash")
    finally:
        run_docker(["rm", "-f", container], timeout=60)


def test_live_schema_contract() -> None:
    sql = sql_backup.source_catalog_sql()
    upper = sql.upper()
    for word in ("CREATE", "ALTER", "DROP", "INSERT", "UPDATE", "DELETE", "TRUNCATE"):
        check(word not in upper, f"probe SQL contains {word}")
    tables = {name: list(columns) for name, columns in sql_backup.REQUIRED_SOURCE_COLUMNS.items()}
    functions = list(sql_backup.SOURCE_RESTORE_FUNCTIONS)
    fresh = sql_backup.interpret_source_catalog({"tables": tables, "functions": functions})
    check(fresh["status"] == "compatible", fresh["status"])
    check(fresh["compared_to_repository_file"] is False, "catalog interpretation compared the repository file")
    file_hash = sql_backup.schema_fingerprint(ROOT / "docs" / "supabase-schema-full.sql")
    check(fresh["fingerprint"] != file_hash, "catalog fingerprint reused the repository file hash")
    tables["characters"] = [column for column in tables["characters"] if column != "guild_rank"]
    drifted = sql_backup.interpret_source_catalog({"tables": tables, "functions": functions})
    check(drifted["status"] == "incompatible", "missing column stayed compatible")
    check(sql_backup.schema_fingerprint(ROOT / "docs" / "supabase-schema-full.sql") == file_hash, "schema file hash changed")
    missing = sql_backup.live_schema_record({})
    check(missing["status"] == "not_assessed", "a missing probe was marked assessed")
    check(missing["status"] != "compatible", "a missing probe was marked compatible")
    try:
        sql_backup.live_schema_record(
            {
                "live_schema_status": "compatible",
                "live_schema_fingerprint": fresh["fingerprint"],
                "live_schema_compared_to_repository_file": True,
            }
        )
        fail("a repository-file comparison was accepted")
    except sql_backup.BackupError:
        pass
    workflow = (ROOT / ".github" / "workflows" / "db-sql-backup.yml").read_text(encoding="utf-8")
    check("github.ref == 'refs/heads/main'" in workflow, "SQL backup is not limited to main")
    check("vars.SQL_BACKUP_SCHEDULE == 'enabled'" in workflow, "schedule gate was removed")
    check("SQL_BACKUP_SCHEDULE: enabled" not in workflow, "schedule was enabled in the workflow")


def main() -> None:
    test_copy_parser()
    test_allowlist_contract()
    test_csv_coverage()
    test_publish_file_across_directories()
    test_retention_tiers()
    test_missing_credentials()
    test_failed_dump()
    test_live_schema_contract()
    test_disposable_snapshot()
    print("SQL backup export tests passed")


if __name__ == "__main__":
    try:
        main()
    except SystemExit as exc:
        if exc.code not in (0, None):
            print(exc.code, file=sys.stderr)
            sys.exit(1)
        raise
