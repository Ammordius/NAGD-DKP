#!/usr/bin/env python3
"""Discover and download an age-encrypted SQL backup artifact.

Reads a GitHub token from the environment. Decrypts only when
SQL_BACKUP_AGE_IDENTITY is set. Checkpoint selection uses artifact
metadata and does not download the archive. Does not print the token,
the identity, or SQL rows, and does not restore a database.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPErrorProcessor, Request, build_opener

import sql_backup

APPROVED_SOURCE_REPOSITORIES = (
    "Ammordius/NAGD-DKP",
    "RimidalEQ/RimidalEQ-NAGD-DKP-backup",
)
# Secret names only. The current repository uses the job token. An approved
# repository with no entry fails closed. Add a production source by naming
# its secret here and in the workflow expressions. Do not store token values.
CURRENT_REPOSITORY_TOKEN_SECRET = "GITHUB_TOKEN"
SOURCE_READ_TOKEN_SECRETS = {
    "RimidalEQ/RimidalEQ-NAGD-DKP-backup": "BACKUP_ARTIFACT_READ_TOKEN_STAGING",
}
APPROVED_HEAD_BRANCHES = ("main",)
WORKFLOW_FILE = "db-sql-backup.yml"
LEGACY_WORKFLOW_FILE = "db-backup.yml"
DESTINATION_PREBACKUP_PREFIX = "sql-restore-destination-backup"
CHECKPOINT_LATEST = "Latest available backup"
CHECKPOINT_PREVIOUS = "Previous backup (previous distinct snapshot)"
CHECKPOINT_LATEST_WEEKLY = "Latest weekly backup"
CHECKPOINT_PREVIOUS_WEEKLY = "Previous weekly backup"
CHECKPOINT_LATEST_MONTHLY = "Latest monthly backup"
CHECKPOINT_BY_NAME = "Specific checkpoint by artifact name"
CHECKPOINT_CHOICES = (
    CHECKPOINT_LATEST,
    CHECKPOINT_PREVIOUS,
    CHECKPOINT_LATEST_WEEKLY,
    CHECKPOINT_PREVIOUS_WEEKLY,
    CHECKPOINT_LATEST_MONTHLY,
    CHECKPOINT_BY_NAME,
)
_TIER_ORDER = ("daily", "weekly", "monthly")

API_ROOT = "https://api.github.com"
API_VERSION = "2022-11-28"
USER_AGENT = "nagd-dkp-sql-backup-fetch"
PER_PAGE = 100
MAX_PAGES = 20
MAX_JSON_BYTES = 2 * 1024 * 1024
MAX_ZIP_BYTES = 64 * 1024 * 1024
MAX_AGE_BYTES = 64 * 1024 * 1024
MAX_TAR_BYTES = 128 * 1024 * 1024
MAX_EXTRACTED_BYTES = 256 * 1024 * 1024
MAX_REDIRECTS = 3

ARCHIVE_NAMES = ("data.sql", "manifest.json", "SHA256SUMS", "summary.txt")
_REPO = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
_ARTIFACT_NAME = re.compile(r"sql-backup-[0-9]{8}T[0-9]{6}Z")
_DAILY_STAMP = re.compile(r"sql-backup-([0-9]{8}T[0-9]{6}Z)")
_WEEKLY_NAME = re.compile(r"sql-backup-weekly-[0-9]{4}-W[0-9]{2}")
_MONTHLY_NAME = re.compile(r"sql-backup-monthly-[0-9]{4}-[0-9]{2}")
_AGE_MEMBER = re.compile(r"sql-backup-[0-9]{8}T[0-9]{6}Z\.tar\.gz\.age")
_DIGITS = re.compile(r"[1-9][0-9]*")
_SHA256 = re.compile(r"sha256:[0-9a-f]{64}")
_SUM_LINE = re.compile(r"([0-9a-f]{64})  (\S+)")
_CREATED = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z")
_COMMIT = re.compile(r"[0-9a-fA-F]{7,64}")


class FetchError(Exception):
    """Fail-closed fetch error. The message must not contain secrets."""


def approved_repositories(current_repository: str) -> set[str]:
    repos = set(APPROVED_SOURCE_REPOSITORIES)
    if current_repository:
        repos.add(normalize_repo(current_repository))
    return repos


def normalize_repo(value: str) -> str:
    text = (value or "").strip()
    if not _REPO.fullmatch(text):
        raise FetchError("Repository must look like owner/name.")
    return text


def require_source(source: str, current_repository: str) -> str:
    repo = normalize_repo(source)
    if repo not in approved_repositories(current_repository):
        raise FetchError(
            "Repository is not approved for SQL backup reads. "
            "A fork relationship does not grant artifact access."
        )
    return repo


def token_secret_name(source: str, current_repository: str) -> str:
    """Return the Actions secret name for this source. Never returns a token value."""
    repo = require_source(source, current_repository)
    current = normalize_repo(current_repository) if (current_repository or "").strip() else ""
    if current and repo == current:
        return CURRENT_REPOSITORY_TOKEN_SECRET
    mapped = SOURCE_READ_TOKEN_SECRETS.get(repo)
    if not mapped:
        raise FetchError("No artifact-read token is mapped for that repository.")
    return mapped


def token_for_source(source: str, current_repository: str) -> str:
    """Read the token selected for this source. The value is not included in errors."""
    expected = token_secret_name(source, current_repository)
    declared = os.environ.get("BACKUP_ARTIFACT_TOKEN_SECRET", "").strip()
    if declared and declared != expected:
        raise FetchError("Artifact-read token secret does not match the source repository.")
    if expected == CURRENT_REPOSITORY_TOKEN_SECRET:
        value = (os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or "").strip()
    else:
        named = os.environ.get(expected, "").strip()
        job_token = os.environ.get("GH_TOKEN", "").strip()
        value = job_token or named if declared == expected else named or job_token
    if not value:
        raise FetchError("Set the mapped artifact-read token to read that repository.")
    return value


def _redact(text: str, secrets: list[str]) -> str:
    redacted = text
    for secret in secrets:
        if secret and len(secret) >= 8:
            redacted = redacted.replace(secret, "[redacted]")
    return redacted


def github_status_message(status: int) -> str:
    if status == 401:
        return "GitHub rejected the token (401)."
    if status == 403:
        return "GitHub refused access (403). The token needs Actions: Read on that repository."
    if status == 404:
        return "GitHub could not find that repository, workflow, or artifact (404)."
    return f"GitHub API returned {status}."


def _parse_time(value: str) -> datetime:
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise FetchError("Artifact expiry time could not be read.") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _blank(value: str | None) -> str | None:
    if value is None:
        return None
    text = value.strip()
    return text or None


def _require_id(value: str | None, label: str) -> str | None:
    text = _blank(value)
    if text is None:
        return None
    if not _DIGITS.fullmatch(text):
        raise FetchError(f"{label} must be a number.")
    return text


def _reject_path(name: str, label: str) -> str:
    if not name or name.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:", name):
        raise FetchError(f"{label} contains an unsafe path.")
    parts = name.replace("\\", "/").split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise FetchError(f"{label} contains an unsafe path.")
    return "/".join(parts)


class UrllibGitHub:
    """GitHub REST client. Drops Authorization when a download leaves the API host."""

    def __init__(self, token: str, base_url: str = API_ROOT) -> None:
        self._token = token
        self._base_url = base_url.rstrip("/")

    def get_json(self, path: str) -> dict:
        payload = self._read(path, MAX_JSON_BYTES, allow_external=False)
        try:
            parsed = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise FetchError("GitHub returned a response that is not JSON.") from exc
        if not isinstance(parsed, dict):
            raise FetchError("GitHub returned an unexpected response.")
        return parsed

    def get_bytes(self, path: str, limit: int) -> bytes:
        return self._read(path, limit, allow_external=True)

    def send_authorization(self, url: str) -> bool:
        parts = urlsplit(url)
        origin = urlsplit(self._base_url)
        loopback = origin.scheme == "http" and origin.hostname in ("127.0.0.1", "localhost")
        allowed_http = loopback and parts.scheme == "http" and parts.hostname == origin.hostname
        if parts.scheme != "https" and not allowed_http:
            raise FetchError("GitHub download redirect was not https.")
        return parts.scheme == origin.scheme and parts.netloc == origin.netloc

    def _read(self, path: str, limit: int, allow_external: bool) -> bytes:
        url = self._base_url + path
        redirects = 0
        while True:
            request = Request(url, method="GET")
            request.add_header("Accept", "application/vnd.github+json")
            request.add_header("X-GitHub-Api-Version", API_VERSION)
            request.add_header("User-Agent", USER_AGENT)
            if self.send_authorization(url):
                request.add_header("Authorization", "Bearer " + self._token)
            try:
                response = build_opener(_KeepRedirect()).open(request, timeout=60)
            except HTTPError as exc:
                body = exc.read(4096)
                exc.close()
                self._raise_status(exc.code, body)
            except URLError as exc:
                raise FetchError("GitHub could not be reached.") from exc
            try:
                status = getattr(response, "status", None) or response.getcode()
                if status in (301, 302, 303, 307, 308):
                    if redirects >= MAX_REDIRECTS:
                        raise FetchError("GitHub download redirect was not followed.")
                    location = response.headers.get("Location")
                    if not location or not location.strip():
                        raise FetchError("GitHub download redirect was missing a location.")
                    next_url = urljoin(url, location.strip())
                    same_origin = self.send_authorization(next_url)
                    if not same_origin and not allow_external:
                        raise FetchError("GitHub API redirect left the API host.")
                    url = next_url
                    redirects += 1
                    continue
                if status != 200:
                    self._raise_status(status, response.read(4096))
                return _read_capped(response, limit)
            finally:
                response.close()

    def _raise_status(self, status: int, body: bytes) -> None:
        text = body.decode("utf-8", errors="replace")
        if self._token and len(self._token) >= 8 and self._token in text:
            text = text.replace(self._token, "[redacted]")
        if "rate limit" in text.lower():
            raise FetchError("GitHub API rate limit exceeded.")
        raise FetchError(github_status_message(status))


class _KeepRedirect(HTTPErrorProcessor):
    """Return 3xx responses so the caller can drop Authorization before following."""

    def http_response(self, request, response):  # noqa: ANN001
        if response.code in (301, 302, 303, 307, 308):
            return response
        return HTTPErrorProcessor.http_response(self, request, response)

    https_response = http_response


def _read_capped(response, limit: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        block = response.read(64 * 1024)
        if not block:
            break
        total += len(block)
        if total > limit:
            raise FetchError("Download exceeds the size limit.")
        chunks.append(block)
    return b"".join(chunks)


def _query(path: str, per_page: int, page: int) -> str:
    separator = "&" if "?" in path else "?"
    return f"{path}{separator}per_page={per_page}&page={page}"


def paginate(client, path: str, key: str, per_page: int) -> list[dict]:
    items: list[dict] = []
    for page in range(1, MAX_PAGES + 1):
        payload = client.get_json(_query(path, per_page, page))
        batch = payload.get(key)
        if not isinstance(batch, list):
            raise FetchError("GitHub returned an unexpected list.")
        for item in batch:
            if not isinstance(item, dict):
                raise FetchError("GitHub returned an unexpected list.")
            items.append(item)
        if len(batch) < per_page:
            return items
    raise FetchError("GitHub result set exceeded the page cap.")


def _workflow_name(run: dict) -> str:
    path = run.get("path")
    if not isinstance(path, str) or not path:
        raise FetchError("Workflow run is missing its workflow path.")
    return path.replace("\\", "/").rsplit("/", 1)[-1]


def _run_ok(run: dict) -> None:
    if run.get("status") != "completed" or run.get("conclusion") != "success":
        raise FetchError("Workflow run did not succeed.")
    if run.get("head_branch") not in APPROVED_HEAD_BRANCHES:
        raise FetchError("Workflow run is not on an approved branch.")
    name = _workflow_name(run)
    if name == LEGACY_WORKFLOW_FILE:
        raise FetchError("Refusing a legacy CSV backup artifact.")
    if name != WORKFLOW_FILE:
        raise FetchError("Artifact is not from the SQL backup workflow.")


def _expired(artifact: dict, now: datetime) -> bool:
    if artifact.get("expired") is True:
        return True
    expires = artifact.get("expires_at")
    if expires is None:
        return False
    if not isinstance(expires, str):
        raise FetchError("Artifact expiry time could not be read.")
    return _parse_time(expires) <= now


def _legacy_name(name: object) -> bool:
    return isinstance(name, str) and (
        name.startswith("supabase-backup") or name.endswith(".csv") or name.endswith(".csv.gz")
    )


def _eligible_name(name: object) -> bool:
    """Daily artifacts. Latest discovery ignores weekly and monthly copies."""
    return isinstance(name, str) and _ARTIFACT_NAME.fullmatch(name) is not None


def _restorable_name(name: object) -> bool:
    """Names an explicit artifact id may restore. The zip member stays a daily stamp."""
    return _eligible_name(name) or (
        isinstance(name, str)
        and (_WEEKLY_NAME.fullmatch(name) is not None or _MONTHLY_NAME.fullmatch(name) is not None)
    )


def _require_artifact_shape(artifact: dict, now: datetime) -> None:
    name = artifact.get("name")
    if _legacy_name(name):
        raise FetchError("Refusing a legacy CSV backup artifact.")
    if not _restorable_name(name):
        raise FetchError("Artifact name is not an SQL backup.")
    if _expired(artifact, now):
        raise FetchError("Artifact is expired.")
    size = artifact.get("size_in_bytes")
    if isinstance(size, int) and not isinstance(size, bool) and size > MAX_ZIP_BYTES:
        raise FetchError("Artifact zip exceeds the size limit.")


def _numeric_id(value: object, label: str) -> str:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise FetchError(f"{label} from GitHub was not a number.")
    return str(value)


def _load_run(client, repo: str, run_id: str) -> dict:
    run = client.get_json(f"/repos/{repo}/actions/runs/{run_id}")
    _run_ok(run)
    return run


def _artifacts_for_run(client, repo: str, run_id: str, per_page: int) -> list[dict]:
    return paginate(client, f"/repos/{repo}/actions/runs/{run_id}/artifacts", "artifacts", per_page)


def _choose_from_run(artifacts: list[dict], now: datetime, artifact_id: str | None) -> dict:
    if artifact_id is not None:
        matches = [item for item in artifacts if str(item.get("id")) == artifact_id]
        if len(matches) != 1:
            raise FetchError("Artifact was not found on that workflow run.")
        chosen = matches[0]
        _require_artifact_shape(chosen, now)
        return chosen
    eligible = []
    for item in artifacts:
        if not _eligible_name(item.get("name")):
            continue
        if _expired(item, now):
            continue
        eligible.append(item)
    if not eligible:
        raise FetchError("No eligible SQL backup artifact.")
    if len(eligible) > 1:
        raise FetchError("Run has more than one SQL backup artifact. Pass an artifact id.")
    return eligible[0]


def resolve_artifact(
    client,
    repo: str,
    *,
    run_id: str | None,
    artifact_id: str | None,
    now: datetime,
    per_page: int,
) -> tuple[dict, dict]:
    if artifact_id is not None:
        artifact = client.get_json(f"/repos/{repo}/actions/artifacts/{artifact_id}")
        nested = artifact.get("workflow_run")
        nested_id = nested.get("id") if isinstance(nested, dict) else None
        if nested_id is None:
            raise FetchError("Artifact is missing its workflow run.")
        resolved_run = _numeric_id(nested_id, "Workflow run id")
        if run_id is not None and resolved_run != run_id:
            raise FetchError("Artifact does not belong to the requested workflow run.")
        run = _load_run(client, repo, resolved_run)
        _require_artifact_shape(artifact, now)
        return artifact, run

    if run_id is not None:
        run = _load_run(client, repo, run_id)
        chosen = _choose_from_run(_artifacts_for_run(client, repo, run_id, per_page), now, None)
        return chosen, run

    runs = paginate(
        client,
        f"/repos/{repo}/actions/workflows/{WORKFLOW_FILE}/runs?status=success",
        "workflow_runs",
        per_page,
    )
    for run in runs:
        try:
            _run_ok(run)
            run_key = _numeric_id(run.get("id"), "Workflow run id")
        except FetchError:
            continue
        found = _artifacts_for_run(client, repo, run_key, per_page)
        try:
            chosen = _choose_from_run(found, now, None)
        except FetchError as exc:
            if str(exc) == "No eligible SQL backup artifact.":
                continue
            raise
        return chosen, run
    raise FetchError("No eligible SQL backup artifact.")


class CheckpointCopy:
    """One retention artifact. Metadata only; the archive is not opened here."""

    def __init__(
        self,
        artifact_id: str,
        name: str,
        tier: str,
        available: bool,
        created_at: str,
        expires_at: str,
        size_in_bytes: int,
        workflow_run_id: str,
    ) -> None:
        self.artifact_id = artifact_id
        self.name = name
        self.tier = tier
        self.available = available
        self.created_at = created_at
        self.expires_at = expires_at
        self.size_in_bytes = size_in_bytes
        self.workflow_run_id = workflow_run_id


class CheckpointSnapshot:
    """Daily, weekly, and monthly copies of one backup run."""

    def __init__(
        self,
        workflow_run_id: str,
        timestamp: datetime,
        timestamp_label: str,
        source_repository: str,
        artifacts: list[CheckpointCopy],
    ) -> None:
        self.workflow_run_id = workflow_run_id
        self.timestamp = timestamp
        self.timestamp_label = timestamp_label
        self.source_repository = source_repository
        self.artifacts = artifacts


class CheckpointSelection:
    def __init__(self, snapshot: CheckpointSnapshot, artifact: CheckpointCopy, checkpoint: str) -> None:
        self.snapshot = snapshot
        self.artifact = artifact
        self.checkpoint = checkpoint


def retention_tier(name: str) -> str:
    if _ARTIFACT_NAME.fullmatch(name):
        return "daily"
    if _WEEKLY_NAME.fullmatch(name):
        return "weekly"
    if _MONTHLY_NAME.fullmatch(name):
        return "monthly"
    raise FetchError("Artifact name is not an SQL backup.")


def _destination_prebackup(name: object) -> bool:
    return isinstance(name, str) and name.startswith(DESTINATION_PREBACKUP_PREFIX)


def _utc_label(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _utc_stamp(value: str, label: str) -> str:
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise FetchError(f"{label} could not be read.") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return _utc_label(parsed)


def _timestamp_from_daily_name(name: str) -> datetime:
    match = _DAILY_STAMP.fullmatch(name)
    if match is None:
        raise FetchError("Daily artifact name has no checkpoint timestamp.")
    return datetime.strptime(match.group(1), "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)


def _checkpoint_copy(artifact: dict, run_id: str, now: datetime) -> CheckpointCopy:
    name = artifact.get("name")
    if not isinstance(name, str) or not _restorable_name(name):
        raise FetchError("Artifact name is not an SQL backup.")
    nested = artifact.get("workflow_run")
    if isinstance(nested, dict) and nested.get("id") is not None:
        nested_id = _numeric_id(nested.get("id"), "Workflow run id")
        if nested_id != run_id:
            raise FetchError("Artifact does not belong to the requested workflow run.")
    size = artifact.get("size_in_bytes")
    if isinstance(size, bool) or not isinstance(size, int) or size < 0:
        raise FetchError("Artifact size could not be read.")
    if size > MAX_ZIP_BYTES:
        raise FetchError("Artifact zip exceeds the size limit.")
    created = artifact.get("created_at")
    if not isinstance(created, str):
        raise FetchError("Artifact created_at could not be read.")
    expires = artifact.get("expires_at")
    if expires is None:
        expires_label = "none"
    elif not isinstance(expires, str):
        raise FetchError("Artifact expiry time could not be read.")
    else:
        expires_label = _utc_stamp(expires, "Artifact expiry time")
    return CheckpointCopy(
        artifact_id=_numeric_id(artifact.get("id"), "Artifact id"),
        name=name,
        tier=retention_tier(name),
        available=not _expired(artifact, now),
        created_at=_utc_stamp(created, "Artifact created_at"),
        expires_at=expires_label,
        size_in_bytes=size,
        workflow_run_id=run_id,
    )


def _group_copies(
    run_id: str,
    copies: list[CheckpointCopy],
    created_at: str,
    repo: str,
) -> CheckpointSnapshot:
    tiers = [copy.tier for copy in copies]
    if len(tiers) != len(set(tiers)):
        raise FetchError(
            f"Workflow run {run_id} has more than one SQL backup artifact in the same retention tier. "
            "Refusing to choose one."
        )
    if len({copy.size_in_bytes for copy in copies}) != 1:
        raise FetchError(
            f"Workflow run {run_id} has SQL backup artifacts of different sizes. "
            "Refusing to treat them as one snapshot."
        )
    daily = [copy for copy in copies if copy.tier == "daily"]
    if daily:
        timestamp = _timestamp_from_daily_name(daily[0].name)
        label = _utc_label(timestamp)
    else:
        if not created_at:
            raise FetchError(
                f"Workflow run {run_id} is missing created_at, so its checkpoint time cannot be read."
            )
        label = _utc_stamp(created_at, "Workflow run created_at")
        timestamp = datetime.strptime(label, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    ordered = sorted(copies, key=lambda copy: _TIER_ORDER.index(copy.tier))
    return CheckpointSnapshot(run_id, timestamp, label, repo, ordered)


def discover_snapshots(client, repo: str, *, now: datetime, per_page: int = PER_PAGE) -> list[CheckpointSnapshot]:
    """List SQL backup artifacts for one repository and group identical retention copies."""
    runs = paginate(
        client,
        f"/repos/{repo}/actions/workflows/{WORKFLOW_FILE}/runs?status=success",
        "workflow_runs",
        per_page,
    )
    snapshots: list[CheckpointSnapshot] = []
    for run in runs:
        try:
            _run_ok(run)
            run_key = _numeric_id(run.get("id"), "Workflow run id")
        except FetchError:
            continue
        created = run.get("created_at")
        if created is not None and not isinstance(created, str):
            raise FetchError("Workflow run created_at could not be read.")
        copies: list[CheckpointCopy] = []
        for item in _artifacts_for_run(client, repo, run_key, per_page):
            name = item.get("name")
            if _legacy_name(name) or _destination_prebackup(name) or not _restorable_name(name):
                continue
            copies.append(_checkpoint_copy(item, run_key, now))
        if not copies:
            continue
        snapshots.append(_group_copies(run_key, copies, created if isinstance(created, str) else "", repo))
    snapshots.sort(key=lambda item: (item.timestamp, int(item.workflow_run_id)), reverse=True)
    return snapshots


def _available_snapshots(snapshots: list[CheckpointSnapshot]) -> list[CheckpointSnapshot]:
    return [snapshot for snapshot in snapshots if any(copy.available for copy in snapshot.artifacts)]


def _snapshots_with_available_tier(snapshots: list[CheckpointSnapshot], tier: str) -> list[CheckpointSnapshot]:
    chosen = []
    for snapshot in snapshots:
        if any(copy.available and copy.tier == tier for copy in snapshot.artifacts):
            chosen.append(snapshot)
    return chosen


def _preferred_copy(snapshot: CheckpointSnapshot) -> CheckpointCopy:
    available = [copy for copy in snapshot.artifacts if copy.available]
    for tier in _TIER_ORDER:
        matches = [copy for copy in available if copy.tier == tier]
        if len(matches) > 1:
            raise FetchError(
                f"Workflow run {snapshot.workflow_run_id} has more than one available {tier} backup. "
                "Refusing to choose one."
            )
        if matches:
            return matches[0]
    raise FetchError("No available copy of that checkpoint. Refusing to substitute another checkpoint.")


def _tier_copy(snapshot: CheckpointSnapshot, tier: str) -> CheckpointCopy:
    matches = [copy for copy in snapshot.artifacts if copy.available and copy.tier == tier]
    if len(matches) != 1:
        raise FetchError(
            f"No available {tier} copy of that checkpoint. Refusing to substitute another checkpoint."
        )
    return matches[0]


def _require_index(items: list[CheckpointSnapshot], index: int, missing: str) -> CheckpointSnapshot:
    if len(items) <= index:
        raise FetchError(missing)
    return items[index]


def _find_copy(snapshots: list[CheckpointSnapshot], artifact_id: str) -> tuple[CheckpointSnapshot, CheckpointCopy] | None:
    matches = [
        (snapshot, copy)
        for snapshot in snapshots
        for copy in snapshot.artifacts
        if copy.artifact_id == artifact_id
    ]
    if len(matches) > 1:
        raise FetchError(f"Artifact id {artifact_id} is duplicated. Refusing to choose one.")
    if not matches:
        return None
    return matches[0]


def _selection_from_resolved(artifact: dict, run: dict, repo: str, now: datetime) -> CheckpointSelection:
    run_id = _numeric_id(run.get("id"), "Workflow run id")
    copy = _checkpoint_copy(artifact, run_id, now)
    if not copy.available:
        raise FetchError(
            f"Artifact {copy.artifact_id} ({copy.name}) is expired. Refusing to substitute another checkpoint."
        )
    created = run.get("created_at") if isinstance(run.get("created_at"), str) else ""
    snapshot = _group_copies(run_id, [copy], created, repo)
    return CheckpointSelection(snapshot, copy, CHECKPOINT_LATEST)


def _expired_copy_message(copy: CheckpointCopy) -> str:
    return (
        f"Artifact {copy.artifact_id} ({copy.name}) is expired. "
        "Refusing to substitute another checkpoint."
    )


def _select_named(snapshots: list[CheckpointSnapshot], checkpoint: str, checkpoint_name: str) -> CheckpointSelection:
    if checkpoint == CHECKPOINT_LATEST:
        snapshot = _require_index(
            _available_snapshots(snapshots),
            0,
            "No available SQL backup checkpoint. Refusing to substitute another checkpoint.",
        )
        return CheckpointSelection(snapshot, _preferred_copy(snapshot), checkpoint)
    if checkpoint == CHECKPOINT_PREVIOUS:
        available = _available_snapshots(snapshots)
        snapshot = _require_index(
            available,
            1,
            "Previous backup is not available. "
            f"{len(available)} distinct checkpoint(s) can be restored. "
            "Refusing to substitute the latest backup.",
        )
        return CheckpointSelection(snapshot, _preferred_copy(snapshot), checkpoint)
    if checkpoint == CHECKPOINT_LATEST_WEEKLY:
        weekly = _snapshots_with_available_tier(snapshots, "weekly")
        snapshot = _require_index(
            weekly,
            0,
            "No weekly backup is available. Refusing to substitute a daily or monthly checkpoint.",
        )
        return CheckpointSelection(snapshot, _tier_copy(snapshot, "weekly"), checkpoint)
    if checkpoint == CHECKPOINT_PREVIOUS_WEEKLY:
        weekly = _snapshots_with_available_tier(snapshots, "weekly")
        snapshot = _require_index(
            weekly,
            1,
            "Previous weekly backup is not available. "
            f"{len(weekly)} weekly checkpoint(s) can be restored. "
            "Refusing to substitute the latest weekly backup.",
        )
        return CheckpointSelection(snapshot, _tier_copy(snapshot, "weekly"), checkpoint)
    if checkpoint == CHECKPOINT_LATEST_MONTHLY:
        monthly = _snapshots_with_available_tier(snapshots, "monthly")
        snapshot = _require_index(
            monthly,
            0,
            "No monthly backup is available. Refusing to substitute a daily or weekly checkpoint.",
        )
        return CheckpointSelection(snapshot, _tier_copy(snapshot, "monthly"), checkpoint)
    if checkpoint != CHECKPOINT_BY_NAME:
        raise FetchError("Checkpoint choice is not one of the workflow options.")
    name = checkpoint_name.strip()
    if not name:
        raise FetchError("Enter the artifact name for a specific checkpoint.")
    available = [
        (snapshot, copy)
        for snapshot in snapshots
        for copy in snapshot.artifacts
        if copy.name == name and copy.available
    ]
    expired = [
        copy
        for snapshot in snapshots
        for copy in snapshot.artifacts
        if copy.name == name and not copy.available
    ]
    if len(available) > 1:
        ids = ", ".join(copy.artifact_id for _snapshot, copy in available)
        raise FetchError(
            f"Artifact name {name} matches {len(available)} available artifacts ({ids}). "
            "Pass one artifact id. Refusing to choose one."
        )
    if len(available) == 1:
        snapshot, copy = available[0]
        return CheckpointSelection(snapshot, copy, checkpoint)
    if expired:
        raise FetchError(f"Artifact name {name} is expired. Refusing to substitute another checkpoint.")
    raise FetchError(
        f"Artifact name {name} is not an available SQL backup. Refusing to substitute another checkpoint."
    )


def select_checkpoint(
    snapshots: list[CheckpointSnapshot],
    *,
    checkpoint: str,
    checkpoint_name: str = "",
    artifact_id: str = "",
    client=None,
    repo: str = "",
    now: datetime | None = None,
    per_page: int = PER_PAGE,
) -> CheckpointSelection:
    """Resolve a workflow choice to one artifact. Never substitutes a different checkpoint."""
    if checkpoint not in CHECKPOINT_CHOICES:
        raise FetchError("Checkpoint choice is not one of the workflow options.")
    explicit = _require_id(_blank(artifact_id), "Artifact id")
    if explicit and checkpoint == CHECKPOINT_LATEST:
        found = _find_copy(snapshots, explicit)
        if found is None:
            if client is None or not repo or now is None:
                raise FetchError(
                    f"Artifact id {explicit} was not found among SQL backups from that repository. "
                    "Refusing to substitute another checkpoint."
                )
            try:
                artifact, run = resolve_artifact(
                    client,
                    repo,
                    run_id=None,
                    artifact_id=explicit,
                    now=now,
                    per_page=per_page,
                )
            except FetchError as exc:
                message = str(exc)
                if "Refusing to substitute" not in message:
                    message = f"{message} Refusing to substitute another checkpoint."
                raise FetchError(message) from None
            return _selection_from_resolved(artifact, run, repo, now)
        snapshot, copy = found
        if not copy.available:
            raise FetchError(_expired_copy_message(copy))
        return CheckpointSelection(snapshot, copy, checkpoint)

    selected = _select_named(snapshots, checkpoint, checkpoint_name)
    if explicit and selected.artifact.artifact_id != explicit:
        found = _find_copy(snapshots, explicit)
        suffix = ""
        if found is not None and not found[1].available:
            suffix = " That artifact id is expired."
        raise FetchError(
            f"Artifact id {explicit} does not match the selected checkpoint "
            f"{selected.artifact.name} (id {selected.artifact.artifact_id}). "
            f"Refusing to restore.{suffix}"
        )
    return selected


def format_checkpoint_inventory(
    snapshots: list[CheckpointSnapshot],
    selection: CheckpointSelection | None,
    *,
    checkpoint: str,
    source: str,
) -> str:
    """Five newest available snapshots, plus the selected snapshot when it is older."""
    shown = _available_snapshots(snapshots)[:5]
    if selection is not None and all(item.workflow_run_id != selection.snapshot.workflow_run_id for item in shown):
        shown = [*shown, selection.snapshot]
    lines = [
        f"checkpoint_choice: {checkpoint}",
        f"source_repository: {source}",
    ]
    if selection is None:
        lines.extend(
            [
                "selected_artifact_id: none",
                "selected_artifact_name: none",
                "selected_snapshot: none",
            ]
        )
    else:
        lines.extend(
            [
                f"selected_artifact_id: {selection.artifact.artifact_id}",
                f"selected_artifact_name: {selection.artifact.name}",
                f"selected_snapshot: {selection.snapshot.timestamp_label}",
                f"selected_tier: {selection.artifact.tier}",
                (
                    "A confirmed restore would replace guild DKP data with historical snapshot "
                    f"{selection.snapshot.timestamp_label} "
                    f"({selection.artifact.name}, artifact {selection.artifact.artifact_id}) "
                    f"from {source}. "
                    "Destination auth, profiles, claims, and the officer audit log are kept."
                ),
            ]
        )
    lines.append("checkpoints:")
    if not shown:
        lines.append("  (none)")
    for snapshot in shown:
        for copy in snapshot.artifacts:
            selected = (
                "yes"
                if selection is not None and copy.artifact_id == selection.artifact.artifact_id
                else "no"
            )
            lines.extend(
                [
                    f"  snapshot: {snapshot.timestamp_label}",
                    f"  source_repository: {snapshot.source_repository}",
                    f"  artifact_name: {copy.name}",
                    f"  artifact_id: {copy.artifact_id}",
                    f"  created_at: {copy.created_at}",
                    f"  expires_at: {copy.expires_at}",
                    f"  tier: {copy.tier}",
                    f"  size_in_bytes: {copy.size_in_bytes}",
                    f"  available: {'yes' if copy.available else 'no'}",
                    f"  selected: {selected}",
                    f"  workflow_run_id: {snapshot.workflow_run_id}",
                ]
            )
    return "\n".join(lines)


def resolve_checkpoint(
    client,
    *,
    source: str,
    current_repository: str,
    checkpoint: str,
    checkpoint_name: str = "",
    artifact_id: str = "",
    now: datetime | None = None,
    per_page: int = PER_PAGE,
) -> tuple[str, CheckpointSelection]:
    repo = require_source(source, current_repository)
    moment = now or datetime.now(timezone.utc)
    snapshots = discover_snapshots(client, repo, now=moment, per_page=per_page)
    selection = select_checkpoint(
        snapshots,
        checkpoint=checkpoint,
        checkpoint_name=checkpoint_name,
        artifact_id=artifact_id,
        client=client,
        repo=repo,
        now=moment,
        per_page=per_page,
    )
    inventory = format_checkpoint_inventory(snapshots, selection, checkpoint=checkpoint, source=repo)
    return inventory, selection


def write_github_output(fields: dict[str, str]) -> None:
    path = os.environ.get("GITHUB_OUTPUT", "").strip()
    if not path:
        return
    rendered: list[str] = []
    for key, value in fields.items():
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", key):
            raise FetchError("GitHub output name is invalid.")
        text = str(value)
        if text.strip() == "" or "\n" in text or "\r" in text:
            raise FetchError("GitHub output value is empty or unsafe.")
        rendered.append(f"{key}={text}")
    with open(path, "a", encoding="utf-8", newline="\n") as handle:
        handle.write("\n".join(rendered) + "\n")


def _zip_member(payload: bytes) -> tuple[str, bytes]:
    try:
        archive = zipfile.ZipFile(io.BytesIO(payload))
    except zipfile.BadZipFile as exc:
        raise FetchError("Artifact zip is malformed.") from exc
    with archive:
        infos = archive.infolist()
        if len(infos) != 1:
            raise FetchError("Artifact zip must contain exactly one SQL backup file.")
        info = infos[0]
        name = _reject_path(info.filename, "Artifact zip")
        if _AGE_MEMBER.fullmatch(name) is None:
            raise FetchError("Artifact zip does not contain the SQL backup file.")
        if info.file_size > MAX_AGE_BYTES:
            raise FetchError("Encrypted artifact exceeds the size limit.")
        member = archive.read(info)
    if len(member) > MAX_AGE_BYTES:
        raise FetchError("Encrypted artifact exceeds the size limit.")
    if not member.startswith(b"age-encryption.org/"):
        raise FetchError("Artifact is not an age-encrypted file.")
    return name, member


def decrypt_age(age_path: Path, identity: str, destination: Path) -> None:
    if not shutil.which("age"):
        raise FetchError("age is not installed or not on PATH.")
    directory = Path(tempfile.mkdtemp(prefix="sql-backup-age-"))
    key_path = directory / "identity.txt"
    try:
        key_path.write_text(identity.strip() + "\n", encoding="utf-8")
        if os.name == "posix":
            os.chmod(directory, 0o700)
            os.chmod(key_path, 0o600)
        completed = subprocess.run(
            ["age", "--decrypt", "--identity", str(key_path), "--output", str(destination), str(age_path)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
        if completed.returncode != 0:
            detail = _redact((completed.stderr or completed.stdout or "")[-400:], [identity])
            raise FetchError("age could not decrypt the artifact. " + detail.strip())
        if destination.stat().st_size > MAX_TAR_BYTES:
            raise FetchError("Decrypted archive exceeds the size limit.")
    finally:
        shutil.rmtree(directory, ignore_errors=True)


def _member_bytes(archive: tarfile.TarFile, member: tarfile.TarInfo) -> bytes:
    handle = archive.extractfile(member)
    if handle is None:
        raise FetchError("Archive member could not be read.")
    chunks: list[bytes] = []
    total = 0
    while True:
        block = handle.read(64 * 1024)
        if not block:
            break
        total += len(block)
        if total > MAX_EXTRACTED_BYTES:
            raise FetchError("Extracted archive exceeds the size limit.")
        chunks.append(block)
    return b"".join(chunks)


def _check_members(archive: tarfile.TarFile) -> dict[str, bytes]:
    found: dict[str, bytes] = {}
    extracted = 0
    for member in archive.getmembers():
        name = _reject_path(member.name, "Archive")
        if member.issym() or member.islnk() or not member.isfile():
            raise FetchError("Archive contains a link or an unexpected member.")
        if member.mode & 0o111:
            raise FetchError("Archive contains an executable file.")
        if name not in ARCHIVE_NAMES or member.name != name or name in found:
            raise FetchError("Archive contains an unexpected file.")
        if member.size < 0 or member.size > MAX_EXTRACTED_BYTES:
            raise FetchError("Extracted archive exceeds the size limit.")
        extracted += member.size
        if extracted > MAX_EXTRACTED_BYTES:
            raise FetchError("Extracted archive exceeds the size limit.")
        found[name] = _member_bytes(archive, member)
    if set(found) != set(ARCHIVE_NAMES):
        raise FetchError("Archive is missing an expected file.")
    return found


def _parse_sums(text: str) -> dict[str, str]:
    found: dict[str, str] = {}
    for line in text.splitlines():
        if not line:
            continue
        match = _SUM_LINE.fullmatch(line)
        if match is None:
            raise FetchError("SHA256SUMS has an unexpected line.")
        filename = match.group(2)
        if filename in found:
            raise FetchError("SHA256SUMS repeats a file.")
        found[filename] = match.group(1)
    if set(found) != {"data.sql", "manifest.json"}:
        raise FetchError("SHA256SUMS does not cover the expected files.")
    return found


def _require_text(value: object, label: str, pattern: re.Pattern[str]) -> str:
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        raise FetchError(f"Manifest {label} is invalid.")
    return value


def verify_plaintext(tar_path: Path, *, source: str, run_id: str, schema_path: Path) -> dict:
    if not schema_path.is_file():
        raise FetchError(f"Missing canonical schema file {sql_backup.CANONICAL_SCHEMA}.")
    try:
        archive = tarfile.open(tar_path, "r:gz")
    except (tarfile.TarError, OSError) as exc:
        raise FetchError("Archive is malformed.") from exc
    with archive:
        files = _check_members(archive)
    try:
        sums = _parse_sums(files["SHA256SUMS"].decode("utf-8"))
    except UnicodeError as exc:
        raise FetchError("SHA256SUMS is not valid text.") from exc
    data_hex = hashlib.sha256(files["data.sql"]).hexdigest()
    manifest_hex = hashlib.sha256(files["manifest.json"]).hexdigest()
    if sums["data.sql"] != data_hex:
        raise FetchError("Checksum does not match data.sql.")
    if sums["manifest.json"] != manifest_hex:
        raise FetchError("Checksum does not match manifest.json.")
    try:
        manifest = json.loads(files["manifest.json"].decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise FetchError("Manifest is not valid JSON.") from exc
    if not isinstance(manifest, dict):
        raise FetchError("Manifest is not valid JSON.")
    if manifest.get("format_version") != sql_backup.FORMAT_VERSION:
        raise FetchError("Artifact format_version is not supported.")
    if manifest.get("included_tables") != list(sql_backup.INCLUDED_TABLES):
        raise FetchError("Artifact table list does not match the allowlist.")
    checksums = manifest.get("checksums")
    if not isinstance(checksums, dict) or checksums.get("data.sql") != "sha256:" + data_hex:
        raise FetchError("Manifest checksum does not match data.sql.")
    if _require_text(manifest.get("source_repository"), "source_repository", _REPO) != source:
        raise FetchError("Manifest source_repository does not match the selected repository.")
    if _require_text(manifest.get("workflow_run_id"), "workflow_run_id", _DIGITS) != str(run_id):
        raise FetchError("Manifest workflow_run_id does not match the workflow run.")
    _require_text(manifest.get("source_commit_sha"), "source_commit_sha", _COMMIT)
    _require_text(manifest.get("created_at"), "created_at", _CREATED)
    if manifest.get("canonical_schema_source") != sql_backup.CANONICAL_SCHEMA:
        raise FetchError("Manifest schema source is invalid.")
    fingerprint = _require_text(manifest.get("canonical_schema_sha256"), "canonical_schema_sha256", _SHA256)
    if fingerprint != sql_backup.schema_fingerprint(schema_path):
        raise FetchError("Schema fingerprint does not match docs/supabase-schema-full.sql.")
    try:
        sql_backup.live_schema_record(manifest)
    except sql_backup.BackupError as exc:
        raise FetchError(str(exc)) from None
    version = manifest.get("postgresql_version")
    if not isinstance(version, str) or not version.strip() or len(version) > 200 or "\n" in version:
        raise FetchError("Manifest postgresql_version is invalid.")
    counts = manifest.get("row_counts")
    if not isinstance(counts, dict) or set(counts) != set(sql_backup.INCLUDED_TABLES):
        raise FetchError("Manifest row_counts do not match the allowlist.")
    for table, count in counts.items():
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            raise FetchError(f"Manifest row count for {table} is invalid.")
    return manifest


def _summary(artifact: dict, run: dict, manifest: dict | None, artifact_sha256: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{64}", artifact_sha256):
        raise FetchError("Artifact digest is invalid.")
    lines = [
        f"source_repository: {run.get('_source_repository', '')}",
        f"workflow_run_id: {run.get('id')}",
        f"artifact_id: {artifact.get('id')}",
        f"artifact_name: {artifact.get('name')}",
        f"head_branch: {run.get('head_branch')}",
        f"head_sha: {run.get('head_sha')}",
        f"artifact_bytes: {artifact.get('size_in_bytes')}",
        f"artifact_sha256: {artifact_sha256}",
    ]
    if manifest is None:
        lines.append("inner_verified: false")
        lines.append("snapshot: not verified (no age identity)")
        return "\n".join(lines)
    lines.extend(
        [
            "inner_verified: true",
            f"format_version: {manifest['format_version']}",
            f"created_at: {manifest['created_at']}",
            f"source_commit_sha: {manifest['source_commit_sha']}",
            f"source_schema_fingerprint: {manifest['canonical_schema_sha256']}",
            f"canonical_schema_sha256: {manifest['canonical_schema_sha256']}",
            f"live_schema_status: {sql_backup.live_schema_record(manifest)['status']}",
            "live_schema_compared_to_repository_file: false",
            f"postgresql_version: {manifest['postgresql_version']}",
            "row_counts:",
        ]
    )
    for name in sql_backup.INCLUDED_TABLES:
        lines.append(f"  {name}: {manifest['row_counts'][name]}")
    return "\n".join(lines)


def fetch(
    *,
    source: str,
    current_repository: str,
    token: str,
    client,
    out_dir: Path,
    run_id: str | None = None,
    artifact_id: str | None = None,
    identity: str | None = None,
    schema_path: Path | None = None,
    now: datetime | None = None,
    per_page: int = PER_PAGE,
) -> str:
    secrets = [token, identity or ""]
    try:
        return _fetch(
            source=source,
            current_repository=current_repository,
            token=token,
            client=client,
            out_dir=out_dir,
            run_id=run_id,
            artifact_id=artifact_id,
            identity=identity,
            schema_path=schema_path,
            now=now or datetime.now(timezone.utc),
            per_page=per_page,
        )
    except FetchError as exc:
        raise FetchError(_redact(str(exc), secrets)) from None


def _fetch(
    *,
    source: str,
    current_repository: str,
    token: str,
    client,
    out_dir: Path,
    run_id: str | None,
    artifact_id: str | None,
    identity: str | None,
    schema_path: Path | None,
    now: datetime,
    per_page: int,
) -> str:
    if not (token or "").strip():
        raise FetchError("Set the mapped artifact-read token to read that repository.")
    repo = require_source(source, current_repository)
    run_id = _require_id(run_id, "Workflow run id")
    artifact_id = _require_id(artifact_id, "Artifact id")
    artifact, run = resolve_artifact(
        client,
        repo,
        run_id=run_id,
        artifact_id=artifact_id,
        now=now,
        per_page=per_page,
    )
    resolved_id = _numeric_id(artifact.get("id"), "Artifact id")
    payload = client.get_bytes(f"/repos/{repo}/actions/artifacts/{resolved_id}/zip", MAX_ZIP_BYTES)
    if len(payload) > MAX_ZIP_BYTES:
        raise FetchError("Artifact zip exceeds the size limit.")
    digest = hashlib.sha256(payload).hexdigest()
    member_name, age_bytes = _zip_member(payload)
    out_dir.mkdir(parents=True, exist_ok=True)
    age_path = out_dir / member_name
    age_path.write_bytes(age_bytes)
    run = dict(run)
    run["_source_repository"] = repo
    manifest = None
    if identity and identity.strip():
        if "AGE-SECRET-KEY-" not in identity:
            raise FetchError("SQL_BACKUP_AGE_IDENTITY is not an age identity.")
        schema = schema_path or (sql_backup.repo_root() / sql_backup.CANONICAL_SCHEMA)
        tar_path = out_dir / "backup.tar.gz"
        try:
            decrypt_age(age_path, identity, tar_path)
            manifest = verify_plaintext(tar_path, source=repo, run_id=str(run.get("id")), schema_path=schema)
        finally:
            tar_path.unlink(missing_ok=True)
    return _redact(_summary(artifact, run, manifest, digest), [token, identity or ""])


def _identity_from_env() -> str | None:
    value = os.environ.get("SQL_BACKUP_AGE_IDENTITY", "")
    text = value.strip()
    return text or None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Download and verify a portable SQL backup artifact.")
    parser.add_argument("--source", required=True, help="Approved source repository (owner/name)")
    parser.add_argument("--current-repository", default=os.environ.get("GITHUB_REPOSITORY", ""))
    parser.add_argument("--run-id", default="")
    parser.add_argument("--artifact-id", default="")
    parser.add_argument("--out-dir", type=Path, default=Path("sql-backup-fetch-out"))
    args = parser.parse_args(argv)
    try:
        token = token_for_source(args.source, args.current_repository)
        summary = fetch(
            source=args.source,
            current_repository=args.current_repository,
            token=token,
            client=UrllibGitHub(token),
            out_dir=args.out_dir,
            run_id=args.run_id,
            artifact_id=args.artifact_id,
            identity=_identity_from_env(),
        )
    except FetchError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(summary)
    step_summary = os.environ.get("GITHUB_STEP_SUMMARY", "").strip()
    if step_summary:
        with open(step_summary, "a", encoding="utf-8", newline="\n") as handle:
            handle.write("## SQL backup fetch\n\n```\n" + summary + "\n```\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
