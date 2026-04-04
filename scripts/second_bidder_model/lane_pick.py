"""Pick a display character lane from per-character debug rows."""
from __future__ import annotations

from typing import Any, Dict, List, Optional


def top_eligible_attending_char_id(character_rows: List[Dict[str, Any]]) -> Optional[str]:
    """Char_id with highest bid plausibility among rows that were on attendance and item-eligible."""
    best_id: Optional[str] = None
    best_pl = float("-inf")
    for r in character_rows:
        if not r.get("eligible_for_item") or not r.get("seen_on_attendance"):
            continue
        cid = r.get("char_id")
        if not cid:
            continue
        sid = str(cid).strip()
        if not sid:
            continue
        pl = float(r.get("character_bid_plausibility", 0.0))
        if pl > best_pl or (pl == best_pl and (best_id is None or sid < best_id)):
            best_pl = pl
            best_id = sid
    return best_id
