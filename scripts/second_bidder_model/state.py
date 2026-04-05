from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from .equip_slot import slot_keys_overlap
from .types import LootSaleEvent
from .weapon_lane import melee_weapon_lane_skips_same_slot_penalty

# (event_index, norm_name, item_name, price, equip_slot_key_or_none, weapon_lane_or_none)
CharWinRow = Tuple[int, str, str, float, Optional[str], Optional[str]]


@dataclass
class KnowledgeState:
    events_committed: int = 0
    account_total_spent: Dict[str, float] = field(default_factory=dict)
    account_win_count: Dict[str, int] = field(default_factory=dict)
    account_norm_win_count: Dict[Tuple[str, str], int] = field(default_factory=dict)
    account_char_spent: Dict[Tuple[str, str], float] = field(default_factory=dict)
    account_paid_to_ref_sum: Dict[str, float] = field(default_factory=dict)
    account_paid_to_ref_n: Dict[str, int] = field(default_factory=dict)
    account_win_history: Dict[str, List[Tuple[int, str, float]]] = field(default_factory=dict)
    # (account_id, char_id) -> prior wins for character-aware item fit (no leakage if updated after score)
    char_win_history: Dict[Tuple[str, str], List[CharWinRow]] = field(default_factory=dict)
    # EWMA of paid_to_ref_ratio on wins (updated when ratio present); starts unset until first observation
    account_paid_to_ref_ewma: Dict[str, float] = field(default_factory=dict)
    # Prior loot-sale rows (same chronology as inference) where the account was an attendee
    account_loot_events_attended: Dict[str, int] = field(default_factory=dict)
    # char_id -> class abbrev (WAR, MNK, …) from backup characters.csv for weapon-lane same-slot rules
    char_class_abbrev: Dict[str, str] = field(default_factory=dict)

    def recency_weighted_norm_wins(
        self, account_id: str, norm_name: str, current_event_index: int, decay: float
    ) -> float:
        total = 0.0
        for idx, n, _cost in self.account_win_history.get(account_id, []):
            if idx >= current_event_index:
                continue
            if n != norm_name:
                continue
            gap = max(0, current_event_index - idx)
            total += math.exp(-decay * gap)
        return total

    def recency_weighted_any_wins(
        self, account_id: str, current_event_index: int, decay: float
    ) -> float:
        total = 0.0
        for idx, _n, _cost in self.account_win_history.get(account_id, []):
            if idx >= current_event_index:
                continue
            gap = max(0, current_event_index - idx)
            total += math.exp(-decay * gap)
        return total

    def recency_weighted_norm_wins_for_char(
        self,
        account_id: str,
        char_id: str,
        norm_name: str,
        current_event_index: int,
        decay: float,
    ) -> float:
        key = (account_id, char_id)
        total = 0.0
        for row in self.char_win_history.get(key, []):
            idx = row[0]
            n = row[1]
            if idx >= current_event_index:
                continue
            if n != norm_name:
                continue
            gap = max(0, current_event_index - idx)
            total += math.exp(-decay * gap)
        return total

    def recency_weighted_any_wins_for_char(
        self, account_id: str, char_id: str, current_event_index: int, decay: float
    ) -> float:
        key = (account_id, char_id)
        total = 0.0
        for row in self.char_win_history.get(key, []):
            idx = row[0]
            if idx >= current_event_index:
                continue
            gap = max(0, current_event_index - idx)
            total += math.exp(-decay * gap)
        return total

    def recency_weighted_same_slot_wins_for_char(
        self,
        account_id: str,
        char_id: str,
        target_slot_key: Optional[str],
        current_event_index: int,
        decay: float,
        *,
        target_weapon_lane: Optional[str] = None,
        filler_max_dkp: float = 3.0,
    ) -> float:
        if not target_slot_key:
            return 0.0
        key = (account_id, char_id)
        total = 0.0
        char_abbrev = self.char_class_abbrev.get(char_id)
        for row in self.char_win_history.get(key, []):
            idx = row[0]
            if idx >= current_event_index:
                continue
            price = float(row[3]) if len(row) >= 4 else 0.0
            if price <= float(filler_max_dkp):
                continue
            win_slot = row[4] if len(row) >= 5 else None
            win_lane = row[5] if len(row) >= 6 else None
            if not slot_keys_overlap(target_slot_key, win_slot):
                continue
            if melee_weapon_lane_skips_same_slot_penalty(
                char_abbrev, target_weapon_lane, win_lane
            ):
                continue
            gap = max(0, current_event_index - idx)
            total += math.exp(-decay * gap)
        return total

    def recency_weighted_same_slot_wins_for_attending_chars(
        self,
        account_id: str,
        attendee_char_ids: List[str],
        target_slot_key: Optional[str],
        current_event_index: int,
        decay: float,
        *,
        target_weapon_lane: Optional[str] = None,
        filler_max_dkp: float = 3.0,
    ) -> float:
        """Sum of decay-weighted prior same-slot wins on any listed character (e.g. raid attendance)."""
        if not target_slot_key or not attendee_char_ids:
            return 0.0
        s = 0.0
        for cid in attendee_char_ids:
            c = (cid or "").strip()
            if not c:
                continue
            s += self.recency_weighted_same_slot_wins_for_char(
                account_id,
                c,
                target_slot_key,
                current_event_index,
                decay,
                target_weapon_lane=target_weapon_lane,
                filler_max_dkp=filler_max_dkp,
            )
        return s

    def char_win_count(self, account_id: str, char_id: str, before_event_index: int | None = None) -> int:
        hist = self.char_win_history.get((account_id, char_id), [])
        if before_event_index is None:
            return len(hist)
        return sum(1 for row in hist if row[0] < before_event_index)


def empty_state() -> KnowledgeState:
    return KnowledgeState()


def _bump_loot_sale_attendance(state: KnowledgeState, event: LootSaleEvent) -> None:
    for aid in event.attendee_account_ids:
        a = (aid or "").strip()
        if not a:
            continue
        state.account_loot_events_attended[a] = state.account_loot_events_attended.get(a, 0) + 1


def update_knowledge_state(
    state: KnowledgeState,
    event: LootSaleEvent,
    *,
    paid_to_ref_ewma_alpha: float = 0.12,
) -> None:
    buyer = (event.buyer_account_id or "").strip()
    price = float(event.winning_price or 0)
    if not buyer or price <= 0:
        _bump_loot_sale_attendance(state, event)
        state.events_committed += 1
        return
    state.account_total_spent[buyer] = state.account_total_spent.get(buyer, 0.0) + price
    state.account_win_count[buyer] = state.account_win_count.get(buyer, 0) + 1
    key = (buyer, event.norm_name)
    state.account_norm_win_count[key] = state.account_norm_win_count.get(key, 0) + 1
    cid = (event.buyer_char_id or "").strip()
    item_name = (event.item_name or "").strip()
    slot_key = (event.equip_slot or "").strip() or None
    lane_key = (event.weapon_lane or "").strip() or None
    if cid:
        ck = (buyer, cid)
        state.account_char_spent[ck] = state.account_char_spent.get(ck, 0.0) + price
        state.char_win_history.setdefault(ck, []).append(
            (event.event_index, event.norm_name, item_name, price, slot_key, lane_key)
        )
    if event.paid_to_ref_ratio is not None:
        r = float(event.paid_to_ref_ratio)
        state.account_paid_to_ref_sum[buyer] = state.account_paid_to_ref_sum.get(buyer, 0.0) + r
        state.account_paid_to_ref_n[buyer] = state.account_paid_to_ref_n.get(buyer, 0) + 1
        a = max(1e-9, min(1.0, float(paid_to_ref_ewma_alpha)))
        prev = state.account_paid_to_ref_ewma.get(buyer)
        if prev is None:
            state.account_paid_to_ref_ewma[buyer] = r
        else:
            state.account_paid_to_ref_ewma[buyer] = a * r + (1.0 - a) * float(prev)
    state.account_win_history.setdefault(buyer, []).append(
        (event.event_index, event.norm_name, price)
    )
    _bump_loot_sale_attendance(state, event)
    state.events_committed += 1
