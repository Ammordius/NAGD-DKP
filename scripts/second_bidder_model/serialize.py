"""JSON-serializable summaries of prediction results (batch export)."""
from __future__ import annotations

from typing import Any, Dict, List

from .types import LootSaleEvent, PredictionResult, ScoredCandidate


def _event_json(e: LootSaleEvent) -> Dict[str, Any]:
    return {
        "event_index": e.event_index,
        "loot_id": e.loot_id,
        "raid_id": e.raid_id,
        "event_id": e.event_id,
        "raid_date": e.raid_date.isoformat() if e.raid_date else None,
        "norm_name": e.norm_name,
        "item_name": e.item_name,
        "winning_price": e.winning_price,
        "buyer_account_id": e.buyer_account_id,
        "buyer_char_id": e.buyer_char_id,
        "attendee_count": len(e.attendee_account_ids),
        "eligible_filter_on": e.eligible_account_ids is not None,
        "eligible_char_pairs_on": e.eligible_char_pairs is not None,
    }


def _scored_json(
    c: ScoredCandidate,
    *,
    include_features: bool,
    include_character_debug: bool,
) -> Dict[str, Any]:
    row: Dict[str, Any] = {
        "account_id": c.account_id,
        "probability": c.probability,
        "raw_score": c.raw_score,
        "pool_before": c.pool_before,
        "capability_score": c.capability_score,
        "propensity_score": c.propensity_score,
        "competitiveness_score": c.competitiveness_score,
        "character_score": c.character_score,
        "top_eligible_char_id": c.top_eligible_char_id,
    }
    if include_features:
        fb = c.features
        row["features"] = {
            "capability": dict(fb.capability),
            "propensity": dict(fb.propensity),
            "competitiveness": dict(fb.competitiveness),
            "character": dict(fb.character),
        }
    if include_character_debug:
        row["character_debug"] = list(c.character_debug)
        row["player_debug"] = dict(c.player_debug)
    return row


def prediction_result_to_json_dict(
    p: PredictionResult,
    *,
    top_candidates: int = 25,
    include_feature_vectors: bool = False,
    include_character_debug: bool = False,
) -> Dict[str, Any]:
    cap = max(0, top_candidates)
    cands: List[ScoredCandidate] = p.candidates[:cap] if cap else []
    return {
        "event": _event_json(p.event),
        "candidates": [
            _scored_json(
                c,
                include_features=include_feature_vectors,
                include_character_debug=include_character_debug,
            )
            for c in cands
        ],
        "candidate_count": len(p.candidates),
        "exclusion_count": len(p.exclusion_notes),
    }
