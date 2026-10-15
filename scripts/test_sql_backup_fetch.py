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
STAGING = "RimidalEQ/RimidalEQ-NAGD-DKP-staging"
CURRENT = "example/dkp"
ROOT_NODE = "R_kgDORQRiNA"
ROOT_NUMERIC = 424242
OTHER_NODE = "R_kgDORnePRA"
OTHER_NUMERIC = 1182240580
TOKEN = "github_pat_test_token_value_not_real"
STAMP = "sql-backup-20261014T150405Z"
AGE_NAME = STAMP + ".tar.gz.age"
RUN_ID = 4242
ARTIFACT_ID = 9090
NOW = datetime(2026, 10, 14, 16, 0, tzinfo=timezone.utc)
ROW_MARKER = b"ROWMARKER_SHOULD_NOT_PRINT"


def fail(message: str) -> None:
    raise SystemExit(message)


def repository_document(full_name: str) -> dict | None:
    if full_name == SOURCE:
        return {"id": ROOT_NUMERIC, "node_id": ROOT_NODE, "full_name": SOURCE, "fork": False}
    if full_name in (OTHER, STAGING):
        canonical = STAGING if full_name == STAGING else OTHER
        return {
            "id": OTHER_NUMERIC,
            "node_id": OTHER_NODE,
            "full_name": canonical,
            "fork": True,
            "parent": {
                "id": ROOT_NUMERIC,
                "node_id": ROOT_NODE,
                "full_name": SOURCE,
                "fork": False,
            },
        }
    if full_name in (CURRENT, "evil/not-a-fork", "evil/fork"):
        return {"id": 999001, "node_id": "R_outside", "full_name": full_name, "fork": False}
    return None


def default_github_payload(path: str) -> dict | None:
    parts = [part for part in path.strip("/").split("/") if part]
    if len(parts) < 3 or parts[0] != "repos":
        return None
    full_name = parts[1] + "/" + parts[2]
    document = repository_document(full_name)
    if len(parts) == 3:
        return document
    if document is None:
        return None
    if len(parts) == 4 and parts[3] == "forks":
        return {"forks": []}
    if parts[3:] == ["actions", "workflows", "db-sql-backup.yml"]:
        if document["node_id"] in (ROOT_NODE, OTHER_NODE):
            return {"path": ".github/workflows/db-sql-backup.yml", "id": 1}
        raise sql_backup_fetch.FetchError(sql_backup_fetch.github_status_message(404))
    return None


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
            default = default_github_payload(parsed.path)
            if default is not None:
                return default
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

    def repository_name_for_node(self, node_id: str) -> str:
        if node_id == OTHER_NODE:
            return STAGING
        if node_id == ROOT_NODE:
            return SOURCE
        return ""

    def get_text(self, path: str) -> str:
        self.calls.append(("text", path))
        raise sql_backup_fetch.FetchError(sql_backup_fetch.github_status_message(404))


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


def bind_artifact(
    client: FakeGitHub,
    record: dict,
    run: dict,
    payload: bytes | None,
    repo: str = SOURCE,
) -> None:
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
    client = FakeGitHub()
    root = sql_backup_fetch.authorize_source(client, SOURCE, CURRENT)
    check(root.node_id == ROOT_NODE, root.node_id)
    fork = sql_backup_fetch.authorize_source(client, OTHER, CURRENT)
    check(fork.node_id == OTHER_NODE, fork.node_id)
    try:
        sql_backup_fetch.authorize_source(client, "evil/not-a-fork", CURRENT)
        fail("a repository outside the fork network was authorized")
    except sql_backup_fetch.FetchError as exc:
        message = str(exc)
        check("not a fork" in message, message)
        check("evil/not-a-fork" in message, message)
        check(TOKEN not in message, "token leaked in a network error")


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
        expect_error("could not be classified", client, artifact_id=str(ARTIFACT_ID), identity=identity)


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


def _http_server(handler: type[BaseHTTPRequestHandler]) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def _stop_servers(*servers: ThreadingHTTPServer) -> None:
    for server in servers:
        server.shutdown()
        server.server_close()


def test_archive_redirect_chain_strips_token() -> None:
    token = "github_pat_multihop_redirect_token"
    signed = "sig=multihop-signed-value"
    seen: dict[str, str | None] = {}

    class FinalHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            seen["final_auth"] = self.headers.get("Authorization")
            seen["final_query"] = self.path
            body = b"zip-bytes"
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, fmt: str, *args) -> None:
            return

    class MidHandler(BaseHTTPRequestHandler):
        final_port = 0

        def do_GET(self) -> None:  # noqa: N802
            seen["mid_auth"] = self.headers.get("Authorization")
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:{MidHandler.final_port}/file?{signed}")
            self.end_headers()

        def log_message(self, fmt: str, *args) -> None:
            return

    class ApiHandler(BaseHTTPRequestHandler):
        mid_port = 0

        def do_GET(self) -> None:  # noqa: N802
            seen["api_auth"] = self.headers.get("Authorization")
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:{ApiHandler.mid_port}/mid?{signed}")
            self.end_headers()

        def log_message(self, fmt: str, *args) -> None:
            return

    final_server = _http_server(FinalHandler)
    MidHandler.final_port = final_server.server_address[1]
    mid_server = _http_server(MidHandler)
    ApiHandler.mid_port = mid_server.server_address[1]
    api_server = _http_server(ApiHandler)
    try:
        client = sql_backup_fetch.UrllibGitHub(token, base_url=f"http://127.0.0.1:{api_server.server_address[1]}")
        payload = client.get_bytes("/repos/example/dkp/actions/artifacts/1/zip", 1024)
        check(payload == b"zip-bytes", "multi-hop download returned the wrong body")
        check(seen.get("api_auth") == "Bearer " + token, "API hop was not authenticated")
        check(seen.get("mid_auth") is None, "token was sent to the intermediate storage host")
        check(seen.get("final_auth") is None, "token was sent to the final storage host")
        check(signed in str(seen.get("final_query")), "final storage host did not receive the signed location")
        check(signed not in payload.decode("ascii"), "signed url was copied into the body")
    finally:
        _stop_servers(api_server, mid_server, final_server)


def test_repository_redirect_keeps_authorization() -> None:
    token = "github_pat_repository_redirect_token"
    seen: list[tuple[str, str | None]] = []

    class ApiHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            seen.append((self.path.split("?", 1)[0], self.headers.get("Authorization")))
            if self.path.startswith("/repos/"):
                self.send_response(301)
                self.send_header("Location", "/repositories/99/actions/artifacts/1")
                self.end_headers()
                return
            body = b'{"id":1}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, fmt: str, *args) -> None:
            return

    server = _http_server(ApiHandler)
    try:
        client = sql_backup_fetch.UrllibGitHub(token, base_url=f"http://127.0.0.1:{server.server_address[1]}")
        payload = client.get_json("/repos/OldOwner/old-name/actions/artifacts/1")
        check(payload == {"id": 1}, "repository redirect returned the wrong JSON")
        check(
            seen == [
                ("/repos/OldOwner/old-name/actions/artifacts/1", "Bearer " + token),
                ("/repositories/99/actions/artifacts/1", "Bearer " + token),
            ],
            str(seen),
        )
        check(token not in json.dumps(payload), "token leaked in redirected metadata")
    finally:
        _stop_servers(server)


def test_metadata_redirect_does_not_leave_api_host() -> None:
    token = "github_pat_metadata_redirect_token"
    signed = "metadata-signed-value"
    hits = {"n": 0}

    class OutsideHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            hits["n"] += 1
            self.send_response(200)
            self.end_headers()

        def log_message(self, fmt: str, *args) -> None:
            return

    class ApiHandler(BaseHTTPRequestHandler):
        outside_port = 0

        def do_GET(self) -> None:  # noqa: N802
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:{ApiHandler.outside_port}/secret?sig={signed}")
            self.end_headers()

        def log_message(self, fmt: str, *args) -> None:
            return

    outside = _http_server(OutsideHandler)
    ApiHandler.outside_port = outside.server_address[1]
    api_server = _http_server(ApiHandler)
    try:
        client = sql_backup_fetch.UrllibGitHub(token, base_url=f"http://127.0.0.1:{api_server.server_address[1]}")
        try:
            client.get_json("/repos/RimidalEQ/RimidalEQ-NAGD-DKP-backup/actions/artifacts/1")
        except sql_backup_fetch.FetchError as exc:
            message = str(exc)
            check("API host" in message, message)
            check(token not in message, "token leaked in a metadata redirect error")
            check(signed not in message, "signed url leaked in a metadata redirect error")
        else:
            fail("metadata redirect to another host was followed")
        check(hits["n"] == 0, "metadata redirect contacted another host")
    finally:
        _stop_servers(api_server, outside)


def test_redirect_loop_is_bounded() -> None:
    token = "github_pat_redirect_loop_token"
    signed = "loop-signed-value"
    hits = {"n": 0}

    class ApiHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            hits["n"] += 1
            self.send_response(302)
            self.send_header("Location", self.path if "sig=" in self.path else f"{self.path}?sig={signed}")
            self.end_headers()

        def log_message(self, fmt: str, *args) -> None:
            return

    server = _http_server(ApiHandler)
    try:
        client = sql_backup_fetch.UrllibGitHub(token, base_url=f"http://127.0.0.1:{server.server_address[1]}")
        try:
            client.get_bytes("/repos/example/dkp/actions/artifacts/1/zip", 1024)
        except sql_backup_fetch.FetchError as exc:
            message = str(exc)
            check("not followed" in message, message)
            check(token not in message, "token leaked in a redirect-loop error")
            check(signed not in message, "signed url leaked in a redirect-loop error")
        else:
            fail("redirect loop was followed without a limit")
        check(hits["n"] <= sql_backup_fetch.MAX_REDIRECTS + 1, f"redirect loop made {hits['n']} requests")
        check(hits["n"] == sql_backup_fetch.MAX_REDIRECTS + 1, f"redirect loop stopped after {hits['n']} requests")
    finally:
        _stop_servers(server)


def test_http_downgrade_is_not_requested() -> None:
    token = "github_pat_downgrade_redirect_token"
    signed = "downgrade-signed-value"
    hits = {"n": 0}

    class EvilHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            hits["n"] += 1
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"should-not-be-read")

        def log_message(self, fmt: str, *args) -> None:
            return

    class ApiHandler(BaseHTTPRequestHandler):
        evil_port = 0

        def do_GET(self) -> None:  # noqa: N802
            self.send_response(302)
            self.send_header("Location", f"http://localhost:{ApiHandler.evil_port}/file?sig={signed}")
            self.end_headers()

        def log_message(self, fmt: str, *args) -> None:
            return

    evil = _http_server(EvilHandler)
    ApiHandler.evil_port = evil.server_address[1]
    api_server = _http_server(ApiHandler)
    try:
        client = sql_backup_fetch.UrllibGitHub(token, base_url=f"http://127.0.0.1:{api_server.server_address[1]}")
        try:
            client.get_bytes("/repos/example/dkp/actions/artifacts/1/zip", 1024)
        except sql_backup_fetch.FetchError as exc:
            message = str(exc)
            check("https" in message, message)
            check(token not in message, "token leaked in a downgrade error")
            check(signed not in message, "signed url leaked in a downgrade error")
        else:
            fail("http downgrade redirect was followed")
        check(hits["n"] == 0, "http downgrade contacted the storage host")
        official = sql_backup_fetch.UrllibGitHub(token)
        try:
            official.send_authorization("http://objects.githubusercontent.com/file?sig=" + signed)
        except sql_backup_fetch.FetchError as exc:
            message = str(exc)
            check("https" in message, message)
            check(signed not in message, "signed url leaked from an https client downgrade")
        else:
            fail("https client accepted an http storage redirect")
    finally:
        _stop_servers(api_server, evil)


def _token_env_names() -> tuple[str, ...]:
    return ("GH_TOKEN", "GITHUB_TOKEN", *sql_backup_fetch.FORK_READ_TOKEN_ENVS)


def test_token_secret_map() -> None:
    saved = {key: os.environ.get(key) for key in _token_env_names()}
    try:
        for key in _token_env_names():
            os.environ.pop(key, None)
        check(sql_backup_fetch.configured_token_slots() == [], "an empty environment still had a token slot")
        os.environ["GH_TOKEN"] = TOKEN
        os.environ["BACKUP_FORK_READ_TOKEN"] = "github_pat_other_slot_value_not_real"
        names = [name for name, _value in sql_backup_fetch.configured_token_slots()]
        check(names == ["GITHUB_TOKEN", "BACKUP_FORK_READ_TOKEN"], str(names))
        check(TOKEN not in " ".join(names), "token value leaked into a secret name")
    finally:
        for key, previous in saved.items():
            if previous is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = previous
    for relative in (".github/workflows/db-restore-sql.yml",):
        text = (ROOT / relative).read_text(encoding="utf-8")
        check("secrets.BACKUP_ARTIFACT_READ_TOKEN_STAGING" in text, relative)
        check("RimidalEQ/" not in text, relative + " still names a fork")
        check("BACKUP_FORK_READ_TOKEN_4" in text, relative)


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


def test_repository_identity_provenance() -> None:
    client = FakeGitHub()
    origin = sql_backup_fetch.authorize_source(client, OTHER, CURRENT)
    renamed = {"source_repository": STAGING, "workflow_run_id": str(RUN_ID)}
    sql_backup_fetch.assert_manifest_origin(
        renamed,
        origin=origin,
        selected_name=OTHER,
        client=client,
        run_id=str(RUN_ID),
    )
    same = {"source_repository": OTHER, "source_repository_id": str(OTHER_NUMERIC)}
    sql_backup_fetch.assert_manifest_origin(
        same,
        origin=origin,
        selected_name=OTHER,
        client=client,
        run_id=str(RUN_ID),
    )
    copied = {"source_repository": SOURCE}
    try:
        sql_backup_fetch.assert_manifest_origin(
            copied,
            origin=origin,
            selected_name=OTHER,
            client=client,
            run_id=str(RUN_ID),
        )
        fail("a copied archive was accepted")
    except sql_backup_fetch.FetchError as exc:
        message = str(exc)
        check("Generate a new backup" in message, message)
        check(f"selected_repository: {OTHER}" in message, message)
        check(f"manifest_source_repository: {SOURCE}" in message, message)
        check(ROOT_NODE in message and OTHER_NODE in message, message)
        check("was not rewritten" in message, message)
        check(ROW_MARKER.decode("ascii") not in message, "SQL row text was printed")
        check("http" not in message.lower(), message)
    mismatched_id = {"source_repository": OTHER, "source_repository_id": "1"}
    try:
        sql_backup_fetch.assert_manifest_origin(
            mismatched_id,
            origin=origin,
            selected_name=OTHER,
            client=client,
            run_id=str(RUN_ID),
        )
        fail("a conflicting repository id was accepted")
    except sql_backup_fetch.FetchError as exc:
        check("Generate a new backup" in str(exc), str(exc))
        check("embedded_repository_id: 1" in str(exc), str(exc))


def test_fork_discovery_reports_unreadable_sources() -> None:
    client = FakeGitHub()
    nested_name = "ExampleNest/NAGD-DKP"
    nested = {
        "id": 626262,
        "node_id": "R_nestedfork",
        "full_name": nested_name,
        "fork": True,
        "parent": {
            "id": OTHER_NUMERIC,
            "node_id": OTHER_NODE,
            "full_name": OTHER,
            "fork": True,
        },
    }
    client.add_json(f"/repos/{SOURCE}/forks", {"forks": [repository_document(OTHER)]})
    client.add_json(f"/repos/{OTHER}/forks", {"forks": [nested]})
    client.add_json(f"/repos/{nested_name}", nested)
    client.add_json(f"/repos/{nested_name}/forks", {"forks": []})
    client.add_json(
        f"/repos/{nested_name}/actions/workflows/db-sql-backup.yml",
        {"path": ".github/workflows/db-sql-backup.yml", "id": 9},
    )
    client.add_json(f"/repos/{SOURCE}/actions/artifacts", {"artifacts": []})
    client.add_json(f"/repos/{OTHER}/actions/artifacts", {"artifacts": []})
    client.add_json(
        f"/repos/{nested_name}/actions/artifacts",
        sql_backup_fetch.FetchError(sql_backup_fetch.github_status_message(403)),
    )
    client.add_json(f"/repos/{SOURCE}/actions/workflows/db-sql-backup.yml/runs", {"workflow_runs": []})
    client.add_json(f"/repos/{OTHER}/actions/workflows/db-sql-backup.yml/runs", {"workflow_runs": []})
    summary = sql_backup_fetch.discover_sources([("GITHUB_TOKEN", client)])
    check(f"repository: {SOURCE}" in summary, summary)
    check(f"repository: {OTHER}" in summary, summary)
    check(f"repository: {nested_name}" in summary, summary)
    check("eligible: yes" in summary, summary)
    check("eligible: no" in summary, summary)
    check("403" in summary, summary)
    check("No configured token can read Actions artifacts" in summary, summary)
    check("Private forks" in summary, summary)
    check(TOKEN not in summary, "token leaked in discovery")
    try:
        sql_backup_fetch.authorize_source(client, CURRENT, SOURCE)
        fail("an arbitrary repository was treated as a fork")
    except sql_backup_fetch.FetchError as exc:
        check("not a fork" in str(exc), str(exc))


def test_renamed_repository_backup_verifies() -> None:
    if not age_available():
        if REQUIRED:
            fail("age is required for the rename provenance test")
        print("skip rename provenance: age is not installed")
        return
    with tempfile.TemporaryDirectory() as tmp:
        data = b"-- fixture\n" + ROW_MARKER + b"\n"
        manifest = manifest_for(data, source_repository=STAGING)
        identity, zipped = encrypted_zip(Path(tmp), manifest, data)
        client = FakeGitHub()
        renamed = repository_document(STAGING)
        client.add_json(f"/repos/{OTHER}", renamed)
        record = artifact_record(size=len(zipped))
        bind_artifact(client, record, success_run(), zipped, repo=STAGING)
        summary = run_fetch(client, source=OTHER, artifact_id=str(ARTIFACT_ID), identity=identity)
        check("inner_verified: true" in summary, summary)
        check(f"canonical_repository: {STAGING}" in summary, summary)
        check(f"selected_repository: {OTHER}" in summary, summary)
        check(f"manifest_source_repository: {STAGING}" in summary, summary)
        check(ROW_MARKER.decode("ascii") not in summary, "SQL row text was printed")


def test_source_aliases_are_not_authentication_errors() -> None:
    saved = os.environ.get("GH_TOKEN")
    os.environ["GH_TOKEN"] = TOKEN
    try:
        try:
            sql_backup_fetch.open_source("not a repo", SOURCE)
            fail("invalid source syntax was accepted")
        except sql_backup_fetch.FetchError as exc:
            message = str(exc)
            check("selection is invalid" in message, message)
            check("GITHUB_TOKEN:" not in message, message)
            check("No configured token" not in message, message)
            check("401" not in message and "403" not in message, message)
        current = sql_backup_fetch.selection_target("  Current Repository  ", "", SOURCE)
        check(current.role == "current" and current.value == SOURCE, current.value)
        slots = sql_backup_fetch.tokens_for_selection(current)
        check([name for name, _value in slots] == ["GITHUB_TOKEN"], str(slots))
        try:
            sql_backup_fetch.selection_target("Other discovered fork", "   ", SOURCE)
            fail("an empty other repository was accepted")
        except sql_backup_fetch.FetchError as exc:
            check("requires an owner/name" in str(exc), str(exc))
            check("GITHUB_TOKEN" not in str(exc), str(exc))
        rimi = sql_backup_fetch.selection_target(" Rimi staging ", "", SOURCE)
        check(rimi.kind == "node" and rimi.value == sql_backup_fetch.RIMI_REPOSITORY_NODE_ID, rimi.value)
        client = FakeGitHub()
        canonical = sql_backup_fetch.resolve_node_repository(client, rimi.value)
        check(canonical == STAGING, canonical)
        identity = sql_backup_fetch.authorize_source(client, canonical, SOURCE)
        renamed = sql_backup_fetch.authorize_source(client, OTHER, SOURCE)
        check(identity.node_id == renamed.node_id == sql_backup_fetch.RIMI_REPOSITORY_NODE_ID, identity.node_id)
        check(identity.numeric_id == renamed.numeric_id == "1182240580", identity.numeric_id)
        check(sql_backup_fetch.deployment_label(identity) == "Rimi staging", identity.full_name)
    finally:
        if saved is None:
            os.environ.pop("GH_TOKEN", None)
        else:
            os.environ["GH_TOKEN"] = saved


def test_schema_compatibility_classes() -> None:
    destination = (ROOT / "docs" / "supabase-schema-full.sql").read_text(encoding="utf-8")
    commented = destination.replace(
        "CREATE TABLE IF NOT EXISTS characters",
        "-- restored note\nCREATE TABLE IF NOT EXISTS characters",
        1,
    )
    comment_class = sql_backup.classify_schema_texts(commented, destination)
    check(comment_class["classification"] == sql_backup.SCHEMA_CLASS_FORMAT, str(comment_class))
    check(comment_class["compatible"] is True, str(comment_class))
    windows = destination.replace("\n", "\r\n")
    line_class = sql_backup.classify_schema_texts(windows, destination)
    check(line_class["classification"] == sql_backup.SCHEMA_CLASS_FORMAT, str(line_class))
    needle = (
        "    WHERE character_key = p_character_key;\n"
        "  END IF;\n"
        "END;\n"
        "$$;\n"
        "\n"
        "-- Move one item's cost"
    )
    replacement = (
        "    WHERE character_key = p_character_key;\n"
        "\n"
        "    DELETE FROM character_dkp_spent\n"
        "    WHERE character_key = p_character_key\n"
        "      AND total_spent = 0;\n"
        "  END IF;\n"
        "END;\n"
        "$$;\n"
        "\n"
        "-- Move one item's cost"
    )
    check(needle in destination, "Rimi fixture anchor was not in the canonical schema")
    rimi = destination.replace(needle, replacement, 1)
    rimi_class = sql_backup.classify_schema_texts(rimi, destination)
    check(rimi_class["classification"] == sql_backup.SCHEMA_CLASS_ADDITIVE, str(rimi_class))
    check(rimi_class["compatible"] is True, str(rimi_class))
    dropped = destination.replace("  char_id TEXT PRIMARY KEY,\n", "", 1)
    dropped_class = sql_backup.classify_schema_texts(dropped, destination)
    check(dropped_class["classification"] == sql_backup.SCHEMA_CLASS_DEFINITE, str(dropped_class))
    check(dropped_class["compatible"] is False, str(dropped_class))
    changed = destination.replace(
        "INSERT INTO restore_in_progress (id, in_progress) VALUES (1, true)",
        "INSERT INTO restore_in_progress (id, in_progress) VALUES (1, false)",
        1,
    )
    changed_class = sql_backup.classify_schema_texts(changed, destination)
    check(changed_class["classification"] == sql_backup.SCHEMA_CLASS_POTENTIAL, str(changed_class))
    check(changed_class["compatible"] is False, str(changed_class))


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
    test_archive_redirect_chain_strips_token()
    test_repository_redirect_keeps_authorization()
    test_metadata_redirect_does_not_leave_api_host()
    test_redirect_loop_is_bounded()
    test_http_downgrade_is_not_requested()
    test_token_secret_map()
    test_repository_identity_provenance()
    test_fork_discovery_reports_unreadable_sources()
    test_official_artifact_list_request()
    test_corrupt_checksum()
    test_schema_mismatch()
    test_source_aliases_are_not_authentication_errors()
    test_schema_compatibility_classes()
    test_wrong_format_version()
    test_executable_member()
    test_valid_approved_fork()
    test_renamed_repository_backup_verifies()
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
