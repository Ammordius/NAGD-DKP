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
2. **Eligibility** (“could use” the item) is **not** inferred from gear in this MVP. Pass `eligible_by_loot_id` into `prepare_second_bidder_events` / `run_from_backup` when you have external JSON (Magelo / `bid_forecast_items`). If omitted, every attendee passes the eligibility filter.
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
