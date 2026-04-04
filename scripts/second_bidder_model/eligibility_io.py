"""Load optional Magelo / bid-forecast eligibility maps from JSON for batch prep."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Optional, Set, Tuple


def load_eligibility_json(
    path: Path,
) -> tuple[Optional[Dict[int, Set[str]]], Optional[Dict[int, Set[Tuple[str, str]]]]]:
    """Parse eligibility JSON written for ``prepare_second_bidder_events``.

    Top-level object may contain:

    - ``eligible_by_loot_id``: ``{ "<loot_id>": ["account_id", ...], ... }``
    - ``eligible_chars_by_loot_id``: ``{ "<loot_id>": [pair, ...], ... }``
      where each ``pair`` is ``["account_id", "char_id"]`` or
      ``{"account_id": "...", "char_id": "..."}``.

    Missing top-level keys are treated as absent maps (no filter for that mode).
    Loot ids are coerced to ``int``. Only keys **present** in each map apply a filter
    for that ``loot_id`` (see HANDOFF_SECOND_BIDDER_MVP).
    """
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError(f"Eligibility JSON must be an object, got {type(raw).__name__}")

    acc_map: Optional[Dict[int, Set[str]]] = None
    char_map: Optional[Dict[int, Set[Tuple[str, str]]]] = None

    if "eligible_by_loot_id" in raw:
        acc_map = {}
        blob = raw["eligible_by_loot_id"]
        if not isinstance(blob, dict):
            raise ValueError("eligible_by_loot_id must be an object")
        for k, v in blob.items():
            lid = int(k)
            if not isinstance(v, list):
                raise ValueError(f"eligible_by_loot_id[{k!r}] must be a list of account ids")
            acc_map[lid] = {str(x).strip() for x in v if str(x).strip()}

    if "eligible_chars_by_loot_id" in raw:
        char_map = {}
        blob = raw["eligible_chars_by_loot_id"]
        if not isinstance(blob, dict):
            raise ValueError("eligible_chars_by_loot_id must be an object")
        for k, v in blob.items():
            lid = int(k)
            if not isinstance(v, list):
                raise ValueError(f"eligible_chars_by_loot_id[{k!r}] must be a list of pairs")
            pairs: Set[Tuple[str, str]] = set()
            for item in v:
                a, c = _parse_char_pair(item, context=f"loot_id={k}")
                pairs.add((a, c))
            char_map[lid] = pairs

    return acc_map, char_map


def _parse_char_pair(item: Any, *, context: str) -> Tuple[str, str]:
    if isinstance(item, (list, tuple)) and len(item) >= 2:
        a, c = str(item[0]).strip(), str(item[1]).strip()
    elif isinstance(item, dict):
        a = str(item.get("account_id") or item.get("account") or "").strip()
        c = str(item.get("char_id") or item.get("character_id") or "").strip()
    else:
        raise ValueError(f"Bad character eligibility entry ({context}): {item!r}")
    if not a or not c:
        raise ValueError(f"Empty account_id or char_id ({context}): {item!r}")
    return a, c
