#!/usr/bin/env python3
"""CI checks for full-database backup and restore workflows.

Uses disposable Postgres 17 for destructive cases. Does not read hosted
credentials and does not call the portable SQL backup.
"""

from __future__ import annotations

import io
import os
import shutil
import subprocess
import tempfile
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import full_db_backup
import full_db_common
import full_db_fetch
import full_db_restore

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = os.environ.get("DKP_PG_TEST") == "1"


def check(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def fails(fn, text: str) -> str:
    try:
        fn()
    except full_db_common.FullDbError as exc:
        message = str(exc)
        check(text in message, message)
        return message
    raise SystemExit(f"Expected failure containing {text}")


def workflow(name: str) -> str:
    return (ROOT / ".github" / "workflows" / name).read_text(encoding="utf-8")


def hosted_configuration(ref: str = "ynvwtvphqsevhpytcugj") -> None:
    os.environ["SQL_RESTORE_DESTINATION_NAME"] = "nagd-dkp"
    os.environ["SQL_RESTORE_DESTINATION_HOST"] = "aws-0-us-east-1.pooler.supabase.com"
    os.environ["SQL_RESTORE_DATABASE_NAME"] = "postgres"
    os.environ["SQL_RESTORE_PROJECT_REF"] = ref


def hosted_url(**changes: str) -> str:
    values = {
        "user": "postgres.ynvwtvphqsevhpytcugj",
        "password": "secret",
        "host": "aws-0-us-east-1.pooler.supabase.com",
        "port": "5432",
        "database": "postgres",
        "sslmode": "require",
    }
    values.update(changes)
    base = (
        f"postgresql://{values['user']}:{values['password']}@{values['host']}:{values['port']}"
        f"/{values['database']}"
    )
    if values["sslmode"]:
        return base + f"?sslmode={values['sslmode']}"
    return base


def test_workflow_shapes() -> None:
    backup = workflow("full_self_host_backup.yml")
    restore = workflow("full_self_host_restore.yml")
    check("schedule:" not in backup, "full backup has a schedule")
    check("FULL_DB_" not in backup, "full backup adds its own GitHub configuration")
    check("SQL_BACKUP_AGE_IDENTITY" not in backup, "backup job receives the private key")
    check("environment:" not in backup, "backup job uses an environment")
    check("workflow_dispatch:" in backup, "backup cannot be started manually")
    check("vars.SQL_RESTORE_PROJECT_REF" in backup, "backup does not read the repository project ref")
    check("secrets.SUPABASE_DB_URL" in backup, "backup does not use SUPABASE_DB_URL")
    check("secrets.SQL_BACKUP_AGE_RECIPIENT" in backup, "backup does not use the existing recipient")
    check("retention-days: 90" in backup, "backup retention is not 90 days")
    check("full-db-backup-" in backup, "backup artifact prefix is missing")
    check("sql-backup-" not in backup.split("name: full-db-backup-", 1)[-1], "backup uploads a portable artifact name")
    source = (ROOT / "scripts" / "full_db_backup.py").read_text(encoding="utf-8")
    check("SQL_BACKUP_AGE_IDENTITY" not in source, "backup command reads the private key")

    check("schedule:" not in restore, "restore has a schedule")
    check("workflow_run:" not in restore, "restore starts when a backup is uploaded")
    check("pull_request:" not in restore, "restore runs on pull request")
    check("push:" not in restore, "restore runs on push")
    check("Rimi" not in restore, "restore can read Rimi")
    check("BACKUP_FORK_READ_TOKEN" not in restore, "restore uses fork tokens")
    check("--check-protection" not in restore, "restore inspects environment protection")
    check(restore.count("environment: sql-restore") == 3, "decrypt jobs do not use sql-restore")
    listing = restore.split("\n  list:", 1)[1].split("\n  pin:", 1)[0]
    pin = restore.split("\n  pin:", 1)[1].split("\n  inspect:", 1)[0]
    inspect = restore.split("\n  inspect:", 1)[1].split("\n  verify:", 1)[0]
    verify = restore.split("\n  verify:", 1)[1].split("\n  restore:", 1)[0]
    execute = restore.split("\n  restore:", 1)[1]
    check("environment:" not in listing, "list waits for restore approval")
    check("environment:" not in pin, "pin waits for restore approval")
    check("SQL_BACKUP_AGE_IDENTITY" not in listing + pin, "list or pin receives the private key")
    check("SQL_BACKUP_AGE_IDENTITY" in inspect, "inspect cannot decrypt")
    check("SQL_BACKUP_AGE_IDENTITY" in verify, "verify cannot decrypt")
    check("inputs.checkpoint" not in inspect + verify + execute, "a later job resolves the checkpoint again")
    check("inputs.artifact_id" not in inspect + verify + execute, "a later job reads the form artifact id")
    check("needs.pin.outputs.artifact_id" in execute, "restore does not use the pinned artifact")
    check("needs.pin.outputs.artifact_sha256" in execute, "restore does not use the pinned checksum")
    check("refs/heads/main" in execute.split("steps:", 1)[0], "restore is not limited to main")
    check("HOSTED_WRITES_ENABLED" not in restore, "the workflow can turn hosted writes on")


def test_hosted_identity() -> None:
    hosted_configuration()
    conn = full_db_common.parse_hosted_database_url(hosted_url())
    full_db_common.assert_hosted_identity(conn)
    hosted_configuration("otherproject")
    fails(lambda: full_db_common.assert_hosted_identity(conn), "SQL_RESTORE_PROJECT_REF")
    hosted_configuration()
    wrong_host = full_db_common.parse_hosted_database_url(
        hosted_url(host="aws-1-eu-central-1.pooler.supabase.com")
    )
    fails(lambda: full_db_common.assert_hosted_identity(wrong_host), "SQL_RESTORE_DESTINATION_HOST")
    pooler = full_db_common.parse_hosted_database_url(hosted_url(port="6543"))
    fails(lambda: full_db_common.assert_hosted_identity(pooler), "transaction pooler")
    plain = full_db_common.parse_hosted_database_url(hosted_url(sslmode=""))
    fails(lambda: full_db_common.assert_hosted_identity(plain), "sslmode=require")
    fails(
        lambda: full_db_common.parse_hosted_database_url(
            "postgresql://postgres:secret@127.0.0.1:5432/postgres?sslmode=require"
        ),
        "local host",
    )
    fails(
        lambda: full_db_common.parse_database_url(
            "postgresql://postgres:secret@db.example.supabase.co:5432/postgres"
        ),
        "non-local",
    )
    previous = os.environ.get("GITHUB_ACTIONS")
    os.environ["GITHUB_ACTIONS"] = "true"
    try:
        fails(
            lambda: full_db_common.parse_hosted_database_url(
                "postgresql://postgres:secret@localhost:5432/postgres?sslmode=require"
            ),
            "local host",
        )
    finally:
        if previous is None:
            os.environ.pop("GITHUB_ACTIONS", None)
        else:
            os.environ["GITHUB_ACTIONS"] = previous
    os.environ["SQL_BACKUP_AGE_IDENTITY"] = "AGE-SECRET-KEY-1sentinel-not-for-backup"
    child = full_db_common.hosted_child_env(conn)
    check("AGE-SECRET-KEY-1sentinel-not-for-backup" not in " ".join(child.values()), "child env kept the private key")
    check(child.get("PGOPTIONS") == "-c default_transaction_read_only=on", "hosted backup is not read only")
    os.environ.pop("SQL_BACKUP_AGE_IDENTITY", None)


def test_missing_recipient_and_required_tables() -> None:
    saved = {key: os.environ.get(key) for key in ("SUPABASE_DB_URL", "SQL_BACKUP_AGE_RECIPIENT")}
    os.environ.pop("SUPABASE_DB_URL", None)
    os.environ.pop("SQL_BACKUP_AGE_RECIPIENT", None)
    try:
        fails(lambda: full_db_backup.build_hosted_backup(Path("missing.age")), "SUPABASE_DB_URL")
        os.environ["SUPABASE_DB_URL"] = hosted_url()
        os.environ["SQL_BACKUP_AGE_RECIPIENT"] = "AGE-SECRET-KEY-1this-must-not-appear"
        message = fails(lambda: full_db_backup.build_hosted_backup(Path("missing.age")), "age public key")
        check("this-must-not-appear" not in message, "secret key was printed")
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
    fails(
        lambda: full_db_common.assert_required_tables(
            [{"schema": "public", "name": "profiles", "object_type": "table"}]
        ),
        "auth.users",
    )
    fails(
        lambda: full_db_common.assert_catalog_entries(
            [{"schema": "public", "name": "extra", "restore_mode": "live"}]
        ),
        "Unclassified",
    )
    fails(
        lambda: full_db_common.assert_catalog_entries(
            [
                {
                    "schema": "public",
                    "name": "extra",
                    "classification": "UNSUPPORTED",
                    "restore_mode": "omit",
                }
            ]
        ),
        "exclusion reason",
    )
    sql = (ROOT / "docs" / "full-db-hosted-inventory.sql").read_text(encoding="utf-8")
    full_db_common.assert_readonly_sql(sql)


def age_pair(directory: Path) -> tuple[Path, str]:
    binary = full_db_common.find_age("age-keygen")
    completed = subprocess.run(
        [binary, "-o", str(directory / "key.txt")],
        check=False,
        capture_output=True,
        text=True,
    )
    check(completed.returncode == 0, completed.stderr)
    identity = directory / "key.txt"
    public = ""
    for line in identity.read_text(encoding="utf-8").splitlines():
        if line.startswith("# public key:"):
            public = line.split(":", 1)[1].strip()
    check(public.startswith("age1"), "age-keygen did not write a public key")
    return identity, public


def sealed_artifact(directory: Path, public: str) -> Path:
    bundle = directory / "bundle"
    bundle.mkdir()
    for name in full_db_common.ARCHIVE_MEMBERS:
        (bundle / name).write_text(name + "\n", encoding="utf-8")
    full_db_common.write_checksums(bundle)
    destination = directory / "full-db-backup-20261018T080000Z.tar.gz.age"
    full_db_common.encrypt_bundle(bundle, public, destination)
    return destination


def test_encryption_failures() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        identity, public = age_pair(root)
        artifact = sealed_artifact(root, public)
        (root / "other").mkdir()
        other, _public = age_pair(root / "other")
        fails(lambda: full_db_common.decrypt_bundle(artifact, other, root / "wrong"), "age decrypt")
        flipped = root / "flipped.tar.gz.age"
        raw = bytearray(artifact.read_bytes())
        raw[-1] ^= 0x01
        flipped.write_bytes(raw)
        fails(lambda: full_db_common.decrypt_bundle(flipped, identity, root / "bad"), "age decrypt")


def artifact_record(artifact_id: int, name: str, created: str, expires: str, expired: bool = False) -> dict:
    return {
        "id": artifact_id,
        "name": name,
        "created_at": created,
        "expires_at": expires,
        "expired": expired,
        "size_in_bytes": 128,
        "workflow_run": {"id": 7000 + artifact_id},
    }


def zip_bytes(name: str, payload: bytes) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(name, payload)
    return buffer.getvalue()


class FakeGitHub:
    def __init__(self, artifacts: list[dict], zips: dict[str, bytes]) -> None:
        self.artifacts = artifacts
        self.zips = zips
        self.requested: list[str] = []

    def get_json(self, path: str):
        base = path.split("?", 1)[0]
        if base.endswith("/actions/artifacts"):
            if "page=" in path and "page=1" not in path:
                return {"artifacts": []}
            return {"artifacts": self.artifacts}
        if "/actions/runs/" in base:
            run_id = base.rstrip("/").split("/")[-1]
            return {
                "id": int(run_id),
                "status": "completed",
                "conclusion": "success",
                "path": ".github/workflows/full_self_host_backup.yml",
            }
        if "/actions/artifacts/" in base:
            artifact_id = base.rstrip("/").split("/")[-1]
            for item in self.artifacts:
                if str(item["id"]) == artifact_id:
                    return item
            raise full_db_fetch.FetchError("missing")
        raise AssertionError(path)

    def get_bytes(self, path: str, limit: int) -> bytes:
        artifact_id = path.split("/artifacts/")[1].split("/")[0]
        self.requested.append(artifact_id)
        return self.zips[artifact_id]


def test_artifact_selection() -> None:
    now = datetime(2026, 10, 16, tzinfo=timezone.utc)
    older = artifact_record(11, "full-db-backup-20261011T080000Z", "2026-10-11T08:00:00Z", "2027-01-09T08:00:00Z")
    newer = artifact_record(22, "full-db-backup-20261018T080000Z", "2026-10-18T08:00:00Z", "2027-01-16T08:00:00Z")
    expired = artifact_record(
        33,
        "full-db-backup-20260101T080000Z",
        "2026-01-01T08:00:00Z",
        "2026-04-01T08:00:00Z",
        expired=True,
    )
    portable = artifact_record(44, "sql-backup-20261018T080000Z", "2026-10-18T09:00:00Z", "2026-10-25T09:00:00Z")
    payload = b"age-encryption.org/v1\n-> test\n"
    zips = {
        "11": zip_bytes("full-db-backup-20261011T080000Z.tar.gz.age", payload),
        "22": zip_bytes("full-db-backup-20261018T080000Z.tar.gz.age", payload + b"newer"),
        "33": zip_bytes("full-db-backup-20260101T080000Z.tar.gz.age", payload),
    }
    client = FakeGitHub([portable, newer, older, expired], zips)
    listed = full_db_fetch.list_full_db_artifacts(client, "owner/repo")
    check([item["id"] for item in listed] == [22, 11, 33], "list order changed")
    fails(lambda: full_db_fetch.reject_foreign_name("sql-backup-20261018T080000Z"), "portable SQL")
    fails(lambda: full_db_fetch.reject_foreign_name("supabase-backup-2026-10-18"), "legacy CSV")
    fails(lambda: full_db_fetch.reject_foreign_name("raid.csv"), "legacy CSV")
    latest = full_db_fetch.select_artifact(listed, "Latest available weekly backup", "", now)
    check(latest["id"] == 22, "latest was not the newest available backup")
    previous = full_db_fetch.select_artifact(listed, "Previous weekly backup", "", now)
    check(previous["id"] == 11, "previous weekly backup changed")
    pinned = full_db_fetch.select_artifact(listed, "Specific artifact ID", "11", now)
    check(pinned["id"] == 11, "specific id was replaced")
    fails(lambda: full_db_fetch.select_artifact(listed, "Specific artifact ID", "33", now), "expired")
    fails(lambda: full_db_fetch.select_artifact(listed, "Specific artifact ID", "99", now), "not found")
    os.environ["CURRENT_REPOSITORY"] = "owner/repo"
    os.environ.pop("GITHUB_REPOSITORY", None)
    os.environ["GH_TOKEN"] = "token"
    pin = full_db_fetch.pin_artifact(client, "owner/repo", "Latest available weekly backup", "", now)
    check(pin["artifact_id"] == "22", pin["artifact_id"])
    client.artifacts.insert(0, artifact_record(55, "full-db-backup-20261019T080000Z", "2026-10-19T08:00:00Z", "2027-01-17T08:00:00Z"))
    client.zips["55"] = zip_bytes("full-db-backup-20261019T080000Z.tar.gz.age", payload + b"after")
    with tempfile.TemporaryDirectory() as tmp:
        path = full_db_fetch.download_pinned(client, "owner/repo", pin["artifact_id"], pin["artifact_sha256"], Path(tmp), now)
        check(path.name.startswith("full-db-backup-20261018"), path.name)
        check(client.requested[-1] == "22", "download resolved a newer artifact")
        fails(
            lambda: full_db_fetch.download_pinned(client, "owner/repo", "22", "0" * 64, Path(tmp), now),
            "checksum",
        )


def test_disposable_postgres() -> None:
    if subprocess.run(["docker", "info"], capture_output=True, check=False).returncode != 0:
        message = "Docker is not available."
        if REQUIRED:
            raise SystemExit(message)
        print(message)
        return
    name = "full-db-actions-" + datetime.now(timezone.utc).strftime("%H%M%S%f")
    started = subprocess.run(
        [
            "docker",
            "run",
            "-d",
            "--name",
            name,
            "-e",
            "POSTGRES_HOST_AUTH_METHOD=trust",
            "-e",
            "POSTGRES_PASSWORD=unused",
            "-p",
            "127.0.0.1:0:5432",
            "postgres:17",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if started.returncode != 0:
        raise SystemExit(started.stderr or "docker run failed")
    try:
        port = ""
        for _ in range(40):
            ready = subprocess.run(
                ["docker", "exec", name, "pg_isready", "-U", "postgres", "-d", "postgres"],
                capture_output=True,
                check=False,
            )
            if ready.returncode == 0:
                mapped = subprocess.run(["docker", "port", name, "5432"], capture_output=True, text=True, check=False)
                port = mapped.stdout.strip().rsplit(":", 1)[-1]
                break
        check(bool(port), "Disposable Postgres 17 did not become ready.")
        fails(
            lambda: full_db_common.assert_catalog_prerequisites(
                name,
                [{"object_type": "extension", "name": "not_a_real_extension", "restore_mode": "omit"}],
                [],
            ),
            "not_a_real_extension",
        )
        fails(
            lambda: full_db_common.assert_catalog_prerequisites(
                name,
                [{"object_type": "role", "name": "not_a_real_role", "restore_mode": "omit"}],
                [],
            ),
            "not_a_real_role",
        )
        if shutil.which("psql") is None:
            message = "psql is not on PATH."
            if REQUIRED:
                raise SystemExit(message)
            print(message)
            return
        conn = {
            "host": "127.0.0.1",
            "port": int(port),
            "user": "postgres",
            "password": "",
            "database": "postgres",
            "sslmode": "",
        }
        secrets = [""]
        full_db_common.hosted_psql_script(
            conn,
            "CREATE TABLE sentinel (id int primary key, note text); INSERT INTO sentinel VALUES (1, 'keep');",
            secrets,
        )
        fails(
            lambda: full_db_common.hosted_psql_script(
                conn,
                "UPDATE sentinel SET note = 'changed'; SELECT 1/0;",
                secrets,
            ),
            "psql",
        )
        note = full_db_common.hosted_psql_text(conn, "SELECT note FROM sentinel;", secrets)
        check(note == "keep", f"partial restore committed: {note}")
    finally:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True, check=False)


def test_hosted_restore_stays_closed() -> None:
    hosted_configuration()
    previous = full_db_restore.HOSTED_WRITES_ENABLED
    full_db_restore.HOSTED_WRITES_ENABLED = False
    try:
        with tempfile.TemporaryDirectory() as tmp:
            artifact = Path(tmp) / "full-db-backup-20261018T080000Z.tar.gz.age"
            artifact.write_bytes(b"age-encryption.org/v1\n")
            os.environ["SUPABASE_DB_URL"] = hosted_url()
            fails(lambda: full_db_restore.hosted_restore(artifact, "RESTORE nagd-dkp"), "RESTORE FULL DATABASE")
            fails(
                lambda: full_db_restore.hosted_restore(artifact, "RESTORE FULL DATABASE nagd-dkp"),
                "not activated",
            )
            backup = Path(tmp) / "destination.tar.gz.age"
            fails(
                lambda: full_db_restore.assert_hosted_write_preconditions(artifact, None, 0),
                "destination backup",
            )
            backup.write_bytes(b"not age")
            fails(
                lambda: full_db_restore.assert_hosted_write_preconditions(artifact, backup, 0),
                "not age ciphertext",
            )
            backup.write_bytes(b"age-encryption.org/v1\n")
            fails(
                lambda: full_db_restore.assert_hosted_write_preconditions(artifact, artifact, 0),
                "must not be the artifact",
            )
            fails(
                lambda: full_db_restore.assert_hosted_write_preconditions(artifact, backup, 2),
                "authentication users",
            )
            full_db_restore.assert_hosted_write_preconditions(artifact, backup, 0)
    finally:
        full_db_restore.HOSTED_WRITES_ENABLED = previous


def main() -> None:
    test_workflow_shapes()
    test_hosted_identity()
    test_missing_recipient_and_required_tables()
    test_encryption_failures()
    test_artifact_selection()
    test_hosted_restore_stays_closed()
    test_disposable_postgres()
    print("full-db actions tests: ok")


if __name__ == "__main__":
    main()
