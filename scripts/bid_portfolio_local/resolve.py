"""Buyer account resolution matching loot_assignment-less SQL (raid_loot + character_account + characters)."""

from __future__ import annotations

import re
from typing import Dict, List, Optional, Set


def parse_cost_num(cost: Any) -> float:
    if cost is None:
        return 0.0
    s = str(cost).strip()
    if not s:
        return 0.0
    cleaned = re.sub(r"[^0-9.\-]", "", s)
    if not cleaned:
        return 0.0
    try:
        return float(cleaned)
    except ValueError:
        return 0.0


def _trim(s: Optional[str]) -> str:
    if s is None:
        return ""
    return str(s).strip()


def buyer_account_ids_for_row(
    char_id: Optional[str],
    character_name: Optional[str],
    *,
    name_to_char_ids: Dict[str, List[str]],
    char_to_accounts: Dict[str, List[str]],
) -> Set[str]:
    """All account_ids that SQL LEFT JOIN character_account would match (OR of char_id and name paths)."""
    out: Set[str] = set()
    cid = _trim(char_id)
    cname = _trim(character_name)
    if cid:
        for aid in char_to_accounts.get(cid, []):
            out.add(aid)
    if cname:
        for ch in name_to_char_ids.get(cname, []):
            for aid in char_to_accounts.get(ch, []):
                out.add(aid)
    return out


def buyer_account_id_for_loot_row(
    char_id: Optional[str],
    character_name: Optional[str],
    *,
    name_to_char_ids: Dict[str, List[str]],
    char_to_accounts: Dict[str, List[str]],
) -> Optional[str]:
    """DISTINCT ON (loot_id) ORDER BY loot_id, ca.account_id -> smallest account_id."""
    ids = buyer_account_ids_for_row(
        char_id, character_name, name_to_char_ids=name_to_char_ids, char_to_accounts=char_to_accounts
    )
    if not ids:
        return None
    return min(ids)


def account_id_from_attendance_row(
    char_id: Optional[str],
    character_name: Optional[str],
    *,
    name_to_char_ids: Dict[str, List[str]],
    char_to_accounts: Dict[str, List[str]],
) -> Optional[str]:
    """LATERAL x: one account per attendance row; use min(account_id) if multiple ca match."""
    ids = buyer_account_ids_for_row(
        char_id, character_name, name_to_char_ids=name_to_char_ids, char_to_accounts=char_to_accounts
    )
    if not ids:
        return None
    return min(ids)
