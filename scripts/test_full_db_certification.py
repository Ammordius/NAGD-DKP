#!/usr/bin/env python3
"""Destructive certification for the full-database backup.

Uses disposable PostgreSQL 17 instances only. It does not connect to a hosted
database and does not stop the long-lived local Supabase stack.
"""

from __future__ import annotations

import hashlib
import json
import os
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import full_db_common
import full_db_restore
from full_db_common import FullDbError

ROOT = Path(__file__).resolve().parents[1]
IMAGE = "public.ecr.aws/supabase/postgres:17.11.0.004"
SCHEMA_PATH = ROOT / "docs" / "supabase-schema-full.sql"
BACKUP_CLI = ROOT / "scripts" / "full_db_backup.py"
RESTORE_CLI = ROOT / "scripts" / "full_db_restore.py"
INSPECT_CLI = ROOT / "scripts" / "full_db_inspect.py"
REPORT_PATH = ROOT / "docs" / "FULL-DATABASE-RECOVERY-CERTIFICATION.md"
LONG_LIVED_DB = "supabase_db_dkp-full-db-recovery"
DATA_SCHEMAS = ("public", "auth", "storage", "certification_extra")
ROW_EXCEPTIONS = {"public.restore_in_progress"}
EVENT_TRIGGERS = (
    "issue_graphql_placeholder",
    "pgrst_ddl_watch",
    "pgrst_drop_watch",
    "issue_pg_cron_access",
    "issue_pg_net_access",
    "issue_pg_graphql_access",
)

PASSWORDS = ("Fixture-Pass-a-not-real", "Fixture-Pass-b-not-real", "low-secret-not-real")
VAULT_PLAINS = {"a": "vault-plain-cycle-a", "b": "vault-plain-cycle-b"}
STORAGE_BYTES = b"cert-object-bytes"
SECRETS: list[str] = [*PASSWORDS, *VAULT_PLAINS.values(), STORAGE_BYTES.decode("ascii")]


def redact(text: str) -> str:
    return full_db_common.redact(text or "", SECRETS)


def fail(message: str) -> None:
    raise SystemExit(redact(message))


def check(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


def remember(secret: str) -> None:
    if secret and secret not in SECRETS:
        SECRETS.append(secret)


def tool_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    env = os.environ.copy()
    age_dir = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WinGet" / "Packages"
    age_bins = sorted(age_dir.glob("FiloSottile.age*/age"))
    prefix = [r"C:\TAKP\pg17\pgsql\bin"]
    if age_bins:
        prefix.append(str(age_bins[-1]))
    env["PATH"] = os.pathsep.join([*prefix, env.get("PATH", "")])
    env.pop("FULL_DB_DATABASE_URL", None)
    env.pop("FULL_DB_BACKUP_AGE_RECIPIENT", None)
    env.pop("FULL_DB_BACKUP_AGE_IDENTITY", None)
    env.pop("SQL_BACKUP_AGE_RECIPIENT", None)
    env.pop("SQL_BACKUP_AGE_IDENTITY", None)
    if extra:
        env.update(extra)
    return env


def run_raw(args: list[str], timeout: int = 180, env: dict[str, str] | None = None, stdin: str | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        input=stdin,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        env=env,
        check=False,
    )


def assert_quiet(completed: subprocess.CompletedProcess[str]) -> None:
    text = (completed.stdout or "") + "\n" + (completed.stderr or "")
    for secret in SECRETS:
        if secret and len(secret) >= 16 and secret in text:
            fail(f"command output contained a secret of length {len(secret)}")
    if "AGE-SECRET-KEY-" in text or "postgresql://" in text:
        fail("command output contained a connection string or age secret")


def free_port() -> int:
    for _ in range(40):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = int(sock.getsockname()[1])
        if port not in full_db_common.DENIED_PORTS:
            return port
    fail("could not allocate a disposable port")
    return 0


def port_open(port: int) -> bool:
    with socket.socket() as sock:
        sock.settimeout(1)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def psql(container: str, sql: str, user: str = "postgres", timeout: int = 300) -> subprocess.CompletedProcess[str]:
    return run_raw(
        ["docker", "exec", "-i", container, "psql", "-U", user, "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At"],
        timeout=timeout,
        stdin=sql,
    )


def psql_ok(container: str, sql: str, user: str = "postgres", timeout: int = 300) -> str:
    completed = psql(container, sql, user=user, timeout=timeout)
    if completed.returncode != 0:
        detail = redact((completed.stderr or completed.stdout or "")[-4000:])
        fail(detail)
    return (completed.stdout or "").strip()


def assert_safe_name(name: str) -> None:
    if "dkp-full-db-recovery" in name:
        fail(f"refusing to delete {name}")


def remove_container(name: str, volume: str | None = None) -> None:
    assert_safe_name(name)
    run_raw(["docker", "rm", "-f", name], timeout=60)
    if volume:
        assert_safe_name(volume)
        run_raw(["docker", "volume", "rm", "-f", volume], timeout=60)


def wait_ready(name: str, supabase_image: bool) -> None:
    sql = "SELECT to_regclass('auth.users') IS NOT NULL AND to_regclass('vault.secrets') IS NOT NULL;" if supabase_image else "SELECT 1;"
    deadline = time.time() + 180
    while time.time() < deadline:
        probe = psql(name, sql)
        if probe.returncode == 0 and (probe.stdout or "").strip() in {"t", "1"}:
            return
        time.sleep(2)
    logs = run_raw(["docker", "logs", "--tail", "40", name], timeout=30)
    fail("Postgres did not become ready.\n" + redact(logs.stdout or logs.stderr or ""))


def start_postgres(name: str, image: str) -> int:
    assert_safe_name(name)
    port = free_port()
    volume = f"{name}-data"
    remove_container(name, volume)
    supabase_image = "supabase/postgres" in image
    env = [
        "-e",
        "POSTGRES_PASSWORD=postgres",
        "-e",
        "POSTGRES_DB=postgres",
    ]
    if supabase_image:
        env.extend(["-e", "POSTGRES_HOST=/var/run/postgresql", "-e", "POSTGRES_USER=supabase_admin"])
    started = run_raw(
        [
            "docker",
            "run",
            "-d",
            "--name",
            name,
            "--label",
            f"com.supabase.cli.project={name}",
            *env,
            "-v",
            f"{volume}:/var/lib/postgresql/data",
            "-p",
            f"127.0.0.1:{port}:5432",
            image,
        ],
        timeout=180,
    )
    if started.returncode != 0:
        remove_container(name, volume)
        fail(redact(started.stderr or started.stdout or "could not start postgres"))
    try:
        wait_ready(name, supabase_image)
    except SystemExit:
        remove_container(name, volume)
        raise
    return port


def database_url(port: int, user: str = "postgres", password: str = "postgres") -> str:
    if password != "postgres":
        remember(password)
    return f"postgresql://{user}:{password}@127.0.0.1:{port}/postgres"


def grant_restore_rights(container: str) -> None:
    """Give the restoring postgres role rights the platform owner already holds.

    Local postgres is not a superuser on this image. TRUNCATE still requires
    the TRUNCATE privilege, which the platform owner can grant.
    """
    completed = run_raw(
        ["docker", "exec", "-i", container, "psql", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
        stdin="""
        DO $$
        DECLARE
          schema_name text;
        BEGIN
          FOREACH schema_name IN ARRAY ARRAY[
            'auth', 'storage', 'public', 'supabase_migrations', 'supabase_functions', 'realtime', '_realtime'
          ]
          LOOP
            IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = schema_name) THEN
              EXECUTE format('GRANT USAGE ON SCHEMA %I TO postgres', schema_name);
              EXECUTE format('GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I TO postgres', schema_name);
              EXECUTE format('GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I TO postgres', schema_name);
            END IF;
          END LOOP;
        END $$;
        """,
        timeout=60,
    )
    check(completed.returncode == 0, "could not grant restore rights\n" + redact(completed.stderr or completed.stdout))


def mark(container: str, label: str) -> None:
    psql_ok(
        container,
        f"""
        CREATE SCHEMA IF NOT EXISTS full_db_meta;
        CREATE TABLE IF NOT EXISTS full_db_meta.disposable_marker (label text PRIMARY KEY);
        DELETE FROM full_db_meta.disposable_marker;
        INSERT INTO full_db_meta.disposable_marker VALUES ('{label}');
        CREATE TABLE IF NOT EXISTS full_db_meta.sentinel (note text PRIMARY KEY);
        DELETE FROM full_db_meta.sentinel;
        INSERT INTO full_db_meta.sentinel VALUES ('before-restore');
        """,
    )


def age_pair(directory: Path) -> tuple[Path, str]:
    key_path = directory / "full-db-age.txt"
    generated = run_raw([full_db_common.find_age("age-keygen"), "-o", str(key_path)], timeout=30)
    check(generated.returncode == 0, "age-keygen failed")
    public = ""
    for line in key_path.read_text(encoding="utf-8").splitlines():
        if "AGE-SECRET-KEY-" in line:
            remember(line.strip())
        if "public key:" in line and "age1" in line:
            public = line.split("public key:", 1)[1].strip()
        elif line.startswith("age1"):
            public = line.strip()
    check(public.startswith("age1"), "ephemeral age public key was not written")
    remember(public)
    return key_path, public


def seal(bundle: Path, recipient: str, destination: Path, members: list[str] | None = None) -> None:
    if members is None:
        full_db_common.write_checksums(bundle)
        full_db_common.encrypt_bundle(bundle, recipient, destination)
        return
    tar_path = bundle / "custom.tar.gz"
    with tarfile.open(tar_path, "w:gz") as archive:
        for name in members:
            archive.add(bundle / name, arcname=name)
    age = full_db_common.find_age("age")
    completed = run_raw([age, "--recipient", recipient, "--output", str(destination), str(tar_path)], timeout=60)
    check(completed.returncode == 0, redact(completed.stderr or "age encrypt failed"))


def backup_database(url: str, recipient: str, out: Path) -> tuple[subprocess.CompletedProcess[str], float]:
    started = time.perf_counter()
    completed = run_raw(
        [sys.executable, str(BACKUP_CLI), "--out", str(out)],
        timeout=900,
        env=tool_env({full_db_common.URL_ENV: url, full_db_common.RECIPIENT_ENV: recipient}),
    )
    elapsed = time.perf_counter() - started
    assert_quiet(completed)
    if completed.returncode != 0:
        fail(redact(completed.stderr or completed.stdout or "backup failed"))
    check(out.read_bytes().startswith(b"age-encryption.org/"), "artifact is not age ciphertext")
    raw = out.read_bytes()
    for secret in (*PASSWORDS, *VAULT_PLAINS.values(), STORAGE_BYTES.decode("ascii")):
        if secret.encode("ascii") in raw:
            fail("encrypted artifact contains plaintext")
    return completed, elapsed


def restore_database(url: str, artifact: Path, identity: Path, label: str, project_id: str) -> tuple[subprocess.CompletedProcess[str], float]:
    started = time.perf_counter()
    completed = run_raw(
        [
            sys.executable,
            str(RESTORE_CLI),
            "--artifact",
            str(artifact),
            "--identity",
            str(identity),
            "--disposable-label",
            label,
            "--project-id",
            project_id,
            "--confirm",
            f"RESTORE FULL {label}",
        ],
        timeout=900,
        env=tool_env({full_db_common.URL_ENV: url}),
    )
    elapsed = time.perf_counter() - started
    assert_quiet(completed)
    return completed, elapsed


def expect_restore_failure(url: str, artifact: Path, identity: Path, label: str, project_id: str, needle: str) -> str:
    completed, _elapsed = restore_database(url, artifact, identity, label, project_id)
    text = redact((completed.stdout or "") + "\n" + (completed.stderr or ""))
    check(completed.returncode != 0, "restore reported success: " + text[-1500:])
    check("restore: committed" not in (completed.stdout or ""), "failed restore printed success")
    check(needle in text, text[-2000:])
    return text


def sentinel_ok(container: str) -> None:
    check(psql_ok(container, "SELECT note FROM full_db_meta.sentinel;") == "before-restore", "sentinel changed")


def long_lived_still_running() -> None:
    inspected = run_raw(["docker", "inspect", "-f", "{{.State.Running}}", LONG_LIVED_DB], timeout=30)
    check(inspected.returncode == 0 and (inspected.stdout or "").strip() == "true", "long-lived database is not running")


def test_refuses_remote_and_long_lived() -> None:
    try:
        full_db_common.parse_database_url("postgresql://postgres:pw@db.example.supabase.co:5432/postgres")
    except FullDbError as exc:
        check("non-local" in str(exc), str(exc))
    else:
        fail("a remote host was accepted")
    try:
        full_db_common.assert_disposable_identity(
            host="127.0.0.1",
            port=54322,
            disposable_label="full-db-restore-not-the-long-lived",
            project_id="full-db-cert-not-the-long-lived",
            secrets=["postgres"],
        )
    except FullDbError as exc:
        check("54322" in str(exc), str(exc))
        check("auth.users" not in str(exc), str(exc))
    else:
        fail("the long-lived port was accepted")
    long_lived_still_running()


def prepare_failure_source(container: str) -> None:
    psql_ok(
        container,
        """
        CREATE SCHEMA certification_extra;
        CREATE TABLE certification_extra.notes (id int PRIMARY KEY, body text);
        INSERT INTO certification_extra.notes VALUES (1, 'failure-fixture');
        CREATE ROLE certification_reader NOLOGIN;
        GRANT USAGE ON SCHEMA certification_extra TO certification_reader;
        CREATE TABLE public.cert_anchor (id int PRIMARY KEY);
        INSERT INTO public.cert_anchor VALUES (1);
        """,
    )


def test_failure_matrix(directory: Path) -> list[dict[str, str]]:
    print("failure matrix: start", flush=True)
    records: list[dict[str, str]] = []
    source = f"full-db-fail-src-{os.getpid()}"
    dest = f"full-db-fail-dst-{os.getpid()}"
    old = f"full-db-fail-pg16-{os.getpid()}"
    label = "full-db-restore-failure"
    try:
        source_port = start_postgres(source, IMAGE)
        prepare_failure_source(source)
        identity, public = age_pair(directory)
        artifact = directory / "failure-backup.tar.gz.age"
        _output, _elapsed = backup_database(database_url(source_port), public, artifact)
        inspected = run_raw(
            [sys.executable, str(INSPECT_CLI), "--artifact", str(artifact), "--identity", str(identity)],
            timeout=180,
            env=tool_env(),
        )
        assert_quiet(inspected)
        check(inspected.returncode == 0, redact(inspected.stderr or inspected.stdout))
        check("full-db-1" in (inspected.stdout or ""), inspected.stdout or "")

        work = directory / "unpacked"
        work.mkdir()
        full_db_common.decrypt_bundle(artifact, identity, work)
        seal(work, public, directory / "missing-member.tar.gz.age", ["roles.sql", "schema.sql", "auth-custom.sql", "history.sql", "catalog.json", "manifest.json", "summary.txt", "SHA256SUMS"])
        try:
            full_db_common.decrypt_bundle(directory / "missing-member.tar.gz.age", identity, directory / "missing-out")
        except FullDbError as exc:
            check("missing" in str(exc).lower() or "data.sql" in str(exc), str(exc))
        else:
            fail("missing archive member was accepted")
        records.append({"name": "missing archive member", "result": "fail closed"})

        manifest = work / "manifest.json"
        manifest.write_text(manifest.read_text(encoding="utf-8") + "\n", encoding="utf-8")
        seal(work, public, directory / "bad-sum.tar.gz.age", list(full_db_common.ARCHIVE_MEMBERS) + ["SHA256SUMS"])
        try:
            full_db_common.decrypt_bundle(directory / "bad-sum.tar.gz.age", identity, directory / "bad-sum-out")
        except FullDbError as exc:
            check("Checksum mismatch" in str(exc), str(exc))
        else:
            fail("checksum mismatch was accepted")
        records.append({"name": "manifest checksum mismatch", "result": "fail closed"})

        dest_port = start_postgres(dest, IMAGE)
        mark(dest, label)
        grant_restore_rights(dest)
        dest_url = database_url(dest_port)
        (directory / "wrong").mkdir(exist_ok=True)
        wrong_key, _wrong_public = age_pair(directory / "wrong")
        expect_restore_failure(dest_url, artifact, wrong_key, label, dest, "decrypt")
        sentinel_ok(dest)
        records.append({"name": "wrong age identity", "result": "fail closed"})

        corrupted = directory / "corrupted.tar.gz.age"
        blob = bytearray(artifact.read_bytes())
        blob[-1] ^= 0x01
        corrupted.write_bytes(blob)
        expect_restore_failure(dest_url, corrupted, identity, label, dest, "decrypt")
        sentinel_ok(dest)
        records.append({"name": "corrupted encrypted artifact", "result": "fail closed"})

        expect_restore_failure(dest_url, artifact, identity, "full-db-restore-other", dest, "marker")
        sentinel_ok(dest)
        records.append({"name": "incorrect destination marker", "result": "fail closed"})

        psql_ok(dest, "CREATE ROLE full_db_low LOGIN PASSWORD 'low-secret-not-real';")
        low_url = database_url(dest_port, "full_db_low", "low-secret-not-real")
        expect_restore_failure(low_url, artifact, identity, label, dest, "session_replication_role")
        sentinel_ok(dest)
        records.append({"name": "privilege mismatch", "result": "fail closed"})

        ext_work = directory / "ext"
        ext_work.mkdir()
        full_db_common.decrypt_bundle(artifact, identity, ext_work)
        catalog = json.loads((ext_work / "catalog.json").read_text(encoding="utf-8"))
        catalog.append(
            {
                "schema": "pg_extension",
                "name": "full_db_missing_extension",
                "object_type": "extension",
                "classification": "CONDITIONALLY_RECOVERABLE",
                "exclusion_reason": "The initialized target must already provide this extension.",
                "restore_mode": "omit",
                "row_count": None,
            }
        )
        (ext_work / "catalog.json").write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8")
        seal(ext_work, public, directory / "missing-ext.tar.gz.age")
        expect_restore_failure(dest_url, directory / "missing-ext.tar.gz.age", identity, label, dest, "full_db_missing_extension")
        sentinel_ok(dest)
        records.append({"name": "missing required extension", "result": "fail closed"})

        role_work = directory / "role"
        role_work.mkdir()
        full_db_common.decrypt_bundle(artifact, identity, role_work)
        role_catalog = json.loads((role_work / "catalog.json").read_text(encoding="utf-8"))
        role_catalog.append(
            {
                "schema": "pg_roles",
                "name": "full_db_missing_role",
                "object_type": "role",
                "classification": "UNSUPPORTED",
                "exclusion_reason": "Required platform role.",
                "restore_mode": "omit",
                "row_count": None,
            }
        )
        (role_work / "catalog.json").write_text(json.dumps(role_catalog, indent=2) + "\n", encoding="utf-8")
        seal(role_work, public, directory / "missing-role.tar.gz.age")
        expect_restore_failure(dest_url, directory / "missing-role.tar.gz.age", identity, label, dest, "full_db_missing_role")
        sentinel_ok(dest)
        records.append({"name": "missing required role", "result": "fail closed"})

        gap_work = directory / "gap"
        gap_work.mkdir()
        full_db_common.decrypt_bundle(artifact, identity, gap_work)
        data_sql = (gap_work / "data.sql").read_text(encoding="utf-8")
        data_sql += 'COPY "public"."cert_missing_table" ("id") FROM stdin;\n1\n\\.\n'
        (gap_work / "data.sql").write_text(data_sql, encoding="utf-8")
        seal(gap_work, public, directory / "missing-table.tar.gz.age")
        expect_restore_failure(dest_url, directory / "missing-table.tar.gz.age", identity, label, dest, "cert_missing_table")
        sentinel_ok(dest)
        check(psql_ok(dest, "SELECT to_regclass('certification_extra.notes') IS NULL;") == "t", "failed restore left the extra schema")
        records.append({"name": "missing schema/table", "result": "rolled back"})

        mid_work = directory / "mid"
        mid_work.mkdir()
        full_db_common.decrypt_bundle(artifact, identity, mid_work)
        schema_sql = (mid_work / "schema.sql").read_text(encoding="utf-8")
        schema_sql = "DO $$ BEGIN RAISE EXCEPTION 'certification-mid-restore'; END $$;\n" + schema_sql
        (mid_work / "schema.sql").write_text(schema_sql, encoding="utf-8")
        seal(mid_work, public, directory / "mid.tar.gz.age")
        expect_restore_failure(dest_url, directory / "mid.tar.gz.age", identity, label, dest, "certification-mid-restore")
        sentinel_ok(dest)
        check(psql_ok(dest, "SELECT to_regclass('public.cert_anchor') IS NULL;") == "t", "partial restore left cert_anchor")
        records.append({"name": "restore failure halfway through", "result": "rolled back, success not reported"})

        old_port = start_postgres(old, "postgres:16")
        version = restore_database(database_url(old_port), artifact, identity, label, old)
        version_text = redact((version[0].stdout or "") + (version[0].stderr or ""))
        check(version[0].returncode != 0, "PostgreSQL 16 was accepted")
        check("not PostgreSQL 17" in version_text, version_text[-1500:])
        check("restore: committed" not in (version[0].stdout or ""), "version refusal printed success")
        check(psql_ok(old, "SELECT to_regclass('full_db_meta.disposable_marker') IS NULL;") == "t", "version check wrote a marker")
        records.append({"name": "unsupported PostgreSQL version", "result": "refused before write"})

        good, _elapsed = restore_database(dest_url, artifact, identity, label, dest)
        check(good.returncode == 0, redact(good.stderr or good.stdout))
        check("restore: committed" in (good.stdout or ""), "successful restore did not report commit")
        check(psql_ok(dest, "SELECT body FROM certification_extra.notes;") == "failure-fixture", "extra schema row missing")
        check(psql_ok(dest, "SELECT rolname FROM pg_roles WHERE rolname = 'certification_reader';") == "certification_reader", "custom role missing")
        sentinel_ok(dest)
        records.append({"name": "clean restore after failed attempts", "result": "committed"})
        long_lived_still_running()
    finally:
        remove_container(source, f"{source}-data")
        remove_container(dest, f"{dest}-data")
        remove_container(old, f"{old}-data")
    return records


def port_free(port: int) -> bool:
    if port in full_db_common.DENIED_PORTS:
        return False
    with socket.socket() as sock:
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def allocate_ports() -> dict[str, int]:
    for base in range(56110, 59000, 20):
        ports = {
            "shadow": base,
            "api": base + 1,
            "db": base + 2,
            "studio": base + 3,
            "smtp": base + 4,
            "analytics": base + 7,
            "pooler": base + 9,
            "inspector": base + 11,
        }
        if all(port_free(port) for port in ports.values()):
            return ports
    fail("could not allocate a disposable Supabase port block")
    return {}


def write_project(root: Path, project_id: str, ports: dict[str, int]) -> None:
    text = (ROOT / "supabase" / "config.toml").read_text(encoding="utf-8")
    replacements = {
        'project_id = "dkp-full-db-recovery"': f'project_id = "{project_id}"',
        "port = 54321": f"port = {ports['api']}",
        "port = 54322": f"port = {ports['db']}",
        "shadow_port = 54320": f"shadow_port = {ports['shadow']}",
        "port = 54329": f"port = {ports['pooler']}",
        "port = 54323": f"port = {ports['studio']}",
        "port = 54324": f"port = {ports['smtp']}",
        "inspector_port = 8083": f"inspector_port = {ports['inspector']}",
        "port = 54327": f"port = {ports['analytics']}",
    }
    for old, new in replacements.items():
        if old not in text:
            fail(f"config template is missing {old}")
        text = text.replace(old, new, 1)
    text = text.replace(
        "[db.seed]\n# If enabled, seeds the database after migrations during a db reset.\nenabled = true\n",
        "[db.seed]\n# If enabled, seeds the database after migrations during a db reset.\nenabled = false\n",
        1,
    )
    supabase_dir = root / "supabase"
    supabase_dir.mkdir(parents=True)
    (supabase_dir / "config.toml").write_text(text, encoding="utf-8")


def supabase(root: Path, args: list[str], timeout: int = 600) -> subprocess.CompletedProcess[str]:
    return run_raw(
        ["cmd", "/c", "npx", "--yes", "supabase@2.121.0", "--yes", "--workdir", str(root), *args],
        timeout=timeout,
        env=tool_env(),
    )


def parse_env(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in text.splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"')
    return values


def stack_env(root: Path) -> dict[str, str]:
    status = supabase(root, ["status", "-o", "env"], timeout=180)
    if status.returncode != 0:
        fail("supabase status failed\n" + redact(status.stderr or status.stdout))
    values = parse_env(status.stdout or "")
    for key in ("ANON_KEY", "SERVICE_ROLE_KEY", "DB_URL"):
        if not values.get(key):
            fail(f"supabase status did not report {key}")
        remember(values[key])
    return values


def http_json(method: str, url: str, key: str, body: dict | None = None, token: str | None = None) -> tuple[int, dict]:
    remember(key)
    if token:
        remember(token)
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "apikey": key,
            "Authorization": f"Bearer {token or key}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = response.read().decode("utf-8", "replace")
            status = response.status
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        status = exc.code
    payload = json.loads(raw) if raw else {}
    if not isinstance(payload, dict):
        payload = {"value": payload}
    access = str(payload.get("access_token") or "")
    if access:
        remember(access)
    return status, payload


def set_event_triggers(container: str, enabled: bool) -> None:
    verb = "ENABLE" if enabled else "DISABLE"
    sql = "\n".join(f"ALTER EVENT TRIGGER {name} {verb};" for name in EVENT_TRIGGERS)
    completed = run_raw(
        ["docker", "exec", "-i", container, "psql", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
        stdin=sql,
        timeout=60,
    )
    check(completed.returncode == 0, f"could not {verb.lower()} event triggers\n" + redact(completed.stderr or completed.stdout))


def apply_canonical_schema(container: str) -> None:
    set_event_triggers(container, False)
    try:
        applied = run_raw(
            ["docker", "exec", "-i", container, "psql", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "--single-transaction"],
            stdin=SCHEMA_PATH.read_text(encoding="utf-8"),
            timeout=600,
        )
        if applied.returncode != 0:
            detail = redact(applied.stderr or applied.stdout or "")
            errors = [line for line in detail.splitlines() if line.startswith("ERROR:")]
            fail("canonical schema failed\n" + "\n".join(errors[-12:] or detail.splitlines()[-20:]))
        granted = run_raw(
            ["docker", "exec", "-i", container, "psql", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
            stdin="""
            GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO postgres;
            GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO postgres;
            GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO postgres;
            """,
            timeout=60,
        )
        check(granted.returncode == 0, redact(granted.stderr or granted.stdout))
    finally:
        set_event_triggers(container, True)


def signup(api: str, key: str, email: str, password: str) -> str:
    status, payload = http_json("POST", f"{api}/auth/v1/signup", key, {"email": email, "password": password})
    user = payload.get("user") if isinstance(payload.get("user"), dict) else {}
    user_id = str(user.get("id") or "")
    check(status in {200, 201} and user_id, f"signup failed for {email} ({status})")
    return user_id


def login(api: str, key: str, email: str, password: str) -> str:
    status, payload = http_json(
        "POST",
        f"{api}/auth/v1/token?grant_type=password",
        key,
        {"email": email, "password": password},
    )
    token = str(payload.get("access_token") or "")
    check(status == 200 and token, f"login failed for {email} ({status})")
    who, user_payload = http_json("GET", f"{api}/auth/v1/user", key, token=token)
    email_back = str((user_payload.get("email") or "")).lower()
    check(who == 200 and email_back == email.lower(), f"login token was not accepted for {email} ({who})")
    return token


def fixture_sql(cycle: str, officer_id: str, officer_email: str) -> str:
    plain = VAULT_PLAINS[cycle]
    if cycle == "a":
        body = """
        INSERT INTO public.characters (char_id, name, class_name) VALUES ('char-cert', 'Certtoon', 'Warrior');
        INSERT INTO public.accounts (account_id, display_name, toon_count) VALUES ('acct-cert', 'Certtoon', 1);
        INSERT INTO public.character_account (char_id, account_id) VALUES ('char-cert', 'acct-cert');
        INSERT INTO public.raids (raid_id, raid_name, date_iso) VALUES ('raid-cert', 'Certification Raid', '2026-01-02');
        INSERT INTO public.raid_events (raid_id, event_id, event_order, event_name, dkp_value)
        VALUES ('raid-cert', '1', 1, 'Named Mob', '10');
        INSERT INTO public.raid_event_attendance (raid_id, event_id, char_id, character_name, account_id)
        VALUES ('raid-cert', '1', 'char-cert', 'Certtoon', 'acct-cert');
        INSERT INTO public.raid_loot (raid_id, event_id, item_name, char_id, character_name, cost)
        VALUES ('raid-cert', '1', 'Certification Shard', 'char-cert', 'Certtoon', '4');
        INSERT INTO public.dkp_adjustments (character_name, earned_delta, spent_delta, account_id)
        VALUES ('Certtoon', 1, 0, 'acct-cert');
        INSERT INTO public.active_raiders (character_key) VALUES ('char-cert');
        INSERT INTO certification_extra.notes (id, body, amount) VALUES (1, $note$O'Brien "café" 名前$note$, 1.25);
        SELECT public.refresh_all_raid_attendance_totals();
        SELECT public.refresh_account_dkp_for_accounts(ARRAY['acct-cert']);
        SELECT setval('public.raid_events_id_seq', 80, true);
        """
    else:
        body = """
        INSERT INTO public.characters (char_id, name, class_name) VALUES ('char-odd', $name$名前 'quoted'$name$, 'Cleric');
        INSERT INTO public.accounts (account_id, display_name, toon_count) VALUES ('acct-odd', $name$名前 'quoted'$name$, 1);
        INSERT INTO public.character_account (char_id, account_id) VALUES ('char-odd', 'acct-odd');
        INSERT INTO certification_extra.notes (id, body, amount) VALUES (1, '', NULL);
        SELECT setval('public.raid_loot_id_seq', 9, true);
        """
    return f"""
    CREATE SCHEMA certification_extra;
    CREATE TABLE certification_extra.notes (id int PRIMARY KEY, body text, amount numeric);
    CREATE ROLE certification_reader NOLOGIN;
    GRANT USAGE ON SCHEMA certification_extra TO certification_reader;
    GRANT SELECT ON certification_extra.notes TO certification_reader;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO certification_reader;
    INSERT INTO public.officer_audit_log (actor_id, actor_email, action, target_type, target_id)
    VALUES ('{officer_id}', '{officer_email}', 'certify-{cycle}', 'character', 'cycle-{cycle}');
    {body}
    INSERT INTO storage.buckets (id, name, public) VALUES ('cert-bucket', 'cert-bucket', false);
    INSERT INTO storage.objects (bucket_id, name) VALUES ('cert-bucket', 'note.txt');
    INSERT INTO supabase_functions.hooks (hook_table_id, hook_name) VALUES (1, 'cert-hook-do-not-fire');
    SELECT vault.create_secret($v${plain}$v$, 'cert-vault-{cycle}', 'probe');
    UPDATE public.restore_in_progress SET in_progress = true WHERE id = 1;
    """


def default_privilege_probe(container: str) -> str:
    psql_ok(container, "CREATE TABLE public.cert_default_priv_probe (id int);")
    grants = psql_ok(
        container,
        """
        SELECT coalesce(string_agg(grantee || ':' || privilege_type, ',' ORDER BY grantee, privilege_type), '')
        FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND table_name = 'cert_default_priv_probe';
        """,
    )
    psql_ok(container, "DROP TABLE public.cert_default_priv_probe;")
    return grants


def default_acl_owners(container: str) -> str:
    return psql_ok(
        container,
        """
        SELECT coalesce(string_agg(line, ',' ORDER BY line), '')
        FROM (
          SELECT pg_get_userbyid(d.defaclrole) || ':' || COALESCE(n.nspname, '') || ':' || d.defaclobjtype::text AS line
          FROM pg_default_acl d
          LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
        ) s;
        """,
    )


def table_hashes(container: str) -> dict[str, str]:
    listed = psql_ok(
        container,
        """
        SELECT n.nspname || '.' || c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY (ARRAY['public','auth','storage','certification_extra'])
          AND c.relkind IN ('r','p')
        ORDER BY 1;
        """,
    )
    hashes: dict[str, str] = {}
    for name in [line for line in listed.splitlines() if line]:
        schema, table = name.split(".", 1)
        digest = psql_ok(
            container,
            f"""
            SELECT md5(coalesce(string_agg(canon, ',' ORDER BY canon), ''))
            FROM (SELECT row_to_json(t)::text AS canon FROM {full_db_common.quote_ident(schema)}.{full_db_common.quote_ident(table)} t) s;
            """,
        )
        hashes[name] = digest
    return hashes


def _wraps_all(expr: str) -> bool:
    if len(expr) < 2 or expr[0] != "(" or expr[-1] != ")":
        return False
    depth = 0
    for index, char in enumerate(expr):
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                return index == len(expr) - 1
    return False


def _split_top(expr: str, operator: str) -> list[str] | None:
    depth = 0
    parts: list[str] = []
    start = 0
    found = False
    index = 0
    while index < len(expr):
        char = expr[index]
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        elif depth == 0 and expr.startswith(operator, index):
            parts.append(expr[start:index].strip())
            found = True
            index += len(operator)
            start = index
            continue
        index += 1
    if not found:
        return None
    parts.append(expr[start:].strip())
    return parts


def _flatten_bool(expr: str) -> str:
    """Flatten associative AND/OR groups so a pg_dump paren round-trip compares equal."""
    expr = expr.strip()
    while _wraps_all(expr):
        expr = expr[1:-1].strip()
    for operator in (" AND ", " OR "):
        parts = _split_top(expr, operator)
        if not parts or len(parts) < 2:
            continue
        other = " OR " if operator == " AND " else " AND "
        flat: list[str] = []
        for part in parts:
            child = _flatten_bool(part)
            same = _split_top(child, operator)
            if same and len(same) > 1:
                flat.extend(same)
            elif _split_top(child, other):
                flat.append(f"({child})")
            else:
                flat.append(child)
        return operator.join(flat)
    return expr


def _normalize_constraint_line(line: str) -> str:
    marker = " CHECK "
    if marker not in line:
        return line
    prefix, _, expr = line.partition(marker)
    return prefix + marker + _flatten_bool(expr)


def _normalize_grant_line(line: str) -> str:
    name, _, acl = line.partition(":")
    privileges = [item for item in acl.split(",") if item and not item.startswith("supabase_admin=")]
    return name + ":" + ",".join(privileges)


def normalize_definitions(kind: str, text: str) -> str:
    lines = [line for line in text.splitlines() if line]
    if kind == "constraints":
        lines = [_normalize_constraint_line(line) for line in lines]
    elif kind == "grants":
        lines = [_normalize_grant_line(line) for line in lines]
    return "\n".join(sorted(lines))


def definition_texts(container: str) -> dict[str, str]:
    scope = "n.nspname = ANY (ARRAY['public','certification_extra'])"
    queries = {
        "columns": f"""
          SELECT n.nspname || '.' || c.relname || '(' ||
            coalesce(string_agg(a.attname || ':' || pg_catalog.format_type(a.atttypid, a.atttypmod), ',' ORDER BY a.attnum), '') || ')' AS line
          FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ANY (ARRAY['public','auth','storage','certification_extra'])
            AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped
          GROUP BY n.nspname, c.relname
        """,
        "constraints": f"""
          SELECT n.nspname || '.' || c.relname || ' ' || pg_get_constraintdef(con.oid) AS line
          FROM pg_constraint con
          JOIN pg_class c ON c.oid = con.conrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE {scope}
        """,
        "indexes": f"""
          SELECT n.nspname || '.' || indexname || ' ' || indexdef AS line
          FROM pg_indexes i
          JOIN pg_namespace n ON n.nspname = i.schemaname
          WHERE {scope}
        """,
        "views": f"""
          SELECT n.nspname || '.' || c.relname || ' ' || pg_get_viewdef(c.oid, true) AS line
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE {scope} AND c.relkind IN ('v','m')
        """,
        "functions": f"""
          SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' || pg_get_functiondef(p.oid) AS line
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE {scope}
        """,
        "triggers": f"""
          SELECT n.nspname || '.' || c.relname || '.' || t.tgname || ' ' || pg_get_triggerdef(t.oid, true) AS line
          FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE NOT t.tgisinternal AND {scope}
        """,
        "policies": f"""
          SELECT n.nspname || '.' || c.relname || '.' || pol.polname || ' ' || pg_get_expr(pol.polqual, pol.polrelid) || ' ' || pg_get_expr(pol.polwithcheck, pol.polrelid) AS line
          FROM pg_policy pol
          JOIN pg_class c ON c.oid = pol.polrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE {scope}
        """,
        "grants": f"""
          SELECT n.nspname || '.' || c.relname || ':' || COALESCE((
            SELECT string_agg(split_part(acl::text, '/', 1), ',' ORDER BY split_part(acl::text, '/', 1))
            FROM unnest(c.relacl) AS acl
          ), '') AS line
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE {scope} AND c.relkind IN ('r','v','m','S','p')
        """,
    }
    return {
        name: psql_ok(container, f"SELECT coalesce(string_agg(line, E'\\n' ORDER BY line), '') FROM ({sql}) s;")
        for name, sql in queries.items()
    }


def sequences(container: str) -> list[str]:
    names = psql_ok(
        container,
        """
        SELECT n.nspname || '.' || c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'S' AND n.nspname IN ('public', 'certification_extra')
        ORDER BY 1;
        """,
    ).splitlines()
    lines = []
    for name in names:
        if "." not in name or "'" in name or '"' in name:
            continue
        schema, rel = name.split(".", 1)
        value = psql_ok(container, f'SELECT last_value::text || \'|\' || CASE WHEN is_called THEN \'t\' ELSE \'f\' END FROM "{schema}"."{rel}";')
        lines.append(f"{name}|{value}")
    return lines


def extensions(container: str) -> list[str]:
    text = psql_ok(container, "SELECT extname || '=' || extversion FROM pg_extension ORDER BY 1;")
    return [line for line in text.splitlines() if line]


def rls_result(container: str, user_id: str) -> tuple[str, str]:
    claims = json.dumps({"sub": user_id, "role": "authenticated"})
    text = psql_ok(
        container,
        f"""
        SELECT set_config('request.jwt.claim.sub', '{user_id}', false);
        SELECT set_config('request.jwt.claims', $claims${claims}$claims$, false);
        SET ROLE authenticated;
        SELECT CASE WHEN public.is_officer() THEN 't' ELSE 'f' END || '|' || count(*)::text FROM public.officer_audit_log;
        RESET ROLE;
        """,
    )
    results = [line for line in text.splitlines() if "|" in line]
    check(len(results) == 1, "role check did not return a result: " + text)
    flag, count = results[0].split("|", 1)
    return flag, count


def project_volumes(project_id: str) -> list[str]:
    listed = run_raw(
        ["docker", "volume", "ls", "--filter", f"label=com.supabase.cli.project={project_id}", "--format", "{{.Name}}"],
        timeout=30,
    )
    names = [line.strip() for line in (listed.stdout or "").splitlines() if line.strip()]
    for name in names:
        assert_safe_name(name)
        if project_id not in name:
            fail(f"volume {name} is not owned by the disposable project")
    return names


def destroy_project(root: Path, project_id: str, port: int, label: str) -> None:
    identity = full_db_common.assert_disposable_identity(
        host="127.0.0.1",
        port=port,
        disposable_label=label,
        project_id=project_id,
        secrets=["postgres"],
    )
    mounted = full_db_common.volumes_safe_to_remove(identity)
    names = sorted(set(mounted) | set(project_volumes(project_id)))
    for name in names:
        assert_safe_name(name)
        if project_id not in name:
            fail(f"refusing to remove {name}")
    stopped = supabase(root, ["stop", "--no-backup"], timeout=300)
    if stopped.returncode != 0:
        fail("supabase stop failed\n" + redact(stopped.stderr or stopped.stdout))
    for name in names:
        exists = run_raw(["docker", "volume", "inspect", name], timeout=30)
        if exists.returncode != 0:
            continue
        removed = run_raw(["docker", "volume", "rm", name], timeout=60)
        check(removed.returncode == 0, redact(removed.stderr or f"could not remove {name}"))
    check(not port_open(port), "destroyed database port is still open")
    inspect_db = run_raw(["docker", "inspect", f"supabase_db_{project_id}"], timeout=30)
    check(inspect_db.returncode != 0, "destroyed database container still exists")
    remaining = project_volumes(project_id)
    check(remaining == [], "disposable volumes remain: " + ", ".join(remaining))
    long_lived_still_running()


def cleanup_project(root: Path, project_id: str) -> None:
    supabase(root, ["stop", "--no-backup"], timeout=300)
    listed = run_raw(
        ["docker", "ps", "-a", "--filter", f"label=com.supabase.cli.project={project_id}", "--format", "{{.Names}}"],
        timeout=30,
    )
    for name in [line.strip() for line in (listed.stdout or "").splitlines() if line.strip()]:
        if project_id not in name or "dkp-full-db-recovery" in name:
            continue
        run_raw(["docker", "rm", "-f", name], timeout=60)
    listed_volumes = run_raw(
        ["docker", "volume", "ls", "--filter", f"label=com.supabase.cli.project={project_id}", "--format", "{{.Name}}"],
        timeout=30,
    )
    for name in [line.strip() for line in (listed_volumes.stdout or "").splitlines() if line.strip()]:
        if project_id not in name or "dkp-full-db-recovery" in name:
            continue
        run_raw(["docker", "volume", "rm", "-f", name], timeout=60)


def run_cycle(cycle: str) -> dict[str, object]:
    print(f"cycle {cycle}: start", flush=True)
    root = Path(tempfile.mkdtemp(prefix="full-db-cert-"))
    project_id = root.name
    label = project_id.replace("full-db-cert-", "full-db-restore-", 1)
    check(project_id.startswith("full-db-cert-"), project_id)
    check("dkp-full-db-recovery" not in str(root), str(root))
    officer_email = f"officer-{cycle}@example.test"
    player_email = f"player-{cycle}@example.test"
    password = PASSWORDS[0] if cycle == "a" else PASSWORDS[1]
    container = f"supabase_db_{project_id}"
    try:
        ports = allocate_ports()
        write_project(root, project_id, ports)
        started = supabase(root, ["start"], timeout=600)
        if started.returncode != 0:
            fail("supabase start failed\n" + redact(started.stderr or started.stdout)[-4000:])
        env = stack_env(root)
        db_url = env["DB_URL"]
        remember(db_url)
        api = env["API_URL"]
        anon = env["ANON_KEY"]
        service = env["SERVICE_ROLE_KEY"]
        port = int(db_url.rsplit(":", 1)[1].split("/")[0])
        check(port == ports["db"], f"database published {port}, expected {ports['db']}")
        mark(container, label)
        apply_canonical_schema(container)
        officer_id = signup(api, anon, officer_email, password)
        player_id = signup(api, anon, player_email, password)
        login(api, anon, officer_email, password)
        login(api, anon, player_email, password)
        psql_ok(container, f"UPDATE public.profiles SET role = 'officer', display_name = 'Cert Officer' WHERE id = '{officer_id}';")
        psql_ok(container, f"UPDATE public.profiles SET display_name = 'Cert Player' WHERE id = '{player_id}';")
        psql_ok(container, fixture_sql(cycle, officer_id, officer_email), timeout=180)
        source_decrypt = psql_ok(
            container,
            f"SELECT CASE WHEN decrypted_secret = $v${VAULT_PLAINS[cycle]}$v$ THEN 't' ELSE 'f' END FROM vault.decrypted_secrets WHERE name = 'cert-vault-{cycle}';",
        )
        check(source_decrypt == "t", "source vault secret did not decrypt")
        source_cipher = psql_ok(
            container,
            f"SELECT md5(secret::text) FROM vault.secrets WHERE name = 'cert-vault-{cycle}';",
        )
        upload_status = 0
        try:
            request = urllib.request.Request(
                f"{api}/storage/v1/object/cert-bucket/bytes.txt",
                data=STORAGE_BYTES,
                method="POST",
                headers={"apikey": service, "Authorization": f"Bearer {service}", "Content-Type": "text/plain"},
            )
            with urllib.request.urlopen(request, timeout=60) as response:
                upload_status = response.status
        except urllib.error.HTTPError as exc:
            upload_status = exc.code
        privilege_before = default_privilege_probe(container)
        owners_before = default_acl_owners(container)
        definition_text = {
            name: normalize_definitions(name, text) for name, text in definition_texts(container).items()
        }
        baseline = {
            "rows": table_hashes(container),
            "definitions": {name: hashlib.md5(text.encode("utf-8")).hexdigest() for name, text in definition_text.items()},
            "definition_text": definition_text,
            "sequences": sequences(container),
            "extensions": extensions(container),
        }
        with tempfile.TemporaryDirectory(prefix="full-db-age-") as age_dir:
            identity, public = age_pair(Path(age_dir))
            artifact = Path(age_dir) / "full-db-backup.tar.gz.age"
            _backup, backup_seconds = backup_database(db_url, public, artifact)
            inspected = run_raw(
                [sys.executable, str(INSPECT_CLI), "--artifact", str(artifact), "--identity", str(identity)],
                timeout=300,
                env=tool_env(),
            )
            assert_quiet(inspected)
            check(inspected.returncode == 0, redact(inspected.stderr or inspected.stdout))
            unpacked = Path(age_dir) / "plain"
            unpacked.mkdir()
            full_db_common.decrypt_bundle(artifact, identity, unpacked)
            data_sql = (unpacked / "data.sql").read_text(encoding="utf-8", errors="replace")
            check(VAULT_PLAINS[cycle] not in data_sql, "vault plaintext was dumped")
            check(STORAGE_BYTES.decode("ascii") not in data_sql, "storage bytes were dumped")
            check("CREATE SCHEMA" in (unpacked / "schema.sql").read_text(encoding="utf-8") or "certification_extra" in (unpacked / "schema.sql").read_text(encoding="utf-8"), "extra schema was not dumped")
            check("certification_extra" in (unpacked / "schema.sql").read_text(encoding="utf-8"), "extra schema was not dumped")
            check("certification_reader" in (unpacked / "roles.sql").read_text(encoding="utf-8"), "custom role was not dumped")
            check("ALTER DEFAULT PRIVILEGES" in (unpacked / "schema.sql").read_text(encoding="utf-8"), "postgres-owned default privileges were omitted")
            catalog = json.loads((unpacked / "catalog.json").read_text(encoding="utf-8"))
            unclassified = [entry for entry in catalog if not entry.get("classification")]
            check(unclassified == [], "catalog has unclassified objects")
            omitted_without_reason = [
                entry for entry in catalog if entry.get("restore_mode") == "omit" and not entry.get("exclusion_reason")
            ]
            check(omitted_without_reason == [], "omitted catalog entry has no reason")
            destroy_project(root, project_id, port, label)
            restarted = supabase(root, ["start"], timeout=600)
            if restarted.returncode != 0:
                fail("recreate failed\n" + redact(restarted.stderr or restarted.stdout)[-4000:])
            env = stack_env(root)
            db_url = env["DB_URL"]
            api = env["API_URL"]
            anon = env["ANON_KEY"]
            service = env["SERVICE_ROLE_KEY"]
            port = int(db_url.rsplit(":", 1)[1].split("/")[0])
            mark(container, label)
            grant_restore_rights(container)
            restored, restore_seconds = restore_database(db_url, artifact, identity, label, project_id)
            check(restored.returncode == 0, redact(restored.stderr or restored.stdout)[-4000:])
            check("restore: committed" in (restored.stdout or ""), "restore did not report commit")
            restored_rows = table_hashes(container)
            restored_definition_text = {
                name: normalize_definitions(name, text) for name, text in definition_texts(container).items()
            }
            restored_definitions = {
                name: hashlib.md5(text.encode("utf-8")).hexdigest() for name, text in restored_definition_text.items()
            }
            row_diffs = [
                name
                for name, digest in baseline["rows"].items()
                if name not in ROW_EXCEPTIONS and restored_rows.get(name) != digest
            ]
            missing_tables = sorted(set(baseline["rows"]) - set(restored_rows) - ROW_EXCEPTIONS)
            definition_diffs = [
                name for name, digest in baseline["definitions"].items() if restored_definitions.get(name) != digest
            ]
            check(row_diffs == [] and missing_tables == [], "row mismatch: " + ", ".join(row_diffs + missing_tables))
            if definition_diffs:
                details = [", ".join(definition_diffs)]
                for name in definition_diffs:
                    before = baseline["definition_text"][name].splitlines()  # type: ignore[index]
                    after = restored_definition_text.get(name, "").splitlines()
                    removed = [line[:200] for line in before if line not in after][:3]
                    added = [line[:200] for line in after if line not in before][:3]
                    details.append(name + " source-only: " + " || ".join(removed))
                    details.append(name + " restored-only: " + " || ".join(added))
                fail("definition mismatch: " + "\n".join(details))
            check(sequences(container) == baseline["sequences"], "sequence state mismatch")
            check(extensions(container) == baseline["extensions"], "extension state mismatch")
            flag = psql_ok(container, "SELECT in_progress FROM public.restore_in_progress;")
            check(flag == "f", f"restore flag was left set ({flag!r})")
            trigger = psql_ok(container, "SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname = 'on_auth_user_created' AND NOT tgisinternal;")
            check("handle_new_user" in trigger, trigger)
            check(psql_ok(container, "SELECT count(*) FROM vault.secrets;") == "0", "vault secrets were loaded live")
            check(psql_ok(container, "SELECT count(*) FROM vault.decrypted_secrets;") == "0", "vault plaintext view returned rows")
            restored_cipher = psql_ok(container, f"SELECT md5(secret::text) FROM full_db_captured.vault__secrets WHERE name = 'cert-vault-{cycle}';")
            check(restored_cipher == source_cipher and restored_cipher != "", "captured vault ciphertext does not match")
            reload = psql(container, "INSERT INTO vault.secrets (id, name, secret) SELECT id, name, secret FROM full_db_captured.vault__secrets;")
            check(reload.returncode != 0, "vault ciphertext was inserted back into vault.secrets")
            check(psql_ok(container, "SELECT count(*) FROM supabase_functions.hooks;") == "0", "hooks were restored live")
            check(
                psql_ok(container, "SELECT hook_name FROM full_db_captured.supabase_functions__hooks;") == "cert-hook-do-not-fire",
                "captured hook row missing",
            )
            for relation in ("cron.job", "net.http_request_queue", "pgmq.meta"):
                check(psql_ok(container, f"SELECT to_regclass('{relation}') IS NULL;") == "t", f"{relation} is live")
            privilege_after = default_privilege_probe(container)
            owners_after = default_acl_owners(container)
            check("certification_reader:SELECT" in privilege_before, "source probe did not receive the postgres-owned default grant")
            check(privilege_before == privilege_after, "postgres-owned default privileges were not restored")
            for line in sequences(container):
                name, last, called = line.split("|")
                if not last:
                    continue
                expected = int(last) + (1 if called == "t" else 0)
                got = int(psql_ok(container, f"SELECT nextval('{name}');"))
                check(got == expected, f"{name} next value {got} != {expected}")
            login(api, anon, officer_email, password)
            login(api, anon, player_email, password)
            officer_flag, officer_count = rls_result(container, officer_id)
            player_flag, player_count = rls_result(container, player_id)
            check(officer_flag == "t" and officer_count != "0", f"officer restriction failed {officer_flag} {officer_count}")
            check(player_flag == "f" and player_count == "0", f"player restriction failed {player_flag} {player_count}")
            fresh_id = signup(api, anon, f"fresh-{cycle}@example.test", password)
            fresh_role = psql_ok(container, f"SELECT role FROM public.profiles WHERE id = '{fresh_id}';")
            check(fresh_role == "player", fresh_role or "fresh profile missing")
            byte_status = 0
            try:
                request = urllib.request.Request(
                    f"{api}/storage/v1/object/cert-bucket/bytes.txt",
                    headers={"apikey": service, "Authorization": f"Bearer {service}"},
                )
                with urllib.request.urlopen(request, timeout=60) as response:
                    byte_status = response.status
                    body = response.read()
            except urllib.error.HTTPError as exc:
                byte_status = exc.code
                body = b""
            if upload_status in {200, 201}:
                check(byte_status != 200 or body != STORAGE_BYTES, "storage object bytes survived volume destruction")
            version = psql_ok(container, "SHOW server_version;")
            counts = {
                "auth.users": psql_ok(container, "SELECT count(*) FROM auth.users;"),
                "public.characters": psql_ok(container, "SELECT count(*) FROM public.characters;"),
                "public.officer_audit_log": psql_ok(container, "SELECT count(*) FROM public.officer_audit_log;"),
                "certification_extra.notes": psql_ok(container, "SELECT count(*) FROM certification_extra.notes;"),
                "storage.objects": psql_ok(container, "SELECT count(*) FROM storage.objects;"),
            }
            print(f"cycle {cycle}: ok", flush=True)
            return {
                "cycle": cycle,
                "version": version,
                "backup_seconds": round(backup_seconds, 1),
                "restore_seconds": round(restore_seconds, 1),
                "inspect": (inspected.stdout or "").strip(),
                "tables": len(baseline["rows"]),
                "hashes": baseline["rows"],
                "restored_hashes": restored_rows,
                "definitions": baseline["definitions"],
                "extensions": baseline["extensions"],
                "sequences": baseline["sequences"],
                "catalog_entries": len(catalog),
                "counts": counts,
                "vault_source_decrypt": source_decrypt,
                "vault_reload_rejected": reload.returncode != 0,
                "storage_upload_status": upload_status,
                "storage_get_status": byte_status,
                "privilege_grants": privilege_after,
                "acl_owners": owners_after,
                "flag": "false",
            }
    finally:
        cleanup_project(root, project_id)
        import shutil

        shutil.rmtree(root, ignore_errors=True)


def markdown_table(headers: list[str], rows: list[list[str]]) -> str:
    head = "| " + " | ".join(headers) + " |"
    rule = "| " + " | ".join("---" for _ in headers) + " |"
    body = ["| " + " | ".join(row) + " |" for row in rows]
    return "\n".join([head, rule, *body])


def write_report(failures: list[dict[str, str]], cycles: list[dict[str, object]]) -> None:
    version = str(cycles[0]["version"])
    hashes = []
    for cycle in cycles:
        for name, digest in cycle["hashes"].items():  # type: ignore[union-attr]
            restored = cycle["restored_hashes"][name]  # type: ignore[index]
            hashes.append([str(cycle["cycle"]), name, digest, str(restored)])
    failure_rows = [[item["name"], item["result"]] for item in failures]
    count_rows = []
    for cycle in cycles:
        for name, count in cycle["counts"].items():  # type: ignore[union-attr]
            count_rows.append([str(cycle["cycle"]), name, str(count), str(count)])
    lines = [
        "# Full database recovery certification",
        "",
        f"Certified at {time.strftime('%Y-%m-%d %H:%M:%S %Z')} on a disposable local Supabase CLI 2.121.0 stack.",
        f"PostgreSQL server version: `{version}`. Client `pg_dump` and `psql` are PostgreSQL 17.11 from the extracted Windows binaries used only on `PATH` for this run. The database image is `{IMAGE}`.",
        "",
        "## Verdicts",
        "",
        "- Overall: **CONDITIONAL PASS**",
        "- PostgreSQL logical recovery of classified live data and `public` definitions, including the extra user schema: **PASS**",
        "- Full Supabase project recovery: **FAIL**",
        "",
        "The artifact restores the initialized database's classified SQL: `public` definitions, live rows for `public`, `auth`, and `storage` metadata, sequence positions, and postgres-owned default privileges. It does not restore the pgsodium root key, storage object bytes, JWT signing keys, API keys, or dashboard auth-provider settings. A new `supabase start` can log the restored users in because GoTrue checks the restored password hashes, and it signs new tokens with the new project's JWT secret.",
        "",
        "## Environment",
        "",
        "- Worktree: `C:\\TAKP\\dkp-full-db-recovery`, branch `full-db-recovery-design`.",
        "- Artifact format: `full-db-1`, file name `full-db-backup-<UTC>.tar.gz.age`, encryption `age` 1.3.2.",
        "- Disposable projects used `supabase start --workdir` with a unique `project_id` beginning `full-db-cert-` and ports outside 54320-54324, 54327, and 54329.",
        "- The long-lived `supabase_db_dkp-full-db-recovery` container was still running after every destructive step. No hosted database was contacted.",
        "",
        "## Tests",
        "",
        markdown_table(["Check", "Result"], failure_rows),
        "",
        "Two destructive cycles used different fixtures. Cycle A has raids, attendance, loot, an adjustment, a cached DKP refresh, and a nontrivial `raid_events` sequence. Cycle B leaves the raid tables empty, uses a quoted Unicode character name, and advances `raid_loot`'s sequence. Both create two Auth users through GoTrue, log them in before backup, and include an extra `certification_extra.notes` table, a `certification_reader` role, one vault secret, storage metadata, and an inert hook.",
        "",
        markdown_table(["Cycle", "Backup seconds", "Restore seconds", "Tables hashed", "Catalog entries"], [
            [str(cycle["cycle"]), str(cycle["backup_seconds"]), str(cycle["restore_seconds"]), str(cycle["tables"]), str(cycle["catalog_entries"])]
            for cycle in cycles
        ]),
        "",
        "## Inventory and hashes",
        "",
        "Row hashes are `md5` of `row_to_json` text, ordered by that text. The restored hash matched the baseline for every compared table. `public.restore_in_progress` is the intentional exception: the source row was `true` and the restored row is `false`.",
        "",
        markdown_table(["Cycle", "Table", "Baseline hash", "Restored hash"], hashes),
        "",
        markdown_table(["Cycle", "Table", "Baseline count", "Restored count"], count_rows),
        "",
        "Definition text for columns, constraints, indexes, views, functions, triggers, and policies on `public` and `certification_extra` matched. CHECK expressions are compared after flattening associative `AND` and `OR` groups, because replaying `pg_dump` drops redundant parentheses. Grant comparison uses grantee and privilege bits and ignores `supabase_admin` entries: that role owned the source tables and is superuser, and `--no-owner` restores ownership to `postgres`. The restore suspends postgres-owned table default privileges before `CREATE TABLE`, then applies the dumped defaults afterward, so a source `REVOKE` such as the narrower `public.profiles` ACL is not widened by the Supabase defaults. Destination event triggers were disabled for the schema replay and enabled again after the transaction, including when that transaction rolls back. Extension name and version lists matched. Sequence `last_value` and `is_called` matched, and one `nextval` on each sequence returned the baseline's next value.",
        "",
        "## Encryption",
        "",
        "Each cycle used a new age identity in a temporary directory. The artifact starts with `age-encryption.org/`. Decrypt with the matching identity succeeds. Decrypt with a different identity, a flipped ciphertext byte, a missing `data.sql` member, and a manifest checksum mismatch all fail. The backup command output contained no age secret, database URL, fixture password, or vault plaintext. Those strings are also absent from `data.sql`.",
        "",
        "## Auth, Vault, and Storage",
        "",
        "Auth: signup and password login succeeded before backup and again after restore on the recreated stack. Officer `is_officer()` is true and the officer can read `officer_audit_log`. The player reads zero audit rows. A user created after restore gets `profiles.role = player` from `on_auth_user_created`.",
        "",
        "Vault: `vault.create_secret` decrypted on the source, so the source root key worked. After restore, `vault.secrets` and `vault.decrypted_secrets` are empty. The ciphertext in `full_db_captured.vault__secrets` matches the source ciphertext. Inserting that ciphertext back into `vault.secrets` is rejected. This is captured ciphertext, not a decrypted secret. The pgsodium root key is outside the artifact and was destroyed with the disposable volume.",
        "",
        "Storage: bucket and object metadata rows are inside the row hashes above. Object bytes are not in `data.sql`. "
        + " ".join(
            f"Cycle {cycle['cycle']} storage upload status was {cycle['storage_upload_status']} and the post-restore GET status was {cycle['storage_get_status']}."
            for cycle in cycles
        )
        + " A successful upload lives on the storage volume. That volume was destroyed with the disposable project, so the recreated project did not return those bytes.",
        "",
        "Operational hooks: `supabase_functions.hooks` is empty after restore. The hook name is in `full_db_captured`. `cron.job`, `net.http_request_queue`, and `pgmq.meta` are absent. No cron job, HTTP request, or queue message is armed.",
        "",
        "## Default privileges",
        "",
        "The source added `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO certification_reader`, owned by `postgres`. That statement is kept. A table created after restore receives `certification_reader:SELECT`.",
        "",
        "Default privileges owned by other roles, including `supabase_admin`, are still omitted. An initialized Supabase project already installs those platform defaults, and this run's new-table grants matched across that set because both projects were created by the same CLI. The backup does not restate another role's defaults, and the restore does not try to.",
        "",
        f"Source and destination default ACL owners were the same string on each cycle: `{cycles[0]['acl_owners']}`.",
        "",
        "## Restore failures",
        "",
        "The SQL load, truncate, publication changes, and foreign-key scan run in one `psql --single-transaction` with `ON_ERROR_STOP=1`. A missing table and a statement raised halfway through left the pre-restore sentinel in place and did not create the backup's extra schema. The process exited non-zero and did not print `restore: committed`. PostgreSQL 16 is refused before any restore SQL. The long-lived port, a remote host, a mismatched marker, a role that cannot set `session_replication_role`, and a catalogued missing extension or role are refused before the load.",
        "",
        "## Commands",
        "",
        "```powershell",
        "$env:PATH = \"C:\\TAKP\\pg17\\pgsql\\bin;<WinGet age directory>;$env:PATH\"",
        "npx --yes supabase@2.121.0 --version",
        "python scripts/test_full_db.py",
        "python scripts/test_sql_backup.py",
        "python scripts/test_sql_backup_fetch.py",
        "python scripts/test_sql_restore_checkpoint.py",
        "python scripts/test_sql_restore.py",
        "python scripts/test_full_db_certification.py",
        "```",
        "",
        "The certification command creates its own temporary projects. It does not read `SQL_BACKUP_AGE_*` and does not write a long-lived `FULL_DB_BACKUP_AGE_*` key.",
        "",
        "## Limitations",
        "",
        "- Vault plaintext is not recoverable from this artifact on a new project.",
        "- Storage object bytes require a separate backup. This run did not produce one.",
        "- JWT secrets, anon and service-role keys, OAuth provider settings, SMTP, and Edge Function source are project configuration, not catalog rows.",
        "- Custom login role passwords are not stored. `certification_reader` is `NOLOGIN`.",
        "- `ALTER DEFAULT PRIVILEGES` for roles other than `postgres` are not replayed.",
        "- Hosted Postgres was not inventoried and was not a restore target.",
        "",
        "Next gate: run the read-only statements in `docs/full-db-hosted-inventory.sql` against an authorized hosted database. Do not add a hosted destructive restore until that inventory is reviewed.",
        "",
    ]
    REPORT_PATH.write_text("\n".join(lines), encoding="utf-8")


def portable_scripts_unchanged() -> None:
    completed = run_raw(
        [
            "git",
            "diff",
            "--stat",
            "--",
            "scripts/sql_backup.py",
            "scripts/sql_restore.py",
            "scripts/sql_backup_fetch.py",
            "scripts/sql_restore_checkpoint.py",
            ".github/workflows/db-sql-backup.yml",
            ".github/workflows/db-restore-sql.yml",
        ],
        timeout=30,
    )
    check((completed.stdout or "").strip() == "", "portable backup files changed\n" + (completed.stdout or ""))


def main() -> None:
    portable_scripts_unchanged()
    long_lived_still_running()
    test_refuses_remote_and_long_lived()
    with tempfile.TemporaryDirectory(prefix="full-db-failure-") as tmp:
        failures = test_failure_matrix(Path(tmp))
    print("failure matrix: ok", flush=True)
    cycles = [run_cycle("a"), run_cycle("b")]
    write_report(failures, cycles)
    print(f"certification report: {REPORT_PATH}", flush=True)
    print("full-db certification: ok", flush=True)


if __name__ == "__main__":
    try:
        main()
    except SystemExit as exc:
        if exc.code not in (0, None):
            print(redact(str(exc)), file=sys.stderr)
            raise SystemExit(1) from None
        raise
    except Exception:
        print(redact(traceback.format_exc()), file=sys.stderr)
        raise SystemExit(1)

