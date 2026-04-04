"""Configurable weights and thresholds for second-bidder MVP."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

CharacterAggregation = Literal["max", "top_k_sum", "logsumexp"]


@dataclass
class SecondBidderConfig:
    min_pool_ratio: float = 0.5
    min_pool_absolute: float = 0.0
    require_pool_ge_clearing: bool = True
    clearing_epsilon: float = 0.0
    w_capability: float = 0.7
    w_propensity: float = 1.0
    w_competitiveness: float = 0.5
    w_character: float = 1.0
    w_affordability: float = 1.0
    capability_weights: dict = field(
        default_factory=lambda: {
            "dkp_ratio": 0.45,
            "dkp_log": 0.35,
            "eligible": 0.2,
            "recent_attendance": 0.0,
        }
    )
    propensity_weights: dict = field(
        default_factory=lambda: {
            "same_norm_recency": 0.5,
            "any_recency": 0.25,
            "attending_toon_spend": 0.25,
        }
    )
    competitiveness_weights: dict = field(
        default_factory=lambda: {
            "mean_win_cost": 0.25,
            "paid_to_ref": 0.25,
            "hoarding_char_lane": 0.25,
            "win_count": 0.25,
        }
    )
    character_weights: dict = field(default_factory=lambda: {"char_agg": 1.0})
    score_floor: float = 1e-6
    recency_decay_per_event: float = 0.03
    recency_decay_char: float | None = None

    # Character-aware heuristics
    min_active_char_lifetime_spend: float = 25.0
    min_char_share_of_account_spend: float = 0.03
    dormant_char_multiplier: float = 0.04
    inactive_player_char_floor: float = 1e-8
    empty_attendee_chars_multiplier: float = 0.02
    exclude_accounts_with_no_attendee_chars: bool = False
    character_aggregation: CharacterAggregation = "max"
    aggregation_top_k: int = 2
    logsumexp_temperature: float = 1.0
