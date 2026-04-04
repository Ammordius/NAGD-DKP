from __future__ import annotations

from typing import Dict, List, Optional, Set, Tuple

from bid_portfolio_local.guild_loot_enriched import build_guild_loot_sale_enriched
from bid_portfolio_local.load_csv import BackupSnapshot
from bid_portfolio_local.portfolio import enriched_guild_sale_sort_key

from .attendance_map import attendee_account_char_map_for_loot
from .types import LootSaleEvent


def prepare_second_bidder_events(
    snap: BackupSnapshot,
    *,
    require_buyer: bool = True,
    require_positive_price: bool = True,
    eligible_by_loot_id: Optional[Dict[int, Set[str]]] = None,
    eligible_chars_by_loot_id: Optional[Dict[int, Set[Tuple[str, str]]]] = None,
) -> List[LootSaleEvent]:
    enriched_list, _by_id = build_guild_loot_sale_enriched(snap)
    rows = list(enriched_list)
    if require_positive_price:
        rows = [e for e in rows if e.cost_num > 0]
    if require_buyer:
        rows = [e for e in rows if (e.buyer_account_id or "").strip()]
    rows.sort(key=enriched_guild_sale_sort_key)

    loot_by_id: Dict[int, Dict[str, str]] = {}
    for rl in snap.raid_loot:
        loot_by_id[int(rl["id"])] = rl

    events: List[LootSaleEvent] = []
    for i, e in enumerate(rows):
        rl = loot_by_id.get(e.loot_id, {})
        buyer_char = (rl.get("char_id") or "").strip() or None
        acc_ids, acc_map = attendee_account_char_map_for_loot(snap, e.raid_id, e.event_id)
        elig = None
        if eligible_by_loot_id is not None and e.loot_id in eligible_by_loot_id:
            elig = set(eligible_by_loot_id[e.loot_id])
        elig_chars = None
        if eligible_chars_by_loot_id is not None and e.loot_id in eligible_chars_by_loot_id:
            elig_chars = set(eligible_chars_by_loot_id[e.loot_id])
        events.append(
            LootSaleEvent(
                event_index=i,
                loot_id=e.loot_id,
                raid_id=e.raid_id,
                event_id=e.event_id,
                raid_date=e.raid_date,
                norm_name=e.norm_name,
                item_name=e.item_name,
                winning_price=float(e.cost_num),
                buyer_account_id=(e.buyer_account_id or "").strip() or None,
                buyer_char_id=buyer_char,
                attendee_account_ids=set(acc_ids),
                attendee_account_to_chars=dict(acc_map),
                eligible_account_ids=elig,
                eligible_char_pairs=elig_chars,
                ref_price_at_sale=e.ref_price_at_sale,
                paid_to_ref_ratio=e.paid_to_ref_ratio,
            )
        )
    return events
