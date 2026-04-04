from __future__ import annotations

import math
from typing import Dict, List, Optional, Tuple

from .types import PredictionResult


def _dcg_binary_at_k(rank: int, k: int) -> float:
    """Single relevant item at 1-based rank; DCG@k with gain 1 at that position."""
    if rank < 1 or rank > k or rank >= 999999:
        return 0.0
    return 1.0 / math.log2(rank + 1.0)


def _idcg_binary_at_k(k: int) -> float:
    """Ideal DCG@k when the relevant item is at rank 1."""
    return _dcg_binary_at_k(1, k)


def evaluate_second_bidder_predictions(
    predictions: List[PredictionResult],
    labels: Optional[Dict[int, str]],
    *,
    top_k: Tuple[int, ...] = (1, 3, 5),
) -> Dict[str, object]:
    if not labels:
        return {
            "labeled_events": 0,
            "note": "No labels: skipped rank metrics. Use diagnostic reports instead.",
        }
    ranks: List[int] = []
    hits = {k: 0 for k in top_k}
    ndcg_sums = {k: 0.0 for k in top_k}
    n = 0
    for p in predictions:
        lid = p.event.loot_id
        if lid not in labels:
            continue
        true_aid = labels[lid]
        n += 1
        order = [c.account_id for c in p.candidates]
        try:
            r = order.index(true_aid) + 1
        except ValueError:
            r = 999999
        ranks.append(r)
        for k in top_k:
            if r <= k:
                hits[k] += 1
            ideal = _idcg_binary_at_k(k)
            dcg = _dcg_binary_at_k(r, k) if r < 999999 else 0.0
            ndcg_sums[k] += (dcg / ideal) if ideal > 0 else 0.0
    def _mean(xs: List[int]) -> Optional[float]:
        return float(sum(xs) / len(xs)) if xs else None

    out: Dict[str, object] = {
        "labeled_events": n,
        "mean_rank": _mean([x for x in ranks if x < 999999]) if ranks else None,
        "missing_from_pool": sum(1 for x in ranks if x >= 999999),
    }
    for k in top_k:
        out[f"top_{k}_hit_rate"] = (hits[k] / n) if n else None
        out[f"ndcg_at_{k}"] = (ndcg_sums[k] / n) if n else None
    return out
