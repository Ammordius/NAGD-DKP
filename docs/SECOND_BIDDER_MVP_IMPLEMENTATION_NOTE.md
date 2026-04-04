# Second bidder MVP — implementation note

## Where things live today

| Area | Location |
|------|-----------|
| Canonical schema (loot, attendance, accounts, portfolio RPCs) | [`docs/supabase-schema-full.sql`](supabase-schema-full.sql) |
| Officer UI: inferred second place (cached + RPC) | [`web/src/pages/ItemPage.jsx`](../web/src/pages/ItemPage.jsx) |
| Client bid simulation / heuristics | [`web/src/lib/bidForecastModel.js`](../web/src/lib/bidForecastModel.js) |
| CSV backup → enriched guild sales + `balance_before` (parity with SQL) | [`scripts/bid_portfolio_local/`](../scripts/bid_portfolio_local/) |
| Portfolio export / backfill | [`scripts/backfill_bid_portfolio_export.py`](../scripts/backfill_bid_portfolio_export.py), [`scripts/compute_bid_portfolio_from_csv.py`](../scripts/compute_bid_portfolio_from_csv.py) |

## New code (this MVP)

| Piece | Path |
|-------|------|
| Package | [`scripts/second_bidder_model/`](../scripts/second_bidder_model/) |
| Package README | [`scripts/second_bidder_model/README.md`](../scripts/second_bidder_model/README.md) |
| Spec | [`SECOND_BIDDER_MVP_SPEC.md`](SECOND_BIDDER_MVP_SPEC.md) |
| Handoff (commands, JSONL, resume) | [`HANDOFF_SECOND_BIDDER_MVP.md`](HANDOFF_SECOND_BIDDER_MVP.md) |
| Sample CLI | [`scripts/run_second_bidder_sample.py`](../scripts/run_second_bidder_sample.py) |
| Batch JSONL + resume | [`scripts/run_second_bidder_batch.py`](../scripts/run_second_bidder_batch.py) |

## Dependencies

- **Python 3.10+** (type hints, dataclasses).
- Reuses [`scripts/bid_portfolio_local`](../scripts/bid_portfolio_local): `BackupSnapshot`, `build_guild_loot_sale_enriched`, `BalanceCalculator`, attendee resolution.
- **No** new pip dependencies (stdlib + `unittest`).

## Tests

```bash
PYTHONPATH=scripts python -m unittest discover -s scripts/second_bidder_model/tests -p "test*.py" -v
```

## Assumptions and ambiguities

1. **Reconstructed pool** uses the same `BalanceCalculator` as the guild SQL docs (opening account balance + raid walk). It is a model, not a logged wallet at auction time.
2. **Eligibility** (“could use” the item) uses **`characters.csv` class/level** plus **`data/item_stats.json`** and **`data/dkp_mob_loot.json`** (optional `raid_item_sources.json`) to build `eligible_char_pairs` per sale (`item_stats_eligibility.py`). Unresolved item names skip the derived gate (permissive). Pass `item_eligibility_bundle=` into `prepare_second_bidder_events` / `run_from_backup`, or rely on batch/sample defaults (loads from repo `data/` when present). Optional `--eligibility-json` supplies Magelo maps; **character pairs are intersected** with derived pairs when both apply. `--no-item-stats` disables derived gating. Account-level `eligible_by_loot_id` from JSON is unchanged.
3. **No future leakage**: `KnowledgeState` is updated only **after** each event is scored; propensity features use **prior** wins only.
4. **Not used in this MVP**: future purchases as a feature for past events (that would be leakage). A separate **diagnostic** correlation could be computed offline; it is intentionally out of the scorer.
5. **Labels** for true second bidder are usually absent; use `evaluate_second_bidder_predictions` when you have a `loot_id → account_id` map.

## Integration path (minimal)

1. Export CSV backup → `load_backup(dir)`.
2. `prepare_second_bidder_events(snap, ...)` → chronological sale events.
3. Optionally attach `eligible_by_loot_id` from your JSON pipeline.
4. `run_sequential_predictions(...)` or `run_from_backup(...)`.
5. `format_event_report(pred)` for inspection.

For **all** sales to disk with progress and **checkpointed resume**, run `run_second_bidder_batch.py` (see package README).

## Character-aware revision (gap + direction)

**Problem:** The original MVP scored **accounts** with strong **player-level** signals (`dkp_ratio`, `account_total_spent`, `hoarding = pool/(1+account_tot)`). High wallet + high lifetime spend on *any* alt could rank an account highly even when no **item-eligible character lane** was a plausible **active gearing** target (e.g. spend concentrated on mains while only a negligible alt could use the drop).

**Current scoring path:** `build_candidate_pool` (includes optional `no_item_eligible_character_lane` when `eligible_char_pairs` is set) → `build_feature_bundles` (`compute_capability_raw` with wealth utilization + soft pool caps, `compute_propensity_raw` with win-rate, **prior_same_item_wins** on same `item_name`, `compute_competitiveness_raw` with `hoarding_char_lane` and `hoarding_account_total`) → per-event min–max normalization across candidates → `score_candidate` → `normalize_candidate_scores`.

**Character lanes (who to score):** Union of raid attendance `char_id`s (when present) and every character with **prior** revealed spend / win history on that account in `KnowledgeState` (known purchases before the event—no future leakage). **Item eligibility** still gates which of those lanes count for the item (`eligible_char_pairs` when provided).

**Implemented direction:** See [`SECOND_BIDDER_CHARACTER_AWARE_SPEC.md`](SECOND_BIDDER_CHARACTER_AWARE_SPEC.md). Code: `character_plausibility.py`, extended `KnowledgeState.char_win_history`, `SecondBidderConfig` knobs, `FeatureBundle.character`, `ScoredCandidate.character_debug` / `player_debug`, optional `eligible_chars_by_loot_id` in `prepare_second_bidder_events`.

**Affected files:** `scripts/second_bidder_model/state.py`, `features.py`, `scoring.py`, `pipeline.py`, `config.py`, `types.py`, `character_plausibility.py`, `eligibility_io.py`, `item_stats_eligibility.py`, `prepare.py`, `serialize.py`, `debug.py`, `run_second_bidder_batch.py`, `run_second_bidder_sample.py`, `scripts/bid_portfolio_local/load_csv.py`, tests, spec + this note.
