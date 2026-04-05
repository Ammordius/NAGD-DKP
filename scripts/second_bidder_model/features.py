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


def _attending_chars_revealed_spend(account_id: str, event: LootSaleEvent, state: KnowledgeState) -> float:
    """Prior spend only on characters linked to this raid's attendance for this account."""
    chars = event.attendee_account_to_chars.get(account_id, set()) or set()
    s = 0.0
    for cid in chars:
        c = (cid or "").strip()
        if not c:
            continue
        s += float(state.account_char_spent.get((account_id, c), 0.0))
    return s


def _max_attending_char_any_recency(
    account_id: str, event: LootSaleEvent, state: KnowledgeState, decay: float
) -> float:
    """Max decay-weighted 'any item' win recency among raid-attending characters."""
    chars = event.attendee_account_to_chars.get(account_id, set()) or set()
    best = 0.0
    idx = event.event_index
    for cid in chars:
        c = (cid or "").strip()
        if not c:
            continue
        v = state.recency_weighted_any_wins_for_char(account_id, c, idx, decay)
        best = max(best, v)
    return best


def _attendee_char_id_list(account_id: str, event: LootSaleEvent) -> List[str]:
    chars = event.attendee_account_to_chars.get(account_id, set()) or set()
    out = [(c or "").strip() for c in chars]
    return [c for c in out if c]


def _same_slot_recency_attending(
    account_id: str, event: LootSaleEvent, state: KnowledgeState, decay: float
) -> float:
    """Decay-weighted prior wins in the same equip slot on any attending character (cooldown signal)."""
    return state.recency_weighted_same_slot_wins_for_attending_chars(
        account_id,
        _attendee_char_id_list(account_id, event),
        event.equip_slot,
        event.event_index,
        decay,
    )


def _prior_same_item_win_count(
    account_id: str,
    item_name: str,
    state: KnowledgeState,
    before_event_index: int,
) -> float:
    """Prior wins of this exact item_name on any character of the account (no leakage)."""
    it = (item_name or "").strip()
    if not it:
        return 0.0
    n = 0
    for (a, _cid), hist in state.char_win_history.items():
        if a != account_id:
            continue
        for row in hist:
            idx, iname = row[0], row[2]
            if idx >= before_event_index:
                continue
            if (iname or "").strip() == it:
                n += 1
    return float(n)


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
    decay_c = (
        config.recency_decay_char
        if config.recency_decay_char is not None
        else config.recency_decay_per_event
    )
    spend = _attending_chars_revealed_spend(account_id, event, state)
    max_att_rec = _max_attending_char_any_recency(account_id, event, state, decay_c)
    slot_rec = _same_slot_recency_attending(account_id, event, state, decay_c)
    wins = int(state.account_win_count.get(account_id, 0))
    attended = int(state.account_loot_events_attended.get(account_id, 0))
    win_rate = float(wins) / float(max(1, attended))
    prior_same = _prior_same_item_win_count(
        account_id, event.item_name, state, event.event_index
    )
    return {
        "same_norm_recency": same,
        "any_recency": anyw,
        "attending_toon_spend": spend,
        "max_attending_char_any_recency": max_att_rec,
        "same_slot_recency_attending": slot_rec,
        "win_rate_over_attended_loot_sales": win_rate,
        "prior_same_item_wins": prior_same,
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
    ew = state.account_paid_to_ref_ewma.get(account_id)
    ewma_ptr = float(ew) if ew is not None else mean_ptr
    if ewma_ptr <= 0.0:
        ewma_ptr = mean_ptr if mean_ptr > 0.0 else 1.0
    char_lane_spend = _max_revealed_char_spend(account_id, state)
    hoard_lane = pool / (1.0 + char_lane_spend)
    hoard_account = pool / (1.0 + tot)
    return {
        "mean_win_cost": mean_cost,
        "paid_to_ref": mean_ptr,
        "paid_to_ref_ewma": ewma_ptr,
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
