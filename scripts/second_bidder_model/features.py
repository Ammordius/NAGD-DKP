from __future__ import annotations

import math
from typing import Dict, List, Tuple

from bid_portfolio_local.balance_before_loot import BalanceCalculator

from .character_plausibility import compute_account_character_plausibility
from .config import SecondBidderConfig
from .state import KnowledgeState
from .types import FeatureBundle, LootSaleEvent


def _revealed_char_spend_sum(account_id: str, state: KnowledgeState) -> float:
    """Sum of prior DKP attributed to any character on this account (from known purchases)."""
    return sum(
        float(v) for (a, _cid), v in state.account_char_spent.items() if a == account_id
    )


def _max_revealed_char_spend(account_id: str, state: KnowledgeState) -> float:
    """Largest prior per-character spend on this account (revealed investment lane ceiling)."""
    m = 0.0
    for (a, _cid), v in state.account_char_spent.items():
        if a == account_id:
            m = max(m, float(v))
    return m


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
    state: KnowledgeState,
    bc: BalanceCalculator,
    config: SecondBidderConfig,
) -> Dict[str, float]:
    pool = float(bc.balance_before(event.loot_id, account_id) or 0.0)
    p = max(float(event.winning_price), 1.0)
    tot = float(state.account_total_spent.get(account_id, 0.0))
    elig = (
        1.0
        if event.eligible_account_ids is None or account_id in event.eligible_account_ids
        else 0.0
    )
    pool_cap = float(config.capability_pool_cap or 0.0)
    pool_for_log = min(pool, pool_cap) if pool_cap > 0 else pool
    ratio = pool / p
    ratio_cap = float(config.capability_dkp_ratio_cap or 0.0)
    if ratio_cap > 0:
        ratio = min(ratio, ratio_cap)
    denom = tot + pool + 1e-9
    wealth_util = tot / denom
    return {
        "dkp_ratio": ratio,
        "dkp_log": math.log1p(max(pool_for_log, 0.0)),
        "eligible": elig,
        "recent_attendance": 1.0,
        "wealth_utilization": wealth_util,
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
    spend = _revealed_char_spend_sum(account_id, state)
    wins = int(state.account_win_count.get(account_id, 0))
    attended = int(state.account_loot_events_attended.get(account_id, 0))
    win_rate = float(wins) / float(max(1, attended))
    return {
        "same_norm_recency": same,
        "any_recency": anyw,
        "attending_toon_spend": spend,
        "win_rate_over_attended_loot_sales": win_rate,
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
    char_lane_spend = _max_revealed_char_spend(account_id, state)
    hoard_lane = pool / (1.0 + char_lane_spend)
    hoard_account = pool / (1.0 + tot)
    return {
        "mean_win_cost": mean_cost,
        "paid_to_ref": mean_ptr,
        "hoarding_char_lane": hoard_lane,
        "hoarding_account_total": hoard_account,
        "win_count": float(wins),
    }


def build_feature_bundles(
    account_ids: List[str],
    event: LootSaleEvent,
    state: KnowledgeState,
    bc: BalanceCalculator,
    config: SecondBidderConfig,
) -> Tuple[List[FeatureBundle], List[Dict[str, object]]]:
    char_raw: List[Dict[str, float]] = []
    side: List[Dict[str, object]] = []
    for a in account_ids:
        raw_agg, rows, notes = compute_account_character_plausibility(a, event, state, config)
        char_raw.append({"char_agg": raw_agg})
        side.append(
            {
                "raw_character_agg": raw_agg,
                "character_rows": rows,
                "exclusion_notes": notes,
            }
        )

    caps = [compute_capability_raw(a, event, state, bc, config) for a in account_ids]
    props = [compute_propensity_raw(a, event, state, config) for a in account_ids]
    comps = [compute_competitiveness_raw(a, event, state, bc) for a in account_ids]
    caps_n = _norm_rows(caps)
    props_n = _norm_rows(props)
    comps_n = _norm_rows(comps)
    chars_n = _norm_rows(char_raw)
    bundles: List[FeatureBundle] = []
    for i, a in enumerate(account_ids):
        bundles.append(
            FeatureBundle(
                account_id=a,
                capability=caps_n[i],
                propensity=props_n[i],
                competitiveness=comps_n[i],
                character=chars_n[i],
            )
        )
    return bundles, side
