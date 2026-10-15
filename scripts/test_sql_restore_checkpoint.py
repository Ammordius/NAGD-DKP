#!/usr/bin/env python3
"""Checkpoint selection for the SQL restore workflow.

Uses a fake GitHub client. Does not download a live artifact or restore a database.
"""

from __future__ import annotations

import io
import os
from contextlib import redirect_stderr
from datetime import datetime, timezone
from pathlib import Path

import sql_backup_fetch
import sql_restore
import sql_restore_checkpoint
from test_sql_backup_fetch import CURRENT, SOURCE, FakeGitHub, run_fetch, zip_bytes

ROOT = Path(__file__).resolve().parents[1]
NOW = datetime(2026, 10, 14, 16, 0, tzinfo=timezone.utc)
REPO = "RimidalEQ/RimidalEQ-NAGD-DKP-backup"
WORKFLOW = ".github/workflows/db-sql-backup.yml"


def fail(message: str) -> None:
    raise SystemExit(message)


def check(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


class Boom:
    def get_json(self, path: str) -> dict:
        raise AssertionError(f"HTTP was called for {path}")

    def get_bytes(self, path: str, limit: int) -> bytes:
        raise AssertionError(f"download was called for {path}")


class Forbidden:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def get_json(self, path: str) -> dict:
        self.calls.append(path)
        raise sql_backup_fetch.FetchError(sql_backup_fetch.github_status_message(403))

    def get_bytes(self, path: str, limit: int) -> bytes:
        raise AssertionError(f"download was called for {path}")


def run_record(
    run_id: int,
    created: str,
    *,
    branch: str = "main",
    path: str = WORKFLOW,
) -> dict:
    return {
        "id": run_id,
        "path": path,
        "status": "completed",
        "conclusion": "success",
        "head_branch": branch,
        "head_sha": "abc123deadbeef",
        "created_at": created,
    }


def artifact(
    artifact_id: int,
    name: str,
    run_id: int,
    *,
    size: int = 100,
    expired: bool = False,
    created: str = "2026-10-14T15:04:05Z",
    expires: str = "2026-12-31T00:00:00Z",
) -> dict:
    return {
        "id": artifact_id,
        "name": name,
        "expired": expired,
        "expires_at": expires,
        "size_in_bytes": size,
        "created_at": created,
        "workflow_run": {"id": run_id, "head_branch": "main", "head_sha": "abc123deadbeef"},
    }


class Catalog:
    def __init__(self, repo: str) -> None:
        self.repo = repo
        self.client = FakeGitHub()
        self.runs: list[dict] = []

    def add(self, run: dict, artifacts: list[dict] | None) -> None:
        self.runs.append(run)
        if artifacts is None:
            return
        self.client.add_json(
            f"/repos/{self.repo}/actions/runs/{run['id']}/artifacts",
            {"artifacts": artifacts},
        )

    def finish(self) -> FakeGitHub:
        self.client.add_json(
            f"/repos/{self.repo}/actions/workflows/db-sql-backup.yml/runs",
            {"workflow_runs": list(self.runs)},
        )
        return self.client


def resolve(client, checkpoint: str, *, name: str = "", artifact_id: str = "", repo: str = REPO):
    return sql_backup_fetch.resolve_checkpoint(
        client,
        source=repo,
        current_repository=CURRENT,
        checkpoint=checkpoint,
        checkpoint_name=name,
        artifact_id=artifact_id,
        now=NOW,
    )


def expect_resolve(substring: str, client, checkpoint: str, **kwargs) -> str:
    try:
        inventory, _selection = resolve(client, checkpoint, **kwargs)
    except sql_backup_fetch.FetchError as exc:
        message = str(exc)
        check(substring in message, f"expected {substring!r} in {message}")
        return message
    fail(f"expected failure containing {substring!r}, got:\n{inventory}")


def ids(text: str) -> list[str]:
    return [line.split(": ", 1)[1] for line in text.splitlines() if line.strip().startswith("artifact_id:")]


def sample_catalog() -> FakeGitHub:
    catalog = Catalog(REPO)
    catalog.add(
        run_record(400, "2026-10-14T18:00:00Z"),
        [
            artifact(
                40,
                "sql-backup-20261014T180000Z",
                400,
                expired=True,
                expires="2026-10-14T12:00:00Z",
            )
        ],
    )
    catalog.add(
        run_record(300, "2026-10-14T15:04:05Z"),
        [
            artifact(14, "sql-backup-20261014T150405Z", 300, size=100),
            artifact(15, "sql-backup-weekly-2026-W42", 300, size=100),
            artifact(16, "sql-backup-monthly-2026-10", 300, size=100),
            artifact(31, "supabase-backup-2026-10-14", 300, size=100),
            artifact(32, "sql-restore-destination-backup-20261014T150405Z", 300, size=100),
            artifact(33, "notes.txt", 300, size=100),
        ],
    )
    catalog.add(
        run_record(200, "2026-10-07T15:04:05Z"),
        [
            artifact(13, "sql-backup-20261007T150405Z", 200, size=110),
            artifact(12, "sql-backup-weekly-2026-W41", 200, size=110),
        ],
    )
    catalog.add(
        run_record(80, "2026-10-01T00:00:00Z"),
        [artifact(8, "sql-backup-weekly-2026-W41", 80, size=90)],
    )
    catalog.add(
        run_record(70, "2026-09-20T00:00:00Z"),
        [artifact(7, "sql-backup-20260920T000000Z", 70, size=70)],
    )
    catalog.add(
        run_record(60, "2026-09-10T00:00:00Z"),
        [artifact(6, "sql-backup-20260910T000000Z", 60, size=60)],
    )
    catalog.add(
        run_record(100, "2026-09-02T03:00:00Z"),
        [artifact(9, "sql-backup-monthly-2026-09", 100, size=80)],
    )
    catalog.add(
        run_record(40, "2026-08-01T00:00:00Z"),
        [artifact(3, "sql-backup-20260801T000000Z", 40, size=40)],
    )
    catalog.add(run_record(91, "2026-10-14T19:00:00Z", branch="feature/not-a-backup"), None)
    catalog.add(
        run_record(92, "2026-10-14T19:00:00Z", path=".github/workflows/db-backup.yml"),
        None,
    )
    return catalog.finish()


def test_latest_previous_and_retention_copies() -> None:
    client = sample_catalog()
    inventory, selection = resolve(client, sql_backup_fetch.CHECKPOINT_LATEST)
    check(selection.artifact.artifact_id == "14", selection.artifact.artifact_id)
    check(selection.artifact.tier == "daily", selection.artifact.tier)
    check(selection.snapshot.timestamp_label == "2026-10-14T15:04:05Z", selection.snapshot.timestamp_label)
    check(len(selection.snapshot.artifacts) == 3, "retention copies were not one snapshot")
    check("sql-backup-weekly-2026-W42" in inventory, inventory)
    check("sql-backup-monthly-2026-10" in inventory, inventory)
    check("supabase-backup" not in inventory, inventory)
    check("sql-restore-destination-backup" not in inventory, inventory)
    check("notes.txt" not in inventory, inventory)
    check("artifact_id: 40" not in inventory, inventory)
    check("replace guild DKP data" in inventory, inventory)
    check("example.test" not in inventory and "AGE-SECRET" not in inventory, inventory)
    shown = ids(inventory)
    check(shown.count("14") == 1, shown)
    check("9" not in shown, shown)
    check("3" not in shown, shown)

    _previous_inventory, previous = resolve(client, sql_backup_fetch.CHECKPOINT_PREVIOUS)
    check(previous.artifact.artifact_id == "13", previous.artifact.artifact_id)
    check(previous.snapshot.workflow_run_id != selection.snapshot.workflow_run_id, "previous used the same snapshot")

    _weekly_inventory, weekly = resolve(client, sql_backup_fetch.CHECKPOINT_LATEST_WEEKLY)
    check(weekly.artifact.artifact_id == "15", weekly.artifact.artifact_id)
    check(weekly.artifact.tier == "weekly", weekly.artifact.tier)
    _older_weekly, older_weekly = resolve(client, sql_backup_fetch.CHECKPOINT_PREVIOUS_WEEKLY)
    check(older_weekly.artifact.artifact_id == "12", older_weekly.artifact.artifact_id)

    monthly_inventory, monthly = resolve(client, sql_backup_fetch.CHECKPOINT_LATEST_MONTHLY)
    check(monthly.artifact.artifact_id == "16", monthly.artifact.artifact_id)
    check(monthly.artifact.tier == "monthly", monthly.artifact.tier)
    check("artifact_id: 16" in monthly_inventory, monthly_inventory)
    older_inventory, older = resolve(
        client,
        sql_backup_fetch.CHECKPOINT_BY_NAME,
        name="sql-backup-monthly-2026-09",
    )
    check(older.artifact.artifact_id == "9", older.artifact.artifact_id)
    check("artifact_id: 9" in older_inventory, "selected monthly checkpoint was omitted from the inventory")


def test_exact_name_and_duplicates() -> None:
    client = sample_catalog()
    inventory, selection = resolve(
        client,
        sql_backup_fetch.CHECKPOINT_BY_NAME,
        name="sql-backup-20260801T000000Z",
    )
    check(selection.artifact.artifact_id == "3", selection.artifact.artifact_id)
    shown = ids(inventory)
    check("3" in shown, shown)
    check("9" not in shown, shown)
    check(shown.count("14") == 1, shown)
    expect_resolve(
        "matches 2",
        client,
        sql_backup_fetch.CHECKPOINT_BY_NAME,
        name="sql-backup-weekly-2026-W41",
    )
    expect_resolve(
        "expired",
        client,
        sql_backup_fetch.CHECKPOINT_BY_NAME,
        name="sql-backup-20261014T180000Z",
    )
    expect_resolve(
        "not an available",
        client,
        sql_backup_fetch.CHECKPOINT_BY_NAME,
        name="sql-backup-missing",
    )
    expect_resolve("Enter the artifact name", client, sql_backup_fetch.CHECKPOINT_BY_NAME, name="  ")


def test_expired_sibling_and_missing_checkpoints() -> None:
    catalog = Catalog(REPO)
    catalog.add(
        run_record(5, "2026-10-14T15:04:05Z"),
        [
            artifact(
                51,
                "sql-backup-20261014T150405Z",
                5,
                size=100,
                expired=True,
                expires="2026-10-14T12:00:00Z",
            ),
            artifact(52, "sql-backup-weekly-2026-W42", 5, size=100),
        ],
    )
    client = catalog.finish()
    inventory, selection = resolve(client, sql_backup_fetch.CHECKPOINT_LATEST)
    check(selection.artifact.artifact_id == "52", selection.artifact.artifact_id)
    check(selection.snapshot.timestamp_label == "2026-10-14T15:04:05Z", selection.snapshot.timestamp_label)
    check("available: no" in inventory, inventory)
    check("available: yes" in inventory, inventory)
    expect_resolve(
        "Refusing to substitute the latest backup",
        client,
        sql_backup_fetch.CHECKPOINT_PREVIOUS,
    )
    expect_resolve(
        "latest weekly",
        client,
        sql_backup_fetch.CHECKPOINT_PREVIOUS_WEEKLY,
    )


def test_missing_weekly_is_not_replaced() -> None:
    catalog = Catalog(REPO)
    catalog.add(
        run_record(1, "2026-10-14T15:04:05Z"),
        [artifact(1, "sql-backup-20261014T150405Z", 1)],
    )
    client = catalog.finish()
    expect_resolve("No weekly backup", client, sql_backup_fetch.CHECKPOINT_LATEST_WEEKLY)
    expect_resolve("No monthly backup", client, sql_backup_fetch.CHECKPOINT_LATEST_MONTHLY)


def test_ambiguous_run_is_not_collapsed() -> None:
    catalog = Catalog(REPO)
    catalog.add(
        run_record(1, "2026-10-14T15:04:05Z"),
        [
            artifact(1, "sql-backup-20261014T150405Z", 1, size=100),
            artifact(2, "sql-backup-weekly-2026-W42", 1, size=90),
        ],
    )
    message = ""
    try:
        resolve(catalog.finish(), sql_backup_fetch.CHECKPOINT_LATEST)
    except sql_backup_fetch.FetchError as exc:
        message = str(exc)
    check("different sizes" in message, message)

    catalog = Catalog(REPO)
    catalog.add(
        run_record(1, "2026-10-14T15:04:05Z"),
        [
            artifact(1, "sql-backup-20261014T150405Z", 1, size=100),
            artifact(2, "sql-backup-20261014T120000Z", 1, size=100),
        ],
    )
    try:
        resolve(catalog.finish(), sql_backup_fetch.CHECKPOINT_LATEST)
    except sql_backup_fetch.FetchError as exc:
        message = str(exc)
    else:
        message = ""
    check("same retention tier" in message, message)


def test_numeric_id_and_conflict() -> None:
    client = sample_catalog()
    inventory, selection = resolve(client, sql_backup_fetch.CHECKPOINT_LATEST, artifact_id="13")
    check(selection.artifact.artifact_id == "13", inventory)
    expect_resolve(
        "does not match",
        client,
        sql_backup_fetch.CHECKPOINT_PREVIOUS,
        artifact_id="14",
    )
    expect_resolve("expired", client, sql_backup_fetch.CHECKPOINT_LATEST, artifact_id="40")

    catalog = Catalog(REPO)
    catalog.add(
        run_record(1, "2026-10-14T15:04:05Z"),
        [artifact(1, "sql-backup-20261014T150405Z", 1)],
    )
    client = catalog.finish()
    client.add_json(
        f"/repos/{REPO}/actions/artifacts/777",
        artifact(777, "supabase-backup-2026-10-14", 7777),
    )
    client.add_json(f"/repos/{REPO}/actions/runs/7777", run_record(7777, "2026-10-14T15:04:05Z"))
    expect_resolve("legacy CSV", client, sql_backup_fetch.CHECKPOINT_LATEST, artifact_id="777")


def test_wrong_source_and_permission() -> None:
    try:
        sql_backup_fetch.resolve_checkpoint(
            FakeGitHub(),
            source="evil/fork",
            current_repository=CURRENT,
            checkpoint=sql_backup_fetch.CHECKPOINT_LATEST,
            now=NOW,
        )
    except sql_backup_fetch.FetchError as exc:
        check("not a fork" in str(exc), str(exc))
    else:
        fail("unapproved source was accepted")

    forbidden = Forbidden()
    try:
        sql_backup_fetch.resolve_checkpoint(
            forbidden,
            source=REPO,
            current_repository=CURRENT,
            checkpoint=sql_backup_fetch.CHECKPOINT_LATEST,
            now=NOW,
        )
    except sql_backup_fetch.FetchError as exc:
        message = str(exc)
        check("403" in message, message)
        check("Actions: Read" in message, message)
    else:
        fail("cross-repository 403 was accepted")
    check(forbidden.calls, "permission error did not reach GitHub")
    check(all(REPO in path for path in forbidden.calls), str(forbidden.calls))
    check(all(CURRENT not in path for path in forbidden.calls), str(forbidden.calls))

    token_names = ("GH_TOKEN", "GITHUB_TOKEN", *sql_backup_fetch.FORK_READ_TOKEN_ENVS)
    saved_tokens = {key: os.environ.get(key) for key in token_names}
    for key in token_names:
        os.environ.pop(key, None)
    captured = io.StringIO()
    try:
        with redirect_stderr(captured):
            code = sql_restore_checkpoint.main(
                [
                    "--source",
                    SOURCE,
                    "--current-repository",
                    CURRENT,
                    "--checkpoint",
                    sql_backup_fetch.CHECKPOINT_LATEST,
                ]
            )
    finally:
        for key, previous in saved_tokens.items():
            if previous is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = previous
    check(code == 1, "a source without a read token was accepted")
    check("No configured token" in captured.getvalue(), captured.getvalue())
    check("github_pat_" not in captured.getvalue(), "token leaked in a permission error")


def test_pin_ignores_a_newer_backup() -> None:
    repo = SOURCE
    catalog = Catalog(repo)
    catalog.add(
        run_record(1, "2026-10-13T15:04:05Z"),
        [artifact(1, "sql-backup-20261013T150405Z", 1, size=128)],
    )
    client = catalog.finish()
    payload = zip_bytes("sql-backup-20261013T150405Z.tar.gz.age", b"age-encryption.org/v1\n-> fake\n")
    pinned = artifact(1, "sql-backup-20261013T150405Z", 1, size=len(payload))
    client.add_json(f"/repos/{repo}/actions/artifacts/1", pinned)
    client.add_json(f"/repos/{repo}/actions/runs/1", run_record(1, "2026-10-13T15:04:05Z"))
    client.zips["1"] = payload

    _inventory, selection = resolve(client, sql_backup_fetch.CHECKPOINT_LATEST, repo=repo)
    check(selection.artifact.artifact_id == "1", selection.artifact.artifact_id)

    client.add_json(
        f"/repos/{repo}/actions/workflows/db-sql-backup.yml/runs",
        {
            "workflow_runs": [
                run_record(2, "2026-10-14T15:04:05Z"),
                run_record(1, "2026-10-13T15:04:05Z"),
            ]
        },
    )
    client.add_json(
        f"/repos/{repo}/actions/runs/2/artifacts",
        {"artifacts": [artifact(2, "sql-backup-20261014T150405Z", 2, size=128)]},
    )
    _again, newer = resolve(client, sql_backup_fetch.CHECKPOINT_LATEST, repo=repo)
    check(newer.artifact.artifact_id == "2", newer.artifact.artifact_id)

    client.calls.clear()
    summary = run_fetch(client, source=repo, current=CURRENT, artifact_id="1", now=NOW)
    check("artifact_id: 1" in summary, summary)
    check("artifact_sha256:" in summary, summary)
    downloaded = [path for kind, path in client.calls if kind == "bytes"]
    check(any("/artifacts/1/zip" in path for path in downloaded), str(downloaded))
    check(all("/artifacts/2/zip" not in path for path in downloaded), str(downloaded))


def test_execute_rechecks_the_pin() -> None:
    pin = {
        "artifact_id": "5",
        "artifact_name": "sql-backup-20261014T150405Z",
        "workflow_run_id": "9",
        "artifact_sha256": "a" * 64,
        "source_repository": REPO,
    }
    sql_restore.assert_pinned_artifact(
        pin,
        source=REPO,
        artifact_id="5",
        expect_name=pin["artifact_name"],
        expect_run="9",
        expect_sha256="a" * 64,
        require_digest=True,
    )
    try:
        sql_restore.assert_pinned_artifact(
            pin,
            source=REPO,
            artifact_id="5",
            expect_name=pin["artifact_name"],
            expect_run="9",
            expect_sha256="b" * 64,
            require_digest=True,
        )
    except sql_restore.RestoreError as exc:
        check("digest" in str(exc), str(exc))
    else:
        fail("a changed digest was accepted")

    keys = (
        "SQL_RESTORE_DESTINATION_NAME",
        "SQL_RESTORE_DESTINATION_HOST",
        "SQL_RESTORE_DATABASE_NAME",
        "SQL_RESTORE_DB_URL",
        "GITHUB_ACTIONS",
    )
    saved = {key: os.environ.get(key) for key in keys}
    os.environ["SQL_RESTORE_DESTINATION_NAME"] = "nagd-dkp"
    os.environ["SQL_RESTORE_DESTINATION_HOST"] = "127.0.0.1"
    os.environ["SQL_RESTORE_DATABASE_NAME"] = "postgres"
    os.environ.pop("SQL_RESTORE_DB_URL", None)
    os.environ.pop("GITHUB_ACTIONS", None)
    try:
        sql_restore.run_restore(
            [
                "--execute",
                "--source",
                CURRENT,
                "--current-repository",
                CURRENT,
                "--artifact-id",
                "123",
                "--destination-name",
                "nagd-dkp",
                "--confirm",
                "RESTORE nagd-dkp",
            ]
        )
    except sql_restore.RestoreError as exc:
        message = str(exc)
        check("digest" in message, message)
        check("SQL_RESTORE_DB_URL" not in message, message)
    else:
        fail("execute resolved an artifact without the preflight pin")
    finally:
        for key, previous in saved.items():
            if previous is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = previous


def test_workflow_choices_stay_static() -> None:
    text = (ROOT / ".github/workflows/db-restore-sql.yml").read_text(encoding="utf-8")
    block = text.split("      checkpoint:\n", 1)[1].split("      checkpoint_name:\n", 1)[0]
    options = [line.strip()[2:] for line in block.splitlines() if line.strip().startswith("- ")]
    check(options == list(sql_backup_fetch.CHECKPOINT_CHOICES), str(options))
    artifact_input = text.split("      artifact_id:\n", 1)[1].split("permissions:", 1)[0]
    check("required: false" in artifact_input, artifact_input)
    check("destination_name:" in text, "destination name is missing from the workflow")
    check("confirm:" in text, "typed confirmation is missing from the workflow")
    operation = text.split("      operation:\n", 1)[1].split("      source_repository:\n", 1)[0]
    operation_options = [line.strip()[2:] for line in operation.splitlines() if line.strip().startswith("- ")]
    check(
        operation_options == ["List available backups", "Dry-run restore", "Restore"],
        str(operation_options),
    )
    source = text.split("      source_repository:\n", 1)[1].split("      source_repository_name:\n", 1)[0]
    source_options = [line.strip()[2:] for line in source.splitlines() if line.strip().startswith("- ")]
    check(
        source_options == ["Current repository", "Rimi staging", "Other discovered fork"],
        str(source_options),
    )
    check("environment: sql-restore" in text, text)
    check(text.count("environment: sql-restore") == 1, "restore asks for environment approval more than once")
    listing = text.split("\n  list:", 1)[1].split("\n  preflight:", 1)[0]
    check("environment:" not in listing, "list waits for restore approval")
    preflight = text.split("\n  preflight:", 1)[1].split("\n  restore:", 1)[0]
    check("environment:" not in preflight, "dry-run waits for restore approval")
    restore = text.split("\n  restore:", 1)[1]
    check("refs/heads/main" in restore.split("steps:", 1)[0], "restore is not limited to main")
    check("inputs.checkpoint" not in restore, "restore job resolves the checkpoint again")
    check("inputs.artifact_id" not in restore, "restore job reads the form artifact id")
    check("needs.preflight.outputs.artifact_id" in restore, restore)
    check("needs.preflight.outputs.artifact_sha256" in restore, restore)
    check("--check-protection" in restore, "destructive restore does not check environment protection")
    check("success()" in restore.split("steps:", 1)[0], "restore can run after a failed preflight")


def main() -> None:
    test_latest_previous_and_retention_copies()
    test_exact_name_and_duplicates()
    test_expired_sibling_and_missing_checkpoints()
    test_missing_weekly_is_not_replaced()
    test_ambiguous_run_is_not_collapsed()
    test_numeric_id_and_conflict()
    test_wrong_source_and_permission()
    test_pin_ignores_a_newer_backup()
    test_execute_rechecks_the_pin()
    test_workflow_choices_stay_static()
    print("sql restore checkpoint tests passed")


if __name__ == "__main__":
    main()
