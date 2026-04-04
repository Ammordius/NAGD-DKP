"""Single runner-up resolver: same candidate pool as second-bidder model, optional rank modes."""
from __future__ import annotations

from typing import Literal, Optional, Tuple

from bid_portfolio_local.balance_before_loot import BalanceCalculator

from .candidates import build_candidate_pool
from .character_plausibility import get_attending_characters
from .config import SecondBidderConfig
from .pipeline import predict_second_bidder_for_event
from .state import KnowledgeState
from .types import LootSaleEvent

RankMode = Literal["max_pool", "scored"]


def _attending_eligible_char_id(event: LootSaleEvent, account_id: str) -> Optional[str]:
    """Pick a stable display char: item-eligible and on raid attendance when pairs exist."""
    aid = (account_id or "").strip()
    if not aid:
        return None
    chars = get_attending_characters(aid, event)
    pairs = event.eligible_char_pairs
    if pairs is None:
        clean = sorted({str(c).strip() for c in chars if str(c).strip()})
        return clean[0] if clean else None
    eligible = sorted(
        (str(c).strip() for c in chars if str(c).strip() and (aid, str(c).strip()) in pairs),
        key=str,
    )
    return eligible[0] if eligible else None


def resolve_runner_up_for_event(
    event: LootSaleEvent,
    state: KnowledgeState,
    bc: BalanceCalculator,
    config: SecondBidderConfig,
    *,
    rank_mode: RankMode = "max_pool",
) -> Tuple[Optional[str], Optional[str]]:
    """Return (runner_up_account_id, runner_up_char_id) using unified eligibility + pool rules.

    rank_mode:
      max_pool — among build_candidate_pool members, highest reconstructed pool (tie-break account_id).
      scored — same as predict_second_bidder_for_event top candidate (uses feature weights).
    """
    if rank_mode == "scored":
        pred = predict_second_bidder_for_event(event, state, bc, config, debug=False)
        if not pred.candidates:
            return None, None
        top = pred.candidates[0]
        cid = top.top_eligible_char_id
        if cid is None and top.account_id:
            cid = _attending_eligible_char_id(event, top.account_id)
        return top.account_id, cid

    candidates, _ex = build_candidate_pool(event, bc, config, state)
    if not candidates:
        return None, None
    buyer = (event.buyer_account_id or "").strip()
    best_aid: Optional[str] = None
    best_pool: Optional[float] = None
    for aid in sorted(candidates):
        if not aid or aid == buyer:
            continue
        pool = bc.balance_before(event.loot_id, aid)
        if pool is None:
            continue
        pf = float(pool)
        if best_aid is None:
            best_aid = aid
            best_pool = pf
        elif pf > (best_pool or 0) or (pf == best_pool and aid < best_aid):
            best_aid = aid
            best_pool = pf
    if not best_aid:
        return None, None
    char_id = _attending_eligible_char_id(event, best_aid)
    return best_aid, char_id


def resolve_runner_up_scored_with_debug(
    event: LootSaleEvent,
    state: KnowledgeState,
    bc: BalanceCalculator,
    config: SecondBidderConfig,
    *,
    debug: bool = False,
) -> Tuple[Optional[str], Optional[str], object]:
    """Scored mode with PredictionResult for batch serialization."""
    pred = predict_second_bidder_for_event(event, state, bc, config, debug=debug)
    if not pred.candidates:
        return None, None, pred
    top = pred.candidates[0]
    cid = top.top_eligible_char_id
    if cid is None and top.account_id:
        cid = _attending_eligible_char_id(event, top.account_id)
    return top.account_id, cid, pred
