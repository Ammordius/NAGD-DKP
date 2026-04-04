# Handoff: Second bidder inference (offline CSV / Python MVP)

## Why this exists

Guild auctions rarely log every bid. Officers still want a **structured guess** at who was plausibly the **second serious bidder** for historical sales. This MVP is a **transparent proxy scorer** (filters + weighted features → relative probabilities among attendees), run **entirely offline** from the same Supabase CSV export used for bid portfolio parity.

It is **not** claiming ground-truth second bids. Outputs are best used for diagnostics, tooling, or future UI—not as ledger truth.

**Spec (behavioral contract):** [`docs/SECOND_BIDDER_MVP_SPEC.md`](SECOND_BIDDER_MVP_SPEC.md). **Short index:** [`docs/SECOND_BIDDER_MVP_IMPLEMENTATION_NOTE.md`](SECOND_BIDDER_MVP_IMPLEMENTATION_NOTE.md).

**Related systems**

- **Officer UI** today uses SQL/RPC + cache for a different “runner-up style” signal; see [`docs/HANDOFF_OFFICER_LOOT_BID_FORECAST.md`](HANDOFF_OFFICER_LOOT_BID_FORECAST.md) and [`web/src/pages/ItemPage.jsx`](../web/src/pages/ItemPage.jsx). This Python path is **separate** until someone explicitly wires it to the DB or web.
- **Reconstructed balances and attendance** intentionally reuse [`scripts/bid_portfolio_local/`](../scripts/bid_portfolio_local/) so pool and attendee sets stay aligned with [`docs/HANDOFF_BID_PORTFOLIO_CSV_LOCAL.md`](HANDOFF_BID_PORTFOLIO_CSV_LOCAL.md) semantics.

## Code map

| Piece | Path |
|--------|------|
| Model package | [`scripts/second_bidder_model/`](../scripts/second_bidder_model/) (`prepare`, `candidates`, `features`, `scoring`, `state`, `pipeline`, `evaluate`, `serialize`, `config`, `types`) |
| Package README (commands, modules) | [`scripts/second_bidder_model/README.md`](../scripts/second_bidder_model/README.md) |
| One-event human report | [`scripts/run_second_bidder_sample.py`](../scripts/run_second_bidder_sample.py) |
| Full history → JSONL + resume | [`scripts/run_second_bidder_batch.py`](../scripts/run_second_bidder_batch.py) |
| Unit tests | [`scripts/second_bidder_model/tests/`](../scripts/second_bidder_model/tests/) |

## Required CSVs (`--backup-dir`)

Same as `bid_portfolio_local.load_backup`: folder containing `raids.csv`, `raid_loot.csv`, `raid_events.csv`, `raid_event_attendance.csv`, `raid_attendance.csv`, `character_account.csv`, `characters.csv`, `account_dkp_summary.csv`, `raid_attendance_dkp_by_account.csv`.

Pass the directory that **directly** holds those files (often `...\backup-YYYY-MM-DD\backup` after unzip).

## Commands (PowerShell, repo root)

```powershell
$env:PYTHONPATH = "scripts"

# Unit tests
python -m unittest discover -s scripts/second_bidder_model/tests -p "test*.py" -v

# Inspect one chronological sale (default: last sale, --index -1)
python scripts/run_second_bidder_sample.py "C:\TAKP\dkp\backup-2026-04-02\backup" --index -1 --debug

# All positive-price sales with buyer → JSONL (progress on stderr)
python scripts/run_second_bidder_batch.py "C:\TAKP\dkp\backup-2026-04-02\backup" `
  --out data/second_bidder.jsonl --progress-every 500 --checkpoint-every 200

# Resume after interrupt (append to same --out; uses checkpoint pickle)
python scripts/run_second_bidder_batch.py "C:\TAKP\dkp\backup-2026-04-02\backup" `
  --out data/second_bidder.jsonl --resume

# Full redo: delete checkpoint + overwrite JSONL
python scripts/run_second_bidder_batch.py "C:\TAKP\dkp\backup-2026-04-02\backup" `
  --out data/second_bidder.jsonl --fresh
```

**No new pip packages:** stdlib only (`pickle` for checkpoints, `json` for JSONL).

## Sequential scoring and checkpoints

Inference is **strictly ordered** by enriched guild sale order (same chronological key as portfolio tooling). A rolling **`KnowledgeState`** records prior wins/spend **only after** each sale is scored, so propensity features do not leak future purchases.

**Checkpoints** store `next_index` plus that state. You cannot safely “skip to loot_id X” without replaying from the start or restoring a matching checkpoint. `--resume` continues from the saved index and **appends** lines to `--out`. A completed batch run deletes the default checkpoint file next to the JSONL.

Default checkpoint path: `<out>.second_bidder_checkpoint.pkl` (override with `--checkpoint`).

## JSONL shape (batch export)

Each line is one object (from [`serialize.prediction_result_to_json_dict`](../scripts/second_bidder_model/serialize.py)):

- **`event`**: `loot_id`, `raid_id`, `event_id`, `raid_date`, `norm_name`, `item_name`, `winning_price`, `buyer_account_id`, `buyer_char_id`, `attendee_count`, `eligible_filter_on`, `event_index`, …
- **`candidates`**: up to `--top-candidates` rows with `account_id`, `probability`, `raw_score`, `pool_before`, group scores; optional `--include-feature-vectors` adds normalized per-feature dicts (much larger).
- **`candidate_count`**, **`exclusion_count`**

`account_id` is whatever appears in `character_account` / resolution (may be numeric or a guild-specific string).

## Eligibility map (`eligible_by_loot_id`)

Optional filter for “could use this item” from **external** data (Magelo, `bid_forecast_items`, etc.). Passed through `prepare_second_bidder_events` / `run_from_backup`.

**Important:** If you pass a dict but a given `loot_id` is **missing** from the dict, that sale has **no** eligibility filter (same as omitting the map). Only keys **present** in the dict apply a strict subset filter. An **empty set** for a key means nobody is eligible for that loot row.

## Labeled evaluation

When you have a map `loot_id → true_second_bidder_account_id`, use `evaluate_second_bidder_predictions` (mean rank, top-k hit, missing-from-pool, mean NDCG@k). Without labels, stick to distribution summaries and per-event reports.

## Parity and caveats

- **Reconstructed DKP** uses `BalanceCalculator` (opening summary + raid walk). It models wallet-at-auction for parity with SQL docs; it is not a literal historical wallet snapshot.
- **Probabilities** are relative weights over the **constructed candidate pool**, not calibrated real-world probabilities.
- **Backup vs live DB:** analyze the same export you trust; drift means stale rows.
- **Attendee resolution** follows `bid_portfolio_local` / SQL-style character→account joins; odd rows usually mean CSV edge cases, not the scorer.

## Follow-ups (optional)

- Pipe JSONL into Supabase (new table) or join to `raid_loot` in analytics.
- Feed `eligible_by_loot_id` from the Magelo / bid-forecast JSON pipeline.
- Tune `SecondBidderConfig` weights from labeled samples (rare).
- Compare side-by-side with officer UI / `runner_up_account_guess` for the same `loot_id` when validating UX.
