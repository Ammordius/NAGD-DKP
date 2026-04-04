from __future__ import annotations

from typing import List

from .types import PredictionResult


def format_event_report(pred: PredictionResult, *, verbose_characters: bool = True) -> str:
    e = pred.event
    lines: List[str] = []
    lines.append("=== Second-bidder inference (character-aware MVP) ===")
    lines.append(f"loot_id={e.loot_id} item={e.item_name!r} norm={e.norm_name!r}")
    lines.append(f"raid={e.raid_id} event_id={e.event_id!r} date={e.raid_date}")
    lines.append(f"price={e.winning_price} buyer={e.buyer_account_id} event_index={e.event_index}")
    lines.append(
        f"attendees={len(e.attendee_account_ids)} "
        f"eligible_filter={'on' if e.eligible_account_ids is not None else 'off'} "
        f"char_elig={'on' if e.eligible_char_pairs is not None else 'off'}"
    )
    lines.append("")
    lines.append("-- Candidates (ranked) --")
    if not pred.candidates:
        lines.append("(none)")
    for i, c in enumerate(pred.candidates, 1):
        lines.append(
            f"{i}. {c.account_id}  P={c.probability:.4f}  raw={c.raw_score:.4f}  "
            f"afford={c.capability_score:.3f} prop={c.propensity_score:.3f} "
            f"comp={c.competitiveness_score:.3f} char={c.character_score:.3f}  "
            f"pool={c.pool_before:.1f}"
        )
        fb = c.features
        lines.append(
            f"     cap {fb.capability}  prop {fb.propensity}  comp {fb.competitiveness}  ch {fb.character}"
        )
        pd = c.player_debug
        if pd:
            lines.append(
                f"     player_debug: raw_char_agg={pd.get('raw_character_agg')} "
                f"char_norm={pd.get('aggregated_character_score_normalized')} "
                f"final={pd.get('final_player_score')} notes={pd.get('exclusion_notes')}"
            )
        if verbose_characters and c.character_debug:
            lines.append("     eligible_characters:")
            for row in c.character_debug:
                lines.append(
                    f"       - {row.get('char_id')!r}  att={row.get('seen_on_attendance')}  "
                    f"prior={row.get('prior_revealed_lane')}  elig={row.get('eligible_for_item')}  "
                    f"dormant={row.get('is_dormant_lane')}  spend={row.get('lifetime_spend')}  "
                    f"share={row.get('share_of_player_spend'):.4f}  "
                    f"active_toon={row.get('active_toon_score'):.3f}  "
                    f"item_fit={row.get('item_fit_score'):.3f}  plaus={row.get('character_bid_plausibility'):.4f}"
                )
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
