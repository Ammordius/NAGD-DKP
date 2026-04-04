from __future__ import annotations

from typing import Any, Dict, Iterator, List, Optional, Tuple

from bid_portfolio_local.balance_before_loot import BalanceCalculator
from bid_portfolio_local.load_csv import BackupSnapshot

from .candidates import build_candidate_pool
from .config import SecondBidderConfig
from .features import build_feature_bundles
from .item_stats_eligibility import ItemStatsEligibilityBundle
from .lane_pick import top_eligible_attending_char_id
from .prepare import prepare_second_bidder_events
from .scoring import normalize_candidate_scores, score_candidate
from .state import KnowledgeState, empty_state, update_knowledge_state
from .types import LootSaleEvent, PredictionResult, ScoredCandidate


def predict_second_bidder_for_event(
    event: LootSaleEvent,
    state: KnowledgeState,
    bc: BalanceCalculator,
    config: SecondBidderConfig,
    *,
    debug: bool = False,
) -> PredictionResult:
    candidates, exclusions = build_candidate_pool(event, bc, config, state)
    dbg: Dict[str, Any] = {}
    if not candidates:
        return PredictionResult(
            event=event,
            candidates=[],
            exclusion_notes=exclusions,
            debug=dbg if debug else {},
        )

    bundles, char_side = build_feature_bundles(candidates, event, state, bc, config)
    raw_by_aid: Dict[str, float] = {}
    scored: List[ScoredCandidate] = []
    for b, side in zip(bundles, char_side):
        raw, cap_scaled, prop, comp, char = score_candidate(b, config)
        raw_by_aid[b.account_id] = raw
        pool = float(bc.balance_before(event.loot_id, b.account_id) or 0.0)
        notes = list(side.get("exclusion_notes") or [])
        rows = side.get("character_rows") or []
        raw_char = float(side.get("raw_character_agg") or 0.0)
        player_debug: Dict[str, Any] = {
            "total_player_dkp": pool,
            "raw_character_agg": raw_char,
            "aggregated_character_score_normalized": float(b.character.get("char_agg", 0.0)),
            "player_affordability_contribution": cap_scaled,
            "propensity_contribution": config.w_propensity * prop,
            "competitiveness_contribution": config.w_competitiveness * comp,
            "character_contribution": config.w_character * char,
            "final_player_score": raw,
            "exclusion_notes": notes,
        }
        lane_id = top_eligible_attending_char_id(list(rows))
        scored.append(
            ScoredCandidate(
                account_id=b.account_id,
                pool_before=pool,
                raw_score=raw,
                probability=0.0,
                capability_score=cap_scaled,
                propensity_score=prop,
                competitiveness_score=comp,
                features=b,
                character_score=char,
                character_debug=list(rows),
                player_debug=player_debug,
                top_eligible_char_id=lane_id,
            )
        )
    probs = normalize_candidate_scores(raw_by_aid, config.score_floor)
    for sc in scored:
        sc.probability = probs.get(sc.account_id, 0.0)
    scored.sort(key=lambda x: (-x.probability, x.account_id))
    if debug:
        dbg["min_pool_rule"] = {
            "winning_price": event.winning_price,
            "require_pool_ge_clearing": config.require_pool_ge_clearing,
            "clearing_epsilon": config.clearing_epsilon,
            "min_pool_ratio": config.min_pool_ratio,
            "min_pool_absolute": config.min_pool_absolute,
        }
    return PredictionResult(
        event=event,
        candidates=scored,
        exclusion_notes=exclusions,
        debug=dbg if debug else {},
    )


def iter_sequential_predictions(
    events: List[LootSaleEvent],
    snap: BackupSnapshot,
    config: SecondBidderConfig,
    *,
    debug_first_n: int = 0,
    start_index: int = 0,
    initial_state: Optional[KnowledgeState] = None,
) -> Iterator[Tuple[int, PredictionResult, KnowledgeState]]:
    """Yield ``(event_index, prediction, knowledge_state)`` after each event.

    ``knowledge_state`` is the rolling state **after** applying that sale (safe to
    pickle for resume with ``next_index = event_index + 1``).
    """
    if start_index < 0:
        raise ValueError("start_index must be >= 0")
    if start_index > 0 and initial_state is None:
        raise ValueError("initial_state is required when start_index > 0")
    if start_index > len(events):
        raise ValueError("start_index out of range")
    bc = BalanceCalculator(snap)
    state = empty_state() if initial_state is None else initial_state
    for i, ev in enumerate(events):
        if i < start_index:
            continue
        use_dbg = debug_first_n > 0 and i < debug_first_n
        pred = predict_second_bidder_for_event(ev, state, bc, config, debug=use_dbg)
        update_knowledge_state(state, ev)
        yield i, pred, state


def run_sequential_predictions(
    events: List[LootSaleEvent],
    snap: BackupSnapshot,
    config: SecondBidderConfig,
    *,
    debug_first_n: int = 0,
    start_index: int = 0,
    initial_state: Optional[KnowledgeState] = None,
) -> List[PredictionResult]:
    """For ``start_index > 0``, pass ``initial_state`` from a checkpoint (post-event state)."""
    if start_index > 0 and initial_state is None:
        raise ValueError("initial_state is required when start_index > 0")
    st = empty_state() if initial_state is None else initial_state
    return [
        pred
        for _, pred, _ in iter_sequential_predictions(
            events,
            snap,
            config,
            debug_first_n=debug_first_n,
            start_index=start_index,
            initial_state=st,
        )
    ]


def run_from_backup(
    backup_dir: str,
    config: Optional[SecondBidderConfig] = None,
    *,
    debug_first_n: int = 0,
    item_eligibility_bundle: Optional[ItemStatsEligibilityBundle] = None,
    **prepare_kwargs: Any,
) -> List[PredictionResult]:
    from pathlib import Path

    from bid_portfolio_local.load_csv import load_backup

    snap = load_backup(Path(backup_dir))
    cfg = config or SecondBidderConfig()
    kw = dict(prepare_kwargs)
    if item_eligibility_bundle is not None:
        kw["item_eligibility_bundle"] = item_eligibility_bundle
    events = prepare_second_bidder_events(snap, **kw)
    return run_sequential_predictions(
        events,
        snap,
        cfg,
        debug_first_n=debug_first_n,
        start_index=0,
        initial_state=None,
    )
