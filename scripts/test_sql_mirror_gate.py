#!/usr/bin/env python3
"""Unit tests for sql_mirror_gate. No network, no database."""

from __future__ import annotations

from datetime import datetime, timezone

import sql_mirror_gate


NOW = datetime(2026, 10, 22, 10, 17, tzinfo=timezone.utc)


def fail(message: str) -> None:
    raise SystemExit(message)


def check(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


def main() -> None:
    decision, reason = sql_mirror_gate.decide(
        resolve_ok=False,
        artifact_id="",
        snapshot_created_at="",
        previous_artifact_id="",
        max_age_hours=36,
        force=False,
        now=NOW,
    )
    check(decision == "skip", "missing resolve should skip")
    check("could not be resolved" in reason, reason)

    decision, reason = sql_mirror_gate.decide(
        resolve_ok=True,
        artifact_id="",
        snapshot_created_at="2026-10-22T07:30:00Z",
        previous_artifact_id="",
        max_age_hours=36,
        force=False,
        now=NOW,
    )
    check(decision == "skip", "empty artifact should skip")
    check("did not pin" in reason, reason)

    decision, reason = sql_mirror_gate.decide(
        resolve_ok=True,
        artifact_id="12345",
        snapshot_created_at="2026-10-20T07:30:00Z",
        previous_artifact_id="",
        max_age_hours=36,
        force=False,
        now=NOW,
    )
    check(decision == "skip", "stale snapshot should skip")
    check("old" in reason, reason)

    decision, reason = sql_mirror_gate.decide(
        resolve_ok=True,
        artifact_id="12345",
        snapshot_created_at="2026-10-22T07:30:00Z",
        previous_artifact_id="12345",
        max_age_hours=36,
        force=False,
        now=NOW,
    )
    check(decision == "skip", "same artifact should skip")
    check("already mirrored" in reason, reason)

    decision, reason = sql_mirror_gate.decide(
        resolve_ok=True,
        artifact_id="12345",
        snapshot_created_at="2026-10-22T07:30:00Z",
        previous_artifact_id="12345",
        max_age_hours=36,
        force=True,
        now=NOW,
    )
    check(decision == "proceed", "force should re-mirror same artifact")
    check("Force" in reason, reason)

    decision, reason = sql_mirror_gate.decide(
        resolve_ok=True,
        artifact_id="99999",
        snapshot_created_at="2026-10-22T07:30:00Z",
        previous_artifact_id="12345",
        max_age_hours=36,
        force=False,
        now=NOW,
    )
    check(decision == "proceed", "fresh new artifact should proceed")
    check("99999" in reason, reason)

    try:
        sql_mirror_gate.decide(
            resolve_ok=True,
            artifact_id="abc",
            snapshot_created_at="2026-10-22T07:30:00Z",
            previous_artifact_id="",
            max_age_hours=36,
            force=False,
            now=NOW,
        )
    except sql_mirror_gate.GateError:
        pass
    else:
        fail("non-numeric artifact_id should raise")

    created = sql_mirror_gate.parse_utc("2026-10-22T07:30:00Z")
    check(created == datetime(2026, 10, 22, 7, 30, tzinfo=timezone.utc), "parse_utc Z")

    source, name, key = sql_mirror_gate.parse_mirror_source("SomeOrg/Some-Fork")
    check(source == "Other discovered fork", source)
    check(name == "SomeOrg/Some-Fork", name)
    check(key.startswith("repo-"), key)

    try:
        sql_mirror_gate.parse_mirror_source("")
    except sql_mirror_gate.GateError:
        pass
    else:
        fail("empty SQL_MIRROR_SOURCE should raise")

    try:
        sql_mirror_gate.parse_mirror_source("Rimi staging")
    except sql_mirror_gate.GateError:
        pass
    else:
        fail("alias SQL_MIRROR_SOURCE should raise")

    print("test_sql_mirror_gate: ok")


if __name__ == "__main__":
    main()
