#!/usr/bin/env python3
"""Mocked checks for cross-repository SQL backup artifact reads.

Discovery cases do not need a token or Docker. Decrypt cases need age.
Set DKP_PG_TEST=1 to fail instead of skip when age is missing.
A live GitHub read runs only when BACKUP_ARTIFACT_LIVE_TEST=1.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import zipfile
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import sql_backup
import sql_backup_fetch

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = os.environ.get("DKP_PG_TEST") == "1"
SOURCE = "Ammordius/NAGD-DKP"
OTHER = "RimidalEQ/RimidalEQ-NAGD-DKP-backup"
CURRENT = "example/dkp"
TOKEN = "github_pat_test_token_value_not_real"
STAMP = "sql-backup-20261014T150405Z"
AGE_NAME = STAMP + ".tar.gz.age"
RUN_ID = 4242
ARTIFACT_ID = 9090
NOW = datetime(2026, 10, 14, 16, 0, tzinfo=timezone.utc)
ROW_MARKER = b"ROWMARKER_SHOULD_NOT_PRINT"


def fail(message: str) -> None:
    raise SystemExit(message)


def check(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


class FakeGitHub:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []
        self.json_routes: dict[tuple[str, int], object] = {}
        self.zips: dict[str, bytes] = {}

    def add_json(self, path: str, payload: object, page: int = 1) -> None:
        self.json_routes[(path, page)] = payload

    def get_json(self, path: str) -> dict:
        self.calls.append(("json", path))
        parsed = urlsplit(path)
        page = int(parse_qs(parsed.query).get("page", ["1"])[0])
        key = (parsed.path, page)
        if key not in self.json_routes:
            fail(f"unexpected GitHub path {path}")
        result = self.json_routes[key]
        if isinstance(result, Exception):
            raise result
        if not isinstance(result, dict):
            fail(f"fake route for {path} is not a dict")
        return result

    def get_bytes(self, path: str, limit: int) -> bytes:
        self.calls.append(("bytes", path))
        parsed = urlsplit(path)
        artifact_id = parsed.path.rstrip("/").rsplit("/", 2)[-2]
        if artifact_id not in self.zips:
            fail(f"unexpected artifact download {path}")
        payload = self.zips[artifact_id]
        check(len(payload) <= limit, "fake zip exceeds the caller's limit")
        return payload


class Boom:
    def get_json(self, path: str) -> dict:
        raise AssertionError("HTTP was called for an unapproved repository")

    def get_bytes(self, path: str, limit: int) -> bytes:
        raise AssertionError("HTTP was called for an unapproved repository")


def success_run(
    run_id: int = RUN_ID,
    branch: str = "main",
    conclusion: str = "success",
    status: str = "completed",
    path: str = ".github/workflows/db-sql-backup.yml",
) -> dict:
    return {
        "id": run_id,
        "path": path,
        "status": status,
        "conclusion": conclusion,
        "head_branch": branch,
        "head_sha": "abc123deadbeef",
    }


def artifact_record(
    artifact_id: int = ARTIFACT_ID,
    name: str = STAMP,
    expired: bool = False,
    expires: str = "2026-10-21T15:04:05Z",
    run_id: int = RUN_ID,
    size: int = 128,
) -> dict:
    return {
        "id": artifact_id,
        "name": name,
        "expired": expired,
        "expires_at": expires,
        "size_in_bytes": size,
        "created_at": "2026-10-14T15:04:05Z",
        "workflow_run": {"id": run_id, "head_branch": "main", "head_sha": "abc123deadbeef"},
    }


def zip_bytes(name: str, payload: bytes) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(name, payload)
    return buffer.getvalue()


def bind_artifact(client: FakeGitHub, record: dict, run: dict, payload: bytes | None) -> None:
    repo = SOURCE
    client.add_json(f"/repos/{repo}/actions/artifacts/{record['id']}", record)
    client.add_json(f"/repos/{repo}/actions/runs/{run['id']}", run)
    if payload is not None:
        client.zips[str(record["id"])] = payload


def run_fetch(client, **kwargs) -> str:
    out = Path(tempfile.mkdtemp(prefix="sql-backup-fetch-test-"))
    try:
        return sql_backup_fetch.fetch(
            source=kwargs.get("source", SOURCE),
            current_repository=kwargs.get("current", CURRENT),
            token=kwargs.get("token", TOKEN),
            client=client,
            out_dir=out,
            run_id=kwargs.get("run_id"),
            artifact_id=kwargs.get("artifact_id"),
            identity=kwargs.get("identity"),
            schema_path=kwargs.get("schema_path"),
            now=kwargs.get("now", NOW),
            per_page=kwargs.get("per_page", 100),
        )
    finally:
        shutil.rmtree(out, ignore_errors=True)


def expect_error(substring: str, client, **kwargs) -> str:
    try:
        text = run_fetch(client, **kwargs)
    except sql_backup_fetch.FetchError as exc:
        message = str(exc)
        check(substring in message, f"expected {substring!r} in {message}")
        check(TOKEN not in message, "token leaked in error")
        return message
    fail(f"expected failure containing {substring!r}, got:\n{text}")


def test_unapproved_repository() -> None:
    sql_backup_fetch.require_source(SOURCE, CURRENT)
    sql_backup_fetch.require_source(OTHER, CURRENT)
    sql_backup_fetch.require_source(CURRENT, CURRENT)
    expect_error("not approved", Boom(), source="evil/not-a-fork")


def test_api_forbidden() -> None:
    class Deny:
        def get_json(self, path: str) -> dict:
            raise sql_backup_fetch.FetchError(sql_backup_fetch.github_status_message(403))

        def get_bytes(self, path: str, limit: int) -> bytes:
            raise AssertionError("download followed a 403")

    message = expect_error("403", Deny())
    check("Actions: Read" in message, message)


def test_no_artifact() -> None:
    client = FakeGitHub()
    client.add_json(
        f"/repos/{SOURCE}/actions/workflows/db-sql-backup.yml/runs",
        {"workflow_runs": []},
    )
    expect_error("No eligible SQL backup artifact", client)
    check(not any(kind == "bytes" for kind, _path in client.calls), "downloaded when no artifact exists")


def test_expired_artifact() -> None:
    client = FakeGitHub()
    record = artifact_record(expired=True, expires="2020-01-01T00:00:00Z")
    bind_artifact(client, record, success_run(), b"unused")
    expect_error("expired", client, artifact_id=str(ARTIFACT_ID))
    check(not any(kind == "bytes" for kind, _path in client.calls), "downloaded an expired artifact")


def test_failed_workflow_and_unapproved_branch() -> None:
    failed = FakeGitHub()
    bind_artifact(failed, artifact_record(), success_run(conclusion="failure"), None)
    expect_error("did not succeed", failed, artifact_id=str(ARTIFACT_ID))

    branched = FakeGitHub()
    bind_artifact(branched, artifact_record(), success_run(branch="feature/sql-backup-restore"), None)
    expect_error("approved branch", branched, artifact_id=str(ARTIFACT_ID))


def test_legacy_csv_and_wrong_name() -> None:
    legacy = FakeGitHub()
    bind_artifact(
        legacy,
        artifact_record(name="supabase-backup-2026-02-20"),
        success_run(path=".github/workflows/db-backup.yml"),
        None,
    )
    expect_error("legacy CSV", legacy, artifact_id=str(ARTIFACT_ID))

    named = FakeGitHub()
    bind_artifact(named, artifact_record(name="nightly-backup"), success_run(), None)
    expect_error("not an SQL backup", named, artifact_id=str(ARTIFACT_ID))


def test_tier_names_need_an_artifact_id() -> None:
    payload = zip_bytes(AGE_NAME, b"age-encryption.org/v1\n-> fake\n")
    weekly_name = "sql-backup-weekly-2026-W42"
    monthly_name = "sql-backup-monthly-2026-10"
    runs = f"/repos/{SOURCE}/actions/workflows/db-sql-backup.yml/runs"
    artifacts = f"/repos/{SOURCE}/actions/runs/{RUN_ID}/artifacts"

    latest = FakeGitHub()
    weekly = artifact_record(name=weekly_name, size=len(payload))
    latest.add_json(runs, {"workflow_runs": [success_run()]})
    latest.add_json(artifacts, {"artifacts": [weekly]})
    expect_error("No eligible SQL backup artifact", latest)
    check(not any(kind == "bytes" for kind, _path in latest.calls), "latest discovery downloaded a weekly artifact")

    explicit = FakeGitHub()
    record = artifact_record(name=weekly_name, size=len(payload))
    bind_artifact(explicit, record, success_run(), payload)
    summary = run_fetch(explicit, artifact_id=str(ARTIFACT_ID))
    check(f"artifact_name: {weekly_name}" in summary, summary)
    check("inner_verified: false" in summary, summary)
    check(any(kind == "bytes" for kind, _path in explicit.calls), "explicit weekly id was not downloaded")

    month = FakeGitHub()
    month_record = artifact_record(artifact_id=8080, name=monthly_name, size=len(payload))
    bind_artifact(month, month_record, success_run(), payload)
    month_summary = run_fetch(month, artifact_id="8080")
    check(f"artifact_name: {monthly_name}" in month_summary, month_summary)

    mixed = FakeGitHub()
    daily = artifact_record(artifact_id=1, name=STAMP, size=len(payload))
    tier = artifact_record(artifact_id=2, name=weekly_name, size=len(payload))
    mixed.add_json(runs, {"workflow_runs": [success_run()]})
    mixed.add_json(artifacts, {"artifacts": [tier, daily]})
    mixed.add_json(f"/repos/{SOURCE}/actions/runs/{RUN_ID}", success_run())
    mixed.zips["1"] = payload
    mixed_summary = run_fetch(mixed)
    check("artifact_id: 1" in mixed_summary, mixed_summary)
    check("artifact_name: " + STAMP in mixed_summary, mixed_summary)
    check("sql-backup-weekly" not in mixed_summary, mixed_summary)


def test_pagination_and_unverified_download() -> None:
    client = FakeGitHub()
    runs = f"/repos/{SOURCE}/actions/workflows/db-sql-backup.yml/runs"
    artifacts = f"/repos/{SOURCE}/actions/runs/{RUN_ID}/artifacts"
    client.add_json(runs, {"workflow_runs": [success_run(run_id=111, branch="dev")]}, page=1)
    client.add_json(runs, {"workflow_runs": [success_run()]}, page=2)
    client.add_json(runs, {"workflow_runs": []}, page=3)
    client.add_json(artifacts, {"artifacts": [artifact_record(artifact_id=1, expired=True)]}, page=1)
    good = artifact_record()
    client.add_json(artifacts, {"artifacts": [good]}, page=2)
    client.add_json(artifacts, {"artifacts": []}, page=3)
    payload = zip_bytes(AGE_NAME, b"age-encryption.org/v1\n-> fake\n")
    good["size_in_bytes"] = len(payload)
    client.zips[str(ARTIFACT_ID)] = payload

    summary = run_fetch(client, per_page=1)
    check("inner_verified: false" in summary, summary)
    check("not verified" in summary, summary)
    check("inner_verified: true" not in summary, summary)
    check(f"artifact_id: {ARTIFACT_ID}" in summary, summary)
    check(f"source_repository: {SOURCE}" in summary, summary)
    check(TOKEN not in summary, "token leaked in summary")
    check(any(kind == "bytes" for kind, _path in client.calls), "zip was not downloaded")
    check(any("page=2" in path for _kind, path in client.calls), "results were not paginated")


def test_zip_path_traversal() -> None:
    client = FakeGitHub()
    payload = zip_bytes("../" + AGE_NAME, b"age-encryption.org/v1\n")
    record = artifact_record(size=len(payload))
    bind_artifact(client, record, success_run(), payload)
    expect_error("unsafe path", client, artifact_id=str(ARTIFACT_ID))


def age_available() -> bool:
    return shutil.which("age") is not None and shutil.which("age-keygen") is not None


def age_identity(directory: Path) -> tuple[str, str]:
    key_path = directory / "key.txt"
    completed = subprocess.run(
        ["age-keygen", "-o", str(key_path)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    check(completed.returncode == 0, "age-keygen failed:\n" + (completed.stderr or ""))
    text = key_path.read_text(encoding="utf-8")
    public = ""
    for line in text.splitlines():
        if line.startswith("# public key:"):
            public = line.split(":", 1)[1].strip()
            break
    check(public.startswith("age1"), "age-keygen did not write a public key")
    return text, public


def manifest_for(data: bytes, **overrides) -> dict:
    fingerprint = sql_backup.schema_fingerprint(ROOT / "docs" / "supabase-schema-full.sql")
    counts = {name: 0 for name in sql_backup.INCLUDED_TABLES}
    counts["characters"] = 2
    manifest = {
        "format_version": sql_backup.FORMAT_VERSION,
        "source_repository": SOURCE,
        "workflow_run_id": str(RUN_ID),
        "source_commit_sha": "abc123deadbeef",
        "created_at": "2026-10-14T15:04:05Z",
        "canonical_schema_source": sql_backup.CANONICAL_SCHEMA,
        "canonical_schema_sha256": fingerprint,
        "postgresql_version": "16.11",
        "included_tables": list(sql_backup.INCLUDED_TABLES),
        "excluded_tables": [],
        "row_counts": counts,
        "checksums": {"data.sql": "sha256:" + hashlib.sha256(data).hexdigest()},
    }
    manifest.update(overrides)
    return manifest


def tar_bytes(files: dict[str, bytes], modes: dict[str, int] | None = None) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for name, payload in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(payload)
            info.mode = (modes or {}).get(name, 0o644)
            info.type = tarfile.REGTYPE
            archive.addfile(info, io.BytesIO(payload))
    return buffer.getvalue()


def archive_files(manifest: dict, data: bytes, extra: tuple[str, bytes, int] | None = None) -> dict[str, bytes]:
    manifest_bytes = (json.dumps(manifest, indent=2) + "\n").encode("utf-8")
    sums = (
        f"{hashlib.sha256(data).hexdigest()}  data.sql\n"
        f"{hashlib.sha256(manifest_bytes).hexdigest()}  manifest.json\n"
    ).encode("utf-8")
    files = {
        "data.sql": data,
        "manifest.json": manifest_bytes,
        "SHA256SUMS": sums,
        "summary.txt": b"format_version: 1\n",
    }
    if extra is not None:
        files[extra[0]] = extra[1]
    return files


def encrypt(tar_payload: bytes, public: str, directory: Path) -> bytes:
    raw = directory / "plain.tar.gz"
    destination = directory / "plain.tar.gz.age"
    raw.write_bytes(tar_payload)
    completed = subprocess.run(
        ["age", "--recipient", public, "--output", str(destination), str(raw)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    check(completed.returncode == 0, "age encrypt failed:\n" + (completed.stderr or ""))
    return destination.read_bytes()


def encrypted_zip(directory: Path, manifest: dict, data: bytes, extra: tuple[str, bytes, int] | None = None) -> tuple[str, bytes]:
    identity, public = age_identity(directory)
    files = archive_files(manifest, data, extra)
    modes = {name: 0o644 for name in files}
    if extra is not None:
        modes[extra[0]] = extra[2]
    payload = encrypt(tar_bytes(files, modes), public, directory)
    return identity, zip_bytes(AGE_NAME, payload)


def test_corrupt_checksum() -> None:
    if not age_available():
        if REQUIRED:
            fail("age is required for checksum tests")
        print("skip corrupt checksum: age is not installed")
        return
    with tempfile.TemporaryDirectory() as tmp:
        directory = Path(tmp)
        data = b"-- checksum fixture\n"
        manifest = manifest_for(data)
        manifest["checksums"]["data.sql"] = "sha256:" + ("ab" * 32)
        files = archive_files(manifest, data)
        files["SHA256SUMS"] = (
            f"{'ab' * 32}  data.sql\n"
            f"{hashlib.sha256(files['manifest.json']).hexdigest()}  manifest.json\n"
        ).encode("utf-8")
        identity, public = age_identity(directory)
        payload = encrypt(tar_bytes(files), public, directory)
        client = FakeGitHub()
        zipped = zip_bytes(AGE_NAME, payload)
        record = artifact_record(size=len(zipped))
        bind_artifact(client, record, success_run(), zipped)
        expect_error("Checksum does not match", client, artifact_id=str(ARTIFACT_ID), identity=identity)


def test_schema_mismatch() -> None:
    if not age_available():
        if REQUIRED:
            fail("age is required for schema tests")
        print("skip schema mismatch: age is not installed")
        return
    with tempfile.TemporaryDirectory() as tmp:
        data = b"-- schema fixture\n"
        manifest = manifest_for(data, canonical_schema_sha256="sha256:" + ("cd" * 32))
        identity, zipped = encrypted_zip(Path(tmp), manifest, data)
        client = FakeGitHub()
        record = artifact_record(size=len(zipped))
        bind_artifact(client, record, success_run(), zipped)
        expect_error("Schema fingerprint", client, artifact_id=str(ARTIFACT_ID), identity=identity)


def test_wrong_format_version() -> None:
    if not age_available():
        if REQUIRED:
            fail("age is required for format tests")
        print("skip format version: age is not installed")
        return
    with tempfile.TemporaryDirectory() as tmp:
        data = b"-- format fixture\n"
        manifest = manifest_for(data, format_version="99")
        identity, zipped = encrypted_zip(Path(tmp), manifest, data)
        client = FakeGitHub()
        record = artifact_record(size=len(zipped))
        bind_artifact(client, record, success_run(), zipped)
        expect_error("format_version", client, artifact_id=str(ARTIFACT_ID), identity=identity)


def test_executable_member() -> None:
    if not age_available():
        if REQUIRED:
            fail("age is required for archive tests")
        print("skip executable member: age is not installed")
        return
    with tempfile.TemporaryDirectory() as tmp:
        data = b"-- executable fixture\n"
        manifest = manifest_for(data)
        identity, zipped = encrypted_zip(Path(tmp), manifest, data, extra=("run.sh", b"#!/bin/sh\n", 0o755))
        client = FakeGitHub()
        record = artifact_record(size=len(zipped))
        bind_artifact(client, record, success_run(), zipped)
        expect_error("executable", client, artifact_id=str(ARTIFACT_ID), identity=identity)


def test_valid_approved_fork() -> None:
    if not age_available():
        if REQUIRED:
            fail("age is required for the valid artifact test")
        print("skip valid artifact: age is not installed")
        return
    with tempfile.TemporaryDirectory() as tmp:
        data = b"-- fixture\n" + ROW_MARKER + b"\n"
        manifest = manifest_for(data)
        identity, zipped = encrypted_zip(Path(tmp), manifest, data)
        client = FakeGitHub()
        record = artifact_record(size=len(zipped))
        bind_artifact(client, record, success_run(), zipped)
        summary = run_fetch(client, artifact_id=str(ARTIFACT_ID), identity=identity)
        check("inner_verified: true" in summary, summary)
        check(f"source_repository: {SOURCE}" in summary, summary)
        check(f"workflow_run_id: {RUN_ID}" in summary, summary)
        check(f"artifact_id: {ARTIFACT_ID}" in summary, summary)
        check("characters: 2" in summary, summary)
        check("format_version: 1" in summary, summary)
        check("live_schema_status: not_assessed" in summary, summary)
        check("live_schema_compared_to_repository_file: false" in summary, summary)
        check(ROW_MARKER.decode("ascii") not in summary, "SQL row text was printed")
        check(TOKEN not in summary, "token leaked in summary")
        check("AGE-SECRET-KEY-" not in summary, "age identity was printed")


def test_redirect_drops_authorization() -> None:
    token = "github_pat_redirect_test_token"
    blob_seen: dict[str, str | None] = {}
    api_seen: dict[str, str | None] = {}

    class BlobHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            blob_seen["auth"] = self.headers.get("Authorization")
            body = b"ok-bytes"
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, fmt: str, *args) -> None:
            return

    class ApiHandler(BaseHTTPRequestHandler):
        blob_port = 0

        def do_GET(self) -> None:  # noqa: N802
            api_seen["auth"] = self.headers.get("Authorization")
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:{ApiHandler.blob_port}/file")
            self.end_headers()

        def log_message(self, fmt: str, *args) -> None:
            return

    blob_server = ThreadingHTTPServer(("127.0.0.1", 0), BlobHandler)
    ApiHandler.blob_port = blob_server.server_address[1]
    api_server = ThreadingHTTPServer(("127.0.0.1", 0), ApiHandler)
    threads = [
        threading.Thread(target=blob_server.serve_forever, daemon=True),
        threading.Thread(target=api_server.serve_forever, daemon=True),
    ]
    for thread in threads:
        thread.start()
    try:
        api_port = api_server.server_address[1]
        client = sql_backup_fetch.UrllibGitHub(token, base_url=f"http://127.0.0.1:{api_port}")
        payload = client.get_bytes("/repos/example/dkp/actions/artifacts/1/zip", 1024)
        check(payload == b"ok-bytes", "redirected download returned the wrong body")
        check(api_seen.get("auth") == "Bearer " + token, "API request was not authenticated")
        check(blob_seen.get("auth") is None, "token was sent to the download host")
        try:
            client.send_authorization("http://objects.githubusercontent.com/file")
        except sql_backup_fetch.FetchError as exc:
            check("https" in str(exc), str(exc))
        else:
            fail("plain http redirect to another host was accepted")
    finally:
        api_server.shutdown()
        blob_server.shutdown()
        api_server.server_close()
        blob_server.server_close()


def test_token_secret_map() -> None:
    check(
        sql_backup_fetch.token_secret_name(OTHER, CURRENT) == "BACKUP_ARTIFACT_READ_TOKEN_STAGING",
        "staging repository did not select its secret",
    )
    check(
        sql_backup_fetch.token_secret_name(CURRENT, CURRENT) == "GITHUB_TOKEN",
        "current repository did not select GITHUB_TOKEN",
    )
    try:
        sql_backup_fetch.token_secret_name(SOURCE, CURRENT)
        fail("unmapped approved repository was given a token")
    except sql_backup_fetch.FetchError as exc:
        check("mapped" in str(exc), str(exc))
        check(TOKEN not in str(exc), "token leaked in an unmapped-source error")
    saved = {
        key: os.environ.get(key)
        for key in ("BACKUP_ARTIFACT_TOKEN_SECRET", "GH_TOKEN", "BACKUP_ARTIFACT_READ_TOKEN_STAGING")
    }
    try:
        os.environ["BACKUP_ARTIFACT_TOKEN_SECRET"] = "BACKUP_ARTIFACT_READ_TOKEN"
        os.environ["GH_TOKEN"] = TOKEN
        try:
            sql_backup_fetch.token_for_source(OTHER, CURRENT)
            fail("wrong secret name was accepted")
        except sql_backup_fetch.FetchError as exc:
            check("does not match" in str(exc), str(exc))
            check(TOKEN not in str(exc), "token leaked in a secret-name error")
        os.environ["BACKUP_ARTIFACT_TOKEN_SECRET"] = "BACKUP_ARTIFACT_READ_TOKEN_STAGING"
        check(sql_backup_fetch.token_for_source(OTHER, CURRENT) == TOKEN, "mapped source did not read GH_TOKEN")
        os.environ.pop("GH_TOKEN", None)
        os.environ.pop("BACKUP_ARTIFACT_TOKEN_SECRET", None)
        os.environ["BACKUP_ARTIFACT_READ_TOKEN_STAGING"] = TOKEN
        check(sql_backup_fetch.token_for_source(OTHER, CURRENT) == TOKEN, "mapped source did not read its named secret")
    finally:
        for key, previous in saved.items():
            if previous is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = previous
    for relative in (".github/workflows/db-sql-backup-fetch.yml", ".github/workflows/db-restore-sql.yml"):
        text = (ROOT / relative).read_text(encoding="utf-8")
        check("secrets.BACKUP_ARTIFACT_READ_TOKEN_STAGING" in text, relative)
        check("secrets.BACKUP_ARTIFACT_READ_TOKEN}" not in text, relative + " still requires the unmapped secret")


def test_official_artifact_list_request() -> None:
    """Record the artifact-list request shape. A loopback response does not authorize the real secret."""
    seen: dict[str, str | None] = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            seen["path"] = self.path.split("?", 1)[0]
            seen["query"] = self.path
            seen["accept"] = self.headers.get("Accept")
            seen["version"] = self.headers.get("X-GitHub-Api-Version")
            seen["auth"] = self.headers.get("Authorization")
            body = b'{"artifacts":[]}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, fmt: str, *args) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        port = server.server_address[1]
        client = sql_backup_fetch.UrllibGitHub(TOKEN, base_url=f"http://127.0.0.1:{port}")
        payload = client.get_json("/repos/RimidalEQ/RimidalEQ-NAGD-DKP-backup/actions/artifacts?per_page=1")
        check(
            seen.get("path") == "/repos/RimidalEQ/RimidalEQ-NAGD-DKP-backup/actions/artifacts",
            str(seen.get("path")),
        )
        check("per_page=1" in str(seen.get("query")), str(seen.get("query")))
        check(seen.get("accept") == "application/vnd.github+json", str(seen.get("accept")))
        check(seen.get("version") == "2022-11-28", str(seen.get("version")))
        check(seen.get("auth") == "Bearer " + TOKEN, "API host did not receive the bearer token")
        check(TOKEN not in json.dumps(payload), "token leaked in the artifact list")
        official = sql_backup_fetch.UrllibGitHub(TOKEN)
        check(sql_backup_fetch.API_ROOT == "https://api.github.com", "client does not use the official GitHub API")
        check(
            official.send_authorization(
                "https://api.github.com/repos/RimidalEQ/RimidalEQ-NAGD-DKP-backup/actions/artifacts?per_page=1"
            ),
            "official API host would not receive authorization",
        )
        check(
            official.send_authorization("https://objects.githubusercontent.com/file") is False,
            "authorization would be sent to the download host",
        )
    finally:
        server.shutdown()
        server.server_close()


def test_live_optional() -> None:
    if os.environ.get("BACKUP_ARTIFACT_LIVE_TEST") != "1":
        return
    repo = os.environ.get("BACKUP_ARTIFACT_LIVE_REPO", "")
    artifact_id = os.environ.get("BACKUP_ARTIFACT_LIVE_ARTIFACT_ID", "")
    current = os.environ.get("GITHUB_REPOSITORY", "local/not-the-live-source")
    check(
        bool(repo and artifact_id),
        "BACKUP_ARTIFACT_LIVE_TEST=1 requires BACKUP_ARTIFACT_LIVE_REPO and BACKUP_ARTIFACT_LIVE_ARTIFACT_ID",
    )
    check(sql_backup_fetch._DIGITS.fullmatch(artifact_id) is not None, "live artifact id must be a number")
    try:
        token = sql_backup_fetch.token_for_source(repo, current)
    except sql_backup_fetch.FetchError as exc:
        message = str(exc)
        check("github_pat_" not in message and "ghp_" not in message, "token leaked in a live setup error")
        fail(message)
    client = sql_backup_fetch.UrllibGitHub(token)
    try:
        payload = client.get_json(f"/repos/{repo}/actions/artifacts/{artifact_id}")
    except sql_backup_fetch.FetchError as exc:
        check(token not in str(exc), "token leaked in a live GitHub error")
        raise
    encoded = json.dumps(payload)
    check(token not in encoded, "token leaked in live artifact metadata")
    check(payload.get("id") == int(artifact_id), "live artifact id did not match")


def main() -> None:
    test_unapproved_repository()
    test_api_forbidden()
    test_no_artifact()
    test_expired_artifact()
    test_failed_workflow_and_unapproved_branch()
    test_legacy_csv_and_wrong_name()
    test_tier_names_need_an_artifact_id()
    test_pagination_and_unverified_download()
    test_zip_path_traversal()
    test_redirect_drops_authorization()
    test_token_secret_map()
    test_official_artifact_list_request()
    test_corrupt_checksum()
    test_schema_mismatch()
    test_wrong_format_version()
    test_executable_member()
    test_valid_approved_fork()
    test_live_optional()
    print("SQL backup fetch tests passed")


if __name__ == "__main__":
    try:
        main()
    except SystemExit as exc:
        if exc.code not in (0, None):
            print(exc.code, file=sys.stderr)
            sys.exit(1)
        raise
