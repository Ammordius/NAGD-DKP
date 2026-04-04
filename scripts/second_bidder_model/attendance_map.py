"""Attendee account -> char ids for auction scope (parity with bid_portfolio_local)."""
from __future__ import annotations

from collections import defaultdict
from typing import Dict, List, Optional, Set, Tuple

from ._path import *  # noqa: F401,F403
from bid_portfolio_local.attendees import (
    _account_ids_for_attendee_row,
    _dedupe_attendee_pairs,
    _distinct_pairs_event,
    _distinct_pairs_raid,
    _norm_event_id,
    _trim_id,
)
from bid_portfolio_local.load_csv import BackupSnapshot


def _raw_attendee_pairs(
    snap: BackupSnapshot,
    raid_id: str,
    pin_event_id: Optional[str],
) -> List[Tuple[Optional[str], Optional[str]]]:
    rid = raid_id.strip()
    use_per_event = bool(snap.raid_event_attendance.get(rid))
    scope = _norm_event_id(pin_event_id)
    scope_has_att = False
    if use_per_event and scope is not None:
        for rea in snap.raid_event_attendance.get(rid, []):
            if _norm_event_id(rea.get("event_id")) == scope:
                scope_has_att = True
                break
    raw_pairs: List[Tuple[Optional[str], Optional[str]]] = []
    if use_per_event and scope is not None and scope_has_att:
        for rea in snap.raid_event_attendance.get(rid, []):
            if _norm_event_id(rea.get("event_id")) != scope:
                continue
            cid = _trim_id(rea.get("char_id"))
            cname = _trim_id(rea.get("character_name"))
            if cid is None and cname is None:
                continue
            raw_pairs.append((cid, cname))
    elif use_per_event:
        raw_pairs.extend(_distinct_pairs_event(snap, rid))
        raw_pairs.extend(_distinct_pairs_raid(snap, rid))
    else:
        raw_pairs.extend(_distinct_pairs_raid(snap, rid))
    return _dedupe_attendee_pairs(raw_pairs)


def attendee_account_char_map_for_loot(
    snap: BackupSnapshot,
    raid_id: str,
    event_id: Optional[str],
) -> Tuple[Set[str], Dict[str, Set[str]]]:
    account_to_chars: Dict[str, Set[str]] = defaultdict(set)
    account_ids: Set[str] = set()
    for cid, cname in _raw_attendee_pairs(snap, raid_id, event_id):
        for aid in _account_ids_for_attendee_row(snap, cid, cname):
            if not aid:
                continue
            account_ids.add(aid)
            if cid:
                account_to_chars[aid].add(cid)
    return account_ids, dict(account_to_chars)
