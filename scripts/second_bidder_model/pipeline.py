from __future__ import annotations

from typing import Any, Dict, List, Optional

from bid_portfolio_local.balance_before_loot import BalanceCalculator
from bid_portfolio_local.load_csv import BackupSnapshot

from .candidates import build_candidate_pool
from .config import SecondBidderConfig
from .features import build_feature_bundles
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
    candidates, exclusions = build_candidate_pool(event, bc, config)
    dbg: Dict[str, Any] = {}
    if not candidates:
        return PredictionResult(
            event=event,
            candidates=[],
            exclusion_notes=exclusions,
            debug=dbg if debug else {},
        )

    bundles = build_feature_bundles(candidates, event, state, bc, config)
    raw_by_aid: Dict[str, float] = {}
    scored: List[ScoredCandidate] = []
    for b in bundles:
        raw, cap, prop, comp = score_candidate(b, config)
        raw_by_aid[b.account_id] = raw
        pool = float(bc.balance_before(event.loot_id, b.account_id) or 0.0)
        scored.append(
            ScoredCandidate(
                account_id=b.account_id,
                pool_before=pool,
                raw_score=raw,
                probability=0.0,
                capability_score=cap,
                propensity_score=prop,
                competitiveness_score=comp,
                features=b,
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


def run_sequential_predictions(
    events: List[LootSaleEvent],
    snap: BackupSnapshot,
    config: SecondBidderConfig,
    *,
    debug_first_n: int = 0,
) -> List[PredictionResult]:
    bc = BalanceCalculator(snap)
    state = empty_state()
    out: List[PredictionResult] = []
    for i, ev in enumerate(events):
        use_dbg = debug_first_n > 0 and i < debug_first_n
        pred = predict_second_bidder_for_event(ev, state, bc, config, debug=use_dbg)
        out.append(pred)
        update_knowledge_state(state, ev)
    return out


def run_from_backup(
    backup_dir: str,
    config: Optional[SecondBidderConfig] = None,
    *,
    debug_first_n: int = 0,
    **prepare_kwargs: Any,
) -> List[PredictionResult]:
    from pathlib import Path

    from bid_portfolio_local.load_csv import load_backup

    snap = load_backup(Path(backup_dir))
    cfg = config or SecondBidderConfig()
    events = prepare_second_bidder_events(snap, **prepare_kwargs)
    return run_sequential_predictions(events, snap, cfg, debug_first_n=debug_first_n)
