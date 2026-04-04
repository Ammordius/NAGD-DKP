from __future__ import annotations

from typing import Dict, List

from .config import SecondBidderConfig
from .types import FeatureBundle


def _dot(weights: Dict[str, float], values: Dict[str, float]) -> float:
    s = 0.0
    for k, w in weights.items():
        s += float(w) * float(values.get(k, 0.0))
    return s


def score_candidate(bundle: FeatureBundle, config: SecondBidderConfig) -> tuple:
    cap = _dot(config.capability_weights, bundle.capability)
    prop = _dot(config.propensity_weights, bundle.propensity)
    comp = _dot(config.competitiveness_weights, bundle.competitiveness)
    raw = (
        config.w_capability * cap
        + config.w_propensity * prop
        + config.w_competitiveness * comp
    )
    return raw, cap, prop, comp


def normalize_candidate_scores(raw_scores: Dict[str, float], floor: float) -> Dict[str, float]:
    adj = {k: max(float(v), floor) for k, v in raw_scores.items()}
    total = sum(adj.values())
    if total <= 0:
        n = len(adj)
        return {k: (1.0 / n if n else 0.0) for k in adj}
    return {k: v / total for k, v in adj.items()}
