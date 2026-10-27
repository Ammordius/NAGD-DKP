#!/usr/bin/env python3
"""Read-only comparison of two portable SQL backup artifacts.

Does not restore into any database and does not use authorize_source /
NAGD fork-network gating. Restore authorization remains unchanged in
sql_backup_fetch.open_source / sql_restore.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import shutil
import sys
import tarfile
import tempfile
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

import mirror_ledger_diff as diff
import mirror_ledger_report as report
import mirror_ledger_snapshot as snap
import sql_backup
import sql_backup_fetch
import sql_restore

_DIGITS = re.compile(r"^[0-9]+$")


class CompareError(Exception):
    """Fail-closed comparison error. Messages must not contain secrets."""


def open_comparison_source(
    repository: str,
    current_repository: str = "",
) -> tuple[str, str, sql_backup_fetch.UrllibGitHub, sql_backup_fetch.RepositoryIdentity]:
    """Open a read-only artifact source without NAGD fork-network authorization.

    Requires a configured token that can resolve the repository and read Actions
    artifacts. Does not call authorize_source() or belongs_to_network().
    """
    current = (current_repository or os.environ.get("GITHUB_REPOSITORY", "")).strip()
    selection = sql_backup_fetch.selection_target(repository, "", current)
    slots = sql_backup_fetch.tokens_for_selection(selection)
    if not slots:
        # Non-current owner/name still may need any configured token.
        slots = sql_backup_fetch.configured_token_slots()
    if not slots:
        raise CompareError("No configured token can read that repository.")
    failures: list[str] = []
    for secret_name, token in slots:
        client = sql_backup_fetch.UrllibGitHub(token)
        try:
            name = sql_backup_fetch.materialize_selection(selection, client)
            identity = sql_backup_fetch.resolve_repository(client, name)
        except sql_backup_fetch.FetchError as exc:
            failures.append(f"{secret_name}: {exc}")
            continue
        status = sql_backup_fetch.workflow_status(client, identity.full_name)
        if status != "present":
            failures.append(
                f"{secret_name}: no compatible SQL backup workflow ({status})"
            )
            continue
        access = sql_backup_fetch.artifact_access_status(client, identity.full_name)
        if access == "readable":
            return secret_name, token, client, identity
        failures.append(f"{secret_name}: {access}")
    detail = "; ".join(failures)
    raise CompareError("No configured token can read that repository. " + detail)


def _parse_created_at(value: str) -> datetime | None:
    text = (value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def resolve_latest_artifact_id(
    repository: str,
    current_repository: str = "",
) -> tuple[str, str, str]:
    """Return (canonical_repo, artifact_id, artifact_name) for the latest SQL backup."""
    _secret, _token, client, origin = open_comparison_source(
        repository, current_repository
    )
    now = datetime.now(timezone.utc)
    try:
        snapshots = sql_backup_fetch.discover_snapshots(
            client, origin.full_name, now=now, per_page=sql_backup_fetch.PER_PAGE
        )
        selection = sql_backup_fetch.select_checkpoint(
            snapshots,
            checkpoint=sql_backup_fetch.CHECKPOINT_LATEST,
            artifact_id="",
            client=client,
            repo=origin.full_name,
            now=now,
            per_page=sql_backup_fetch.PER_PAGE,
        )
    except sql_backup_fetch.FetchError as exc:
        raise CompareError(str(exc)) from None
    return (
        origin.full_name,
        selection.artifact.artifact_id,
        selection.artifact.name,
    )


def resolve_compare_sides(
    *,
    old_repository: str = "",
    old_artifact_id: str = "",
    new_repository: str = "",
    new_artifact_id: str = "",
    current_repository: str = "",
    mirror_source: str = "",
) -> dict[str, str]:
    """Apply defaults: old=SQL_MIRROR_SOURCE latest, new=this repo latest.

    Explicit owner/name and numeric artifact ids still win when provided.
    """
    current = (current_repository or os.environ.get("GITHUB_REPOSITORY", "")).strip()
    mirror = (mirror_source or os.environ.get("SQL_MIRROR_SOURCE", "")).strip()

    old_repo = (old_repository or "").strip() or mirror
    new_repo = (new_repository or "").strip() or current
    if not old_repo:
        raise CompareError(
            "old_repository is empty and SQL_MIRROR_SOURCE is not set. "
            "Pass old_repository=owner/name or set the mirror source variable."
        )
    if not new_repo:
        raise CompareError(
            "new_repository is empty and the current repository is unknown. "
            "Pass new_repository=owner/name."
        )

    old_id = (old_artifact_id or "").strip()
    new_id = (new_artifact_id or "").strip()
    old_name = ""
    new_name = ""

    if old_id:
        if not _DIGITS.fullmatch(old_id):
            raise CompareError(f"old_artifact_id must be numeric, got {old_id!r}.")
        # Canonicalize repository name via comparison opener.
        _s, _t, _c, old_origin = open_comparison_source(old_repo, current)
        old_repo = old_origin.full_name
    else:
        old_repo, old_id, old_name = resolve_latest_artifact_id(old_repo, current)

    if new_id:
        if not _DIGITS.fullmatch(new_id):
            raise CompareError(f"new_artifact_id must be numeric, got {new_id!r}.")
        _s, _t, _c, new_origin = open_comparison_source(new_repo, current)
        new_repo = new_origin.full_name
    else:
        new_repo, new_id, new_name = resolve_latest_artifact_id(new_repo, current)

    return {
        "old_repository": old_repo,
        "old_artifact_id": old_id,
        "old_artifact_name": old_name,
        "new_repository": new_repo,
        "new_artifact_id": new_id,
        "new_artifact_name": new_name,
    }


def fetch_verified_backup(
    *,
    repository: str,
    artifact_id: str,
    current_repository: str,
    work_dir: Path,
) -> dict[str, Any]:
    """Download, decrypt, and verify one portable SQL artifact into work_dir."""
    artifact_id = (artifact_id or "").strip()
    if not artifact_id:
        _repo, artifact_id, _name = resolve_latest_artifact_id(
            repository, current_repository
        )
        repository = _repo
    elif not _DIGITS.fullmatch(artifact_id):
        raise CompareError(f"Artifact id must be numeric, got {artifact_id!r}.")
    identity_key = sql_backup_fetch._identity_from_env()
    if not identity_key:
        raise CompareError("Set SQL_BACKUP_AGE_IDENTITY to decrypt SQL backups.")
    if "AGE-SECRET-KEY-" not in identity_key:
        raise CompareError("SQL_BACKUP_AGE_IDENTITY is not an age identity.")

    secret_name, token, client, origin = open_comparison_source(
        repository, current_repository
    )
    del secret_name
    now = datetime.now(timezone.utc)
    try:
        artifact, run = sql_backup_fetch.resolve_artifact(
            client,
            origin.full_name,
            run_id=None,
            artifact_id=artifact_id,
            now=now,
            per_page=sql_backup_fetch.PER_PAGE,
        )
    except sql_backup_fetch.FetchError as exc:
        raise CompareError(str(exc)) from None

    run_id = str(run.get("id") or "")
    resolved_id = sql_backup_fetch._numeric_id(artifact.get("id"), "Artifact id")
    try:
        payload = client.get_bytes(
            f"/repos/{origin.full_name}/actions/artifacts/{resolved_id}/zip",
            sql_backup_fetch.MAX_ZIP_BYTES,
        )
        member_name, age_bytes = sql_backup_fetch._zip_member(payload)
    except sql_backup_fetch.FetchError as exc:
        raise CompareError(str(exc)) from None

    work_dir.mkdir(parents=True, exist_ok=True)
    age_path = work_dir / member_name
    age_path.write_bytes(age_bytes)
    tar_path = work_dir / "backup.tar.gz"
    schema_path = sql_backup.repo_root() / sql_backup.CANONICAL_SCHEMA
    try:
        try:
            sql_backup_fetch.decrypt_age(age_path, identity_key, tar_path)
            manifest = sql_backup_fetch.verify_plaintext(
                tar_path,
                source=origin.full_name,
                run_id=run_id,
                schema_path=schema_path,
                origin=origin,
                client=client,
                selected_name=repository,
            )
        except sql_backup_fetch.FetchError as exc:
            raise CompareError(str(exc)) from None

        try:
            with tarfile.open(tar_path, "r:gz") as archive:
                files = sql_backup_fetch._check_members(archive)
        except (tarfile.TarError, OSError, sql_backup_fetch.FetchError) as exc:
            raise CompareError(f"Archive could not be read: {exc}") from exc

        try:
            sql_text = files["data.sql"].decode("utf-8")
        except UnicodeError as exc:
            raise CompareError("data.sql is not valid UTF-8.") from exc

        try:
            blocks = sql_restore.parsed_blocks(sql_text)
            sql_restore.require_parsed_counts(blocks, manifest)
        except sql_restore.RestoreError as exc:
            raise CompareError(str(exc)) from None

        return {
            "repository": origin.full_name,
            "repository_id": origin.node_id,
            "artifact_id": str(resolved_id),
            "artifact_name": str(artifact.get("name") or ""),
            "workflow_run_id": run_id,
            "manifest": manifest,
            "blocks": blocks,
            "created_at": str(manifest.get("created_at") or ""),
            "snapshot_created_at": str(
                manifest.get("created_at")
                or artifact.get("created_at")
                or ""
            ),
        }
    finally:
        tar_path.unlink(missing_ok=True)
        age_path.unlink(missing_ok=True)


def blocks_to_tables(blocks: dict[str, dict]) -> dict[str, list[dict[str, str]]]:
    tables: dict[str, list[dict[str, str]]] = {t: [] for t in snap.SNAPSHOT_TABLES}
    for table in sql_backup.INCLUDED_TABLES:
        columns = blocks[table]["columns"]
        rows: list[dict[str, str]] = []
        for raw in blocks[table]["rows"]:
            row = {
                col: ("" if val is None else str(val))
                for col, val in zip(columns, raw)
            }
            rows.append(row)
        tables[table] = rows
    return tables


def _as_of_from_tables(tables: dict[str, list[dict[str, str]]]) -> date:
    raid_dates: list[date] = []
    for row in tables.get("raids", []):
        text = (row.get("date_iso") or "").strip()
        if len(text) >= 10:
            try:
                raid_dates.append(date.fromisoformat(text[:10]))
            except ValueError:
                pass
    return max(raid_dates) if raid_dates else date.today()


def reconstruct_summaries(
    tables: dict[str, list[dict[str, str]]],
    blocks: dict[str, dict],
) -> None:
    """Fill dkp_summary and account_dkp_summary from portable guild rows."""
    as_of = _as_of_from_tables(tables)
    account_totals = sql_restore.expected_account_totals(blocks, as_of)
    char_totals = sql_restore.expected_character_totals(blocks, as_of)

    account_names = {
        r.get("account_id", ""): r.get("display_name", "")
        for r in tables.get("accounts", [])
    }
    acct_rows = []
    for account_id, totals in sorted(account_totals.items()):
        acct_rows.append(
            {
                "account_id": account_id,
                "display_name": account_names.get(account_id, account_id),
                "earned": totals["earned"],
                "spent": totals["spent"],
                "earned_30d": totals.get("earned_30d", "0"),
                "earned_60d": totals.get("earned_60d", "0"),
                "last_activity_date": "",
                "updated_at": "",
            }
        )
    tables["account_dkp_summary"] = acct_rows

    char_rows = []
    for key, totals in sorted(char_totals.items()):
        char_rows.append(
            {
                "character_key": key,
                "character_name": totals.get("character_name", key),
                "earned": totals["earned"],
                "spent": totals["spent"],
                "earned_30d": totals.get("earned_30d", "0"),
                "earned_60d": totals.get("earned_60d", "0"),
                "last_activity_date": "",
                "updated_at": "",
            }
        )
    tables["dkp_summary"] = char_rows


def write_snapshot_from_tables(
    out_dir: Path,
    tables: dict[str, list[dict[str, str]]],
    *,
    label: str,
    captured_at: str,
    source_artifact_id: str,
    source_repository: str,
) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    row_counts: dict[str, int] = {}
    for table in snap.SNAPSHOT_TABLES:
        rows = tables.get(table, [])
        path = out_dir / f"{table}.csv"
        if not rows:
            # Still write a header for required derived tables when empty.
            if table in ("dkp_summary", "account_dkp_summary"):
                headers = (
                    [
                        "character_key",
                        "character_name",
                        "earned",
                        "spent",
                        "earned_30d",
                        "earned_60d",
                        "last_activity_date",
                        "updated_at",
                    ]
                    if table == "dkp_summary"
                    else [
                        "account_id",
                        "display_name",
                        "earned",
                        "spent",
                        "earned_30d",
                        "earned_60d",
                        "last_activity_date",
                        "updated_at",
                    ]
                )
                with path.open("w", encoding="utf-8", newline="") as handle:
                    csv.writer(handle, lineterminator="\n").writerow(headers)
            else:
                path.write_text("", encoding="utf-8")
            row_counts[table] = 0
            continue
        columns = list(rows[0].keys())
        with path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=columns, lineterminator="\n")
            writer.writeheader()
            for row in rows:
                writer.writerow({c: row.get(c, "") for c in columns})
        row_counts[table] = len(rows)
    manifest = {
        "format": "mirror-ledger-snapshot-v1",
        "captured_at": captured_at,
        "label": label,
        "source_artifact_id": source_artifact_id,
        "source_repository": source_repository,
        "tables": list(snap.SNAPSHOT_TABLES),
        "row_counts": row_counts,
        "balance_source": "reconstructed_from_portable_backup",
    }
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )


def materialize_backup_snapshot(payload: dict[str, Any], out_dir: Path, *, label: str) -> Path:
    tables = blocks_to_tables(payload["blocks"])
    reconstruct_summaries(tables, payload["blocks"])
    captured = payload.get("snapshot_created_at") or payload.get("created_at") or ""
    if not captured:
        captured = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    write_snapshot_from_tables(
        out_dir,
        tables,
        label=label,
        captured_at=captured,
        source_artifact_id=str(payload.get("artifact_id") or ""),
        source_repository=str(payload.get("repository") or ""),
    )
    return out_dir


def compare_artifacts(
    *,
    old_repository: str = "",
    old_artifact_id: str = "",
    new_repository: str = "",
    new_artifact_id: str = "",
    out_dir: Path,
    current_repository: str = "",
    mirror_source: str = "",
) -> dict[str, Any]:
    current = (current_repository or os.environ.get("GITHUB_REPOSITORY", "")).strip()
    sides = resolve_compare_sides(
        old_repository=old_repository,
        old_artifact_id=old_artifact_id,
        new_repository=new_repository,
        new_artifact_id=new_artifact_id,
        current_repository=current,
        mirror_source=mirror_source,
    )
    work = Path(tempfile.mkdtemp(prefix="sql-artifact-compare-"))
    warnings: list[str] = []
    try:
        old_work = work / "old"
        new_work = work / "new"
        old_payload = fetch_verified_backup(
            repository=sides["old_repository"],
            artifact_id=sides["old_artifact_id"],
            current_repository=current,
            work_dir=old_work,
        )
        new_payload = fetch_verified_backup(
            repository=sides["new_repository"],
            artifact_id=sides["new_artifact_id"],
            current_repository=current,
            work_dir=new_work,
        )

        if (
            old_payload["artifact_id"] == new_payload["artifact_id"]
            and old_payload["repository"].casefold() == new_payload["repository"].casefold()
        ):
            warnings.append(
                "The same artifact was selected twice; expecting a zero substantive delta."
            )

        old_ts = _parse_created_at(old_payload.get("snapshot_created_at", ""))
        new_ts = _parse_created_at(new_payload.get("snapshot_created_at", ""))
        if old_ts and new_ts and new_ts < old_ts:
            warnings.append(
                "Snapshot timestamps appear reversed: the selected 'new' artifact "
                f"({new_payload.get('snapshot_created_at')}) is older than 'old' "
                f"({old_payload.get('snapshot_created_at')})."
            )

        old_snap = work / "snap_old"
        new_snap = work / "snap_new"
        materialize_backup_snapshot(old_payload, old_snap, label="old")
        materialize_backup_snapshot(new_payload, new_snap, label="new")

        provenance = {
            "old_repository": old_payload["repository"],
            "old_artifact_id": old_payload["artifact_id"],
            "old_workflow_run_id": old_payload["workflow_run_id"],
            "new_repository": new_payload["repository"],
            "new_artifact_id": new_payload["artifact_id"],
            "new_workflow_run_id": new_payload["workflow_run_id"],
            "balance_source": "reconstructed_from_portable_backup",
            "warnings": warnings,
            "actions_run_url": "",
            "defaults": {
                "old_defaulted_from_mirror_source": not (old_repository or "").strip(),
                "new_defaulted_from_current_repository": not (new_repository or "").strip(),
                "old_artifact_defaulted_to_latest": not (old_artifact_id or "").strip(),
                "new_artifact_defaulted_to_latest": not (new_artifact_id or "").strip(),
            },
        }
        model = diff.compare_snapshots(
            old_snap,
            new_snap,
            provenance=provenance,
            require_manifest=True,
        )
        model["warnings"] = warnings
        model["balance_source"] = "reconstructed_from_portable_backup"
        model["title"] = "NAGD DKP — SQL Artifact Comparison"
        model["disclaimer"] = (
            "This report compares two portable SQL backup artifacts without restoring "
            "either into a database. Base character and account DKP balances are "
            "independently reconstructed from guild rows and do not include manual "
            "adjustments. This is not an officer audit trail."
        )
        report.write_report_bundle(
            model,
            out_dir,
            balance_source="reconstructed_from_portable_backup",
        )
        return model
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _write_github_output(fields: dict[str, str]) -> None:
    path = os.environ.get("GITHUB_OUTPUT", "").strip()
    if not path:
        return
    with open(path, "a", encoding="utf-8", newline="\n") as handle:
        for key, value in fields.items():
            if "\n" in value or "\r" in value:
                raise CompareError(f"Refusing multiline GitHub output for {key}.")
            handle.write(f"{key}={value}\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Compare two portable SQL backup artifacts (read-only, no DB). "
            "Defaults: old=SQL_MIRROR_SOURCE latest, new=current repository latest."
        )
    )
    parser.add_argument(
        "--old-repository",
        default="",
        help="Old owner/name (default: SQL_MIRROR_SOURCE)",
    )
    parser.add_argument(
        "--old-artifact-id",
        default="",
        help="Old numeric artifact id (default: latest SQL backup in that repo)",
    )
    parser.add_argument(
        "--new-repository",
        default="",
        help="New owner/name (default: current repository)",
    )
    parser.add_argument(
        "--new-artifact-id",
        default="",
        help="New numeric artifact id (default: latest SQL backup in that repo)",
    )
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--current-repository", default="")
    parser.add_argument(
        "--mirror-source",
        default="",
        help="Fallback old repository when --old-repository is empty (default: SQL_MIRROR_SOURCE env)",
    )
    args = parser.parse_args(argv)

    try:
        model = compare_artifacts(
            old_repository=args.old_repository,
            old_artifact_id=args.old_artifact_id,
            new_repository=args.new_repository,
            new_artifact_id=args.new_artifact_id,
            out_dir=args.out,
            current_repository=args.current_repository,
            mirror_source=args.mirror_source,
        )
    except CompareError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    ok = bool((model.get("validation") or {}).get("ok"))
    prov = model.get("provenance") or {}
    old_id = str(prov.get("old_artifact_id") or "")
    new_id = str(prov.get("new_artifact_id") or "")
    _write_github_output(
        {
            "old_repository": str(prov.get("old_repository") or ""),
            "old_artifact_id": old_id,
            "new_repository": str(prov.get("new_repository") or ""),
            "new_artifact_id": new_id,
            "artifact_name": f"sql-compare-{old_id}-vs-{new_id}",
        }
    )
    print(
        f"Wrote comparison {args.out} validation_ok={ok} "
        f"warnings={len(model.get('warnings') or [])} "
        f"old={prov.get('old_repository')}#{old_id} "
        f"new={prov.get('new_repository')}#{new_id}"
    )
    # Write step summary when running in Actions.
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY", "").strip()
    if summary_path:
        defaults = prov.get("defaults") or {}
        lines = [
            "## SQL artifact comparison",
            "",
            f"- Old: `{prov.get('old_repository')}` artifact `{old_id}`"
            + (" (default: mirror source latest)" if defaults.get("old_artifact_defaulted_to_latest") or defaults.get("old_defaulted_from_mirror_source") else ""),
            f"- New: `{prov.get('new_repository')}` artifact `{new_id}`"
            + (" (default: this repo latest)" if defaults.get("new_artifact_defaulted_to_latest") or defaults.get("new_defaulted_from_current_repository") else ""),
            f"- Validation: {'PASS' if ok else 'FAIL'}",
            f"- Balance source: `{model.get('balance_source')}`",
            "",
            "Download the workflow artifact for `index.html`, `delta.json`, and `manifest.json`.",
            "This job does not publish to GitHub Pages.",
            "",
        ]
        for warning in model.get("warnings") or []:
            lines.append(f"> Warning: {warning}")
            lines.append("")
        with open(summary_path, "a", encoding="utf-8", newline="\n") as handle:
            handle.write("\n".join(lines))
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
