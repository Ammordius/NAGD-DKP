"""Load Supabase CSV backup tables used by bid portfolio logic."""

from __future__ import annotations

import csv
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Tuple

def _read_csv(path: Path) -> List[Dict[str, str]]:
    if not path.is_file():
        raise FileNotFoundError(f"Missing required CSV: {path}")
    with path.open(newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def _f(row: Dict[str, str], key: str, default: str = "") -> str:
    v = row.get(key)
    if v is None:
        return default
    return str(v).strip()


@dataclass
class BackupSnapshot:
    backup_dir: Path
    raid_loot: List[Dict[str, str]] = field(default_factory=list)
    raids: Dict[str, Dict[str, str]] = field(default_factory=dict)
    raid_events: Dict[str, List[Dict[str, str]]] = field(default_factory=dict)
    raid_event_attendance: Dict[str, List[Dict[str, str]]] = field(default_factory=dict)
    raid_attendance: Dict[str, List[Dict[str, str]]] = field(default_factory=dict)
    account_dkp_summary: Dict[str, Dict[str, str]] = field(default_factory=dict)
    raid_dkp_by_account: Dict[Tuple[str, str], float] = field(default_factory=dict)
    # character_id -> sorted unique account_ids
    char_to_accounts: Dict[str, List[str]] = field(default_factory=dict)
    # trim(name) -> char_ids (exact); lower(trim(name)) -> char_ids (matches SQL name join)
    name_to_char_ids: Dict[str, List[str]] = field(default_factory=dict)
    lower_name_to_char_ids: Dict[str, List[str]] = field(default_factory=dict)
    character_names: Dict[str, str] = field(default_factory=dict)

    def raid_has_event_attendance(self, raid_id: str) -> bool:
        return bool(self.raid_event_attendance.get(raid_id))


def load_backup(backup_dir: Path) -> BackupSnapshot:
    d = Path(backup_dir)
    snap = BackupSnapshot(backup_dir=d)

    for row in _read_csv(d / "raids.csv"):
        rid = _f(row, "raid_id")
        if rid:
            snap.raids[rid] = row

    for row in _read_csv(d / "raid_loot.csv"):
        snap.raid_loot.append(row)

    for row in _read_csv(d / "raid_events.csv"):
        rid = _f(row, "raid_id")
        if rid:
            snap.raid_events.setdefault(rid, []).append(row)

    for row in _read_csv(d / "raid_event_attendance.csv"):
        rid = _f(row, "raid_id")
        if rid:
            snap.raid_event_attendance.setdefault(rid, []).append(row)

    for row in _read_csv(d / "raid_attendance.csv"):
        rid = _f(row, "raid_id")
        if rid:
            snap.raid_attendance.setdefault(rid, []).append(row)

    for row in _read_csv(d / "account_dkp_summary.csv"):
        aid = _f(row, "account_id")
        if aid:
            snap.account_dkp_summary[aid] = row

    for row in _read_csv(d / "raid_attendance_dkp_by_account.csv"):
        rid, aid = _f(row, "raid_id"), _f(row, "account_id")
        if rid and aid:
            snap.raid_dkp_by_account[(rid, aid)] = parse_float(_f(row, "dkp_earned", "0"))

    char_accounts = _read_csv(d / "character_account.csv")
    ca_map: defaultdict[str, set] = defaultdict(set)
    for row in char_accounts:
        cid, aid = _f(row, "char_id"), _f(row, "account_id")
        if cid and aid:
            ca_map[cid].add(aid)
    snap.char_to_accounts = {k: sorted(v) for k, v in ca_map.items()}

    name_map: defaultdict[str, List[str]] = defaultdict(list)
    lower_map: defaultdict[str, List[str]] = defaultdict(list)
    for row in _read_csv(d / "characters.csv"):
        cid = _f(row, "char_id")
        name = _f(row, "name")
        if cid:
            snap.character_names[cid] = name
        if cid and name:
            key = name.strip()
            if cid not in name_map[key]:
                name_map[key].append(cid)
            lk = name.strip().lower()
            if cid not in lower_map[lk]:
                lower_map[lk].append(cid)
    snap.name_to_char_ids = dict(name_map)
    snap.lower_name_to_char_ids = dict(lower_map)

    return snap


def parse_float(s: str) -> float:
    try:
        return float(s)
    except ValueError:
        return 0.0
