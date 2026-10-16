#!/usr/bin/env python3
"""PostgreSQL 17 tests for the full-database backup.

The disposable databases are containers this file creates and removes.
It does not restore onto the supabase start database and does not connect
to a non-local host.
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import full_db_backup
import full_db_common
import full_db_inspect
import full_db_restore
from full_db_common import FullDbError

ROOT = Path(__file__).resolve().parents[1]
IMAGE = "public.ecr.aws/supabase/postgres:17.11.0.004"
FIXTURE_USER = "11111111-1111-4111-8111-111111111111"
FIXTURE_EMAIL = "user-a@example.test"
FIXTURE_HASH = "fixture-bcrypt-not-a-login"
LABEL = "full-db-restore-disposable"
JWT = "fixture-jwt-secret-at-least-32-characters"


def fail(message: str) -> None:
    raise SystemExit(full_db_common.redact(message, [JWT, FIXTURE_HASH]))


def check(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


def run(args: list[str], timeout: int = 180) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=False,
    )


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def psql(container: str, sql: str, timeout: int = 300) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["docker", "exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At"],
        input=sql,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=False,
    )


EVENT_TRIGGERS = (
    "issue_graphql_placeholder",
    "pgrst_ddl_watch",
    "pgrst_drop_watch",
    "issue_pg_cron_access",
    "issue_pg_net_access",
    "issue_pg_graphql_access",
)


def psql_admin(container: str, sql: str, timeout: int = 60) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["docker", "exec", "-i", container, "psql", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
        input=sql,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=False,
    )


def set_event_triggers(container: str, enabled: bool) -> None:
    verb = "ENABLE" if enabled else "DISABLE"
    sql = "\n".join(f"ALTER EVENT TRIGGER {name} {verb};" for name in EVENT_TRIGGERS)
    result = psql_admin(container, sql)
    check(result.returncode == 0, f"could not {verb.lower()} event triggers:\n" + (result.stderr or result.stdout))


def start_database(name: str) -> tuple[str, int]:
    port = free_port()
    run(["docker", "rm", "-f", name], timeout=60)
    started = run(
        [
            "docker",
            "run",
            "-d",
            "--name",
            name,
            "-e",
            "POSTGRES_PASSWORD=postgres",
            "-e",
            "POSTGRES_HOST=/var/run/postgresql",
            "-e",
            "POSTGRES_USER=supabase_admin",
            "-e",
            "POSTGRES_DB=postgres",
            "-e",
            "POSTGRES_INITDB_ARGS=--allow-group-access --locale-provider=icu --encoding=UTF-8 --icu-locale=en_US.UTF-8",
            "-e",
            f"JWT_SECRET={JWT}",
            "-e",
            "JWT_EXP=3600",
            "-p",
            f"127.0.0.1:{port}:5432",
            IMAGE,
        ],
        timeout=180,
    )
    if started.returncode != 0:
        fail(started.stderr or started.stdout or "could not start Postgres 17")
    deadline = time.time() + 180
    stable = 0
    while time.time() < deadline:
        probe = psql(
            name,
            "SELECT to_regclass('auth.users') IS NOT NULL AND to_regclass('vault.secrets') IS NOT NULL;",
        )
        if probe.returncode == 0 and (probe.stdout or "").strip() == "t":
            stable += 1
            if stable >= 3:
                version = psql(name, "SHOW server_version;")
                check(version.returncode == 0 and (version.stdout or "").strip().startswith("17."), version.stdout or version.stderr)
                return name, port
        else:
            stable = 0
        time.sleep(2)
    logs = run(["docker", "logs", "--tail", "40", name], timeout=30)
    fail("Postgres 17 did not become ready.\n" + (logs.stderr or logs.stdout or ""))
    return name, port


def ephemeral_recipient(directory: Path) -> tuple[Path, str]:
    key_path = directory / "full-db-age.txt"
    age_keygen = full_db_common.find_age("age-keygen")
    generated = run([age_keygen, "-o", str(key_path)], timeout=30)
    check(generated.returncode == 0, "age-keygen failed")
    public = ""
    for line in key_path.read_text(encoding="utf-8").splitlines():
        if "public key:" in line and "age1" in line:
            public = line.split("public key:", 1)[1].strip()
        elif line.startswith("age1"):
            public = line.strip()
    check(public.startswith("age1"), "ephemeral age public key was not written")
    return key_path, public


def test_tools_are_postgres_17() -> None:
    age = full_db_common.find_age("age")
    version = full_db_common.age_version(age)
    check(version.startswith("v") or "age" in version.lower() or version[:1].isdigit(), version)
    client = run(["docker", "run", "--rm", "postgres:17", "pg_dump", "--version"], timeout=120)
    check(client.returncode == 0, client.stderr or "postgres:17 pg_dump failed")
    full_db_common.require_major_17(client.stdout, "postgres:17 pg_dump")
    try:
        full_db_common.require_major_17("pg_dump (PostgreSQL) 16.11", "pg_dump")
    except FullDbError:
        return
    fail("PostgreSQL 16 was accepted")


def test_rejects_remote_host() -> None:
    try:
        full_db_common.parse_database_url("postgresql://postgres:pw@db.example.supabase.co:5432/postgres")
    except FullDbError as exc:
        check("non-local" in str(exc), str(exc))
        return
    fail("A remote host was accepted")


def test_running_supabase_inventory() -> None:
    probe = psql("supabase_db_dkp-full-db-recovery", "SHOW server_version;")
    check(probe.returncode == 0, "local supabase database is not running")
    check((probe.stdout or "").strip().startswith("17."), probe.stdout or "")
    identity, catalog = full_db_common.collect_catalog("supabase_db_dkp-full-db-recovery", [])
    check(identity["server_version_num"] // 10000 == 17, str(identity["server_version_num"]))
    names = {(entry["schema"], entry["name"], entry["object_type"]) for entry in catalog}
    for required in (
        ("auth", "users", "table"),
        ("auth", "identities", "table"),
        ("storage", "buckets", "table"),
        ("storage", "objects", "table"),
        ("storage", "buckets_vectors", "table"),
        ("storage", "vector_indexes", "table"),
        ("vault", "secrets", "table"),
        ("vault", "decrypted_secrets", "view"),
        ("supabase_functions", "hooks", "table"),
    ):
        check(required in names, f"missing discovered object {required}")
    absent = {entry["name"] for entry in catalog if entry["object_type"] == "schema" and entry["restore_mode"] == "omit"}
    for name in ("cron", "net", "pgmq"):
        check(name in absent, f"{name} was not disclosed as absent")
    decrypted = next(entry for entry in catalog if entry["schema"] == "vault" and entry["name"] == "decrypted_secrets")
    check(decrypted["restore_mode"] == "omit", "decrypted_secrets would be dumped")
    hooks = next(entry for entry in catalog if entry["schema"] == "supabase_functions" and entry["name"] == "hooks")
    check(hooks["restore_mode"] == "inert", "hooks would be restored live")


def managed_schema_sql() -> str:
    args = [
        "docker",
        "exec",
        "supabase_db_dkp-full-db-recovery",
        "pg_dump",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "--schema-only",
        "--no-owner",
        "--no-privileges",
    ]
    for schema in ("auth", "storage", "supabase_functions", "_realtime"):
        args.extend(["--schema", schema])
    dumped = run(args, timeout=120)
    check(dumped.returncode == 0, dumped.stderr or "managed schema dump failed")
    lines = []
    for line in (dumped.stdout or "").splitlines():
        if line.startswith("CREATE SCHEMA ") and "IF NOT EXISTS" not in line:
            line = "CREATE SCHEMA IF NOT EXISTS " + line[len("CREATE SCHEMA ") :]
        lines.append(line)
    return "\n".join(lines) + "\n"


def install_managed_schema(container: str, sql: str) -> None:
    set_event_triggers(container, False)
    try:
        dropped = psql_admin(
            container,
            """
            DROP SCHEMA IF EXISTS auth CASCADE;
            DROP SCHEMA IF EXISTS storage CASCADE;
            DROP SCHEMA IF EXISTS supabase_functions CASCADE;
            DROP SCHEMA IF EXISTS _realtime CASCADE;
            """,
        )
        if dropped.returncode != 0:
            fail("managed schema reset failed:\n" + (dropped.stderr or dropped.stdout or ""))
        applied = psql_admin(container, sql, timeout=180)
        if applied.returncode == 0:
            granted = psql_admin(
                container,
                """
                GRANT USAGE ON SCHEMA auth, storage, supabase_functions, _realtime TO postgres;
                GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA auth TO postgres;
                GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA auth TO postgres;
                GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA auth TO postgres;
                GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA storage TO postgres;
                GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA storage TO postgres;
                GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA supabase_functions TO postgres;
                GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA supabase_functions TO postgres;
                GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA _realtime TO postgres;
                GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA _realtime TO postgres;
                """,
            )
            if granted.returncode != 0:
                fail("postgres grants failed:\n" + (granted.stderr or granted.stdout or ""))
    finally:
        set_event_triggers(container, True)
    if applied.returncode != 0:
        detail = applied.stderr or applied.stdout or ""
        error_lines = [line for line in detail.splitlines() if line.startswith("ERROR:")]
        fail("managed schema install failed:\n" + "\n".join(error_lines[-8:] or detail.splitlines()[-20:]))


def test_disposable_restore() -> None:
    source = f"full-db-src-{os.getpid()}"
    dest = f"full-db-dst-{os.getpid()}"
    try:
        _source, source_port = start_database(source)
        managed = managed_schema_sql()
        install_managed_schema(source, managed)
        schema = (ROOT / "docs" / "supabase-schema-full.sql").read_text(encoding="utf-8")
        applied = None
        set_event_triggers(source, False)
        try:
            applied = psql_admin(source, schema, timeout=600)
            if applied.returncode == 0:
                granted = psql_admin(
                    source,
                    """
                    GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO postgres;
                    GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO postgres;
                    GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO postgres;
                    """,
                )
                if granted.returncode != 0:
                    fail("public grants failed:\n" + (granted.stderr or granted.stdout or ""))
        finally:
            set_event_triggers(source, True)
        if applied is None or applied.returncode != 0:
            detail = "" if applied is None else (applied.stderr or applied.stdout or "")
            error_lines = [line for line in detail.splitlines() if line.startswith("ERROR:")]
            fail("canonical schema failed:\n" + "\n".join(error_lines[-8:] or detail.splitlines()[-20:]))
        fixture = f"""
        INSERT INTO auth.users (id, email, encrypted_password, is_sso_user, is_anonymous, aud, role)
        VALUES ('{FIXTURE_USER}', '{FIXTURE_EMAIL}', '{FIXTURE_HASH}', false, false, 'authenticated', 'authenticated');
        UPDATE public.profiles
        SET email = '{FIXTURE_EMAIL}', role = 'officer', display_name = 'Fixture User'
        WHERE id = '{FIXTURE_USER}';
        INSERT INTO public.characters (char_id, name) VALUES ('char-fixture-1', 'Fixturetoon');
        INSERT INTO public.officer_audit_log (actor_id, actor_email, action, target_type, target_id)
        VALUES ('{FIXTURE_USER}', '{FIXTURE_EMAIL}', 'fixture', 'character', 'char-fixture-1');
        INSERT INTO supabase_functions.hooks (hook_table_id, hook_name)
        VALUES (1, 'fixture-hook-do-not-fire');
        SELECT vault.create_secret('fixture-plaintext-not-real', 'phase2-probe', 'probe');
        """
        loaded = psql(source, fixture)
        if loaded.returncode != 0:
            fail("fixture insert failed:\n" + (loaded.stderr or loaded.stdout)[-4000:])
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            identity, public = ephemeral_recipient(tmp_path)
            artifact = tmp_path / "full-db-backup.tar.gz.age"
            env = os.environ.copy()
            env[full_db_common.URL_ENV] = f"postgresql://postgres:postgres@127.0.0.1:{source_port}/postgres"
            env[full_db_common.RECIPIENT_ENV] = public
            old = os.environ.copy()
            os.environ.update(env)
            try:
                manifest = full_db_backup.build_backup(artifact)
            finally:
                os.environ.clear()
                os.environ.update(old)
            check(manifest["format_version"] == "full-db-1", manifest["format_version"])
            check(str(manifest["postgresql_version"]).startswith("17"), manifest["postgresql_version"])
            check(artifact.read_bytes().startswith(b"age-encryption.org/"), "artifact is not age ciphertext")
            report = full_db_inspect.inspect_artifact(artifact, identity)
            check(report["format_version"] == "full-db-1", "inspect did not verify the artifact")
            check("cron" in report["omitted_schemas"], "inspect did not disclose cron")
            _dest, dest_port = start_database(dest)
            install_managed_schema(dest, managed)
            marked = psql(
                dest,
                f"""
                CREATE SCHEMA full_db_meta;
                CREATE TABLE full_db_meta.disposable_marker (label text PRIMARY KEY);
                INSERT INTO full_db_meta.disposable_marker VALUES ('{LABEL}');
                """,
            )
            check(marked.returncode == 0, marked.stderr or marked.stdout)
            os.environ[full_db_common.URL_ENV] = f"postgresql://postgres:postgres@127.0.0.1:{dest_port}/postgres"
            try:
                full_db_restore.restore_backup(
                    artifact,
                    identity,
                    LABEL,
                    f"RESTORE FULL {LABEL}",
                )
            finally:
                os.environ.pop(full_db_common.URL_ENV, None)
            email = psql(dest, "SELECT email FROM auth.users;")
            check(FIXTURE_EMAIL in (email.stdout or ""), "auth user was not restored")
            password = psql(dest, f"SELECT encrypted_password = '{FIXTURE_HASH}' FROM auth.users;")
            check((password.stdout or "").strip() == "t", "password hash changed")
            profile = psql(dest, "SELECT role FROM public.profiles;")
            check((profile.stdout or "").strip() == "officer", profile.stdout or profile.stderr)
            character = psql(dest, "SELECT name FROM public.characters;")
            check("Fixturetoon" in (character.stdout or ""), character.stdout or "")
            live_hooks = psql(dest, "SELECT count(*) FROM supabase_functions.hooks;")
            check((live_hooks.stdout or "").strip() == "0", "hooks were reactivated")
            captured_hooks = psql(dest, "SELECT hook_name FROM full_db_captured.supabase_functions__hooks;")
            check("fixture-hook-do-not-fire" in (captured_hooks.stdout or ""), captured_hooks.stdout or captured_hooks.stderr)
            live_secrets = psql(dest, "SELECT count(*) FROM vault.secrets;")
            check((live_secrets.stdout or "").strip() == "0", "vault secrets were loaded into the live table")
            captured_secret = psql(dest, "SELECT name FROM full_db_captured.vault__secrets;")
            check("phase2-probe" in (captured_secret.stdout or ""), captured_secret.stdout or captured_secret.stderr)
            flag = psql(dest, "SELECT in_progress FROM public.restore_in_progress;")
            check((flag.stdout or "").strip() == "f", flag.stdout or flag.stderr)
            trigger = psql(
                dest,
                "SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname = 'on_auth_user_created' AND NOT tgisinternal;",
            )
            check("handle_new_user" in (trigger.stdout or ""), trigger.stdout or trigger.stderr)
    finally:
        run(["docker", "rm", "-f", source, dest], timeout=60)


def main() -> None:
    test_tools_are_postgres_17()
    test_rejects_remote_host()
    test_running_supabase_inventory()
    test_disposable_restore()
    print("full-db phase 2 tests: ok")


if __name__ == "__main__":
    main()
