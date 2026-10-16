#!/usr/bin/env python3
"""List and pin full-database backup artifacts from the current repository.

Portable SQL backups and CSV backups are rejected. Selection returns one
artifact id and the SHA-256 of its zip. A later download uses that id and
does not resolve Latest again.
"""

from __future__ import annotations

import hashlib
import io
import os
import re
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from full_db_common import FullDbError
from sql_backup_fetch import FetchError, UrllibGitHub, paginate

WORKFLOW_FILE = "full_self_host_backup.yml"
NAME_RE = re.compile(r"^full-db-backup-[0-9]{8}T[0-9]{6}Z$")
MEMBER_RE = re.compile(r"^full-db-backup-[0-9]{8}T[0-9]{6}Z\.tar\.gz\.age$")
MAX_ZIP_BYTES = 512 * 1024 * 1024
PER_PAGE = 100
CHECKPOINTS = (
    "Latest available weekly backup",
    "Previous weekly backup",
    "Specific artifact ID",
)


def current_repository() -> str:
    current = os.environ.get("CURRENT_REPOSITORY", "").strip()
    actions_repo = os.environ.get("GITHUB_REPOSITORY", "").strip()
    if not current:
        current = actions_repo
    if current.count("/") != 1:
        raise FullDbError("Set CURRENT_REPOSITORY to owner/name.")
    if actions_repo and current != actions_repo:
        raise FullDbError("Full-database artifacts are limited to the current repository.")
    return current


def github_token() -> str:
    token = os.environ.get("GH_TOKEN", "").strip() or os.environ.get("GITHUB_TOKEN", "").strip()
    if not token:
        raise FullDbError("Set GH_TOKEN.")
    return token


def _parse_time(value: str) -> datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise FullDbError("Artifact time could not be read.")
    try:
        parsed = datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError as exc:
        raise FullDbError("Artifact time could not be read.") from exc
    return parsed.replace(tzinfo=timezone.utc)


def is_expired(artifact: dict, now: datetime) -> bool:
    if artifact.get("expired") is True:
        return True
    expires = artifact.get("expires_at")
    if expires is None:
        return False
    return _parse_time(expires) <= now


def reject_foreign_name(name: object) -> None:
    text = name if isinstance(name, str) else ""
    if text.startswith("sql-restore-destination-backup"):
        raise FullDbError("Refusing a destination pre-backup artifact.")
    if text.startswith("sql-backup"):
        raise FullDbError("Refusing a portable SQL backup artifact.")
    if text.startswith("supabase-backup") or text.endswith(".csv") or text.endswith(".csv.gz"):
        raise FullDbError("Refusing a legacy CSV backup artifact.")
    if not NAME_RE.fullmatch(text):
        raise FullDbError("Artifact name is not a full-database backup.")


def _created(artifact: dict) -> datetime:
    return _parse_time(str(artifact.get("created_at") or ""))


def list_full_db_artifacts(client, repo: str) -> list[dict]:
    try:
        items = paginate(client, f"/repos/{repo}/actions/artifacts", "artifacts", PER_PAGE)
    except FetchError as exc:
        raise FullDbError(str(exc)) from exc
    chosen = []
    for item in items:
        name = item.get("name")
        if not isinstance(name, str) or not NAME_RE.fullmatch(name):
            continue
        chosen.append(item)
    chosen.sort(key=_created, reverse=True)
    return chosen


def assert_backup_run(client, repo: str, artifact: dict) -> dict:
    workflow_run = artifact.get("workflow_run") or {}
    run_id = workflow_run.get("id")
    if not isinstance(run_id, int) or isinstance(run_id, bool):
        raise FullDbError("Artifact is missing its workflow run.")
    try:
        run = client.get_json(f"/repos/{repo}/actions/runs/{run_id}")
    except FetchError as exc:
        raise FullDbError(str(exc)) from exc
    if run.get("status") != "completed" or run.get("conclusion") != "success":
        raise FullDbError("Full-database backup workflow run did not succeed.")
    path = str(run.get("path") or "").replace("\\", "/")
    if path.endswith("db-backup.yml") or path.endswith("db-sql-backup.yml"):
        raise FullDbError("Refusing a portable or CSV backup artifact.")
    if not path.endswith(WORKFLOW_FILE):
        raise FullDbError("Artifact is not from the full self-host backup workflow.")
    return run


def select_artifact(artifacts: list[dict], checkpoint: str, artifact_id: str, now: datetime) -> dict:
    if checkpoint not in CHECKPOINTS:
        raise FullDbError("Checkpoint choice is not a full-database backup.")
    if artifact_id.strip():
        if not artifact_id.strip().isdigit():
            raise FullDbError("Artifact id must be a number.")
        matches = [item for item in artifacts if str(item.get("id")) == artifact_id.strip()]
        if len(matches) != 1:
            raise FullDbError("Artifact id was not found in this repository.")
        chosen = matches[0]
        reject_foreign_name(chosen.get("name"))
        if is_expired(chosen, now):
            raise FullDbError("Artifact is expired.")
        return chosen
    if checkpoint == "Specific artifact ID":
        raise FullDbError("Specific artifact ID requires an artifact id.")
    available = [item for item in artifacts if not is_expired(item, now)]
    if checkpoint == "Latest available weekly backup":
        if not available:
            raise FullDbError("No full-database backup is available.")
        return available[0]
    if len(available) < 2:
        raise FullDbError("No previous full-database backup is available.")
    return available[1]


def _zip_member(payload: bytes) -> tuple[str, bytes]:
    try:
        archive = zipfile.ZipFile(io.BytesIO(payload))
    except zipfile.BadZipFile as exc:
        raise FullDbError("Artifact zip could not be read.") from exc
    names = [name for name in archive.namelist() if "/" not in name and "\\" not in name]
    age_names = [name for name in names if MEMBER_RE.fullmatch(name)]
    if len(age_names) != 1:
        raise FullDbError("Full-database artifact zip must contain one encrypted archive.")
    data = archive.read(age_names[0])
    if not data.startswith(b"age-encryption.org/"):
        raise FullDbError("Artifact is not age ciphertext.")
    return age_names[0], data


def download_id(client, repo: str, artifact_id: str, limit: int = MAX_ZIP_BYTES) -> tuple[bytes, str]:
    try:
        payload = client.get_bytes(f"/repos/{repo}/actions/artifacts/{artifact_id}/zip", limit)
    except FetchError as exc:
        raise FullDbError(str(exc)) from exc
    digest = hashlib.sha256(payload).hexdigest()
    return payload, digest


def pin_artifact(client, repo: str, checkpoint: str, artifact_id: str, now: datetime | None = None) -> dict:
    moment = now or datetime.now(timezone.utc)
    artifacts = list_full_db_artifacts(client, repo)
    chosen = select_artifact(artifacts, checkpoint, artifact_id, moment)
    reject_foreign_name(chosen.get("name"))
    if is_expired(chosen, moment):
        raise FullDbError("Artifact is expired.")
    run = assert_backup_run(client, repo, chosen)
    resolved_id = str(chosen.get("id"))
    payload, digest = download_id(client, repo, resolved_id)
    _zip_member(payload)
    return {
        "artifact_id": resolved_id,
        "artifact_name": str(chosen.get("name")),
        "workflow_run_id": str(run.get("id")),
        "artifact_sha256": digest,
        "source_repository": repo,
    }


def download_pinned(client, repo: str, artifact_id: str, expect_sha256: str, out_dir: Path, now: datetime | None = None) -> Path:
    if not expect_sha256 or len(expect_sha256) != 64:
        raise FullDbError("Pinned checksum is missing.")
    moment = now or datetime.now(timezone.utc)
    try:
        artifact = client.get_json(f"/repos/{repo}/actions/artifacts/{artifact_id}")
    except FetchError as exc:
        raise FullDbError(str(exc)) from exc
    reject_foreign_name(artifact.get("name"))
    if is_expired(artifact, moment):
        raise FullDbError("Artifact is expired.")
    assert_backup_run(client, repo, artifact)
    payload, digest = download_id(client, repo, artifact_id)
    if digest != expect_sha256.lower():
        raise FullDbError("Pinned artifact checksum does not match.")
    member_name, age_bytes = _zip_member(payload)
    out_dir.mkdir(parents=True, exist_ok=True)
    destination = out_dir / member_name
    destination.write_bytes(age_bytes)
    return destination


def _write_output(pin: dict) -> None:
    path = os.environ.get("GITHUB_OUTPUT", "").strip()
    if not path:
        return
    with open(path, "a", encoding="utf-8", newline="\n") as handle:
        for key in ("artifact_id", "artifact_name", "workflow_run_id", "artifact_sha256", "source_repository"):
            handle.write(f"{key}={pin[key]}\n")


def _append_summary(text: str) -> None:
    print(text)
    path = os.environ.get("GITHUB_STEP_SUMMARY", "").strip()
    if not path:
        return
    with open(path, "a", encoding="utf-8", newline="\n") as handle:
        handle.write(text + "\n")


def format_list(artifacts: list[dict], now: datetime) -> str:
    lines = [
        "Full-database backup artifacts in this repository.",
        "Workflow choices are static. Copy an artifact id below for Specific artifact ID.",
        "artifact_id | name | created_at | expires_at | size_bytes | available",
    ]
    if not artifacts:
        lines.append("(none)")
        return "\n".join(lines)
    for item in artifacts:
        available = "no" if is_expired(item, now) else "yes"
        lines.append(
            " | ".join(
                [
                    str(item.get("id")),
                    str(item.get("name")),
                    str(item.get("created_at")),
                    str(item.get("expires_at")),
                    str(item.get("size_in_bytes")),
                    available,
                ]
            )
        )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="List or pin full-database backup artifacts.")
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--select", action="store_true")
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--checkpoint", default="")
    parser.add_argument("--artifact-id", default="")
    parser.add_argument("--expect-sha256", default="")
    parser.add_argument("--out-dir", type=Path)
    args = parser.parse_args(argv)
    modes = sum(1 for flag in (args.list, args.select, args.download) if flag)
    if modes != 1:
        print("Pass exactly one of --list, --select, or --download.", file=sys.stderr)
        return 1
    try:
        repo = current_repository()
        token = github_token()
        client = UrllibGitHub(token)
        now = datetime.now(timezone.utc)
        if args.list:
            text = format_list(list_full_db_artifacts(client, repo), now)
            _append_summary(text)
            return 0
        if args.select:
            checkpoint = args.checkpoint or os.environ.get("CHECKPOINT", "")
            artifact_id = args.artifact_id or os.environ.get("ARTIFACT_ID", "")
            pin = pin_artifact(client, repo, checkpoint, artifact_id, now)
            _write_output(pin)
            _append_summary(
                "\n".join(
                    [
                        f"pinned_artifact_id: {pin['artifact_id']}",
                        f"pinned_artifact_name: {pin['artifact_name']}",
                        f"pinned_workflow_run_id: {pin['workflow_run_id']}",
                        f"pinned_sha256: {pin['artifact_sha256']}",
                        f"source_repository: {pin['source_repository']}",
                    ]
                )
            )
            return 0
        artifact_id = args.artifact_id or os.environ.get("ARTIFACT_ID", "")
        expect = args.expect_sha256 or os.environ.get("PINNED_SHA256", "")
        if args.out_dir is None:
            raise FullDbError("Download requires --out-dir.")
        path = download_pinned(client, repo, artifact_id, expect, args.out_dir, now)
        print(f"downloaded: {path.name}")
        return 0
    except FullDbError as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.exit(main())
