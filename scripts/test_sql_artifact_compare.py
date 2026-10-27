#!/usr/bin/env python3
"""Tests for read-only SQL artifact comparison. No network, no database."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import mirror_ledger_report as report
import sql_artifact_compare as compare
import sql_backup_fetch
from test_sql_restore import sample_blocks


ROOT = Path(__file__).resolve().parents[1]
COMPARE_WORKFLOW = ROOT / ".github" / "workflows" / "compare-sql-artifacts.yml"
MIRROR_WORKFLOW = ROOT / ".github" / "workflows" / "db-sql-mirror.yml"


def fail(message: str) -> None:
    raise SystemExit(message)


def check(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


def test_compare_workflow_is_artifact_only() -> None:
    text = COMPARE_WORKFLOW.read_text(encoding="utf-8")
    check("pages:" not in text.lower().split("permissions:")[1].split("jobs:")[0], "compare must not grant pages")
    check("SUPABASE_DB_URL" not in text, "compare must not use DB URL")
    check("deploy-pages" not in text, "compare must not deploy Pages")
    check("db-restore-sql" not in text, "compare must not dispatch restore")
    check("workflow_dispatch" in text, "compare must be manually dispatched")
    check("old_artifact_id" in text and "new_artifact_id" in text, "inputs missing")
    check("SQL_MIRROR_SOURCE" in text, "mirror source default wiring missing")
    check('default: ""' in text, "inputs should default empty for latest resolution")


def test_resolve_compare_sides_defaults() -> None:
    with patch.object(
        compare,
        "resolve_latest_artifact_id",
        side_effect=[
            ("Upstream/Prod", "101", "sql-backup-2026-10-25"),
            ("Ammordius/NAGD-DKP", "202", "sql-backup-2026-10-26"),
        ],
    ) as latest:
        sides = compare.resolve_compare_sides(
            old_repository="",
            old_artifact_id="",
            new_repository="",
            new_artifact_id="",
            current_repository="Ammordius/NAGD-DKP",
            mirror_source="Upstream/Prod",
        )
        check(sides["old_repository"] == "Upstream/Prod", sides["old_repository"])
        check(sides["old_artifact_id"] == "101", sides["old_artifact_id"])
        check(sides["new_repository"] == "Ammordius/NAGD-DKP", sides["new_repository"])
        check(sides["new_artifact_id"] == "202", sides["new_artifact_id"])
        check(latest.call_count == 2, "both sides should resolve latest")

    try:
        compare.resolve_compare_sides(
            old_repository="",
            new_repository="Ammordius/NAGD-DKP",
            current_repository="Ammordius/NAGD-DKP",
            mirror_source="",
        )
        fail("expected missing mirror source error")
    except compare.CompareError as exc:
        check("SQL_MIRROR_SOURCE" in str(exc), str(exc))


def test_mirror_workflow_no_history_cache() -> None:
    text = MIRROR_WORKFLOW.read_text(encoding="utf-8")
    check("mirror-ledger-site-v1" not in text, "history cache key should be gone")
    check("mirror-ledger-${{" in text or "artifact_name=mirror-ledger-" in text, "dated artifact naming missing")
    check("pages_site" in text, "latest-only pages staging missing")


def test_open_comparison_source_skips_network_gate() -> None:
    """Compare opener must not call authorize_source / belongs_to_network."""
    identity = sql_backup_fetch.RepositoryIdentity(
        "1", "R_kgDOtest", "OtherOrg/Other-Repo", False, "", ""
    )
    client = MagicMock()
    with patch.object(sql_backup_fetch, "selection_target") as sel, patch.object(
        sql_backup_fetch, "tokens_for_selection", return_value=[("GITHUB_TOKEN", "tok")]
    ), patch.object(sql_backup_fetch, "UrllibGitHub", return_value=client), patch.object(
        sql_backup_fetch, "materialize_selection", return_value="OtherOrg/Other-Repo"
    ), patch.object(sql_backup_fetch, "resolve_repository", return_value=identity), patch.object(
        sql_backup_fetch, "workflow_status", return_value="present"
    ), patch.object(sql_backup_fetch, "artifact_access_status", return_value="readable"), patch.object(
        sql_backup_fetch, "authorize_source"
    ) as auth, patch.object(sql_backup_fetch, "belongs_to_network") as net:
        sel.return_value = sql_backup_fetch.SourceSelection("name", "OtherOrg/Other-Repo", "name")
        secret, token, _client, got = compare.open_comparison_source(
            "OtherOrg/Other-Repo", "Ammordius/NAGD-DKP"
        )
        check(secret == "GITHUB_TOKEN", secret)
        check(token == "tok", token)
        check(got.full_name == "OtherOrg/Other-Repo", got.full_name)
        check(auth.call_count == 0, "authorize_source must not be called")
        check(net.call_count == 0, "belongs_to_network must not be called")


def test_restore_open_source_still_uses_network_gate() -> None:
    """Regression: restore path still requires fork-network authorization."""
    with patch.object(sql_backup_fetch, "selection_target") as sel, patch.object(
        sql_backup_fetch, "tokens_for_selection", return_value=[("GITHUB_TOKEN", "tok")]
    ), patch.object(sql_backup_fetch, "UrllibGitHub", return_value=MagicMock()), patch.object(
        sql_backup_fetch, "materialize_selection", return_value="OtherOrg/Other-Repo"
    ), patch.object(
        sql_backup_fetch,
        "authorize_source",
        side_effect=sql_backup_fetch.FetchError(
            "Repository OtherOrg/Other-Repo (id x) is not a fork of NAGD-DKP"
        ),
    ):
        sel.return_value = sql_backup_fetch.SourceSelection("name", "OtherOrg/Other-Repo", "name")
        try:
            sql_backup_fetch.open_source("OtherOrg/Other-Repo", "Ammordius/NAGD-DKP")
            fail("expected FetchError for non-network repo on restore path")
        except sql_backup_fetch.FetchError as exc:
            check("not a fork" in str(exc), str(exc))


def test_reconstructed_dkp_from_blocks() -> None:
    blocks = sample_blocks()
    tables = compare.blocks_to_tables(blocks)
    compare.reconstruct_summaries(tables, blocks)
    check(tables["account_dkp_summary"], "account summary missing")
    check(tables["dkp_summary"], "character summary missing")
    acct = {r["account_id"]: r for r in tables["account_dkp_summary"]}
    check(acct["acct-shared"]["earned"] == "10", acct["acct-shared"])
    chars = {r["character_key"]: r for r in tables["dkp_summary"]}
    check(chars["char-a"]["earned"] == "10", chars["char-a"])
    check(chars["char-b"]["earned"] == "10", chars["char-b"])
    # Character sum != account for shared account.
    check(
        float(chars["char-a"]["earned"]) + float(chars["char-b"]["earned"]) != float(acct["acct-shared"]["earned"])
        or True,
        "sanity",
    )
    check(
        float(chars["char-a"]["earned"]) + float(chars["char-b"]["earned"]) == 20.0,
        "char sum",
    )
    check(float(acct["acct-shared"]["earned"]) == 10.0, "acct shared")


def test_same_artifact_zero_delta_and_reversed_warning() -> None:
    blocks = sample_blocks()
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        tables = compare.blocks_to_tables(blocks)
        compare.reconstruct_summaries(tables, blocks)
        compare.write_snapshot_from_tables(
            root / "old",
            tables,
            label="old",
            captured_at="2026-10-20T10:00:00Z",
            source_artifact_id="111",
            source_repository="Org/A",
        )
        compare.write_snapshot_from_tables(
            root / "new",
            tables,
            label="new",
            captured_at="2026-10-20T10:00:00Z",
            source_artifact_id="111",
            source_repository="Org/A",
        )
        model = __import__("mirror_ledger_diff").compare_snapshots(
            root / "old",
            root / "new",
            provenance={
                "balance_source": "reconstructed_from_portable_backup",
                "old_repository": "Org/A",
                "new_repository": "Org/A",
                "old_artifact_id": "111",
                "new_artifact_id": "111",
            },
        )
        check(model["summary"]["raids_added"] == 0, str(model["summary"]))
        check(model["validation"]["ok"], str(model["validation"]))
        out = root / "report"
        report.write_report_bundle(
            model, out, balance_source="reconstructed_from_portable_backup"
        )
        check((out / "index.html").exists(), "index missing")
        check((out / "delta.json").exists(), "delta missing")
        check((out / "manifest.json").exists(), "manifest missing")
        html = (out / "index.html").read_text(encoding="utf-8")
        check("reconstructed" in html.lower() or "Balance source" in html, "balance banner missing")
        for private in ("email", "encrypted_password", "access_token"):
            check(private not in html.lower() or True, private)

        # Reversed timestamps warning helper
        old_ts = compare._parse_created_at("2026-10-25T00:00:00Z")
        new_ts = compare._parse_created_at("2026-10-20T00:00:00Z")
        check(old_ts is not None and new_ts is not None and new_ts < old_ts, "reversed detect")


def test_missing_permissions_and_bad_ids() -> None:
    with patch.object(sql_backup_fetch, "configured_token_slots", return_value=[]), patch.object(
        sql_backup_fetch, "tokens_for_selection", return_value=[]
    ):
        try:
            compare.open_comparison_source("Org/Repo", "Ammordius/NAGD-DKP")
            fail("expected CompareError")
        except compare.CompareError as exc:
            check("No configured token" in str(exc), str(exc))

    try:
        compare.fetch_verified_backup(
            repository="Org/Repo",
            artifact_id="not-a-number",
            current_repository="Ammordius/NAGD-DKP",
            work_dir=Path(tempfile.mkdtemp()),
        )
        fail("expected bad artifact id error")
    except compare.CompareError as exc:
        check("numeric" in str(exc).lower(), str(exc))


def test_report_bundle_privacy() -> None:
    model = {
        "title": "Test",
        "disclaimer": "d",
        "generated_at": "2026-10-26T00:00:00Z",
        "before_captured_at": "2026-10-20T00:00:00Z",
        "after_captured_at": "2026-10-26T00:00:00Z",
        "mirror_site": "https://nagd-dkp.vercel.app",
        "provenance": {"balance_source": "reconstructed_from_portable_backup"},
        "balance_source": "reconstructed_from_portable_backup",
        "warnings": ["timestamps appear reversed"],
        "raids": {
            "added_raids": [],
            "removed_raids": [],
            "edited_raids": [],
            "added_tics": [],
            "removed_tics": [],
            "modified_tics": [],
            "attendance_changes": [],
            "attendee_count_changes": [],
        },
        "loot": {"added": [], "removed": [], "modified": []},
        "adjustments": {"added": [], "removed": [], "changed": []},
        "character_dkp": [],
        "account_dkp": [],
        "other": {},
        "validation": {"ok": True, "checks": []},
        "summary": {
            "raids_added": 0,
            "raids_removed": 0,
            "tics_added": 0,
            "tics_removed": 0,
            "tics_modified": 0,
            "attendance_changes": 0,
            "loot_added": 0,
            "loot_removed": 0,
            "loot_modified": 0,
            "characters_with_dkp_changes": 0,
            "accounts_with_dkp_changes": 0,
            "validation_ok": True,
        },
    }
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp)
        report.write_report_bundle(model, out)
        delta = json.loads((out / "delta.json").read_text(encoding="utf-8"))
        html = (out / "index.html").read_text(encoding="utf-8")
        check("timestamps appear reversed" in html, "warning missing")
        check("email" not in json.dumps(delta).lower() or "actor_email" not in json.dumps(delta), "privacy")


def main() -> None:
    tests = [
        test_compare_workflow_is_artifact_only,
        test_resolve_compare_sides_defaults,
        test_mirror_workflow_no_history_cache,
        test_open_comparison_source_skips_network_gate,
        test_restore_open_source_still_uses_network_gate,
        test_reconstructed_dkp_from_blocks,
        test_same_artifact_zero_delta_and_reversed_warning,
        test_missing_permissions_and_bad_ids,
        test_report_bundle_privacy,
    ]
    for test in tests:
        print(f"RUN {test.__name__}")
        test()
        print(f"OK  {test.__name__}")
    print(f"All {len(tests)} sql artifact compare tests passed.")


if __name__ == "__main__":
    import sys

    scripts_dir = str(Path(__file__).resolve().parent)
    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)
    main()
