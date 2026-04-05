"""Weapon sub-lanes for PRIMARY/SECONDARY (parity with web/src/lib/bidForecastModel.js)."""
from __future__ import annotations

import re
from typing import Any, Dict, FrozenSet, Optional

from .equip_slot import normalize_equip_slot_key

MELEE_WEAPON_LANE_ABBREVS: FrozenSet[str] = frozenset({"WAR", "ROG", "MNK"})

_CLASS_TO_ABBREV = {
    "warrior": "WAR",
    "war": "WAR",
    "rogue": "ROG",
    "rog": "ROG",
    "monk": "MNK",
    "mnk": "MNK",
}


def abbrev_for_class_name(raw: Optional[str]) -> Optional[str]:
    if not raw or not isinstance(raw, str):
        return None
    t = raw.strip()
    if not t:
        return None
    u = t.upper()
    if len(u) <= 4 and u.isalpha():
        return u
    k = t.lower().replace(" ", "_")
    return _CLASS_TO_ABBREV.get(k)


def classify_weapon_lane_from_stats(st: Optional[Dict[str, Any]]) -> Optional[str]:
    if not st or not isinstance(st, dict):
        return None
    raw_slot = st.get("slot")
    if not isinstance(raw_slot, str) or not raw_slot.strip():
        return None
    slot_key = normalize_equip_slot_key(raw_slot)
    if not slot_key:
        return None
    tokens = {x for x in slot_key.split("|") if x}
    has_primary = "PRIMARY" in tokens
    has_secondary = "SECONDARY" in tokens
    skill = st.get("skill")
    skill_s = skill if isinstance(skill, str) else ""
    name = st.get("name")
    name_s = name if isinstance(name, str) else ""
    is_2h = bool(re.search(r"^\s*2H\b", skill_s, re.I) or re.search(r"\b2H\s+", skill_s, re.I))
    try:
        ac = float(st.get("ac") or 0)
    except (TypeError, ValueError):
        ac = float("nan")
    dmg_raw = st.get("dmg")
    has_dmg = dmg_raw is not None and dmg_raw != ""

    if has_secondary and not has_primary:
        if re.search(r"shield", name_s, re.I) or re.search(r"shield", skill_s, re.I):
            return "shield"
        if ac == ac and ac >= 18 and not has_dmg:
            return "shield"
        if skill_s and re.search(r"\b(1H|One Hand|Hand to Hand)\b", skill_s, re.I):
            return "oh_weapon"
        if has_dmg or st.get("atkDelay") is not None:
            return "oh_weapon"
        return None

    if has_primary and not has_secondary:
        if is_2h:
            return "two_hand"
        if skill_s and re.search(r"\b1H\b", skill_s, re.I):
            return "mh_one_hand"
        if has_dmg or st.get("atkDelay") is not None:
            return "mh_one_hand"
        return None

    if has_primary and has_secondary:
        if is_2h:
            return "two_hand"
        return "mh_one_hand"

    return None


def melee_weapon_lane_skips_same_slot_penalty(
    char_abbrev: Optional[str],
    target_lane: Optional[str],
    prior_lane: Optional[str],
) -> bool:
    if not char_abbrev or char_abbrev not in MELEE_WEAPON_LANE_ABBREVS:
        return False
    if not target_lane or not prior_lane:
        return False
    return target_lane != prior_lane
