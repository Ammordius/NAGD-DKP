#!/usr/bin/env python3
"""Resolve one SQL restore checkpoint to an artifact id.

Lists GitHub artifact metadata only. Does not download, decrypt, or restore.
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone

import sql_backup_fetch


def write_step_summary(title: str, body: str) -> None:
    print(body)
    path = os.environ.get("GITHUB_STEP_SUMMARY", "").strip()
    if not path:
        return
    with open(path, "a", encoding="utf-8", newline="\n") as handle:
        handle.write(f"## {title}\n\n```\n{body}\n```\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Resolve a SQL restore checkpoint to one artifact.")
    parser.add_argument("--source", required=True)
    parser.add_argument("--source-name", default="")
    parser.add_argument("--current-repository", default=os.environ.get("GITHUB_REPOSITORY", ""))
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--checkpoint-name", default="")
    parser.add_argument("--artifact-id", default="")
    args = parser.parse_args(argv)

    token = ""
    try:
        _secret_name, token, client, identity = sql_backup_fetch.open_source(
            args.source, args.current_repository, args.source_name
        )
        repo = identity.full_name
        identity_lines = "\n".join(
            [
                f"selected_repository: {repo}",
                f"canonical_repository: {repo}",
                f"deployment: {sql_backup_fetch.deployment_label(identity, args.current_repository)}",
                f"repository_id: {identity.node_id}",
                f"numeric_id: {identity.numeric_id}",
                f"eligible_fork: yes",
            ]
        )
        now = datetime.now(timezone.utc)
        snapshots = sql_backup_fetch.discover_snapshots(client, repo, now=now)
        try:
            selection = sql_backup_fetch.select_checkpoint(
                snapshots,
                checkpoint=args.checkpoint,
                checkpoint_name=args.checkpoint_name,
                artifact_id=args.artifact_id,
                client=client,
                repo=repo,
                now=now,
            )
        except sql_backup_fetch.FetchError as exc:
            inventory = identity_lines + "\n" + sql_backup_fetch.format_checkpoint_inventory(
                snapshots,
                None,
                checkpoint=args.checkpoint,
                source=repo,
            )
            write_step_summary("SQL restore checkpoints", inventory)
            print(sql_backup_fetch._redact(str(exc), [token]), file=sys.stderr)
            return 1
        inventory = identity_lines + "\n" + sql_backup_fetch.format_checkpoint_inventory(
            snapshots,
            selection,
            checkpoint=args.checkpoint,
            source=repo,
        )
    except sql_backup_fetch.FetchError as exc:
        message = sql_backup_fetch._redact(str(exc), [token])
        print(message, file=sys.stderr)
        return 1

    write_step_summary("SQL restore checkpoints", inventory)
    try:
        sql_backup_fetch.write_github_output(
            {
                "artifact_id": selection.artifact.artifact_id,
                "source_repository": selection.snapshot.source_repository,
                "artifact_name": selection.artifact.name,
                "workflow_run_id": selection.artifact.workflow_run_id,
                "retention_tier": selection.artifact.tier,
                "snapshot_created_at": selection.snapshot.timestamp_label,
            }
        )
    except sql_backup_fetch.FetchError as exc:
        print(sql_backup_fetch._redact(str(exc), [token]), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
