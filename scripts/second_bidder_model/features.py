from __future__ import annotations

import math
from typing import Dict, List

from bid_portfolio_local.balance_before_loot import BalanceCalculator

from .config import SecondBidderConfig
from .state import KnowledgeState
from .types import FeatureBundle, LootSaleEvent


def _norm_rows(raw_rows: List[Dict[str, float]]) -> List[Dict[str, float]]:
    if not raw_rows:
        return []
    keys: List[str] = sorted({k for r in raw_rows for k in r})
    out: List[Dict[str, float]] = []
    for r in raw_rows:
        nr: Dict[str, float] = {}
        for k in keys:
            vals = [float(x.get(k, 0.0)) for x in raw_rows]
            lo, hi = min(vals), max(vals)
            v = float(r.get(k, 0.0))
            if hi <= lo:
                nr[k] = 0.5
            else:
                nr[k] = (v - lo) / (hi - lo)
        out.append(nr)
    return out


def compute_capability_raw(
    account_id: str,
    event: LootSaleEvent,
    bc: BalanceCalculator,
) -> Dict[str, float]:
    pool = float(bc.balance_before(event.loot_id, account_id) or 0.0)
    p = max(float(event.winning_price), 1.0)
    elig = (
        1.0
        if event.eligible_account_ids is None or account_id in event.eligible_account_ids
        else 0.0
    )
    return {
        "dkp_ratio": pool / p,
        "dkp_log": math.log1p(max(pool, 0.0)),
        "eligible": elig,
        "recent_attendance": 1.0,
    }


def compute_propensity_raw(
    account_id: str,
    event: LootSaleEvent,
    state: KnowledgeState,
    config: SecondBidderConfig,
) -> Dict[str, float]:
    d = config.recency_decay_per_event
    idx = event.event_index
    same = state.recency_weighted_norm_wins(account_id, event.norm_name, idx, d)
    anyw = state.recency_weighted_any_wins(account_id, idx, d)
    chars = event.attendee_account_to_chars.get(account_id, set())
    spend = 0.0
    for c in chars:
        spend += state.account_char_spent.get((account_id, c), 0.0)
    return {
        "same_norm_recency": same,
        "any_recency": anyw,
        "attending_toon_spend": spend,
    }


def compute_competitiveness_raw(
    account_id: str,
    event: LootSaleEvent,
    state: KnowledgeState,
    bc: BalanceCalculator,
) -> Dict[str, float]:
    pool = float(bc.balance_before(event.loot_id, account_id) or 0.0)
    wins = int(state.account_win_count.get(account_id, 0))
    tot = float(state.account_total_spent.get(account_id, 0.0))
    mean_cost = (tot / wins) if wins else 0.0
    n = int(state.account_paid_to_ref_n.get(account_id, 0))
    s = float(state.account_paid_to_ref_sum.get(account_id, 0.0))
    mean_ptr = (s / n) if n else 0.0
    hoard = pool / (1.0 + tot)
    return {
        "mean_win_cost": mean_cost,
        "paid_to_ref": mean_ptr,
        "hoarding": hoard,
        "win_count": float(wins),
    }


def build_feature_bundles(
    account_ids: List[str],
    event: LootSaleEvent,
    state: KnowledgeState,
    bc: BalanceCalculator,
    config: SecondBidderConfig,
) -> List[FeatureBundle]:
    caps = [compute_capability_raw(a, event, bc) for a in account_ids]
    props = [compute_propensity_raw(a, event, state, config) for a in account_ids]
    comps = [compute_competitiveness_raw(a, event, state, bc) for a in account_ids]
    caps_n = _norm_rows(caps)
    props_n = _norm_rows(props)
    comps_n = _norm_rows(comps)
    bundles: List[FeatureBundle] = []
    for i, a in enumerate(account_ids):
        bundles.append(
            FeatureBundle(
                account_id=a,
                capability=caps_n[i],
                propensity=props_n[i],
                competitiveness=comps_n[i],
            )
        )
    return bundles
