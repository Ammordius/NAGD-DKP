"""Runner-up guess + officer_bid_portfolio_for_loot-shaped JSON + bid_portfolio_auction_fact row."""

from __future__ import annotations

import statistics
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from .attendees import attendee_account_ids_for_loot
from .balance_before_loot import BalanceCalculator
from .guild_loot_enriched import EnrichedLoot
from .load_csv import BackupSnapshot


def _median(xs: List[float]) -> Optional[float]:
    if not xs:
        return None
    return float(statistics.median(xs))


def enriched_guild_sale_sort_key(e: EnrichedLoot) -> Tuple:
    """Match guild_loot_sale_enriched ORDER BY raid_date ASC NULLS FIRST, loot_id ASC."""
    if e.raid_date is None:
        return (0, e.loot_id)
    return (1, e.raid_date, e.loot_id)


def _strictly_before(
    ed: Optional[date],
    eid: int,
    cd: Optional[date],
    cid: int,
) -> bool:
    """SQL: e.raid_date < c OR (e.raid_date IS NOT DISTINCT FROM c AND e.loot_id < c.loot_id)."""
    if ed is None or cd is None:
        if ed is None and cd is None:
            return eid < cid
        return False
    if ed < cd:
        return True
    if ed > cd:
        return False
    return eid < cid


def _strictly_after(
    ed: Optional[date],
    eid: int,
    cd: Optional[date],
    cid: int,
) -> bool:
    if ed is None or cd is None:
        if ed is None and cd is None:
            return eid > cid
        return False
    if ed > cd:
        return True
    if ed < cd:
        return False
    return eid > cid


def runner_up_account_guess(
    bc: BalanceCalculator,
    snap: BackupSnapshot,
    gle: EnrichedLoot,
) -> Optional[str]:
    p = gle.cost_num
    buyer = gle.buyer_account_id
    if p is None or p <= 0:
        return None
    attendees = attendee_account_ids_for_loot(snap, gle.raid_id, gle.event_id)
    best: Optional[str] = None
    best_pool: Optional[float] = None
    for aid in attendees:
        if not aid or aid == buyer:
            continue
        pool = bc.balance_before(gle.loot_id, aid)
        if pool is None or pool < p:
            continue
        if best is None:
            best = aid
            best_pool = pool
        elif pool > best_pool or (pool == best_pool and aid < best):
            best = aid
            best_pool = pool
    return best


@dataclass
class PortfolioIndexes:
    """Pre-indexed enriched rows (guild sale order) for fast prior / later lookups."""

    by_buyer_positive: Dict[str, List[EnrichedLoot]]
    by_norm_buyer_positive: Dict[Tuple[str, str], List[EnrichedLoot]]


def build_portfolio_indexes(enriched_sorted: List[EnrichedLoot]) -> PortfolioIndexes:
    by_buyer: Dict[str, List[EnrichedLoot]] = defaultdict(list)
    by_nb: Dict[Tuple[str, str], List[EnrichedLoot]] = defaultdict(list)
    for e in enriched_sorted:
        if not e.buyer_account_id or e.cost_num <= 0:
            continue
        by_buyer[e.buyer_account_id].append(e)
        by_nb[(e.norm_name, e.buyer_account_id)].append(e)
    return PortfolioIndexes(
        by_buyer_positive=dict(by_buyer), by_norm_buyer_positive=dict(by_nb)
    )


def prior_purchase_stats(
    indexes: PortfolioIndexes,
    current: EnrichedLoot,
    account_id: str,
) -> Tuple[Optional[float], int, Optional[float]]:
    costs: List[float] = []
    ratios: List[float] = []
    for e in indexes.by_buyer_positive.get(account_id, []):
        if not _strictly_before(
            e.raid_date, e.loot_id, current.raid_date, current.loot_id
        ):
            continue
        costs.append(e.cost_num)
        if e.paid_to_ref_ratio is not None:
            ratios.append(float(e.paid_to_ref_ratio))
    return _median(costs), len(costs), _median(ratios) if ratios else None


def first_later_same_norm(
    indexes: PortfolioIndexes,
    current: EnrichedLoot,
    account_id: str,
) -> Tuple[Optional[int], bool]:
    for e in indexes.by_norm_buyer_positive.get((current.norm_name, account_id), []):
        if e.cost_num <= 0:
            continue
        if _strictly_after(e.raid_date, e.loot_id, current.raid_date, current.loot_id):
            return e.loot_id, True
    return None, False


def sale_object(gle: EnrichedLoot) -> Dict[str, Any]:
    return {
        "loot_id": gle.loot_id,
        "raid_id": gle.raid_id,
        "event_id": gle.event_id,
        "item_name": gle.item_name,
        "norm_name": gle.norm_name,
        "raid_date": gle.raid_date.isoformat() if gle.raid_date else None,
        "cost_num": gle.cost_num,
        "cost_text": gle.cost_text,
        "buyer_account_id": gle.buyer_account_id,
        "ref_price_at_sale": gle.ref_price_at_sale,
        "paid_to_ref_ratio": gle.paid_to_ref_ratio,
        "next_guild_sale_loot_id": gle.next_guild_sale_loot_id,
        "next_guild_sale_buyer_account_id": gle.next_guild_sale_buyer_account_id,
    }


def officer_bid_portfolio_for_loot_payload(
    snap: BackupSnapshot,
    bc: BalanceCalculator,
    gle: EnrichedLoot,
    indexes: PortfolioIndexes,
) -> Dict[str, Any]:
    use_per_event = snap.raid_has_event_attendance(gle.raid_id)
    sim_mode = "per_event" if use_per_event else "raid_level"
    p = gle.cost_num
    buyer = gle.buyer_account_id
    runner = runner_up_account_guess(bc, snap, gle)
    attendees: List[Dict[str, Any]] = []
    for aid in sorted(attendee_account_ids_for_loot(snap, gle.raid_id, gle.event_id)):
        pool = bc.balance_before(gle.loot_id, aid)
        could_clear = p is not None and p > 0 and pool is not None and pool >= p
        syn = None
        if p is not None and p > 0 and pool is not None:
            syn = min(pool, max(0.0, p - 1))
        med_paid, cnt_prior, med_ratio = prior_purchase_stats(indexes, gle, aid)
        later_id, later_flag = first_later_same_norm(indexes, gle, aid)
        attendees.append(
            {
                "account_id": aid,
                "pool_before": pool,
                "could_clear": could_clear,
                "synthetic_max_bid": syn,
                "is_buyer": aid == buyer,
                "median_paid_prior": med_paid,
                "purchase_count_prior": cnt_prior,
                "median_paid_to_ref_prior": med_ratio,
                "later_bought_same_norm": later_flag,
                "first_later_loot_id": later_id,
            }
        )
    return {
        "loot_id": gle.loot_id,
        "raid_id": gle.raid_id,
        "sim_mode": sim_mode,
        "sale": sale_object(gle),
        "runner_up_account_guess": runner,
        "attendees": attendees,
        "notes": [
            "Heuristic only: no auction log.",
            "synthetic_max_bid uses LEAST(pool, P-1) for teaching scaffold.",
            "runner_up_account_guess = max pool among non-buyer attendees with pool >= P.",
        ],
    }


def fact_row(
    gle: EnrichedLoot,
    runner: Optional[str],
    payload: Optional[Dict[str, Any]],
    computed_at: Optional[str] = None,
) -> Dict[str, Any]:
    if computed_at is None:
        computed_at = datetime.now(timezone.utc).isoformat()
    row: Dict[str, Any] = {
        "loot_id": gle.loot_id,
        "raid_id": gle.raid_id,
        "event_id": gle.event_id,
        "raid_date": gle.raid_date.isoformat() if gle.raid_date else None,
        "item_name": gle.item_name,
        "norm_name": gle.norm_name,
        "cost_num": gle.cost_num,
        "buyer_account_id": gle.buyer_account_id,
        "ref_price_at_sale": gle.ref_price_at_sale,
        "paid_to_ref_ratio": gle.paid_to_ref_ratio,
        "runner_up_account_guess": runner,
        "next_guild_sale_loot_id": gle.next_guild_sale_loot_id,
        "next_guild_sale_buyer_account_id": gle.next_guild_sale_buyer_account_id,
        "computed_at": computed_at,
    }
    if payload is not None:
        row["payload"] = payload
    return row
