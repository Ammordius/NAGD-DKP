"""Configurable weights and thresholds for second-bidder MVP."""
from __future__ import annotations
from dataclasses import dataclass, field

@dataclass
class SecondBidderConfig:
    min_pool_ratio: float = 0.5
    min_pool_absolute: float = 0.0
    require_pool_ge_clearing: bool = True
    clearing_epsilon: float = 0.0
    w_capability: float = 1.0
    w_propensity: float = 1.0
    w_competitiveness: float = 0.8
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
            "hoarding": 0.25,
            "win_count": 0.25,
        }
    )
    score_floor: float = 1e-6
    recency_decay_per_event: float = 0.03
