"""Shared datatypes for second-bidder inference."""
from __future__ import annotations
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Dict, List, Optional, Set, Tuple

@dataclass
class LootSaleEvent:
    event_index: int
    loot_id: int
    raid_id: str
    event_id: Optional[str]
    raid_date: Optional[date]
    norm_name: str
    item_name: str
    winning_price: float
    buyer_account_id: Optional[str]
    buyer_char_id: Optional[str]
    attendee_account_ids: Set[str]
    attendee_account_to_chars: Dict[str, Set[str]] = field(default_factory=dict)
    eligible_account_ids: Optional[Set[str]] = None
    # Optional (account_id, char_id) pairs that may bid on this item; if set, used per character
    eligible_char_pairs: Optional[Set[Tuple[str, str]]] = None
    ref_price_at_sale: Optional[float] = None
    paid_to_ref_ratio: Optional[float] = None
    # Normalized from item_stats.slot (see equip_slot.normalize_equip_slot_key); None if unknown
    equip_slot: Optional[str] = None

@dataclass
class FeatureBundle:
    account_id: str
    capability: Dict[str, float]
    propensity: Dict[str, float]
    competitiveness: Dict[str, float]
    character: Dict[str, float] = field(default_factory=dict)

@dataclass
class ScoredCandidate:
    account_id: str
    pool_before: float
    raw_score: float
    probability: float
    capability_score: float
    propensity_score: float
    competitiveness_score: float
    features: FeatureBundle
    character_score: float = 0.0
    character_debug: List[Dict[str, Any]] = field(default_factory=list)
    player_debug: Dict[str, Any] = field(default_factory=dict)
    # Best-scoring item-eligible character that was on raid attendance (for officer UI)
    top_eligible_char_id: Optional[str] = None

@dataclass
class PredictionResult:
    event: LootSaleEvent
    candidates: List[ScoredCandidate]
    exclusion_notes: Dict[str, str]
    debug: Dict[str, Any] = field(default_factory=dict)
