from __future__ import annotations

import json
import os
import sys
import tempfile
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
from second_bidder_model.character_plausibility import aggregate_character_scores_to_player
from second_bidder_model.config import SecondBidderConfig
from second_bidder_model.eligibility_io import load_eligibility_json
from second_bidder_model.features import compute_propensity_raw
from second_bidder_model.evaluate import evaluate_second_bidder_predictions
from second_bidder_model.pipeline import (
    iter_sequential_predictions,
    predict_second_bidder_for_event,
    run_sequential_predictions,
)
from second_bidder_model.prepare import prepare_second_bidder_events
from second_bidder_model.types import FeatureBundle, PredictionResult, ScoredCandidate
from second_bidder_model.scoring import normalize_candidate_scores
from second_bidder_model.item_stats_eligibility import (
    char_meets_item_stats,
    merge_eligible_char_pairs,
)
from second_bidder_model.lane_pick import top_eligible_attending_char_id
from second_bidder_model.state import KnowledgeState, empty_state, update_knowledge_state
from second_bidder_model.types import LootSaleEvent


class MockBC:
    def __init__(self, pools):
        self.pools = pools

    def balance_before(self, loot_id: int, account_id: str):
        return self.pools.get((loot_id, account_id))


class TestSequentialResume(unittest.TestCase):
    def test_resume_requires_initial_state(self):
        ev = LootSaleEvent(
            event_index=0,
            loot_id=1,
            raid_id="r",
            event_id=None,
            raid_date=None,
            norm_name="n",
            item_name="I",
            winning_price=1.0,
            buyer_account_id="a",
            buyer_char_id=None,
            attendee_account_ids={"a"},
            attendee_account_to_chars={},
        )
        with self.assertRaises(ValueError):
            list(
                iter_sequential_predictions(
                    [ev],
                    snap=None,  # type: ignore[arg-type]
                    config=SecondBidderConfig(),
                    start_index=1,
                    initial_state=None,
                )
            )
        with self.assertRaises(ValueError):
            run_sequential_predictions(
                [ev],
                snap=None,  # type: ignore[arg-type]
                config=SecondBidderConfig(),
                start_index=1,
                initial_state=None,
            )


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
        cands, excl = build_candidate_pool(ev, MockBC(pools), cfg, empty_state())
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
        self.assertEqual(raw0["prior_same_item_wins"], 0.0)
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

    def test_prior_same_item_wins_counts_only_matching_name_before_index(self):
        st = KnowledgeState()
        st.char_win_history[("A", "x")] = [
            (0, "boots", "Boots of Time", 10.0),
            (0, "boots", "Other Boots", 5.0),
        ]
        cfg = SecondBidderConfig()
        raw = compute_propensity_raw(
            "A",
            LootSaleEvent(
                event_index=1,
                loot_id=2,
                raid_id="r",
                event_id=None,
                raid_date=None,
                norm_name="boots",
                item_name="Boots of Time",
                winning_price=20.0,
                buyer_account_id="B",
                buyer_char_id="y",
                attendee_account_ids={"A", "B"},
                attendee_account_to_chars={},
            ),
            st,
            cfg,
        )
        self.assertEqual(raw["prior_same_item_wins"], 1.0)


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
                character_score=0.0,
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


class TestPrepareCharEligibility(unittest.TestCase):
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

    def test_eligible_chars_attached(self):
        el = self._sample_enriched(42)
        snap = BackupSnapshot(Path("."))
        snap.raid_loot = [{"id": "42", "char_id": "", "raid_id": "r1"}]
        pairs = {("acc1", "c1")}
        with patch(
            "second_bidder_model.prepare.build_guild_loot_sale_enriched",
            return_value=([el], {42: el}),
        ):
            with patch(
                "second_bidder_model.prepare.attendee_account_char_map_for_loot",
                return_value=({"buyer"}, {}),
            ):
                events = prepare_second_bidder_events(
                    snap, eligible_chars_by_loot_id={42: pairs}
                )
        self.assertEqual(events[0].eligible_char_pairs, pairs)


class TestEligibilityJsonLoader(unittest.TestCase):
    def test_loads_account_and_char_maps(self):
        fd, path = tempfile.mkstemp(suffix=".json", text=True)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "eligible_by_loot_id": {"10": ["a", "b"]},
                        "eligible_chars_by_loot_id": {
                            "20": [["a", "c1"], {"account_id": "b", "char_id": "c2"}]
                        },
                    },
                    f,
                )
            acc, chars = load_eligibility_json(Path(path))
            self.assertIsNotNone(acc)
            self.assertIsNotNone(chars)
            assert acc is not None and chars is not None
            self.assertEqual(acc[10], {"a", "b"})
            self.assertEqual(chars[20], {("a", "c1"), ("b", "c2")})
        finally:
            os.unlink(path)

    def test_optional_sections(self):
        fd, path = tempfile.mkstemp(suffix=".json", text=True)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump({"eligible_by_loot_id": {"5": ["x"]}}, f)
            acc, chars = load_eligibility_json(Path(path))
            self.assertIsNotNone(acc)
            self.assertIsNone(chars)
        finally:
            os.unlink(path)


class TestCharacterAwareScoring(unittest.TestCase):
    def _ev(
        self,
        *,
        attendees: set,
        acc_to_chars: dict,
        norm: str = "ancient_symbol",
        price: float = 500.0,
        loot_id: int = 99,
        ei: int = 5,
        eligible_char_pairs=None,
    ) -> LootSaleEvent:
        return LootSaleEvent(
            event_index=ei,
            loot_id=loot_id,
            raid_id="r",
            event_id=None,
            raid_date=None,
            norm_name=norm,
            item_name="Symbol of Ancient Summoning",
            winning_price=price,
            buyer_account_id="winner",
            buyer_char_id="wc",
            attendee_account_ids=attendees,
            attendee_account_to_chars=acc_to_chars,
            eligible_account_ids=None,
            eligible_char_pairs=eligible_char_pairs,
        )

    def test_high_dkp_dormant_attendee_ranks_below_active_lane(self):
        """Same pool; only item-eligible lane for A is a negligible-spend toon; B has a real lane.

        Character universe includes all prior-revealed spenders; char-level eligibility
        restricts who could use this item (e.g. Magelo).
        """
        st = KnowledgeState()
        st.account_total_spent["A"] = 1314.0 + 1095.0 + 728.0 + 7.0
        st.account_char_spent[("A", "inacht")] = 1314.0
        st.account_char_spent[("A", "perch")] = 1095.0
        st.account_char_spent[("A", "larch")] = 728.0
        st.account_char_spent[("A", "drudge")] = 7.0
        st.account_total_spent["B"] = 800.0
        st.account_char_spent[("B", "main")] = 800.0

        ev = self._ev(
            attendees={"A", "B", "winner"},
            acc_to_chars={"A": {"drudge"}, "B": {"main"}},
            eligible_char_pairs={("A", "drudge"), ("B", "main")},
        )
        pools = {(ev.loot_id, "A"): 2000.0, (ev.loot_id, "B"): 2000.0, (ev.loot_id, "winner"): 100.0}
        cfg = SecondBidderConfig(
            w_character=2.0,
            w_capability=0.3,
            w_propensity=0.2,
            w_competitiveness=0.2,
        )
        pred = predict_second_bidder_for_event(ev, st, MockBC(pools), cfg)
        by_aid = {c.account_id: c.probability for c in pred.candidates}
        self.assertGreater(by_aid["B"], by_aid["A"])

    def test_negligible_sibling_max_aggregation_uses_strong_lane_when_both_attend(self):
        """When two toons attend, max aggregation should reflect the stronger lane."""
        st = KnowledgeState()
        st.account_total_spent["A"] = 1300.0 + 7.0
        st.account_char_spent[("A", "big")] = 1300.0
        st.account_char_spent[("A", "tiny")] = 7.0
        ev = self._ev(
            attendees={"A", "winner"},
            acc_to_chars={"A": {"big", "tiny"}},
            ei=2,
        )
        pools = {(ev.loot_id, "A"): 1500.0, (ev.loot_id, "winner"): 10.0}
        cfg = SecondBidderConfig(character_aggregation="max")
        pred = predict_second_bidder_for_event(ev, st, MockBC(pools), cfg)
        sc = pred.candidates[0]
        rows = {r["char_id"]: r for r in sc.character_debug}
        self.assertGreater(rows["big"]["character_bid_plausibility"], rows["tiny"]["character_bid_plausibility"])
        self.assertGreater(sc.player_debug["raw_character_agg"], rows["tiny"]["character_bid_plausibility"])

    def test_active_player_beats_dormant_only_peer(self):
        st = KnowledgeState()
        st.account_total_spent["dormant_only"] = 5000.0
        st.account_char_spent[("dormant_only", "mule")] = 50.0
        st.account_total_spent["active"] = 600.0
        st.account_char_spent[("active", "main")] = 600.0
        ev = self._ev(
            attendees={"dormant_only", "active", "winner"},
            acc_to_chars={"dormant_only": {"mule"}, "active": {"main"}},
            ei=3,
        )
        pools = {
            (ev.loot_id, "dormant_only"): 3000.0,
            (ev.loot_id, "active"): 3000.0,
            (ev.loot_id, "winner"): 1.0,
        }
        cfg = SecondBidderConfig(w_character=2.5, w_capability=0.2)
        pred = predict_second_bidder_for_event(ev, st, MockBC(pools), cfg)
        p = {c.account_id: c.probability for c in pred.candidates}
        self.assertGreater(p["active"], p["dormant_only"])

    def test_aggregation_top_k_sum_exceeds_max(self):
        cfg = SecondBidderConfig(character_aggregation="max", aggregation_top_k=2)
        self.assertEqual(aggregate_character_scores_to_player([10.0, 5.0], cfg), 10.0)
        cfg2 = SecondBidderConfig(character_aggregation="top_k_sum", aggregation_top_k=2)
        self.assertEqual(aggregate_character_scores_to_player([10.0, 5.0], cfg2), 15.0)

    def test_char_history_future_index_ignored(self):
        st = KnowledgeState()
        st.char_win_history[("A", "c1")] = [(10, "helm", "Helm", 5.0)]
        v = st.recency_weighted_norm_wins_for_char("A", "c1", "helm", current_event_index=5, decay=0.1)
        self.assertAlmostEqual(v, 0.0, places=6)

    def test_default_config_prefers_active_burner_without_char_eligibility_gate(self):
        """Production-shaped: no eligible_char_pairs; similar pools; B wins on utilization + win-rate."""
        st = KnowledgeState()
        st.account_total_spent["H"] = 4000.0
        st.account_char_spent[("H", "h1")] = 4000.0
        st.account_win_count["H"] = 25
        st.account_loot_events_attended["H"] = 500
        st.account_total_spent["B"] = 8000.0
        st.account_char_spent[("B", "b1")] = 8000.0
        st.account_win_count["B"] = 90
        st.account_loot_events_attended["B"] = 160

        ev = self._ev(
            attendees={"H", "B", "winner"},
            acc_to_chars={"H": {"h1"}, "B": {"b1"}},
            ei=100,
            eligible_char_pairs=None,
        )
        pools = {
            (ev.loot_id, "H"): 4500.0,
            (ev.loot_id, "B"): 4500.0,
            (ev.loot_id, "winner"): 100.0,
        }
        pred = predict_second_bidder_for_event(ev, st, MockBC(pools), SecondBidderConfig())
        p = {c.account_id: c.probability for c in pred.candidates}
        self.assertGreater(p["B"], p["H"])

    def test_multi_toon_inacht_pattern_not_top_from_dkp_alone(self):
        """Concentrated spend on mains; only drudge attends — must not dominate vs real bidder."""
        st = KnowledgeState()
        for aid, mp in [
            ("inacht_acct", {"inacht": 1314.0, "perch": 1095.0, "larch": 728.0, "drudge": 7.0}),
        ]:
            tot = sum(mp.values())
            st.account_total_spent[aid] = tot
            for c, s in mp.items():
                st.account_char_spent[(aid, c)] = s
        st.account_total_spent["other"] = 900.0
        st.account_char_spent[("other", "ot")] = 900.0

        ev = self._ev(
            attendees={"inacht_acct", "other", "winner"},
            acc_to_chars={"inacht_acct": {"drudge"}, "other": {"ot"}},
            ei=10,
            eligible_char_pairs={("inacht_acct", "drudge"), ("other", "ot")},
        )
        pools = {
            (ev.loot_id, "inacht_acct"): 5000.0,
            (ev.loot_id, "other"): 5000.0,
            (ev.loot_id, "winner"): 100.0,
        }
        cfg = SecondBidderConfig(w_character=3.0, w_capability=0.15, w_propensity=0.15, w_competitiveness=0.15)
        pred = predict_second_bidder_for_event(ev, st, MockBC(pools), cfg)
        p = {c.account_id: c.probability for c in pred.candidates}
        self.assertGreater(p["other"], p["inacht_acct"])

    def test_prior_revealed_chars_used_when_attendance_has_no_char_ids(self):
        """Portfolio lanes from known purchases still score even if attendance lacks char_id."""
        st = KnowledgeState()
        st.account_total_spent["solo"] = 400.0
        st.account_char_spent[("solo", "main")] = 400.0
        ev = self._ev(
            attendees={"solo", "winner"},
            acc_to_chars={"solo": set()},
            ei=4,
        )
        pools = {(ev.loot_id, "solo"): 800.0, (ev.loot_id, "winner"): 1.0}
        pred = predict_second_bidder_for_event(ev, st, MockBC(pools), SecondBidderConfig())
        sc = pred.candidates[0]
        ids = {r["char_id"] for r in sc.character_debug}
        self.assertIn("main", ids)
        self.assertGreater(sc.player_debug["raw_character_agg"], 0.0)


class TestItemStatsEligibility(unittest.TestCase):
    def test_merge_eligible_char_pairs_intersection(self):
        d = {("A", "c1"), ("B", "c2")}
        j = {("A", "c1")}
        self.assertEqual(merge_eligible_char_pairs(d, j), {("A", "c1")})
        self.assertEqual(merge_eligible_char_pairs(None, j), j)
        self.assertEqual(merge_eligible_char_pairs(d, None), d)

    def test_char_meets_required_level(self):
        snap = BackupSnapshot(Path("."))
        snap.character_level["c1"] = 60
        snap.character_class_name["c1"] = "Warrior"
        stats = {"classes": "WAR PAL", "requiredLevel": 65}
        self.assertFalse(char_meets_item_stats(snap, "c1", stats))
        snap.character_level["c1"] = 65
        self.assertTrue(char_meets_item_stats(snap, "c1", stats))

    def test_char_wrong_class_fails(self):
        snap = BackupSnapshot(Path("."))
        snap.character_class_name["nec1"] = "Necromancer"
        snap.character_level["nec1"] = 70
        stats = {"classes": "WAR PAL RNG", "requiredLevel": 1}
        self.assertFalse(char_meets_item_stats(snap, "nec1", stats))

    def test_unmapped_class_strict_fails_when_item_has_class_list(self):
        snap = BackupSnapshot(Path("."))
        snap.character_class_name["x"] = "UnknownClass"
        snap.character_level["x"] = 70
        stats = {"classes": "WAR PAL", "requiredLevel": 1}
        self.assertFalse(char_meets_item_stats(snap, "x", stats))
        self.assertTrue(
            char_meets_item_stats(snap, "x", stats, permissive_missing_char_class_level=True)
        )

    def test_missing_level_strict_fails_when_required_level_set(self):
        snap = BackupSnapshot(Path("."))
        snap.character_class_name["x"] = "Warrior"
        stats = {"classes": "WAR PAL", "requiredLevel": 65}
        self.assertFalse(char_meets_item_stats(snap, "x", stats))
        self.assertTrue(
            char_meets_item_stats(snap, "x", stats, permissive_missing_char_class_level=True)
        )

    def test_all_classes_item_still_requires_level_when_strict(self):
        snap = BackupSnapshot(Path("."))
        snap.character_class_name["x"] = "Warrior"
        stats = {"classes": "ALL", "requiredLevel": 65}
        self.assertFalse(char_meets_item_stats(snap, "x", stats))


class TestLanePick(unittest.TestCase):
    def test_top_eligible_attending_char_id(self):
        rows = [
            {
                "char_id": "a",
                "eligible_for_item": True,
                "seen_on_attendance": True,
                "character_bid_plausibility": 0.5,
            },
            {
                "char_id": "b",
                "eligible_for_item": True,
                "seen_on_attendance": True,
                "character_bid_plausibility": 0.9,
            },
            {
                "char_id": "c",
                "eligible_for_item": False,
                "seen_on_attendance": True,
                "character_bid_plausibility": 1.0,
            },
        ]
        self.assertEqual(top_eligible_attending_char_id(rows), "b")


class TestPoolExclusionEligiblePairs(unittest.TestCase):
    def test_excludes_when_no_attendee_char_in_eligible_pairs(self):
        ev = LootSaleEvent(
            event_index=0,
            loot_id=10,
            raid_id="r1",
            event_id=None,
            raid_date=date(2024, 1, 1),
            norm_name="ear",
            item_name="Silver Hoop",
            winning_price=100.0,
            buyer_account_id="buyer",
            buyer_char_id="c_buyer",
            attendee_account_ids={"buyer", "mage_acct"},
            attendee_account_to_chars={"mage_acct": {"mage1"}},
            eligible_char_pairs={("war_acct", "war1")},
        )
        pools = {(10, "buyer"): 500.0, (10, "mage_acct"): 200.0}
        cands, excl = build_candidate_pool(ev, MockBC(pools), SecondBidderConfig(), empty_state())
        self.assertNotIn("mage_acct", cands)
        self.assertEqual(excl.get("mage_acct"), "no_item_eligible_character_lane")

    def test_includes_when_pair_matches_attendance_char(self):
        ev = LootSaleEvent(
            event_index=0,
            loot_id=10,
            raid_id="r1",
            event_id=None,
            raid_date=None,
            norm_name="ear",
            item_name="Silver Hoop",
            winning_price=100.0,
            buyer_account_id="buyer",
            buyer_char_id=None,
            attendee_account_ids={"buyer", "war_acct"},
            attendee_account_to_chars={"war_acct": {"war1"}},
            eligible_char_pairs={("war_acct", "war1")},
        )
        pools = {(10, "war_acct"): 200.0, (10, "buyer"): 1.0}
        cands, excl = build_candidate_pool(ev, MockBC(pools), SecondBidderConfig(), empty_state())
        self.assertIn("war_acct", cands)

    def test_strict_attending_lane_excludes_off_raid_eligible_alt(self):
        """Plausibility set can include an off-raid eligible alt; strict mode does not."""
        st = empty_state()
        st.account_char_spent[("boxer", "clr1")] = 100.0
        st.account_total_spent["boxer"] = 100.0
        ev = LootSaleEvent(
            event_index=0,
            loot_id=10,
            raid_id="r1",
            event_id=None,
            raid_date=None,
            norm_name="x",
            item_name="Priest item",
            winning_price=100.0,
            buyer_account_id="buyer",
            buyer_char_id=None,
            attendee_account_ids={"buyer", "boxer", "war_acct"},
            attendee_account_to_chars={"boxer": {"bard1"}, "war_acct": {"war1"}},
            eligible_char_pairs={("boxer", "clr1"), ("war_acct", "war1")},
        )
        pools = {(10, "buyer"): 500.0, (10, "boxer"): 200.0, (10, "war_acct"): 200.0}
        cands, _excl = build_candidate_pool(ev, MockBC(pools), SecondBidderConfig(), st)
        self.assertIn("boxer", cands)
        cands2, excl2 = build_candidate_pool(
            ev,
            MockBC(pools),
            SecondBidderConfig(require_item_eligible_attending_lane_for_pool=True),
            st,
        )
        self.assertNotIn("boxer", cands2)
        self.assertEqual(excl2.get("boxer"), "no_item_eligible_attending_lane")
        self.assertIn("war_acct", cands2)


if __name__ == "__main__":
    unittest.main()
