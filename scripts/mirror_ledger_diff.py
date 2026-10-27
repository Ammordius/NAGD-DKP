#!/usr/bin/env python3
"""Semantic before/after diff for mirror ledger snapshots.

Compares two snapshot directories (CSV + manifest) and produces a structured
report model used by mirror_ledger_report.py. Uses decimal.Decimal for DKP.
"""

from __future__ import annotations

import csv
import sys
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

import mirror_ledger_snapshot as snap
import sql_restore

# Columns never shown in public output (defense in depth; snapshots exclude auth tables).
PRIVATE_COLUMNS = frozenset(
    {
        "email",
        "actor_email",
        "password",
        "token",
        "secret",
        "access_token",
        "refresh_token",
        "confirmation_token",
        "recovery_token",
        "email_change_token_new",
        "email_change_token_current",
        "phone_change_token",
        "reauthentication_token",
        "encrypted_password",
        "raw_app_meta_data",
        "raw_user_meta_data",
    }
)

# Ignore for changed-row detection (volatile / restore noise).
IGNORE_COLUMNS = frozenset({"updated_at"})

TABLE_KEYS: dict[str, tuple[str, ...]] = {
    "characters": ("char_id",),
    "accounts": ("account_id",),
    "character_account": ("char_id", "account_id"),
    "raids": ("raid_id",),
    "raid_events": ("id",),
    "raid_attendance": ("id",),
    "raid_event_attendance": ("id",),
    "raid_loot": ("id",),
    "loot_assignment": ("loot_id",),
    "dkp_adjustments": ("character_name",),
    "raid_classifications": ("raid_id", "mob"),
    "active_raiders": ("character_key",),
    "active_accounts": ("account_id",),
    "dkp_summary": ("character_key",),
    "account_dkp_summary": ("account_id",),
}

MIRROR_SITE = "https://nagd-dkp.vercel.app"


class DiffError(Exception):
    """Invalid or incomplete snapshots."""


def _cell(value: str | None) -> str:
    if value is None:
        return ""
    return str(value)


def load_csv_rows(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        rows: list[dict[str, str]] = []
        for raw in reader:
            row = {k: _cell(v) for k, v in raw.items() if k is not None}
            rows.append(row)
        return rows


def load_snapshot_tables(snap_dir: Path) -> dict[str, list[dict[str, str]]]:
    snap_dir = Path(snap_dir)
    tables: dict[str, list[dict[str, str]]] = {}
    for table in snap.SNAPSHOT_TABLES:
        tables[table] = load_csv_rows(snap_dir / f"{table}.csv")
    return tables


def row_key(row: dict[str, str], key_cols: tuple[str, ...]) -> str:
    return "\0".join(row.get(c, "") for c in key_cols)


def index_by_key(
    rows: list[dict[str, str]], key_cols: tuple[str, ...]
) -> dict[str, list[dict[str, str]]]:
    """Multiset index: duplicate keys keep all rows in encounter order."""
    indexed: dict[str, list[dict[str, str]]] = {}
    for row in rows:
        indexed.setdefault(row_key(row, key_cols), []).append(row)
    return indexed


def public_fields(row: dict[str, str]) -> dict[str, str]:
    return {k: v for k, v in row.items() if k not in PRIVATE_COLUMNS}


def semantic_equal(old: dict[str, str], new: dict[str, str]) -> bool:
    keys = (set(old) | set(new)) - IGNORE_COLUMNS - PRIVATE_COLUMNS
    for key in keys:
        if old.get(key, "") != new.get(key, ""):
            return False
    return True


def field_diffs(old: dict[str, str], new: dict[str, str]) -> list[dict[str, str]]:
    keys = sorted((set(old) | set(new)) - IGNORE_COLUMNS - PRIVATE_COLUMNS)
    out: list[dict[str, str]] = []
    for key in keys:
        ov, nv = old.get(key, ""), new.get(key, "")
        if ov != nv:
            out.append({"field": key, "old": ov, "new": nv})
    return out


def parse_decimal(value: str | None, default: str = "0") -> Decimal:
    text = (value or "").strip()
    if not text:
        text = default
    try:
        return Decimal(text)
    except InvalidOperation as exc:
        raise DiffError(f"Non-numeric DKP value: {value!r}") from exc


def format_decimal(value: Decimal) -> str:
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text or "0"


def signed_decimal(value: Decimal) -> str:
    text = format_decimal(value)
    if value > 0:
        return f"+{text}"
    return text


def raid_url(raid_id: str) -> str:
    return f"{MIRROR_SITE}/raids/{raid_id}"


def tic_dkp_for_event_group(events: list[dict[str, str]]) -> Decimal:
    """Sum distinct (event_order, lower(event_name)) DKP values — same idea as dkp_one_tic_value."""
    seen: set[tuple[str, str]] = set()
    total = Decimal(0)
    ordered = sorted(
        events,
        key=lambda e: (
            e.get("event_order", "") != "",
            int(e["event_order"]) if str(e.get("event_order", "")).lstrip("-").isdigit() else 0,
            e.get("event_name", "").lower(),
            e.get("id", ""),
        ),
    )
    for event in ordered:
        distinct = (event.get("event_order", ""), event.get("event_name", "").strip().lower())
        if distinct in seen:
            continue
        seen.add(distinct)
        total += parse_decimal(event.get("dkp_value"))
    return total


def potential_dkp_for_raid(events: list[dict[str, str]]) -> Decimal:
    """Sum of distinct tic DKP values across all event_ids in the raid."""
    by_event: dict[str, list[dict[str, str]]] = {}
    for event in events:
        by_event.setdefault(event.get("event_id", ""), []).append(event)
    total = Decimal(0)
    for group in by_event.values():
        total += tic_dkp_for_event_group(group)
    return total


def attendee_count_for_tic(
    attendance: list[dict[str, str]], raid_id: str, event_id: str
) -> int:
    return sum(
        1
        for row in attendance
        if row.get("raid_id") == raid_id and row.get("event_id") == event_id
    )


def character_label(row: dict[str, str]) -> str:
    return row.get("character_name") or row.get("character_key") or row.get("char_id") or "(unknown)"


@dataclass
class ValidationResult:
    ok: bool
    checks: list[dict[str, Any]] = field(default_factory=list)

    def add(self, name: str, passed: bool, detail: str = "") -> None:
        self.checks.append({"name": name, "passed": passed, "detail": detail})
        if not passed:
            self.ok = False


def diff_keyed_table(
    old_rows: list[dict[str, str]],
    new_rows: list[dict[str, str]],
    key_cols: tuple[str, ...],
) -> dict[str, list]:
    old_idx = index_by_key(old_rows, key_cols)
    new_idx = index_by_key(new_rows, key_cols)
    added: list[dict[str, str]] = []
    removed: list[dict[str, str]] = []
    changed: list[dict[str, Any]] = []

    all_keys = sorted(set(old_idx) | set(new_idx))
    for key in all_keys:
        old_list = list(old_idx.get(key, []))
        new_list = list(new_idx.get(key, []))
        # Pair by occurrence ordinal within the key.
        paired = min(len(old_list), len(new_list))
        for i in range(paired):
            if not semantic_equal(old_list[i], new_list[i]):
                changed.append(
                    {
                        "key": key.replace("\0", "|"),
                        "old": public_fields(old_list[i]),
                        "new": public_fields(new_list[i]),
                        "fields": field_diffs(old_list[i], new_list[i]),
                    }
                )
        for row in new_list[paired:]:
            added.append(public_fields(row))
        for row in old_list[paired:]:
            removed.append(public_fields(row))
    return {"added": added, "removed": removed, "changed": changed}


def build_raid_sections(
    old: dict[str, list[dict[str, str]]],
    new: dict[str, list[dict[str, str]]],
) -> dict[str, Any]:
    old_raids = {r["raid_id"]: r for r in old["raids"]}
    new_raids = {r["raid_id"]: r for r in new["raids"]}
    old_events = old["raid_events"]
    new_events = new["raid_events"]
    old_att = old["raid_event_attendance"]
    new_att = new["raid_event_attendance"]

    def events_for(rows: list[dict[str, str]], raid_id: str) -> list[dict[str, str]]:
        return sorted(
            [e for e in rows if e.get("raid_id") == raid_id],
            key=lambda e: (
                int(e["event_order"]) if str(e.get("event_order", "")).lstrip("-").isdigit() else 0,
                e.get("event_time", ""),
                e.get("id", ""),
            ),
        )

    def tic_rows(events: list[dict[str, str]], attendance: list[dict[str, str]]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for event in events:
            eid = event.get("event_id", "")
            rid = event.get("raid_id", "")
            count = event.get("attendee_count", "").strip()
            if not count:
                count = str(attendee_count_for_tic(attendance, rid, eid))
            out.append(
                {
                    "id": event.get("id", ""),
                    "event_id": eid,
                    "event_name": event.get("event_name", ""),
                    "event_time": event.get("event_time", ""),
                    "event_order": event.get("event_order", ""),
                    "dkp": event.get("dkp_value", "") or "0",
                    "attendees": count,
                }
            )
        return out

    added_raids: list[dict[str, Any]] = []
    for raid_id in sorted(set(new_raids) - set(old_raids)):
        raid = new_raids[raid_id]
        events = events_for(new_events, raid_id)
        added_raids.append(
            {
                "raid_id": raid_id,
                "raid_name": raid.get("raid_name", ""),
                "date": raid.get("date") or raid.get("date_iso", ""),
                "date_iso": raid.get("date_iso", ""),
                "url": raid_url(raid_id),
                "tic_count": len(events),
                "tics": tic_rows(events, new_att),
                "potential_dkp": format_decimal(potential_dkp_for_raid(events)),
                "potential_dkp_note": "Sum of distinct tic DKP values for this raid (not attendees × DKP).",
            }
        )

    removed_raids: list[dict[str, Any]] = []
    for raid_id in sorted(set(old_raids) - set(new_raids)):
        raid = old_raids[raid_id]
        events = events_for(old_events, raid_id)
        removed_raids.append(
            {
                "raid_id": raid_id,
                "raid_name": raid.get("raid_name", ""),
                "date": raid.get("date") or raid.get("date_iso", ""),
                "date_iso": raid.get("date_iso", ""),
                "url": raid_url(raid_id),
                "tic_count": len(events),
                "tics": tic_rows(events, old_att),
                "potential_dkp": format_decimal(potential_dkp_for_raid(events)),
            }
        )

    edited_raids: list[dict[str, Any]] = []
    for raid_id in sorted(set(old_raids) & set(new_raids)):
        fields = field_diffs(old_raids[raid_id], new_raids[raid_id])
        # Ignore pure url churn if nothing else changed and url is derived — still report real edits.
        if fields:
            edited_raids.append(
                {
                    "raid_id": raid_id,
                    "raid_name": new_raids[raid_id].get("raid_name", ""),
                    "date": new_raids[raid_id].get("date") or new_raids[raid_id].get("date_iso", ""),
                    "url": raid_url(raid_id),
                    "fields": fields,
                }
            )

    old_ev_by_id = {e["id"]: e for e in old_events if e.get("id")}
    new_ev_by_id = {e["id"]: e for e in new_events if e.get("id")}

    added_tics: list[dict[str, Any]] = []
    for eid in sorted(set(new_ev_by_id) - set(old_ev_by_id), key=lambda x: int(x) if x.isdigit() else 0):
        event = new_ev_by_id[eid]
        raid_id = event.get("raid_id", "")
        # Skip tics belonging to wholly new raids (already shown under added raids).
        if raid_id not in old_raids:
            continue
        added_tics.append(
            {
                "id": eid,
                "raid_id": raid_id,
                "raid_name": new_raids.get(raid_id, {}).get("raid_name", ""),
                "event_name": event.get("event_name", ""),
                "event_id": event.get("event_id", ""),
                "dkp": event.get("dkp_value", "") or "0",
                "event_time": event.get("event_time", ""),
                "url": raid_url(raid_id),
            }
        )

    removed_tics: list[dict[str, Any]] = []
    for eid in sorted(set(old_ev_by_id) - set(new_ev_by_id), key=lambda x: int(x) if x.isdigit() else 0):
        event = old_ev_by_id[eid]
        raid_id = event.get("raid_id", "")
        if raid_id not in new_raids:
            continue
        removed_tics.append(
            {
                "id": eid,
                "raid_id": raid_id,
                "raid_name": old_raids.get(raid_id, {}).get("raid_name", ""),
                "event_name": event.get("event_name", ""),
                "event_id": event.get("event_id", ""),
                "dkp": event.get("dkp_value", "") or "0",
                "event_time": event.get("event_time", ""),
                "url": raid_url(raid_id),
            }
        )

    modified_tics: list[dict[str, Any]] = []
    for eid in sorted(set(old_ev_by_id) & set(new_ev_by_id), key=lambda x: int(x) if x.isdigit() else 0):
        fields = field_diffs(old_ev_by_id[eid], new_ev_by_id[eid])
        if not fields:
            continue
        event = new_ev_by_id[eid]
        raid_id = event.get("raid_id", "")
        modified_tics.append(
            {
                "id": eid,
                "raid_id": raid_id,
                "raid_name": new_raids.get(raid_id, old_raids.get(raid_id, {})).get("raid_name", ""),
                "event_name": event.get("event_name", ""),
                "event_id": event.get("event_id", ""),
                "old_dkp": old_ev_by_id[eid].get("dkp_value", "") or "0",
                "new_dkp": event.get("dkp_value", "") or "0",
                "old_time": old_ev_by_id[eid].get("event_time", ""),
                "new_time": event.get("event_time", ""),
                "fields": fields,
                "url": raid_url(raid_id),
            }
        )

    # Attendance changes on surviving tics/raids.
    att_diff = diff_keyed_table(old_att, new_att, ("id",))
    attendance_changes: list[dict[str, Any]] = []
    for row in att_diff["added"]:
        raid_id = row.get("raid_id", "")
        if raid_id not in old_raids:
            continue
        attendance_changes.append(
            {
                "action": "added",
                "raid_id": raid_id,
                "raid_name": new_raids.get(raid_id, {}).get("raid_name", ""),
                "event_id": row.get("event_id", ""),
                "character": character_label(row),
                "char_id": row.get("char_id", ""),
                "account_id": row.get("account_id", ""),
                "url": raid_url(raid_id),
            }
        )
    for row in att_diff["removed"]:
        raid_id = row.get("raid_id", "")
        if raid_id not in new_raids:
            continue
        attendance_changes.append(
            {
                "action": "removed",
                "raid_id": raid_id,
                "raid_name": old_raids.get(raid_id, {}).get("raid_name", ""),
                "event_id": row.get("event_id", ""),
                "character": character_label(row),
                "char_id": row.get("char_id", ""),
                "account_id": row.get("account_id", ""),
                "url": raid_url(raid_id),
            }
        )

    # Attendee count deltas per surviving (raid_id, event_id).
    def count_map(rows: list[dict[str, str]]) -> dict[tuple[str, str], int]:
        counts: dict[tuple[str, str], int] = {}
        for row in rows:
            key = (row.get("raid_id", ""), row.get("event_id", ""))
            counts[key] = counts.get(key, 0) + 1
        return counts

    old_counts = count_map(old_att)
    new_counts = count_map(new_att)
    attendee_count_changes: list[dict[str, Any]] = []
    for key in sorted(set(old_counts) | set(new_counts)):
        raid_id, event_id = key
        if raid_id not in old_raids or raid_id not in new_raids:
            continue
        oc, nc = old_counts.get(key, 0), new_counts.get(key, 0)
        if oc == nc:
            continue
        # Prefer event name from new, else old.
        name = ""
        for ev in new_events + old_events:
            if ev.get("raid_id") == raid_id and ev.get("event_id") == event_id:
                name = ev.get("event_name", "")
                break
        attendee_count_changes.append(
            {
                "raid_id": raid_id,
                "raid_name": new_raids.get(raid_id, {}).get("raid_name", ""),
                "event_id": event_id,
                "event_name": name,
                "old_count": oc,
                "new_count": nc,
                "delta": nc - oc,
                "url": raid_url(raid_id),
            }
        )

    return {
        "added_raids": added_raids,
        "removed_raids": removed_raids,
        "edited_raids": edited_raids,
        "added_tics": added_tics,
        "removed_tics": removed_tics,
        "modified_tics": modified_tics,
        "attendance_changes": attendance_changes,
        "attendee_count_changes": attendee_count_changes,
    }


def build_loot_sections(
    old: dict[str, list[dict[str, str]]],
    new: dict[str, list[dict[str, str]]],
) -> dict[str, Any]:
    old_loot = {r["id"]: r for r in old["raid_loot"] if r.get("id")}
    new_loot = {r["id"]: r for r in new["raid_loot"] if r.get("id")}
    old_assign = {r["loot_id"]: r for r in old["loot_assignment"] if r.get("loot_id")}
    new_assign = {r["loot_id"]: r for r in new["loot_assignment"] if r.get("loot_id")}
    new_raids = {r["raid_id"]: r for r in new["raids"]}
    old_raids = {r["raid_id"]: r for r in old["raids"]}

    def enrich(row: dict[str, str], assigns: dict[str, dict[str, str]]) -> dict[str, Any]:
        loot_id = row.get("id", "")
        assign = assigns.get(loot_id, {})
        raid_id = row.get("raid_id", "")
        raid = new_raids.get(raid_id) or old_raids.get(raid_id) or {}
        return {
            "id": loot_id,
            "raid_id": raid_id,
            "raid_name": raid.get("raid_name", ""),
            "event_id": row.get("event_id", ""),
            "item_name": row.get("item_name", ""),
            "character": character_label(row),
            "char_id": row.get("char_id", ""),
            "cost": row.get("cost", "") or "0",
            "assigned_character": assign.get("assigned_character_name")
            or assign.get("assigned_char_id")
            or "",
            "url": raid_url(raid_id) if raid_id else MIRROR_SITE,
        }

    added = [enrich(new_loot[i], new_assign) for i in sorted(set(new_loot) - set(old_loot), key=_id_sort)]
    removed = [enrich(old_loot[i], old_assign) for i in sorted(set(old_loot) - set(new_loot), key=_id_sort)]
    modified: list[dict[str, Any]] = []
    for loot_id in sorted(set(old_loot) & set(new_loot), key=_id_sort):
        fields = field_diffs(old_loot[loot_id], new_loot[loot_id])
        assign_fields = field_diffs(old_assign.get(loot_id, {}), new_assign.get(loot_id, {}))
        if not fields and not assign_fields:
            continue
        base = enrich(new_loot[loot_id], new_assign)
        base["fields"] = fields
        base["assignment_fields"] = assign_fields
        base["old_cost"] = old_loot[loot_id].get("cost", "") or "0"
        base["new_cost"] = new_loot[loot_id].get("cost", "") or "0"
        base["old_character"] = character_label(old_loot[loot_id])
        base["new_character"] = character_label(new_loot[loot_id])
        modified.append(base)
    return {"added": added, "removed": removed, "modified": modified}


def _id_sort(value: str) -> tuple:
    return (0, int(value)) if value.isdigit() else (1, value)


def build_adjustment_sections(
    old: dict[str, list[dict[str, str]]],
    new: dict[str, list[dict[str, str]]],
) -> dict[str, Any]:
    return diff_keyed_table(old["dkp_adjustments"], new["dkp_adjustments"], ("character_name",))


def build_dkp_deltas(
    old_rows: list[dict[str, str]],
    new_rows: list[dict[str, str]],
    *,
    key_col: str,
    name_col: str,
) -> list[dict[str, Any]]:
    old_by = {r[key_col]: r for r in old_rows if r.get(key_col)}
    new_by = {r[key_col]: r for r in new_rows if r.get(key_col)}
    results: list[dict[str, Any]] = []
    for key in sorted(set(old_by) | set(new_by)):
        old_r = old_by.get(key)
        new_r = new_by.get(key)
        status = "unchanged"
        if old_r is None:
            status = "added"
            old_earned = old_spent = old_balance = Decimal(0)
            new_earned = parse_decimal(new_r.get("earned") if new_r else None)
            new_spent = parse_decimal(new_r.get("spent") if new_r else None)
            new_balance = new_earned - new_spent
            name = (new_r or {}).get(name_col, "") or key
        elif new_r is None:
            status = "removed"
            new_earned = new_spent = new_balance = Decimal(0)
            old_earned = parse_decimal(old_r.get("earned"))
            old_spent = parse_decimal(old_r.get("spent"))
            old_balance = old_earned - old_spent
            name = old_r.get(name_col, "") or key
        else:
            old_earned = parse_decimal(old_r.get("earned"))
            old_spent = parse_decimal(old_r.get("spent"))
            old_balance = old_earned - old_spent
            new_earned = parse_decimal(new_r.get("earned"))
            new_spent = parse_decimal(new_r.get("spent"))
            new_balance = new_earned - new_spent
            name = new_r.get(name_col, "") or old_r.get(name_col, "") or key
            if old_earned != new_earned or old_spent != new_spent:
                status = "changed"

        d_earned = new_earned - old_earned
        d_spent = new_spent - old_spent
        d_balance = new_balance - old_balance
        results.append(
            {
                "key": key,
                "name": name,
                "status": status,
                "old_earned": format_decimal(old_earned),
                "new_earned": format_decimal(new_earned),
                "old_spent": format_decimal(old_spent),
                "new_spent": format_decimal(new_spent),
                "old_balance": format_decimal(old_balance),
                "new_balance": format_decimal(new_balance),
                "delta_earned": format_decimal(d_earned),
                "delta_spent": format_decimal(d_spent),
                "delta_balance": format_decimal(d_balance),
                "delta_earned_signed": signed_decimal(d_earned),
                "delta_spent_signed": signed_decimal(d_spent),
                "delta_balance_signed": signed_decimal(d_balance),
                "changed": status != "unchanged",
            }
        )
    return results


def build_other_sections(
    old: dict[str, list[dict[str, str]]],
    new: dict[str, list[dict[str, str]]],
) -> dict[str, Any]:
    sections = {}
    for table, keys in (
        ("characters", ("char_id",)),
        ("accounts", ("account_id",)),
        ("character_account", ("char_id", "account_id")),
        ("active_raiders", ("character_key",)),
        ("active_accounts", ("account_id",)),
        ("raid_classifications", ("raid_id", "mob")),
    ):
        diff = diff_keyed_table(old[table], new[table], keys)
        # For characters, only expose safe display fields in added/removed summaries.
        if table == "characters":
            safe_cols = ("char_id", "name", "race", "class_name", "level", "guild_rank")
            for section in ("added", "removed"):
                diff[section] = [
                    {c: r.get(c, "") for c in safe_cols if c in r or True}
                    for r in diff[section]
                ]
            for item in diff["changed"]:
                item["old"] = {c: item["old"].get(c, "") for c in safe_cols}
                item["new"] = {c: item["new"].get(c, "") for c in safe_cols}
                item["fields"] = [f for f in item["fields"] if f["field"] in safe_cols]
        elif table == "accounts":
            safe_cols = ("account_id", "display_name", "toon_names", "toon_count", "inactive")
            for section in ("added", "removed"):
                diff[section] = [{c: r.get(c, "") for c in safe_cols} for r in diff[section]]
            for item in diff["changed"]:
                item["fields"] = [f for f in item["fields"] if f["field"] in safe_cols]
        sections[table] = diff
    return sections


def csv_tables_to_blocks(tables: dict[str, list[dict[str, str]]]) -> dict[str, dict]:
    """Convert snapshot CSVs into the block shape expected by sql_restore.expected_account_totals."""
    import sql_backup

    blocks: dict[str, dict] = {}
    for table in sql_restore.PRIMARY_KEYS:
        rows = tables.get(table, [])
        if not rows:
            columns = list(
                sql_backup.REQUIRED_SOURCE_COLUMNS.get(table, TABLE_KEYS.get(table, ()))
            )
            blocks[table] = {"columns": columns, "rows": []}
            continue
        columns = list(rows[0].keys())
        body: list[list[str | None]] = []
        for row in rows:
            body.append([_csv_null(row.get(c, "")) for c in columns])
        blocks[table] = {"columns": columns, "rows": body}
    return blocks


def _csv_null(value: str) -> str | None:
    return None if value == "" else value


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


def _earned_spent(row: dict[str, Any] | None) -> tuple[Decimal, Decimal]:
    if not row:
        return Decimal(0), Decimal(0)
    return parse_decimal(row.get("earned")), parse_decimal(row.get("spent"))


def _compare_summary_to_expected(
    *,
    summary_rows: list[dict[str, str]],
    key_col: str,
    expected: dict[str, dict[str, str]],
) -> list[str]:
    """Return mismatch strings: summary earned/spent vs independently reconstructed totals."""
    summary = {r[key_col]: r for r in summary_rows if r.get(key_col)}
    mismatches: list[str] = []
    keys = set(expected) | set(summary)
    for key in sorted(keys):
        exp = expected.get(key)
        got = summary.get(key)
        if exp is None and got is not None:
            ge, gs = _earned_spent(got)
            if ge == 0 and gs == 0:
                continue
            mismatches.append(f"{key}: unexpected summary row")
            continue
        if got is None and exp is not None:
            mismatches.append(f"{key}: missing summary row")
            continue
        if exp is None or got is None:
            continue
        ee, es = _earned_spent(exp)
        ge, gs = _earned_spent(got)
        if ee != ge:
            mismatches.append(f"{key}: earned {exp['earned']}!={got.get('earned')}")
        if es != gs:
            mismatches.append(f"{key}: spent {exp['spent']}!={got.get('spent')}")
    return mismatches


def _delta_vs_reconstructed(
    *,
    deltas: list[dict[str, Any]],
    old_expected: dict[str, dict[str, str]],
    new_expected: dict[str, dict[str, str]],
) -> list[str]:
    """Reported row deltas must equal independently reconstructed new − old."""
    by_key = {r["key"]: r for r in deltas if r.get("key")}
    mismatches: list[str] = []
    keys = set(by_key) | set(old_expected) | set(new_expected)
    for key in sorted(keys):
        old_e, old_s = _earned_spent(old_expected.get(key))
        new_e, new_s = _earned_spent(new_expected.get(key))
        exp_de = new_e - old_e
        exp_ds = new_s - old_s
        exp_db = (new_e - new_s) - (old_e - old_s)
        if exp_de == 0 and exp_ds == 0 and exp_db == 0 and key not in by_key:
            continue
        row = by_key.get(key)
        if row is None:
            mismatches.append(f"{key}: missing reported delta")
            continue
        if parse_decimal(row["delta_earned"]) != exp_de:
            mismatches.append(
                f"{key}: delta_earned {row['delta_earned']}!={format_decimal(exp_de)}"
            )
        if parse_decimal(row["delta_spent"]) != exp_ds:
            mismatches.append(
                f"{key}: delta_spent {row['delta_spent']}!={format_decimal(exp_ds)}"
            )
        if parse_decimal(row["delta_balance"]) != exp_db:
            mismatches.append(
                f"{key}: delta_balance {row['delta_balance']}!={format_decimal(exp_db)}"
            )
        # Absolute totals in the report must match reconstruction (atomicity of endpoints).
        if parse_decimal(row["old_earned"]) != old_e or parse_decimal(row["old_spent"]) != old_s:
            mismatches.append(f"{key}: old totals != reconstructed")
        if parse_decimal(row["new_earned"]) != new_e or parse_decimal(row["new_spent"]) != new_s:
            mismatches.append(f"{key}: new totals != reconstructed")
    return mismatches


def validate_report(
    old_tables: dict[str, list[dict[str, str]]],
    new_tables: dict[str, list[dict[str, str]]],
    character_deltas: list[dict[str, Any]],
    account_deltas: list[dict[str, Any]],
    old_manifest: dict,
    new_manifest: dict,
) -> ValidationResult:
    """Validate snapshot integrity, clean DKP totals, and reported deltas vs reconstruction.

    Independent reconstruction uses sql_restore.expected_account_totals /
    expected_character_totals (attendance + loot; adjustments excluded). That is the
    same arithmetic restore uses to prove destination account DKP is clean.
    """
    result = ValidationResult(ok=True)

    for label, manifest, tables in (
        ("before", old_manifest, old_tables),
        ("after", new_manifest, new_tables),
    ):
        missing = [t for t in snap.SNAPSHOT_TABLES if t not in tables]
        result.add(
            f"snapshot_{label}_tables_present",
            not missing,
            f"missing={missing}" if missing else "ok",
        )
        counts = (manifest or {}).get("row_counts") or {}
        mismatches = []
        for table in snap.SNAPSHOT_TABLES:
            expected = counts.get(table)
            if expected is None:
                continue
            if int(expected) != len(tables[table]):
                mismatches.append(f"{table}:{expected}!={len(tables[table])}")
        result.add(
            f"snapshot_{label}_row_counts",
            not mismatches,
            ", ".join(mismatches) if mismatches else "ok",
        )

    def check_deltas(label: str, rows: list[dict[str, Any]]) -> None:
        bad = []
        for row in rows:
            old_b = parse_decimal(row["old_balance"])
            new_b = parse_decimal(row["new_balance"])
            d_b = parse_decimal(row["delta_balance"])
            d_e = parse_decimal(row["delta_earned"])
            d_s = parse_decimal(row["delta_spent"])
            if new_b - old_b != d_b:
                bad.append(f"{row['key']}: balance identity")
            if d_e - d_s != d_b:
                bad.append(f"{row['key']}: delta identity")
            recomputed_old = parse_decimal(row["old_earned"]) - parse_decimal(row["old_spent"])
            recomputed_new = parse_decimal(row["new_earned"]) - parse_decimal(row["new_spent"])
            if recomputed_old != old_b or recomputed_new != new_b:
                bad.append(f"{row['key']}: earned-spent")
        result.add(
            f"{label}_dkp_internal_consistency",
            not bad,
            f"{len(bad)} failures" if bad else "ok",
        )

    check_deltas("character", character_deltas)
    check_deltas("account", account_deltas)

    old_acct_exp: dict[str, dict[str, str]] = {}
    new_acct_exp: dict[str, dict[str, str]] = {}
    old_char_exp: dict[str, dict[str, str]] = {}
    new_char_exp: dict[str, dict[str, str]] = {}

    # Clean totals on both sides + reported deltas vs independent reconstruction.
    try:
        old_blocks = csv_tables_to_blocks(old_tables)
        new_blocks = csv_tables_to_blocks(new_tables)
        old_as_of = _as_of_from_tables(old_tables)
        new_as_of = _as_of_from_tables(new_tables)
        old_acct_exp = sql_restore.expected_account_totals(old_blocks, old_as_of)
        new_acct_exp = sql_restore.expected_account_totals(new_blocks, new_as_of)
        old_char_exp = sql_restore.expected_character_totals(old_blocks, old_as_of)
        new_char_exp = sql_restore.expected_character_totals(new_blocks, new_as_of)

        for side, tables, acct_exp, char_exp in (
            ("before", old_tables, old_acct_exp, old_char_exp),
            ("after", new_tables, new_acct_exp, new_char_exp),
        ):
            acct_mismatches = _compare_summary_to_expected(
                summary_rows=tables.get("account_dkp_summary", []),
                key_col="account_id",
                expected=acct_exp,
            )
            result.add(
                f"account_dkp_clean_{side}",
                not acct_mismatches,
                (
                    f"{len(acct_mismatches)} mismatches (sql_restore.expected_account_totals)"
                    if acct_mismatches
                    else "matched sql_restore.expected_account_totals"
                ),
            )
            char_mismatches = _compare_summary_to_expected(
                summary_rows=tables.get("dkp_summary", []),
                key_col="character_key",
                expected=char_exp,
            )
            result.add(
                f"character_dkp_clean_{side}",
                not char_mismatches,
                (
                    f"{len(char_mismatches)} mismatches (sql_restore.expected_character_totals)"
                    if char_mismatches
                    else "matched sql_restore.expected_character_totals"
                ),
            )

        # Keep legacy name as an alias of after-side account cleanliness for older readers.
        after_acct = next(
            (c for c in result.checks if c["name"] == "account_dkp_clean_after"),
            None,
        )
        result.add(
            "account_dkp_recomputed_from_guild_rows",
            bool(after_acct and after_acct["passed"]),
            (after_acct or {}).get("detail", "missing after check"),
        )

        acct_delta_bad = _delta_vs_reconstructed(
            deltas=account_deltas,
            old_expected=old_acct_exp,
            new_expected=new_acct_exp,
        )
        result.add(
            "account_dkp_delta_matches_reconstructed",
            not acct_delta_bad,
            (
                f"{len(acct_delta_bad)} mismatches"
                if acct_delta_bad
                else "reported account deltas == reconstructed new − old"
            ),
        )
        char_delta_bad = _delta_vs_reconstructed(
            deltas=character_deltas,
            old_expected=old_char_exp,
            new_expected=new_char_exp,
        )
        result.add(
            "character_dkp_delta_matches_reconstructed",
            not char_delta_bad,
            (
                f"{len(char_delta_bad)} mismatches"
                if char_delta_bad
                else "reported character deltas == reconstructed new − old"
            ),
        )
    except Exception as exc:  # noqa: BLE001 — surface as failed checks, do not invent pass
        detail = f"check could not run: {type(exc).__name__}: {exc}"
        for name in (
            "account_dkp_clean_before",
            "account_dkp_clean_after",
            "character_dkp_clean_before",
            "character_dkp_clean_after",
            "account_dkp_recomputed_from_guild_rows",
            "account_dkp_delta_matches_reconstructed",
            "character_dkp_delta_matches_reconstructed",
        ):
            if not any(c["name"] == name for c in result.checks):
                result.add(name, False, detail)

    return result


def summarize(model: dict[str, Any]) -> dict[str, Any]:
    raids = model["raids"]
    loot = model["loot"]
    adjustments = model["adjustments"]
    char_changed = sum(1 for r in model["character_dkp"] if r["changed"])
    acct_changed = sum(1 for r in model["account_dkp"] if r["changed"])
    return {
        "raids_added": len(raids["added_raids"]),
        "raids_removed": len(raids["removed_raids"]),
        "raids_edited": len(raids["edited_raids"]),
        "tics_added": len(raids["added_tics"]),
        "tics_removed": len(raids["removed_tics"]),
        "tics_modified": len(raids["modified_tics"]),
        "attendance_changes": len(raids["attendance_changes"]),
        "attendee_count_changes": len(raids["attendee_count_changes"]),
        "loot_added": len(loot["added"]),
        "loot_removed": len(loot["removed"]),
        "loot_modified": len(loot["modified"]),
        "adjustments_added": len(adjustments["added"]),
        "adjustments_removed": len(adjustments["removed"]),
        "adjustments_changed": len(adjustments["changed"]),
        "characters_with_dkp_changes": char_changed,
        "accounts_with_dkp_changes": acct_changed,
        "validation_ok": model["validation"]["ok"],
    }


def compare_snapshots(
    old_dir: Path,
    new_dir: Path,
    *,
    provenance: dict[str, Any] | None = None,
    require_manifest: bool = True,
) -> dict[str, Any]:
    old_dir = Path(old_dir)
    new_dir = Path(new_dir)
    try:
        old_manifest = snap.verify_snapshot_dir(old_dir, require_manifest=require_manifest)
        new_manifest = snap.verify_snapshot_dir(new_dir, require_manifest=require_manifest)
    except snap.SnapshotError as exc:
        raise DiffError(str(exc)) from exc

    old_tables = load_snapshot_tables(old_dir)
    new_tables = load_snapshot_tables(new_dir)

    character_dkp = build_dkp_deltas(
        old_tables["dkp_summary"],
        new_tables["dkp_summary"],
        key_col="character_key",
        name_col="character_name",
    )
    account_dkp = build_dkp_deltas(
        old_tables["account_dkp_summary"],
        new_tables["account_dkp_summary"],
        key_col="account_id",
        name_col="display_name",
    )

    validation = validate_report(
        old_tables,
        new_tables,
        character_dkp,
        account_dkp,
        old_manifest,
        new_manifest,
    )

    before_at = (old_manifest or {}).get("captured_at", "")
    after_at = (new_manifest or {}).get("captured_at", "")
    model: dict[str, Any] = {
        "title": "NAGD DKP Mirror — Daily Change Report",
        "disclaimer": (
            "This report compares two read-only snapshots of the mirror database "
            "before and after a successful SQL restore. The mirror does not copy "
            "production officer_audit_log, so this is not an officer audit trail "
            "and does not identify who made a change."
        ),
        "mirror_site": MIRROR_SITE,
        "before_captured_at": before_at,
        "after_captured_at": after_at,
        "interval": {"start": before_at, "end": after_at},
        "provenance": provenance or {},
        "raids": build_raid_sections(old_tables, new_tables),
        "loot": build_loot_sections(old_tables, new_tables),
        "adjustments": build_adjustment_sections(old_tables, new_tables),
        "character_dkp": character_dkp,
        "account_dkp": account_dkp,
        "other": build_other_sections(old_tables, new_tables),
        "validation": {
            "ok": validation.ok,
            "checks": validation.checks,
        },
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    model["summary"] = summarize(model)
    return model


def main(argv: list[str] | None = None) -> int:
    import argparse
    import json

    parser = argparse.ArgumentParser(description="Diff two mirror ledger snapshots to JSON.")
    parser.add_argument("--old", type=Path, required=True)
    parser.add_argument("--new", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--allow-missing-manifest", action="store_true")
    args = parser.parse_args(argv)
    try:
        model = compare_snapshots(
            args.old,
            args.new,
            require_manifest=not args.allow_missing_manifest,
        )
    except DiffError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(model, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {args.out} validation_ok={model['validation']['ok']}")
    return 0 if model["validation"]["ok"] else 2


if __name__ == "__main__":
    sys.exit(main())
