from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Dict, List, Tuple

from .types import LootSaleEvent


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
    char_win_history: Dict[Tuple[str, str], List[Tuple[int, str, str, float]]] = field(
        default_factory=dict
    )
    # Prior loot-sale rows (same chronology as inference) where the account was an attendee
    account_loot_events_attended: Dict[str, int] = field(default_factory=dict)

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
        for idx, n, _item, _cost in self.char_win_history.get(key, []):
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
        for idx, _n, _item, _cost in self.char_win_history.get(key, []):
            if idx >= current_event_index:
                continue
            gap = max(0, current_event_index - idx)
            total += math.exp(-decay * gap)
        return total

    def char_win_count(self, account_id: str, char_id: str, before_event_index: int | None = None) -> int:
        hist = self.char_win_history.get((account_id, char_id), [])
        if before_event_index is None:
            return len(hist)
        return sum(1 for idx, *_rest in hist if idx < before_event_index)


def empty_state() -> KnowledgeState:
    return KnowledgeState()


def _bump_loot_sale_attendance(state: KnowledgeState, event: LootSaleEvent) -> None:
    for aid in event.attendee_account_ids:
        a = (aid or "").strip()
        if not a:
            continue
        state.account_loot_events_attended[a] = state.account_loot_events_attended.get(a, 0) + 1


def update_knowledge_state(state: KnowledgeState, event: LootSaleEvent) -> None:
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
    if cid:
        ck = (buyer, cid)
        state.account_char_spent[ck] = state.account_char_spent.get(ck, 0.0) + price
        state.char_win_history.setdefault(ck, []).append(
            (event.event_index, event.norm_name, item_name, price)
        )
    if event.paid_to_ref_ratio is not None:
        state.account_paid_to_ref_sum[buyer] = state.account_paid_to_ref_sum.get(buyer, 0.0) + float(
            event.paid_to_ref_ratio
        )
        state.account_paid_to_ref_n[buyer] = state.account_paid_to_ref_n.get(buyer, 0) + 1
    state.account_win_history.setdefault(buyer, []).append(
        (event.event_index, event.norm_name, price)
    )
    _bump_loot_sale_attendance(state, event)
    state.events_committed += 1
