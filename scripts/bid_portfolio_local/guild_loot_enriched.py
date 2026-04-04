"""Rebuild guild_loot_sale_enriched view from BackupSnapshot."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any, Dict, List, Optional, Tuple

from .load_csv import BackupSnapshot
from .normalize import normalize_item_name_for_lookup, raid_date_parsed
from .resolve import buyer_account_id_for_loot_row, parse_cost_num


def enriched_guild_sale_sort_key(e: "EnrichedLoot") -> Tuple:
    """Match guild_loot_sale_enriched ORDER BY raid_date ASC NULLS FIRST, loot_id ASC."""
    if e.raid_date is None:
        return (0, e.loot_id)
    return (1, e.raid_date, e.loot_id)


@dataclass
class EnrichedLoot:
    loot_id: int
    raid_id: str
    event_id: Optional[str]
    item_name: str
    norm_name: str
    raid_date: Optional[date]
    cost_num: float
    cost_text: str
    buyer_account_id: Optional[str]
    ref_price_at_sale: Optional[float]
    paid_to_ref_ratio: Optional[float]
    next_guild_sale_loot_id: Optional[int]
    next_guild_sale_buyer_account_id: Optional[str]


def _event_id_from_row(row: Dict[str, Any]) -> Optional[str]:
    raw = (row.get("event_id") or "").strip()
    return raw if raw else None


def build_guild_loot_sale_enriched(snap: BackupSnapshot) -> Tuple[List[EnrichedLoot], Dict[int, EnrichedLoot]]:
    """Return sorted list and loot_id -> row index map."""
    base: List[dict] = []
    for rl in snap.raid_loot:
        item = (rl.get("item_name") or "").strip()
        if not item:
            continue
        rid = (rl.get("raid_id") or "").strip()
        if not rid or rid not in snap.raids:
            continue
        raid_row = snap.raids[rid]
        iso = raid_row.get("date_iso") or ""
        rd = raid_date_parsed(str(iso).strip() if iso else None)
        lid = int(rl["id"])
        cost_num = parse_cost_num(rl.get("cost"))
        cost_text = str(rl.get("cost") or "")
        norm = normalize_item_name_for_lookup(item)
        buyer = buyer_account_id_for_loot_row(
            rl.get("char_id"),
            rl.get("character_name"),
            name_to_char_ids=snap.name_to_char_ids,
            char_to_accounts=snap.char_to_accounts,
        )
        base.append(
            {
                "loot_id": lid,
                "raid_id": rid,
                "event_id": _event_id_from_row(rl),
                "item_name": item,
                "norm_name": norm,
                "raid_date": rd,
                "cost_num": cost_num,
                "cost_text": cost_text,
                "buyer_account_id": buyer,
            }
        )

    # ref window: only positive-cost rows per norm_name
    positive = [b for b in base if b["cost_num"] > 0]
    positive.sort(key=lambda x: (x["norm_name"], x["raid_date"] is None, x["raid_date"], x["loot_id"]))
    ref_by_loot: Dict[int, Optional[float]] = {}
    by_norm: Dict[str, List[dict]] = {}
    for row in positive:
        by_norm.setdefault(row["norm_name"], []).append(row)
    for rows in by_norm.values():
        for i, r in enumerate(rows):
            # ROWS BETWEEN 3 PRECEDING AND 1 PRECEDING (exclude current row)
            window = rows[max(0, i - 3) : i]
            if not window:
                ref_by_loot[r["loot_id"]] = None
            else:
                ref_by_loot[r["loot_id"]] = sum(x["cost_num"] for x in window) / len(window)

    # full core sorted for LEAD (all base rows)
    base.sort(key=lambda x: (x["norm_name"], x["raid_date"] is None, x["raid_date"], x["loot_id"]))
    next_loot: Dict[int, Optional[int]] = {}
    next_buyer: Dict[int, Optional[str]] = {}
    for i, r in enumerate(base):
        if i + 1 < len(base) and base[i + 1]["norm_name"] == r["norm_name"]:
            nxt = base[i + 1]
            next_loot[r["loot_id"]] = nxt["loot_id"]
            next_buyer[r["loot_id"]] = nxt["buyer_account_id"]
        else:
            next_loot[r["loot_id"]] = None
            next_buyer[r["loot_id"]] = None

    out: List[EnrichedLoot] = []
    by_id: Dict[int, EnrichedLoot] = {}
    for b in sorted(base, key=lambda x: x["loot_id"]):
        lid = b["loot_id"]
        ref = ref_by_loot.get(lid) if b["cost_num"] > 0 else None
        ratio = None
        if b["cost_num"] > 0 and ref is not None and ref > 0:
            ratio = b["cost_num"] / ref
        el = EnrichedLoot(
            loot_id=lid,
            raid_id=b["raid_id"],
            event_id=b["event_id"],
            item_name=b["item_name"],
            norm_name=b["norm_name"],
            raid_date=b["raid_date"],
            cost_num=b["cost_num"],
            cost_text=b["cost_text"],
            buyer_account_id=b["buyer_account_id"],
            ref_price_at_sale=ref,
            paid_to_ref_ratio=ratio,
            next_guild_sale_loot_id=next_loot.get(lid),
            next_guild_sale_buyer_account_id=next_buyer.get(lid),
        )
        out.append(el)
        by_id[lid] = el
    return out, by_id
