# Handoff: Local bid portfolio from CSV + Supabase upsert

## Why this exists

`dba_backfill_bid_portfolio_range` / `officer_backfill_bid_portfolio_batch` can time out in Supabase SQL Editor (heavy per-loot work, session/proxy limits). This path recomputes **`guild_loot_sale_enriched` semantics**, **`account_balance_before_loot`**, **`officer_bid_portfolio_for_loot`**, and **`bid_portfolio_auction_fact`** columns **offline** from a CSV backup, then **upserts** via PostgREST (fast batches).

Canonical behavior reference: [`docs/supabase-schema-full.sql`](supabase-schema-full.sql). Officer-facing overview: [`docs/HANDOFF_OFFICER_LOOT_BID_FORECAST.md`](HANDOFF_OFFICER_LOOT_BID_FORECAST.md) (Historical backfill **Option D**).

## Code map

| Piece | Path |
|--------|------|
| Core library | [`scripts/bid_portfolio_local/`](../scripts/bid_portfolio_local/) (`normalize`, `load_csv`, `guild_loot_enriched`, `attendees`, `balance_before_loot`, `portfolio`, `resolve`) |
| Compute JSONL | [`scripts/compute_bid_portfolio_from_csv.py`](../scripts/compute_bid_portfolio_from_csv.py) |
| Upload | [`scripts/upload_bid_portfolio_fact.py`](../scripts/upload_bid_portfolio_fact.py) |
| Runner-up only (Python second-bidder JSONL → `runner_up_account_guess`) | [`scripts/upload_second_bidder_runner_up.py`](../scripts/upload_second_bidder_runner_up.py); see [`HANDOFF_SECOND_BIDDER_MVP.md`](HANDOFF_SECOND_BIDDER_MVP.md) |

## Required CSVs (in `--backup-dir`)

`raid_loot.csv`, `raids.csv`, `raid_events.csv`, `raid_event_attendance.csv`, `raid_attendance.csv`, `character_account.csv`, `characters.csv`, `account_dkp_summary.csv`, `raid_attendance_dkp_by_account.csv`.

No `loot_assignment` in export is OK (matches empty table in SQL).

## Commands

```powershell
# 1) Compute (example backup path)
python scripts/compute_bid_portfolio_from_csv.py --backup-dir C:\TAKP\dkp\backup-2026-04-02\backup --out data/bid_portfolio_fact.jsonl

# Optional: full RPC-shaped JSON in payload column
python scripts/compute_bid_portfolio_from_csv.py --backup-dir ... --out data/bpf_with_payload.jsonl --include-payload

# Resume long runs
python scripts/compute_bid_portfolio_from_csv.py --backup-dir ... --out data/bpf.jsonl --checkpoint data/bpf.done.txt

# 2) Upload (uses web/.env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)
python scripts/upload_bid_portfolio_fact.py --in data/bid_portfolio_fact.jsonl
```

Env loading matches [`scripts/backfill_bid_portfolio_export.py`](../scripts/backfill_bid_portfolio_export.py) (`web/.env`, `web/.env.local`).

## Upload: FK on `loot_id`

`bid_portfolio_auction_fact.loot_id` references `raid_loot(id)`. If the CSV snapshot contains loot rows **not** present in the target Supabase project, upsert fails with `23503`.

**Default behavior:** the uploader fetches all remote `raid_loot.id` values and **skips** JSONL rows whose `loot_id` is missing. stderr reports skip count.

**Override:** `--no-skip-missing-loot` if every id is guaranteed to exist remotely.

## JSONL shape

- Without `--include-payload`: `{"fact": { ... }}` per line (fact columns only; `payload` omitted / uploaded as SQL NULL).
- With `--include-payload`: `{"fact": {...}, "payload": {...}}` (payload matches `officer_bid_portfolio_for_loot`).

## Parity / caveats

- Attendee resolution follows SQL (`char_id` / `character_name` → `characters` → `character_account`); CSV **`account_id` on `raid_event_attendance` is ignored** (same as SQL).
- Live DB drift vs backup: skipped upload rows or re-export CSVs from the same project you upsert into.
- Re-run upload is safe: upsert on `loot_id`.

## Follow-ups (optional)

- Spot-check a few `loot_id`s against `officer_bid_portfolio_for_loot` when DB matches backup.
- If upload batches fail on huge `payload`, lower `--batch-size` on the uploader.
