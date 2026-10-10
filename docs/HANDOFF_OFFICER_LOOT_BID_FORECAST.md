# Handoff: Officer bidding portfolio

Historical **heuristics only** — there is still **no auction log**. Objects live in [`docs/supabase-schema-full.sql`](supabase-schema-full.sql). Item and account pages read `officer_bid_portfolio_for_loot` and `officer_account_bidding_portfolio`.

Bid hints and global bid interest (the old officer forecast pages and `officer_*_bid_forecast` RPCs) have been removed. Drop them on a live project with [`docs/drop-officer-bid-forecast.sql`](drop-officer-bid-forecast.sql).

## Handoff for next session (bid portfolio backfill — Apr 2026)

**Goal:** Fill **`bid_portfolio_auction_fact`** without PostgREST **`57014` statement timeout** on heavy ranges or **`include_payload=true`**.

**What landed (apply via canonical schema):**

| Change | Where |
|--------|--------|
| **`dba_backfill_bid_portfolio_range(min, max, chunk_size, include_payload)`** | `SECURITY INVOKER` **procedure**; **`COMMIT` after each chunk**; only **`session_user` `postgres` / `supabase_admin`** (Supabase SQL Editor). |
| **`officer_backfill_bid_portfolio_batch`** | Allows **officers**, **`service_role` JWT**, and **direct DB** (`session_user` in `postgres`, `supabase_admin`). **`SET LOCAL statement_timeout = '20min'`** per call. |
| **`officer_bid_portfolio_for_loot`** | Same **`session_user`** allowance (needed when batch builds **payload** from SQL Editor). **`SET LOCAL statement_timeout = '20min'`**. |
| **Python** [`scripts/backfill_bid_portfolio_export.py`](../scripts/backfill_bid_portfolio_export.py) | Splits **`--db-batch`** into chunks; with **`include_payload=true`** caps chunk size via **`BID_PORTFOLIO_PAYLOAD_MAX_CHUNK`** (default **1**); **`POSTGREST_TIMEOUT_PAYLOAD_SEC`** (default **600**) for HTTP client. |

**Recommended run (large backfill):** Supabase **SQL Editor**:

```sql
CALL public.dba_backfill_bid_portfolio_range(1, 100000, 50, false);
-- payload JSON per row (slow): use chunk 1
CALL public.dba_backfill_bid_portfolio_range(1, 100000, 1, true);
```

Watch **Messages** for `RAISE NOTICE` per chunk. If a chunk still times out, **lower `chunk_size`** (payload mode: stay at **1**).

**Alternative:** `python scripts/backfill_bid_portfolio_export.py --db-batch MIN MAX false|true` with **`SUPABASE_SERVICE_ROLE_KEY`** (see script docstring for env vars).

**Auth nuance:** Use **`session_user`**, not **`current_user`**, for SQL Editor bypass — **`SECURITY DEFINER`** would make **`current_user`** the function owner and would **not** be safe for that check.

## Where things live

| Piece | Location |
|--------|-----------|
| Canonical schema | [`docs/supabase-schema-full.sql`](supabase-schema-full.sql) |
| One-shot drop of removed forecast RPCs | [`docs/drop-officer-bid-forecast.sql`](drop-officer-bid-forecast.sql) |
| Item page runner-up | [`web/src/pages/ItemPage.jsx`](../web/src/pages/ItemPage.jsx) |
| Account bidding card | [`web/src/components/AccountBiddingPortfolioCard.jsx`](../web/src/components/AccountBiddingPortfolioCard.jsx) |
| Name normalization (Python) | [`scripts/bid_portfolio_local/normalize.py`](../scripts/bid_portfolio_local/normalize.py) (keep aligned with `normalize_item_name_for_lookup` in SQL) |
| Export / backfill | [`scripts/backfill_bid_portfolio_export.py`](../scripts/backfill_bid_portfolio_export.py); **local CSV rebuild** [`scripts/bid_portfolio_local/`](../scripts/bid_portfolio_local/), [`scripts/compute_bid_portfolio_from_csv.py`](../scripts/compute_bid_portfolio_from_csv.py), [`scripts/upload_bid_portfolio_fact.py`](../scripts/upload_bid_portfolio_fact.py) (see **Historical backfill** Option D) |

## Bidding portfolio objects

| Object | Role |
|--------|------|
| `guild_loot_sale_enriched` | View: each `raid_loot` row with `norm_name`, `ref_price_at_sale` (avg of up to 3 prior guild sales of that name), `paid_to_ref_ratio`, `buyer_account_id`, **`next_guild_sale_loot_id` / `next_guild_sale_buyer_account_id`** (next guild sale of same `norm_name`, by `raid_date` then `loot_id`). |
| `normalize_item_name_for_lookup(text)` | Internal `IMMUTABLE` name key. Keep aligned with [`scripts/bid_portfolio_local/normalize.py`](../scripts/bid_portfolio_local/normalize.py). |
| `bid_forecast_attendees_resolved_for_scope(raid_id, pin_event_id)` | Internal: attendee rows with account resolution; tic-scoped when that event has attendance. Used by portfolio RPCs. |
| `attendee_accounts_for_loot(loot_id)` | Internal: distinct attendee `account_id` for that loot row’s event scope. |
| `account_balance_before_loot(loot_id, account_id)` | Internal: reconstructed pool immediately before that loot row (raid earn, tic credits, and prior loot in the raid). |
| `bid_portfolio_runner_up_guess(loot_id)` | **Deprecated** for product use: class-unaware max-pool heuristic (ad-hoc SQL only). |
| `officer_bid_portfolio_for_loot(loot_id)` | Officers: JSON — sale enrichment, `sim_mode`, per-attendee `pool_before`, `could_clear`, `synthetic_max_bid` (= `LEAST(pool, P-1)` teaching scaffold), historic medians (`median_paid_prior`, `median_paid_to_ref_prior`), `later_bought_same_norm`, **`runner_up_account_guess` / `runner_up_char_guess` read from `bid_portfolio_auction_fact`** (NULL until Python CSV/JSONL backfill). |
| `officer_account_bidding_portfolio(account_id, from_date, to_date)` | Officers: aggregates over `raid_date` range — wins, DKP on wins, `auction_rows_present`, `could_clear_but_not_buyer_count`, `runner_up_guess_count` (**compares account to fact `runner_up_account_guess`**), sum of synthetic max bids when present and not buyer, avg `paid_to_ref` on wins. |
| `bid_portfolio_auction_fact` | Optional table: denormalized row per `loot_id` (runner-up guess, next guild sale columns, optional full `payload` JSON). Officer RLS only. |
| `officer_backfill_bid_portfolio_batch(min_id, max_id, include_payload)` | Upsert fact rows for **`loot_id` in range** (officers, **service_role**, or **postgres / supabase_admin** in SQL Editor). Per-call **`SET LOCAL statement_timeout = '20min'`**. Large jobs: chunk from the client or use **`dba_backfill_bid_portfolio_range`** (**COMMIT** between chunks). **`include_payload=true`** is **much** heavier (often **chunk size 1**). |
| `dba_backfill_bid_portfolio_range(...)` | **Procedure** (SQL Editor only): loops **`officer_backfill_bid_portfolio_batch`** with **`COMMIT`** after each slice. |

**Assumptions (explicit):**

- `synthetic_max_bid` does **not** prove anyone bid `P-1`; it is a labeled scaffold.
- Stored `runner_up_*` fields are **Python-unified** guesses (item_stats + character CSV eligibility, then max_pool or scored rank); they are **not** true second-highest bids without an auction log.
- Attendees and pools use **raid/tic data only** — no Magelo / current gear.

**Apply:** run the updated canonical schema (or equivalent migration) on Supabase so these objects exist.

## Historical backfill (batched, officers)

Large “recompute everything” jobs must be **chunked**. Each `officer_bid_portfolio_for_loot` call does attendee × subquery work; Supabase/PostgREST **statement timeouts** (often on the order of seconds for pooled connections) apply **per request**.

**Option A — JSONL export (no new table rows):** run [`scripts/backfill_bid_portfolio_export.py`](../scripts/backfill_bid_portfolio_export.py). It loads **`web/.env`** then **`web/.env.local`**, so `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` work the same as the web app; still set **`SUPABASE_ACCESS_TOKEN`** to an **officer** JWT (service role does **not** pass `is_officer()`). Use `--min-loot-id` / `--max-loot-id` or `--loot-ids-file` in modest sizes; tune `POSTGREST_TIMEOUT_SEC` (default 120) if needed.

**Option B — persist via PostgREST / CLI:** after applying schema, run repeated **small** batches with the helper (or your own RPC client):

`python scripts/backfill_bid_portfolio_export.py --db-batch 1 400 false`

Uses **`SUPABASE_SERVICE_ROLE_KEY`** (or `VITE_SUPABASE_SERVICE_ROLE_KEY` from `web/.env`) and URL from the same env files; the RPC allows **`service_role`** JWT and officers. Third argument `true` fills `payload` with the full per-loot JSON (heavier); tune chunking / env vars as in the script docstring.

**Option C — persist from Supabase SQL Editor (recommended for large backfills):** run the canonical schema so `dba_backfill_bid_portfolio_range` exists. In the SQL Editor (connected as **postgres**), **COMMIT between chunks** avoids one huge transaction and keeps each `officer_backfill_bid_portfolio_batch` call within a manageable statement budget:

```sql
CALL public.dba_backfill_bid_portfolio_range(1, 10000, 50, false);
```

Arguments: `min_loot_id`, `max_loot_id`, `chunk_size`, `include_payload`. For `include_payload := true`, use a small chunk (often **`1`**) so each statement stays under timeout: e.g. `CALL public.dba_backfill_bid_portfolio_range(1, 5000, 1, true);`. Progress appears as **`RAISE NOTICE`** messages. You can also run single chunks ad hoc: `SELECT * FROM officer_backfill_bid_portfolio_batch(1, 400, false);` — the batch function allows **direct DB sessions** (`session_user` **postgres** / **supabase_admin**) as well as officers and **service_role**.

**Option D — local CSV snapshot + upsert (no DB-side portfolio RPC):** when SQL Editor / `dba_backfill_bid_portfolio_range` still hits **session or proxy timeouts**, rebuild the same logic offline from a **CSV export** of the tables the portfolio uses, then **`upsert`** `bid_portfolio_auction_fact` via the **service role** (fast HTTP batches, no `officer_backfill_bid_portfolio_batch`).

1. Export CSVs (or use an existing backup folder) containing at least: `raid_loot`, `raids`, `raid_events`, `raid_event_attendance`, `raid_attendance`, `character_account`, `characters`, `account_dkp_summary`, `raid_attendance_dkp_by_account`.
2. Compute JSONL:  
   `python scripts/compute_bid_portfolio_from_csv.py --backup-dir C:/path/to/backup --out data/bid_portfolio_fact.jsonl`  
   Add `--include-payload` to fill `payload` with the full `officer_bid_portfolio_for_loot`-shaped JSON (larger file). Optional: `--min-loot-id` / `--max-loot-id`, `--loot-ids-file`, `--checkpoint path.txt` to resume.
3. Upload:  
   `python scripts/upload_bid_portfolio_fact.py --in data/bid_portfolio_fact.jsonl`  
   Uses `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` from `web/.env` (same as [`scripts/backfill_bid_portfolio_export.py`](../scripts/backfill_bid_portfolio_export.py)). Tune `--batch-size` if requests fail on large payloads. By default the uploader **loads remote `raid_loot` ids** and **skips** fact rows whose `loot_id` is missing (avoids FK `bid_portfolio_auction_fact_loot_id_fkey` when the CSV snapshot is ahead of or differs from production). Use `--no-skip-missing-loot` only when you know every id exists remotely.

Implementation lives under [`scripts/bid_portfolio_local/`](../scripts/bid_portfolio_local/) (parity target: [`docs/supabase-schema-full.sql`](supabase-schema-full.sql) — `guild_loot_sale_enriched`, `account_balance_before_loot`, `officer_bid_portfolio_for_loot`). If the CSV dump has **no** `loot_assignment` rows, behavior matches Postgres with an empty `loot_assignment` table (buyer resolution from `raid_loot` only). **Dedicated handoff** for this path: [`HANDOFF_BID_PORTFOLIO_CSV_LOCAL.md`](HANDOFF_BID_PORTFOLIO_CSV_LOCAL.md).

**`later_bought_same_norm` vs next guild sale:** per-attendee `later_bought_same_norm` (in `officer_bid_portfolio_for_loot`) means *that account* bought the same normalized item later. **`next_guild_sale_*`** on the view / fact table is the **next guild-wide** sale of that `norm_name` after this row (whoever won).

## Quick test

1. Apply SQL, sign in as an officer.
2. Call **`officer_bid_portfolio_for_loot`** with a real `loot_id`; confirm `sale` (including `next_guild_sale_*`), `attendees`, and `runner_up_account_guess`. Call **`officer_account_bidding_portfolio`** with an `account_id` and a **narrow date range** first (unbounded scans all loot and can be slow).
3. **Backfill:** in SQL Editor, **`CALL dba_backfill_bid_portfolio_range(...)`** or **`SELECT * FROM officer_backfill_bid_portfolio_batch(...)`** on a small range; confirm **`bid_portfolio_auction_fact`** rows. Or **`scripts/backfill_bid_portfolio_export.py`** with service role (**`--db-batch`**) or officer JWT + **`--out`** JSONL.
