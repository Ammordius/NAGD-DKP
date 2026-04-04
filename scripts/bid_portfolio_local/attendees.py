"""Port bid_forecast_attendees_resolved_for_scope and attendee_accounts_for_loot."""

from __future__ import annotations

from typing import Dict, List, Optional, Set, Tuple

from .load_csv import BackupSnapshot


def _trim_id(s: Optional[str]) -> Optional[str]:
    if s is None:
        return None
    t = str(s).strip()
    return t if t else None


def _norm_event_id(s: Optional[str]) -> Optional[str]:
    t = _trim_id(s)
    return t


def _distinct_pairs_event(snap: BackupSnapshot, raid_id: str) -> List[Tuple[Optional[str], Optional[str]]]:
    pairs: List[Tuple[Optional[str], Optional[str]]] = []
    seen: Set[Tuple[str, str]] = set()
    for rea in snap.raid_event_attendance.get(raid_id, []):
        cid = _trim_id(rea.get("char_id"))
        cname = _trim_id(rea.get("character_name"))
        if cid is None and cname is None:
            continue
        key = (cid or "", (cname or "").lower().strip())
        if key in seen:
            continue
        seen.add(key)
        pairs.append((cid, cname))
    return pairs


def _distinct_pairs_raid(snap: BackupSnapshot, raid_id: str) -> List[Tuple[Optional[str], Optional[str]]]:
    pairs: List[Tuple[Optional[str], Optional[str]]] = []
    seen: Set[Tuple[str, str]] = set()
    for ra in snap.raid_attendance.get(raid_id, []):
        cid = _trim_id(ra.get("char_id"))
        cname = _trim_id(ra.get("character_name"))
        if cid is None and cname is None:
            continue
        key = (cid or "", (cname or "").lower().strip())
        if key in seen:
            continue
        seen.add(key)
        pairs.append((cid, cname))
    return pairs


def _dedupe_attendee_pairs(
    raw_pairs: List[Tuple[Optional[str], Optional[str]]],
) -> List[Tuple[Optional[str], Optional[str]]]:
    """DISTINCT ON (coalesce(char_id,''), lower(trim(character_name))) with SQL ordering."""
    dedup: Dict[Tuple[str, str], Tuple[Optional[str], Optional[str]]] = {}
    order_keys: List[Tuple[str, str]] = []
    for cid, cname in raw_pairs:
        co_cid = cid or ""
        ln = (cname or "").lower().strip()
        k = (co_cid, ln)
        if k not in dedup:
            dedup[k] = (cid, cname)
            order_keys.append(k)

    def sort_key(k: Tuple[str, str]) -> Tuple[str, str, int]:
        co_cid, ln = k
        cid, _ = dedup[k]
        null_last = 0 if cid else 1
        return (co_cid, ln, null_last)

    order_keys.sort(key=sort_key)
    return [dedup[k] for k in order_keys]


def _account_ids_for_attendee_row(snap: BackupSnapshot, cid: Optional[str], cname: Optional[str]) -> List[str]:
    """LEFT JOIN characters + character_account (all accounts for all matching characters)."""
    aids: List[str] = []
    if cid:
        if cid in snap.character_names:
            aids.extend(snap.char_to_accounts.get(cid, []))
    elif cname:
        lk = (cname or "").strip().lower()
        for ch in snap.lower_name_to_char_ids.get(lk, []):
            aids.extend(snap.char_to_accounts.get(ch, []))
    return aids


def bid_forecast_attendees_resolved_for_scope(
    snap: BackupSnapshot,
    raid_id: str,
    pin_event_id: Optional[str],
) -> List[Dict[str, Optional[str]]]:
    """Mirrors SQL rows (one row per attendee_raw_dedup × character_account expansion simplified to one row per dedup key for display)."""
    ids = attendee_account_ids_for_loot(snap, raid_id, pin_event_id)
    out: List[Dict[str, Optional[str]]] = []
    for aid in sorted(ids):
        out.append(
            {
                "raw_char_id": None,
                "raw_character_name": None,
                "resolved_char_id": None,
                "resolved_name": None,
                "class_name": None,
                "account_id": aid,
                "account_display_name": "",
            }
        )
    return out


def attendee_account_ids_for_loot(
    snap: BackupSnapshot,
    raid_id: str,
    event_id: Optional[str],
) -> Set[str]:
    """DISTINCT non-null account_id (parity with attendee_accounts_for_loot)."""
    rid = raid_id.strip()
    use_per_event = bool(snap.raid_event_attendance.get(rid))
    scope = _norm_event_id(event_id)
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

    deduped = _dedupe_attendee_pairs(raw_pairs)
    ids: Set[str] = set()
    for cid, cname in deduped:
        for aid in _account_ids_for_attendee_row(snap, cid, cname):
            if aid:
                ids.add(aid)
    return ids
