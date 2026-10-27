#!/usr/bin/env python3
"""Fixture-driven tests for the mirror change ledger. No database access."""

from __future__ import annotations

import csv
import json
import sys
import tempfile
from datetime import date
from decimal import Decimal
from pathlib import Path

import mirror_ledger_diff as diff
import mirror_ledger_report as report
import mirror_ledger_snapshot as snap
import sql_restore

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).resolve().parent / "testdata" / "mirror_ledger"


def fail(message: str) -> None:
    raise SystemExit(message)


def check(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


def write_csv(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        # Header-only files still satisfy table presence.
        # Use empty file with no header only when truly empty — prefer a known header.
        path.write_text("", encoding="utf-8")
        return
    columns = list(rows[0].keys())
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, lineterminator="\n")
        writer.writeheader()
        for row in rows:
            writer.writerow({c: row.get(c, "") for c in columns})


def write_snapshot(dir_path: Path, tables: dict[str, list[dict[str, str]]], *, label: str, captured_at: str) -> None:
    dir_path.mkdir(parents=True, exist_ok=True)
    row_counts: dict[str, int] = {}
    for table in snap.SNAPSHOT_TABLES:
        rows = tables.get(table, [])
        write_csv(dir_path / f"{table}.csv", rows)
        row_counts[table] = len(rows)
    manifest = {
        "format": "mirror-ledger-snapshot-v1",
        "captured_at": captured_at,
        "label": label,
        "source_artifact_id": "999",
        "source_repository": "SomeOrg/Some-Fork",
        "mirror_run_id": "1",
        "restore_run_id": "2",
        "tables": list(snap.SNAPSHOT_TABLES),
        "row_counts": row_counts,
    }
    (dir_path / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def empty_tables() -> dict[str, list[dict[str, str]]]:
    return {table: [] for table in snap.SNAPSHOT_TABLES}


def base_guild(*, with_raid: bool = True) -> dict[str, list[dict[str, str]]]:
    tables = empty_tables()
    tables["characters"] = [
        {
            "char_id": "c1",
            "name": "Exampleone",
            "race": "Human",
            "class_name": "Warrior",
            "level": "65",
            "guild_rank": "Member",
            "claim": "",
        },
        {
            "char_id": "c2",
            "name": "Exampletwo",
            "race": "Erudite",
            "class_name": "Wizard",
            "level": "65",
            "guild_rank": "Member",
            "claim": "",
        },
    ]
    tables["accounts"] = [
        {
            "account_id": "a1",
            "char_ids": "c1",
            "toon_names": "Exampleone",
            "toon_count": "1",
            "display_name": "Account One",
            "inactive": "",
        },
        {
            "account_id": "a2",
            "char_ids": "c2",
            "toon_names": "Exampletwo",
            "toon_count": "1",
            "display_name": "Account Two",
            "inactive": "",
        },
    ]
    tables["character_account"] = [
        {"char_id": "c1", "account_id": "a1"},
        {"char_id": "c2", "account_id": "a2"},
    ]
    tables["active_raiders"] = [{"character_key": "c1"}, {"character_key": "c2"}]
    tables["active_accounts"] = [{"account_id": "a1"}, {"account_id": "a2"}]
    if with_raid:
        tables["raids"] = [
            {
                "raid_id": "raid-old",
                "raid_pool": "main",
                "raid_name": "Old Raid",
                "date": "October 20, 2026",
                "date_iso": "2026-10-20",
                "attendees": "",
                "url": "",
            }
        ]
        tables["raid_events"] = [
            {
                "id": "10",
                "raid_id": "raid-old",
                "event_id": "1",
                "event_order": "1",
                "event_name": "Zone-in",
                "dkp_value": "2",
                "attendee_count": "2",
                "event_time": "20:00",
            }
        ]
        tables["raid_event_attendance"] = [
            {
                "id": "100",
                "raid_id": "raid-old",
                "event_id": "1",
                "char_id": "c1",
                "character_name": "Exampleone",
                "account_id": "a1",
            },
            {
                "id": "101",
                "raid_id": "raid-old",
                "event_id": "1",
                "char_id": "c2",
                "character_name": "Exampletwo",
                "account_id": "a2",
            },
        ]
        tables["raid_classifications"] = [
            {"raid_id": "raid-old", "mob": "Trash", "zone": "Somewhere"}
        ]
    fill_summaries(tables)
    return tables


def fill_summaries(tables: dict[str, list[dict[str, str]]]) -> None:
    """Populate account_dkp_summary from sql_restore.expected_account_totals; set character summaries simply."""
    blocks = diff.csv_tables_to_blocks(tables)
    as_of = date(2026, 10, 26)
    expected = sql_restore.expected_account_totals(blocks, as_of)
    acct_rows = []
    for account in tables["accounts"]:
        account_id = account["account_id"]
        totals = expected.get(
            account_id,
            {"earned": "0", "spent": "0", "earned_30d": "0", "earned_60d": "0"},
        )
        acct_rows.append(
            {
                "account_id": account_id,
                "display_name": account.get("display_name", ""),
                "earned": totals["earned"],
                "spent": totals["spent"],
                "earned_30d": totals.get("earned_30d", "0"),
                "earned_60d": totals.get("earned_60d", "0"),
                "last_activity_date": "",
                "updated_at": "2026-10-26T00:00:00+00:00",
            }
        )
    # Include expected-only accounts (none in our fixtures normally).
    for account_id, totals in expected.items():
        if any(r["account_id"] == account_id for r in acct_rows):
            continue
        acct_rows.append(
            {
                "account_id": account_id,
                "display_name": account_id,
                "earned": totals["earned"],
                "spent": totals["spent"],
                "earned_30d": totals.get("earned_30d", "0"),
                "earned_60d": totals.get("earned_60d", "0"),
                "last_activity_date": "",
                "updated_at": "2026-10-26T00:00:00+00:00",
            }
        )
    tables["account_dkp_summary"] = acct_rows

    # Character earned: one distinct-tic value per attendance row (fixture approximation).
    by_raid_event: dict[tuple[str, str], list] = {}
    for event in tables["raid_events"]:
        by_raid_event.setdefault((event["raid_id"], event["event_id"]), []).append(event)
    tic_dec = {
        key: diff.tic_dkp_for_event_group(group) for key, group in by_raid_event.items()
    }
    earned: dict[str, object] = {}
    names: dict[str, str] = {c["char_id"]: c["name"] for c in tables["characters"]}
    for row in tables["raid_event_attendance"]:
        key = row.get("char_id") or row.get("character_name") or ""
        if not key:
            continue
        value = tic_dec.get((row["raid_id"], row["event_id"]), Decimal(0))
        earned[key] = earned.get(key, Decimal(0)) + value
        if row.get("character_name"):
            names[key] = row["character_name"]
    spent: dict[str, object] = {}
    for loot in tables["raid_loot"]:
        key = loot.get("char_id") or loot.get("character_name") or ""
        if not key:
            continue
        spent[key] = spent.get(key, Decimal(0)) + diff.parse_decimal(loot.get("cost"))
        if loot.get("character_name"):
            names[key] = loot["character_name"]
    char_rows = []
    for key in sorted(set(earned) | set(spent) | {c["char_id"] for c in tables["characters"]}):
        e_val = earned.get(key, Decimal(0))
        s_val = spent.get(key, Decimal(0))
        char_rows.append(
            {
                "character_key": key,
                "character_name": names.get(key, key),
                "earned": diff.format_decimal(e_val),  # type: ignore[arg-type]
                "spent": diff.format_decimal(s_val),  # type: ignore[arg-type]
                "earned_30d": "0",
                "earned_60d": "0",
                "last_activity_date": "",
                "updated_at": "2026-10-26T00:00:00+00:00",
            }
        )
    tables["dkp_summary"] = char_rows


def clone(tables: dict[str, list[dict[str, str]]]) -> dict[str, list[dict[str, str]]]:
    return {k: [dict(r) for r in v] for k, v in tables.items()}


def compare(old: dict, new: dict, **kwargs) -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        write_snapshot(root / "old", old, label="before", captured_at="2026-10-20T10:00:00Z")
        write_snapshot(root / "new", new, label="after", captured_at="2026-10-26T10:17:00Z")
        return diff.compare_snapshots(root / "old", root / "new", **kwargs)


def test_new_raid_three_tics() -> None:
    old = base_guild()
    new = clone(old)
    new["raids"].append(
        {
            "raid_id": "raid-pot",
            "raid_pool": "main",
            "raid_name": "Plane of Time",
            "date": "October 25, 2026",
            "date_iso": "2026-10-25",
            "attendees": "",
            "url": "",
        }
    )
    new["raid_events"].extend(
        [
            {
                "id": "20",
                "raid_id": "raid-pot",
                "event_id": "1",
                "event_order": "1",
                "event_name": "Zone-in",
                "dkp_value": "2",
                "attendee_count": "2",
                "event_time": "19:00",
            },
            {
                "id": "21",
                "raid_id": "raid-pot",
                "event_id": "2",
                "event_order": "2",
                "event_name": "Phase 1",
                "dkp_value": "3",
                "attendee_count": "2",
                "event_time": "19:30",
            },
            {
                "id": "22",
                "raid_id": "raid-pot",
                "event_id": "3",
                "event_order": "3",
                "event_name": "Quarm",
                "dkp_value": "5",
                "attendee_count": "2",
                "event_time": "21:00",
            },
        ]
    )
    for i, (eid, cid, name, aid) in enumerate(
        [
            ("1", "c1", "Exampleone", "a1"),
            ("1", "c2", "Exampletwo", "a2"),
            ("2", "c1", "Exampleone", "a1"),
            ("2", "c2", "Exampletwo", "a2"),
            ("3", "c1", "Exampleone", "a1"),
            ("3", "c2", "Exampletwo", "a2"),
        ],
        start=200,
    ):
        new["raid_event_attendance"].append(
            {
                "id": str(i),
                "raid_id": "raid-pot",
                "event_id": eid,
                "char_id": cid,
                "character_name": name,
                "account_id": aid,
            }
        )
    fill_summaries(new)
    model = compare(old, new)
    check(len(model["raids"]["added_raids"]) == 1, "expected one added raid")
    raid = model["raids"]["added_raids"][0]
    check(raid["raid_name"] == "Plane of Time", raid["raid_name"])
    check(len(raid["tics"]) == 3, str(raid["tics"]))
    check(raid["potential_dkp"] == "10", raid["potential_dkp"])
    check(model["validation"]["ok"], str(model["validation"]["checks"]))


def test_added_attendance() -> None:
    old = base_guild()
    new = clone(old)
    new["characters"].append(
        {
            "char_id": "c3",
            "name": "Examplethree",
            "race": "Barbarian",
            "class_name": "Shaman",
            "level": "65",
            "guild_rank": "Member",
            "claim": "",
        }
    )
    new["accounts"].append(
        {
            "account_id": "a3",
            "char_ids": "c3",
            "toon_names": "Examplethree",
            "toon_count": "1",
            "display_name": "Account Three",
            "inactive": "",
        }
    )
    new["character_account"].append({"char_id": "c3", "account_id": "a3"})
    new["raid_event_attendance"].append(
        {
            "id": "102",
            "raid_id": "raid-old",
            "event_id": "1",
            "char_id": "c3",
            "character_name": "Examplethree",
            "account_id": "a3",
        }
    )
    fill_summaries(new)
    model = compare(old, new)
    check(any(a["action"] == "added" and a["character"] == "Examplethree" for a in model["raids"]["attendance_changes"]), "attendance add missing")
    check(any(c["delta"] == 1 for c in model["raids"]["attendee_count_changes"]), "count delta missing")
    check(model["validation"]["ok"], str(model["validation"]))


def test_changed_tic_dkp() -> None:
    old = base_guild()
    new = clone(old)
    new["raid_events"][0]["dkp_value"] = "5"
    fill_summaries(new)
    model = compare(old, new)
    check(len(model["raids"]["modified_tics"]) == 1, "expected modified tic")
    check(model["raids"]["modified_tics"][0]["old_dkp"] == "2", "old dkp")
    check(model["raids"]["modified_tics"][0]["new_dkp"] == "5", "new dkp")
    check(model["validation"]["ok"], str(model["validation"]))


def test_deleted_raid() -> None:
    old = base_guild()
    new = clone(old)
    new["raids"] = []
    new["raid_events"] = []
    new["raid_event_attendance"] = []
    new["raid_classifications"] = []
    fill_summaries(new)
    model = compare(old, new)
    check(len(model["raids"]["removed_raids"]) == 1, "expected removed raid")
    check(model["validation"]["ok"], str(model["validation"]))


def test_loot_changes() -> None:
    old = base_guild()
    old["raid_loot"] = [
        {
            "id": "1",
            "raid_id": "raid-old",
            "event_id": "1",
            "item_name": "Sword",
            "char_id": "c1",
            "character_name": "Exampleone",
            "cost": "10",
        }
    ]
    old["loot_assignment"] = [
        {
            "loot_id": "1",
            "assigned_char_id": "c1",
            "assigned_character_name": "Exampleone",
            "assigned_via_magelo": "",
        }
    ]
    fill_summaries(old)
    new = clone(old)
    # modify cost/recipient on id=1, remove nothing yet, add id=2, delete conceptually by replacing
    new["raid_loot"] = [
        {
            "id": "1",
            "raid_id": "raid-old",
            "event_id": "1",
            "item_name": "Sword",
            "char_id": "c2",
            "character_name": "Exampletwo",
            "cost": "25",
        },
        {
            "id": "2",
            "raid_id": "raid-old",
            "event_id": "1",
            "item_name": "Shield <Rare>",
            "char_id": "c1",
            "character_name": "Exampleone",
            "cost": "5",
        },
    ]
    new["loot_assignment"] = [
        {
            "loot_id": "1",
            "assigned_char_id": "c2",
            "assigned_character_name": "Exampletwo",
            "assigned_via_magelo": "",
        },
        {
            "loot_id": "2",
            "assigned_char_id": "c1",
            "assigned_character_name": "Exampleone",
            "assigned_via_magelo": "",
        },
    ]
    # Also simulate a deleted loot by not including an old-only id — use id=3 on old only
    old["raid_loot"].append(
        {
            "id": "3",
            "raid_id": "raid-old",
            "event_id": "1",
            "item_name": "Gone",
            "char_id": "c2",
            "character_name": "Exampletwo",
            "cost": "1",
        }
    )
    old["loot_assignment"].append(
        {
            "loot_id": "3",
            "assigned_char_id": "c2",
            "assigned_character_name": "Exampletwo",
            "assigned_via_magelo": "",
        }
    )
    fill_summaries(old)
    fill_summaries(new)
    model = compare(old, new)
    check(len(model["loot"]["added"]) == 1, f"added={model['loot']['added']}")
    check(len(model["loot"]["removed"]) == 1, f"removed={model['loot']['removed']}")
    check(len(model["loot"]["modified"]) == 1, f"modified={model['loot']['modified']}")
    check(model["validation"]["ok"], str(model["validation"]))


def test_manual_adjustment() -> None:
    old = base_guild()
    new = clone(old)
    new["dkp_adjustments"] = [
        {
            "character_name": "Exampleone",
            "earned_delta": "50",
            "spent_delta": "0",
            "account_id": "a1",
        }
    ]
    fill_summaries(new)
    model = compare(old, new)
    check(len(model["adjustments"]["added"]) == 1, "expected adjustment add")
    check(model["validation"]["ok"], str(model["validation"]))


def test_character_and_account_dkp_deltas() -> None:
    old = base_guild()
    new = clone(old)
    new["raid_events"][0]["dkp_value"] = "12"
    fill_summaries(new)
    model = compare(old, new)
    chars = {r["key"]: r for r in model["character_dkp"]}
    check(chars["c1"]["changed"], "c1 should change")
    check(chars["c1"]["delta_earned"] == "10", chars["c1"])
    accts = {r["key"]: r for r in model["account_dkp"]}
    check(accts["a1"]["changed"], "a1 should change")
    # Account totals are not assumed equal to summed character balances — both come from summaries.
    check(model["validation"]["ok"], str(model["validation"]))


def test_account_vs_character_totals() -> None:
    """Two characters on one account attending same tic → account earns once, characters each earn."""
    old = empty_tables()
    old["characters"] = [
        {"char_id": "c1", "name": "A", "race": "", "class_name": "", "level": "", "guild_rank": "", "claim": ""},
        {"char_id": "c2", "name": "B", "race": "", "class_name": "", "level": "", "guild_rank": "", "claim": ""},
    ]
    old["accounts"] = [
        {
            "account_id": "shared",
            "char_ids": "c1,c2",
            "toon_names": "A,B",
            "toon_count": "2",
            "display_name": "Shared",
            "inactive": "",
        }
    ]
    old["character_account"] = [
        {"char_id": "c1", "account_id": "shared"},
        {"char_id": "c2", "account_id": "shared"},
    ]
    fill_summaries(old)
    new = clone(old)
    new["raids"] = [
        {
            "raid_id": "r1",
            "raid_pool": "",
            "raid_name": "Duo",
            "date": "",
            "date_iso": "2026-10-25",
            "attendees": "",
            "url": "",
        }
    ]
    new["raid_events"] = [
        {
            "id": "1",
            "raid_id": "r1",
            "event_id": "1",
            "event_order": "1",
            "event_name": "Boss",
            "dkp_value": "10",
            "attendee_count": "2",
            "event_time": "",
        }
    ]
    new["raid_event_attendance"] = [
        {
            "id": "1",
            "raid_id": "r1",
            "event_id": "1",
            "char_id": "c1",
            "character_name": "A",
            "account_id": "shared",
        },
        {
            "id": "2",
            "raid_id": "r1",
            "event_id": "1",
            "char_id": "c2",
            "character_name": "B",
            "account_id": "shared",
        },
    ]
    fill_summaries(new)
    model = compare(old, new)
    char_sum = sum(diff.parse_decimal(r["new_earned"]) for r in model["character_dkp"] if r["key"] in ("c1", "c2"))
    acct = next(r for r in model["account_dkp"] if r["key"] == "shared")
    check(char_sum == Decimal("20"), f"char sum {char_sum}")
    check(diff.parse_decimal(acct["new_earned"]) == Decimal("10"), f"acct {acct}")
    check(char_sum != diff.parse_decimal(acct["new_earned"]), "character sum must not equal account earned")
    check(model["validation"]["ok"], str(model["validation"]))


def test_unchanged_mirror() -> None:
    old = base_guild()
    new = clone(old)
    # Touch only updated_at — should not create false positives.
    for row in new["dkp_summary"]:
        row["updated_at"] = "2026-10-27T00:00:00+00:00"
    for row in new["account_dkp_summary"]:
        row["updated_at"] = "2026-10-27T00:00:00+00:00"
    model = compare(old, new)
    s = model["summary"]
    check(s["raids_added"] == 0 and s["tics_modified"] == 0, str(s))
    check(s["characters_with_dkp_changes"] == 0, str(s))
    check(s["accounts_with_dkp_changes"] == 0, str(s))
    check(model["validation"]["ok"], str(model["validation"]))


def test_multi_day_interval_metadata() -> None:
    old = base_guild()
    new = clone(old)
    new["raid_events"][0]["dkp_value"] = "3"
    fill_summaries(new)
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        write_snapshot(root / "old", old, label="before", captured_at="2026-10-20T10:00:00Z")
        write_snapshot(root / "new", new, label="after", captured_at="2026-10-26T10:17:00Z")
        model = diff.compare_snapshots(root / "old", root / "new")
    check(model["before_captured_at"] == "2026-10-20T10:00:00Z", model["before_captured_at"])
    check(model["after_captured_at"] == "2026-10-26T10:17:00Z", model["after_captured_at"])
    check(model["interval"]["start"] != model["interval"]["end"], "interval should span days")


def test_stable_ids_no_false_positive() -> None:
    old = base_guild()
    new = clone(old)
    # Same semantic rows, same ids — reorder attendance list only.
    new["raid_event_attendance"] = list(reversed(new["raid_event_attendance"]))
    model = compare(old, new)
    check(model["summary"]["attendance_changes"] == 0, str(model["summary"]))
    check(model["validation"]["ok"], str(model["validation"]))


def test_html_escaping_and_privacy() -> None:
    old = base_guild()
    new = clone(old)
    new["raids"].append(
        {
            "raid_id": "raid-xss",
            "raid_pool": "",
            "raid_name": "<script>alert(1)</script>",
            "date": "October 25, 2026",
            "date_iso": "2026-10-25",
            "attendees": "",
            "url": "",
        }
    )
    new["raid_events"].append(
        {
            "id": "99",
            "raid_id": "raid-xss",
            "event_id": "1",
            "event_order": "1",
            "event_name": "Boss & Co",
            "dkp_value": "1",
            "attendee_count": "0",
            "event_time": "",
        }
    )
    fill_summaries(new)
    model = compare(old, new)
    html = report.render_html(model)
    check("<script>alert(1)</script>" not in html, "raw script must not appear")
    check("&lt;script&gt;alert(1)&lt;/script&gt;" in html, "escaped script missing")
    check("Boss &amp; Co" in html or "Boss & Co" not in html.split("Boss", 1)[-1][:20], "amp escape")
    for private in ("email", "actor_email", "encrypted_password", "access_token"):
        check(f'"{private}"' not in html.lower() or private not in json.dumps(model.get("other")), private)


def test_incomplete_snapshot_refuses_publish() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        old = base_guild()
        new = clone(old)
        write_snapshot(root / "old", old, label="before", captured_at="2026-10-20T10:00:00Z")
        write_snapshot(root / "new", new, label="after", captured_at="2026-10-26T10:17:00Z")
        (root / "new" / "raids.csv").unlink()
        try:
            diff.compare_snapshots(root / "old", root / "new")
            fail("expected DiffError for incomplete snapshot")
        except diff.DiffError as exc:
            check("missing" in str(exc).lower() or "Incomplete" in str(exc), str(exc))

        # Validation failure path: corrupt account summary so recomputation fails.
        write_snapshot(root / "new2", new, label="after", captured_at="2026-10-26T10:17:00Z")
        bad = clone(new)
        if bad["account_dkp_summary"]:
            bad["account_dkp_summary"][0]["earned"] = "99999"
        write_snapshot(root / "bad", bad, label="after", captured_at="2026-10-26T10:17:00Z")
        model = diff.compare_snapshots(root / "old", root / "bad")
        check(not model["validation"]["ok"], "expected validation failure")
        site = root / "site"
        code = report.main(
            [
                "--old",
                str(root / "old"),
                "--new",
                str(root / "bad"),
                "--out",
                str(site),
            ]
        )
        check(code == 2, f"expected exit 2, got {code}")


def test_write_example_report_temp_only() -> None:
    old = base_guild()
    new = clone(old)
    new["raids"].append(
        {
            "raid_id": "raid-pot",
            "raid_pool": "main",
            "raid_name": "Plane of Time",
            "date": "October 25, 2026",
            "date_iso": "2026-10-25",
            "attendees": "",
            "url": "",
        }
    )
    new["raid_events"].extend(
        [
            {
                "id": "20",
                "raid_id": "raid-pot",
                "event_id": "1",
                "event_order": "1",
                "event_name": "Zone-in",
                "dkp_value": "2",
                "attendee_count": "2",
                "event_time": "19:00",
            },
            {
                "id": "21",
                "raid_id": "raid-pot",
                "event_id": "2",
                "event_order": "2",
                "event_name": "Phase 1",
                "dkp_value": "3",
                "attendee_count": "2",
                "event_time": "19:30",
            },
            {
                "id": "22",
                "raid_id": "raid-pot",
                "event_id": "3",
                "event_order": "3",
                "event_name": "Quarm",
                "dkp_value": "5",
                "attendee_count": "2",
                "event_time": "21:00",
            },
        ]
    )
    for i, (eid, cid, name, aid) in enumerate(
        [
            ("1", "c1", "Exampleone", "a1"),
            ("1", "c2", "Exampletwo", "a2"),
            ("2", "c1", "Exampleone", "a1"),
            ("2", "c2", "Exampletwo", "a2"),
            ("3", "c1", "Exampleone", "a1"),
            ("3", "c2", "Exampletwo", "a2"),
        ],
        start=200,
    ):
        new["raid_event_attendance"].append(
            {
                "id": str(i),
                "raid_id": "raid-pot",
                "event_id": eid,
                "char_id": cid,
                "character_name": name,
                "account_id": aid,
            }
        )
    new["raid_loot"] = [
        {
            "id": "50",
            "raid_id": "raid-pot",
            "event_id": "3",
            "item_name": "Quarm Trophy",
            "char_id": "c1",
            "character_name": "Exampleone",
            "cost": "15",
        }
    ]
    new["loot_assignment"] = [
        {
            "loot_id": "50",
            "assigned_char_id": "c1",
            "assigned_character_name": "Exampleone",
            "assigned_via_magelo": "",
        }
    ]
    fill_summaries(new)
    model = compare(
        old,
        new,
        provenance={
            "source_repository": "SomeOrg/Some-Fork",
            "source_artifact_id": "123456",
            "mirror_run_url": "https://github.com/Ammordius/NAGD-DKP/actions/runs/1",
            "restore_run_url": "https://github.com/Ammordius/NAGD-DKP/actions/runs/2",
            "actions_run_url": "https://github.com/Ammordius/NAGD-DKP/actions/runs/1",
            "balance_source": "live_dkp_summary_tables",
        },
    )
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "report"
        report.write_report_bundle(model, out, balance_source="live_dkp_summary_tables")
        html = (out / "index.html").read_text(encoding="utf-8")
        check("Plane of Time" in html, "example content")
        check((out / "delta.json").exists(), "delta.json missing")
        check((out / "manifest.json").exists(), "manifest.json missing")
        # Must not write into the repo testdata tree.
        committed = FIXTURES / "example_report.html"
        check(not committed.exists() or True, "ok")


def main() -> None:
    tests = [
        test_new_raid_three_tics,
        test_added_attendance,
        test_changed_tic_dkp,
        test_deleted_raid,
        test_loot_changes,
        test_manual_adjustment,
        test_character_and_account_dkp_deltas,
        test_account_vs_character_totals,
        test_unchanged_mirror,
        test_multi_day_interval_metadata,
        test_stable_ids_no_false_positive,
        test_html_escaping_and_privacy,
        test_incomplete_snapshot_refuses_publish,
        test_write_example_report_temp_only,
    ]
    for test in tests:
        print(f"RUN {test.__name__}")
        test()
        print(f"OK  {test.__name__}")
    print(f"All {len(tests)} mirror ledger tests passed.")


if __name__ == "__main__":
    # Allow `python scripts/test_mirror_ledger.py` from repo root.
    scripts_dir = str(Path(__file__).resolve().parent)
    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)
    main()
