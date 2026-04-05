"""Character-level bid plausibility and aggregation for second-bidder MVP."""
from __future__ import annotations

import math
from typing import Any, Dict, List, Set, Tuple

from .config import SecondBidderConfig
from .state import KnowledgeState
from .types import LootSaleEvent


def get_attending_characters(account_id: str, event: LootSaleEvent) -> Set[str]:
    """Character IDs linked from raid attendance rows for this account (may be incomplete)."""
    return set(event.attendee_account_to_chars.get(account_id, set()))


def get_player_characters_for_plausibility(
    account_id: str,
    event: LootSaleEvent,
    state: KnowledgeState,
) -> Set[str]:
    """Characters to score for an attending account.

    **Pool / candidacy** is still the **account** (attended, not winner, pool rule).

    **Lanes** for revealed investment come from **prior** purchase history in ``KnowledgeState``
    (we know which character bought what, strictly before this event) unioned with any
    attendance-resolved character IDs for this raid scope. This does not use future buys.
    """
    chars: Set[str] = set(get_attending_characters(account_id, event))
    for (aid, cid), spent in state.account_char_spent.items():
        if aid != account_id or not (cid or "").strip():
            continue
        if float(spent or 0.0) > 0.0:
            chars.add(str(cid).strip())
    for (aid, cid) in state.char_win_history.keys():
        if aid == account_id and (cid or "").strip():
            chars.add(str(cid).strip())
    return chars


def compute_active_toon_features(
    account_id: str,
    char_id: str,
    event: LootSaleEvent,
    state: KnowledgeState,
    config: SecondBidderConfig,
) -> Dict[str, float]:
    tot = float(state.account_total_spent.get(account_id, 0.0))
    ck = (account_id, char_id)
    spent = float(state.account_char_spent.get(ck, 0.0))
    share = (spent / tot) if tot > 0 else 0.0
    wins = float(state.char_win_count(account_id, char_id, event.event_index))
    decay = (
        config.recency_decay_char
        if config.recency_decay_char is not None
        else config.recency_decay_per_event
    )
    any_rec = state.recency_weighted_any_wins_for_char(
        account_id, char_id, event.event_index, decay
    )
    dormant = (spent < config.min_active_char_lifetime_spend) or (
        share < config.min_char_share_of_account_spend
    )
    return {
        "char_lifetime_spend": spent,
        "char_share_of_account": share,
        "char_win_count": wins,
        "char_any_recency": any_rec,
        "is_dormant_lane": 1.0 if dormant else 0.0,
    }


def compute_item_character_fit_features(
    account_id: str,
    char_id: str,
    event: LootSaleEvent,
    state: KnowledgeState,
    config: SecondBidderConfig,
) -> Dict[str, float]:
    decay = (
        config.recency_decay_char
        if config.recency_decay_char is not None
        else config.recency_decay_per_event
    )
    same_norm = state.recency_weighted_norm_wins_for_char(
        account_id, char_id, event.norm_name, event.event_index, decay
    )
    key = (account_id, char_id)
    same_item_hits = 0.0
    item_name = (event.item_name or "").strip()
    if item_name:
        for row in state.char_win_history.get(key, []):
            it = row[2]
            if it == item_name:
                same_item_hits += 1.0
    return {
        "char_same_norm_recency": same_norm,
        "char_same_item_prior_wins": same_item_hits,
    }


def compute_spend_willingness_proxy(
    active: Dict[str, float],
) -> float:
    spent = max(0.0, float(active["char_lifetime_spend"]))
    share = max(0.0, float(active["char_share_of_account"]))
    return math.log1p(spent) * (0.2 + 0.8 * min(1.0, share * 5.0))


def score_character_bid_plausibility(
    elig_gate: float,
    active: Dict[str, float],
    fit: Dict[str, float],
    willingness: float,
    config: SecondBidderConfig,
) -> Tuple[float, Dict[str, float]]:
    if elig_gate <= 0:
        return 0.0, {"elig_gate": 0.0, "product": 0.0}

    dormant_mult = (
        config.dormant_char_multiplier if active["is_dormant_lane"] >= 0.5 else 1.0
    )
    base_active = math.log1p(max(0.0, active["char_lifetime_spend"]))
    fit_boost = 1.0 + float(fit["char_same_norm_recency"]) + 0.1 * float(
        fit["char_same_item_prior_wins"]
    )
    prod = (
        float(elig_gate)
        * dormant_mult
        * (1.0 + base_active)
        * fit_boost
        * (1.0 + max(0.0, willingness))
    )
    detail = {
        "elig_gate": elig_gate,
        "dormant_multiplier_applied": dormant_mult,
        "active_log_spend_term": base_active,
        "fit_boost": fit_boost,
        "willingness": willingness,
        "product": prod,
    }
    return prod, detail


def aggregate_character_scores_to_player(
    char_scores: List[float],
    config: SecondBidderConfig,
) -> float:
    vals = [float(x) for x in char_scores if float(x) > 0]
    if not vals:
        return 0.0
    mode = config.character_aggregation
    if mode == "max":
        return max(vals)
    if mode == "top_k_sum":
        k = max(1, int(config.aggregation_top_k))
        vals.sort(reverse=True)
        return float(sum(vals[:k]))
    if mode == "logsumexp":
        t = max(1e-6, float(config.logsumexp_temperature))
        m = max(vals)
        s = sum(math.exp((v - m) / t) for v in vals)
        return t * (m / t + math.log(s))
    return max(vals)


def character_elig_gate(
    account_id: str,
    char_id: str,
    event: LootSaleEvent,
) -> float:
    pairs = event.eligible_char_pairs
    if pairs is None:
        return 1.0
    return 1.0 if (account_id, char_id) in pairs else 0.0


def compute_account_character_plausibility(
    account_id: str,
    event: LootSaleEvent,
    state: KnowledgeState,
    config: SecondBidderConfig,
) -> Tuple[float, List[Dict[str, Any]], List[str]]:
    chars = get_player_characters_for_plausibility(account_id, event, state)
    notes: List[str] = []
    rows: List[Dict[str, Any]] = []
    scores: List[float] = []

    if not chars:
        notes.append("no_prior_character_signal_and_no_attendance_chars")
        raw = config.inactive_player_char_floor * config.empty_attendee_chars_multiplier
        return raw, rows, notes

    any_eligible_positive = False
    any_non_dormant_eligible = False

    for cid in sorted(chars):
        elig = character_elig_gate(account_id, cid, event)
        active = compute_active_toon_features(account_id, cid, event, state, config)
        fit = compute_item_character_fit_features(account_id, cid, event, state, config)
        will = compute_spend_willingness_proxy(active)
        pl, detail = score_character_bid_plausibility(elig, active, fit, will, config)

        active_toon_score = math.log1p(max(0.0, active["char_lifetime_spend"])) * (
            0.15 + 0.85 * min(1.0, float(active["char_share_of_account"]) * 4.0)
        )
        item_fit_score = float(fit["char_same_norm_recency"]) + 0.1 * float(
            fit["char_same_item_prior_wins"]
        )
        at_event = cid in get_attending_characters(account_id, event)
        prior_spend = float(state.account_char_spent.get((account_id, cid), 0.0)) > 0.0 or bool(
            state.char_win_history.get((account_id, cid))
        )
        row: Dict[str, Any] = {
            "char_id": cid,
            "seen_on_attendance": at_event,
            "prior_revealed_lane": prior_spend,
            "eligible_for_item": bool(elig >= 1.0),
            "lifetime_spend": active["char_lifetime_spend"],
            "share_of_player_spend": active["char_share_of_account"],
            "win_count_on_char": int(active["char_win_count"]),
            "recent_spend_proxy": active["char_any_recency"],
            "is_dormant_lane": bool(active["is_dormant_lane"] >= 0.5),
            "active_toon_score": active_toon_score,
            "item_fit_score": item_fit_score,
            "same_norm_recency": fit["char_same_norm_recency"],
            "same_item_prior_wins": int(fit["char_same_item_prior_wins"]),
            "willingness_proxy": will,
            "character_bid_plausibility": pl,
            "detail": detail,
        }
        rows.append(row)
        scores.append(pl)
        if elig >= 1.0 and pl > 0:
            any_eligible_positive = True
        if (
            elig >= 1.0
            and pl > 0
            and active["is_dormant_lane"] < 0.5
        ):
            any_non_dormant_eligible = True

    agg = aggregate_character_scores_to_player(scores, config)

    if not any_eligible_positive:
        notes.append("no_eligible_character_lane")
        agg = min(agg, config.inactive_player_char_floor)
    elif not any_non_dormant_eligible and chars:
        notes.append("only_dormant_eligible_lanes")
        agg = min(agg, max(config.inactive_player_char_floor, agg * config.dormant_char_multiplier))

    return agg, rows, notes
