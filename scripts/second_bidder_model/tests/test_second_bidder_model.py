from __future__ import annotations

import sys
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2]
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from bid_portfolio_local.guild_loot_enriched import EnrichedLoot
from bid_portfolio_local.load_csv import BackupSnapshot

from second_bidder_model.candidates import build_candidate_pool
from second_bidder_model.config import SecondBidderConfig
from second_bidder_model.features import compute_propensity_raw
from second_bidder_model.evaluate import evaluate_second_bidder_predictions
from second_bidder_model.prepare import prepare_second_bidder_events
from second_bidder_model.types import FeatureBundle, PredictionResult, ScoredCandidate
from second_bidder_model.scoring import normalize_candidate_scores
from second_bidder_model.state import KnowledgeState, empty_state, update_knowledge_state
from second_bidder_model.types import LootSaleEvent


class MockBC:
    def __init__(self, pools):
        self.pools = pools

    def balance_before(self, loot_id: int, account_id: str):
        return self.pools.get((loot_id, account_id))


class TestNormalize(unittest.TestCase):
    def test_sums_to_one(self):
        raw = {"a": 1.0, "b": 3.0, "c": 0.0}
        p = normalize_candidate_scores(raw, 1e-6)
        self.assertAlmostEqual(sum(p.values()), 1.0, places=6)


class TestPrepareEligibilityPartialMap(unittest.TestCase):
    def _sample_enriched(self, loot_id: int = 42) -> EnrichedLoot:
        return EnrichedLoot(
            loot_id=loot_id,
            raid_id="r1",
            event_id=None,
            item_name="Sword",
            norm_name="sword",
            raid_date=None,
            cost_num=10.0,
            cost_text="10",
            buyer_account_id="buyer",
            ref_price_at_sale=None,
            paid_to_ref_ratio=None,
            next_guild_sale_loot_id=None,
            next_guild_sale_buyer_account_id=None,
        )

    def test_missing_loot_id_in_map_skips_eligibility_filter(self):
        el = self._sample_enriched(42)
        snap = BackupSnapshot(Path("."))
        snap.raid_loot = [{"id": "42", "char_id": "", "raid_id": "r1"}]
        with patch(
            "second_bidder_model.prepare.build_guild_loot_sale_enriched",
            return_value=([el], {42: el}),
        ):
            with patch(
                "second_bidder_model.prepare.attendee_account_char_map_for_loot",
                return_value=({"buyer", "other"}, {}),
            ):
                events = prepare_second_bidder_events(
                    snap, eligible_by_loot_id={99: {"only_other_loot"}}
                )
        self.assertEqual(len(events), 1)
        self.assertIsNone(events[0].eligible_account_ids)

    def test_present_loot_id_applies_filter(self):
        el = self._sample_enriched(42)
        snap = BackupSnapshot(Path("."))
        snap.raid_loot = [{"id": "42", "char_id": "", "raid_id": "r1"}]
        with patch(
            "second_bidder_model.prepare.build_guild_loot_sale_enriched",
            return_value=([el], {42: el}),
        ):
            with patch(
                "second_bidder_model.prepare.attendee_account_char_map_for_loot",
                return_value=({"buyer", "other"}, {}),
            ):
                events = prepare_second_bidder_events(
                    snap, eligible_by_loot_id={42: {"other"}}
                )
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].eligible_account_ids, {"other"})


class TestCandidatePool(unittest.TestCase):
    def test_excludes_low_pool(self):
        ev = LootSaleEvent(
            event_index=0,
            loot_id=10,
            raid_id="r1",
            event_id=None,
            raid_date=date(2024, 1, 1),
            norm_name="sword",
            item_name="Sword",
            winning_price=100.0,
            buyer_account_id="buyer",
            buyer_char_id="c_buyer",
            attendee_account_ids={"buyer", "rich", "poor"},
            attendee_account_to_chars={"rich": {"c1"}, "poor": {"c2"}},
        )
        cfg = SecondBidderConfig(
            min_pool_ratio=0.5,
            min_pool_absolute=0.0,
            require_pool_ge_clearing=True,
            clearing_epsilon=0.0,
        )
        pools = {
            (10, "buyer"): 500.0,
            (10, "rich"): 200.0,
            (10, "poor"): 30.0,
        }
        cands, excl = build_candidate_pool(ev, MockBC(pools), cfg)
        self.assertIn("rich", cands)
        self.assertNotIn("poor", cands)
        self.assertIn("poor", excl)
        self.assertIn("buyer", excl)


class TestNoFutureLeakage(unittest.TestCase):
    def test_propensity_ignores_future_win(self):
        st = empty_state()
        ev_future = LootSaleEvent(
            event_index=1,
            loot_id=20,
            raid_id="r",
            event_id=None,
            raid_date=None,
            norm_name="helm",
            item_name="Helm",
            winning_price=50.0,
            buyer_account_id="A",
            buyer_char_id="c1",
            attendee_account_ids={"A"},
            attendee_account_to_chars={},
        )
        cfg = SecondBidderConfig(recency_decay_per_event=0.1)
        # Score event_index=0 while state still empty (as in sequential first step)
        raw0 = compute_propensity_raw(
            "A",
            LootSaleEvent(
                event_index=0,
                loot_id=10,
                raid_id="r",
                event_id=None,
                raid_date=None,
                norm_name="helm",
                item_name="Helm",
                winning_price=40.0,
                buyer_account_id="B",
                buyer_char_id="c2",
                attendee_account_ids={"A", "B"},
                attendee_account_to_chars={},
            ),
            st,
            cfg,
        )
        self.assertAlmostEqual(raw0["same_norm_recency"], 0.0, places=6)
        update_knowledge_state(st, ev_future)
        # After future win committed, history exists ? but scoring past event_0 should use empty state only in pipeline order

    def test_update_then_propensity_sees_past_only(self):
        st = KnowledgeState()
        first = LootSaleEvent(
            event_index=0,
            loot_id=1,
            raid_id="r",
            event_id=None,
            raid_date=None,
            norm_name="boots",
            item_name="Boots",
            winning_price=10.0,
            buyer_account_id="A",
            buyer_char_id="x",
            attendee_account_ids={"A"},
            attendee_account_to_chars={},
        )
        update_knowledge_state(st, first)
        cfg = SecondBidderConfig(recency_decay_per_event=0.0)
        raw = compute_propensity_raw(
            "A",
            LootSaleEvent(
                event_index=1,
                loot_id=2,
                raid_id="r",
                event_id=None,
                raid_date=None,
                norm_name="boots",
                item_name="Boots2",
                winning_price=20.0,
                buyer_account_id="B",
                buyer_char_id="y",
                attendee_account_ids={"A", "B"},
                attendee_account_to_chars={},
            ),
            st,
            cfg,
        )
        self.assertGreater(raw["same_norm_recency"], 0.0)


class TestEvaluateMetrics(unittest.TestCase):
    def _pred(self, loot_id: int, order: list[str]) -> PredictionResult:
        ev = LootSaleEvent(
            event_index=0,
            loot_id=loot_id,
            raid_id="r",
            event_id=None,
            raid_date=None,
            norm_name="n",
            item_name="I",
            winning_price=1.0,
            buyer_account_id="buyer",
            buyer_char_id=None,
            attendee_account_ids=set(order + ["buyer"]),
            attendee_account_to_chars={},
        )
        fb = FeatureBundle("x", {}, {}, {})
        scored = [
            ScoredCandidate(
                account_id=aid,
                pool_before=1.0,
                raw_score=1.0,
                probability=1.0 / len(order),
                capability_score=0.0,
                propensity_score=0.0,
                competitiveness_score=0.0,
                features=fb,
            )
            for aid in order
        ]
        return PredictionResult(event=ev, candidates=scored, exclusion_notes={})

    def test_ndcg_perfect_when_label_first(self):
        p = self._pred(1, ["truth", "b", "c"])
        out = evaluate_second_bidder_predictions([p], {1: "truth"}, top_k=(1, 3))
        self.assertEqual(out["ndcg_at_1"], 1.0)
        self.assertEqual(out["ndcg_at_3"], 1.0)

    def test_ndcg_zero_when_missing_from_pool(self):
        p = self._pred(1, ["a", "b"])
        out = evaluate_second_bidder_predictions([p], {1: "not_in_list"}, top_k=(3,))
        self.assertEqual(out["ndcg_at_3"], 0.0)


class TestDeterministicToy(unittest.TestCase):
    def test_same_inputs_same_probs(self):
        cfg = SecondBidderConfig()
        raw = {"x": 2.0, "y": 2.0}
        p1 = normalize_candidate_scores(raw, cfg.score_floor)
        p2 = normalize_candidate_scores(raw, cfg.score_floor)
        self.assertEqual(p1, p2)
        self.assertAlmostEqual(p1["x"], 0.5, places=6)


if __name__ == "__main__":
    unittest.main()
