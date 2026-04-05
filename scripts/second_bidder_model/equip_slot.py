"""Normalize equipment slot strings from item_stats for cross-item matching."""
from __future__ import annotations

from typing import Optional, Set


def normalize_equip_slot_key(raw: Optional[str]) -> Optional[str]:
    """Canonical key: sorted upper tokens joined by '|' so PRIMARY SECONDARY matches SECONDARY PRIMARY."""
    if not raw or not isinstance(raw, str):
        return None
    parts = [p for p in raw.strip().upper().split() if p]
    if not parts:
        return None
    return "|".join(sorted(parts))


def slot_key_token_set(key: Optional[str]) -> Set[str]:
    if not key:
        return set()
    return {t for t in key.split("|") if t}


def slot_keys_overlap(key_a: Optional[str], key_b: Optional[str]) -> bool:
    """True when both keys resolve and share at least one slot token (e.g. EAR vs EAR)."""
    if not key_a or not key_b:
        return False
    return bool(slot_key_token_set(key_a) & slot_key_token_set(key_b))
