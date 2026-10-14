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
    finally:
        run_docker(["rm", "-f", container], timeout=60)


def main() -> None:
    test_copy_parser()
    test_allowlist_contract()
    test_missing_credentials()
    test_failed_dump()
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
