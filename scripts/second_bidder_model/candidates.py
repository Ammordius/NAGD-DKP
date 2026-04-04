from __future__ import annotations

from typing import Dict, List, Set, Tuple

from bid_portfolio_local.balance_before_loot import BalanceCalculator

from .config import SecondBidderConfig
from .types import LootSaleEvent


def build_candidate_pool(
    event: LootSaleEvent,
    bc: BalanceCalculator,
    config: SecondBidderConfig,
) -> Tuple[List[str], Dict[str, str]]:
    exclusions: Dict[str, str] = {}
    p = float(event.winning_price or 0)
    ratio_floor = config.min_pool_ratio * p
    abs_floor = config.min_pool_absolute
    clear_need = (p - config.clearing_epsilon) if config.require_pool_ge_clearing else 0.0
    min_pool = max(abs_floor, ratio_floor, clear_need)

    candidates: List[str] = []
    for aid in sorted(event.attendee_account_ids):
        if aid == event.buyer_account_id:
            exclusions[aid] = "winner"
            continue
        if event.eligible_account_ids is not None and aid not in event.eligible_account_ids:
            exclusions[aid] = "not_eligible_for_item_external"
            continue
        pool = bc.balance_before(event.loot_id, aid)
        if pool is None:
            exclusions[aid] = "no_reconstructed_pool"
            continue
        if float(pool) < min_pool:
            exclusions[aid] = "pool_below_threshold"
            continue
        candidates.append(aid)
    return candidates, exclusions
