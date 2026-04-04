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
    w_capability: float = 0.55
    w_propensity: float = 1.0
    w_competitiveness: float = 0.6
    w_character: float = 1.0
    w_affordability: float = 1.0
    capability_weights: dict = field(
        default_factory=lambda: {
            "dkp_ratio": 0.28,
            "dkp_log": 0.22,
            "eligible": 0.12,
            "recent_attendance": 0.0,
            "wealth_utilization": 0.38,
        }
    )
    propensity_weights: dict = field(
        default_factory=lambda: {
            "same_norm_recency": 0.35,
            "any_recency": 0.18,
            "attending_toon_spend": 0.18,
            "win_rate_over_attended_loot_sales": 0.18,
            "prior_same_item_wins": 0.11,
        }
    )
    competitiveness_weights: dict = field(
        default_factory=lambda: {
            "mean_win_cost": 0.18,
            "paid_to_ref": 0.18,
            "hoarding_char_lane": 0.12,
            "hoarding_account_total": 0.34,
            "win_count": 0.18,
        }
    )
    character_weights: dict = field(default_factory=lambda: {"char_agg": 1.0})
    score_floor: float = 1e-6
    recency_decay_per_event: float = 0.03
    recency_decay_char: float | None = None

    # Soften extreme wallets before per-event min–max (0 disables)
    capability_pool_cap: float = 500.0
    capability_dkp_ratio_cap: float = 3.5

    # Character-aware heuristics
    min_active_char_lifetime_spend: float = 25.0
    min_char_share_of_account_spend: float = 0.03
    dormant_char_multiplier: float = 0.04
    inactive_player_char_floor: float = 1e-8
    empty_attendee_chars_multiplier: float = 0.02
    exclude_accounts_with_no_attendee_chars: bool = False
    # When True and eligible_char_pairs is set, require an item-eligible character who was
    # on this raid's attendance (not only an off-raid alt in the plausibility set).
    require_item_eligible_attending_lane_for_pool: bool = False
    character_aggregation: CharacterAggregation = "max"
    aggregation_top_k: int = 2
    logsumexp_temperature: float = 1.0
