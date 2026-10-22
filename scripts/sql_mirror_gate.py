#!/usr/bin/env python3
"""Decide whether a scheduled one-way SQL mirror should dispatch a restore.

Soft-skips when the source checkpoint is missing, stale, or already mirrored.
Does not download, decrypt, or restore.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import sys
from datetime import datetime, timedelta, timezone


DEFAULT_MAX_AGE_HOURS = 36
ALIAS_OTHER = "Other discovered fork"
_REPO = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")


class GateError(Exception):
    """Invalid gate inputs."""


def parse_mirror_source(value: str) -> tuple[str, str, str]:
    """Map SQL_MIRROR_SOURCE to restore dispatch inputs.

    Returns (source_repository, source_repository_name, cache_key).
    Accepts only owner/name (any NAGD network repo the fork-read tokens can see).
    """
    text = (value or "").strip()
    if not text:
        raise GateError(
            "SQL_MIRROR_SOURCE is not set. Set it to the source repository owner/name."
        )
    if not _REPO.fullmatch(text):
        raise GateError(
            "SQL_MIRROR_SOURCE must be owner/name (for example SomeOrg/Some-Fork). "
            f"Got {value!r}."
        )
    digest = hashlib.sha256(text.casefold().encode("utf-8")).hexdigest()[:12]
    return ALIAS_OTHER, text, f"repo-{digest}"


def parse_utc(value: str) -> datetime:
    text = value.strip()
    if not text:
        raise GateError("snapshot_created_at is empty.")
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise GateError(f"snapshot_created_at could not be read: {value!r}.") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def decide(
    *,
    resolve_ok: bool,
    artifact_id: str,
    snapshot_created_at: str,
    previous_artifact_id: str,
    max_age_hours: int,
    force: bool,
    now: datetime | None = None,
) -> tuple[str, str]:
    """Return (decision, reason) where decision is proceed or skip."""
    if max_age_hours < 1:
        raise GateError("max_age_hours must be at least 1.")
    if not resolve_ok:
        return "skip", "Source checkpoint could not be resolved."
    artifact = artifact_id.strip()
    if not artifact:
        return "skip", "Source checkpoint did not pin an artifact id."
    if not artifact.isdigit():
        raise GateError(f"artifact_id must be numeric, got {artifact_id!r}.")

    created = parse_utc(snapshot_created_at)
    clock = now if now is not None else datetime.now(timezone.utc)
    age = clock - created
    if age > timedelta(hours=max_age_hours):
        hours = age.total_seconds() / 3600.0
        return (
            "skip",
            f"Source snapshot {snapshot_created_at.strip()} is {hours:.1f}h old "
            f"(limit {max_age_hours}h).",
        )

    previous = previous_artifact_id.strip()
    if not force and previous and previous == artifact:
        return "skip", f"Artifact {artifact} was already mirrored successfully."

    if force and previous and previous == artifact:
        return "proceed", f"Force re-mirror of artifact {artifact}."
    return "proceed", f"Mirror artifact {artifact} from {snapshot_created_at.strip()}."


def write_step_summary(title: str, body: str) -> None:
    print(body)
    path = os.environ.get("GITHUB_STEP_SUMMARY", "").strip()
    if not path:
        return
    with open(path, "a", encoding="utf-8", newline="\n") as handle:
        handle.write(f"## {title}\n\n```\n{body}\n```\n")


def write_github_output(fields: dict[str, str]) -> None:
    path = os.environ.get("GITHUB_OUTPUT", "").strip()
    if not path:
        return
    with open(path, "a", encoding="utf-8", newline="\n") as handle:
        for key, value in fields.items():
            if "\n" in value or "\r" in value:
                raise GateError(f"Refusing multiline GitHub output for {key}.")
            handle.write(f"{key}={value}\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Gate a scheduled SQL mirror dispatch.")
    parser.add_argument(
        "--parse-source",
        default="",
        help="Parse SQL_MIRROR_SOURCE and write restore dispatch outputs.",
    )
    parser.add_argument("--resolve-ok", default="", choices=("", "true", "false"))
    parser.add_argument("--artifact-id", default="")
    parser.add_argument("--snapshot-created-at", default="")
    parser.add_argument("--previous-artifact-id", default="")
    parser.add_argument("--max-age-hours", type=int, default=DEFAULT_MAX_AGE_HOURS)
    parser.add_argument("--force", default="false", choices=("true", "false"))
    args = parser.parse_args(argv)

    try:
        if args.parse_source or not args.resolve_ok:
            if args.resolve_ok:
                raise GateError("Pass either --parse-source or --resolve-ok, not both.")
            source_repository, source_repository_name, cache_key = parse_mirror_source(
                args.parse_source
            )
            label = source_repository_name or source_repository
            body = "\n".join(
                [
                    f"source_repository: {source_repository}",
                    f"source_repository_name: {source_repository_name or '(none)'}",
                    f"cache_key: {cache_key}",
                ]
            )
            write_step_summary("SQL mirror source", body)
            write_github_output(
                {
                    "source_repository": source_repository,
                    "source_repository_name": source_repository_name,
                    "cache_key": cache_key,
                    "source_label": label,
                }
            )
            return 0

        decision, reason = decide(
            resolve_ok=args.resolve_ok == "true",
            artifact_id=args.artifact_id,
            snapshot_created_at=args.snapshot_created_at,
            previous_artifact_id=args.previous_artifact_id,
            max_age_hours=args.max_age_hours,
            force=args.force == "true",
        )
    except GateError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    body = "\n".join(
        [
            f"decision: {decision}",
            f"reason: {reason}",
            f"artifact_id: {args.artifact_id.strip() or '(none)'}",
            f"snapshot_created_at: {args.snapshot_created_at.strip() or '(none)'}",
            f"previous_artifact_id: {args.previous_artifact_id.strip() or '(none)'}",
            f"force: {args.force}",
            f"max_age_hours: {args.max_age_hours}",
        ]
    )
    write_step_summary("SQL mirror gate", body)
    write_github_output({"decision": decision, "reason": reason})
    return 0


if __name__ == "__main__":
    sys.exit(main())
