from __future__ import annotations

from typing import List

from .types import PredictionResult


def format_event_report(pred: PredictionResult) -> str:
    e = pred.event
    lines: List[str] = []
    lines.append("=== Second-bidder inference (MVP) ===")
    lines.append(f"loot_id={e.loot_id} item={e.item_name!r} norm={e.norm_name!r}")
    lines.append(f"raid={e.raid_id} event_id={e.event_id!r} date={e.raid_date}")
    lines.append(f"price={e.winning_price} buyer={e.buyer_account_id} event_index={e.event_index}")
    lines.append(f"attendees={len(e.attendee_account_ids)} eligible_filter={'on' if e.eligible_account_ids is not None else 'off'}")
    lines.append("")
    lines.append("-- Candidates (ranked) --")
    if not pred.candidates:
        lines.append("(none)")
    for i, c in enumerate(pred.candidates, 1):
        lines.append(
            f"{i}. {c.account_id}  P={c.probability:.4f}  raw={c.raw_score:.4f}  "
            f"cap={c.capability_score:.3f} prop={c.propensity_score:.3f} comp={c.competitiveness_score:.3f}  "
            f"pool={c.pool_before:.1f}"
        )
        fb = c.features
        lines.append(f"     cap {fb.capability}  prop {fb.propensity}  comp {fb.competitiveness}")
    lines.append("")
    lines.append("-- Excluded attendees --")
    if not pred.exclusion_notes:
        lines.append("(none)")
    for aid, reason in sorted(pred.exclusion_notes.items()):
        lines.append(f"  {aid}: {reason}")
    if pred.debug:
        lines.append("")
        lines.append(f"-- debug -- {pred.debug}")
    return "\n".join(lines)
