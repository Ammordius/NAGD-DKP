# Handoff: Officer loot bid interest (“Bid hints”)

**CI precompute + secrets + troubleshooting (short):** [HANDOFF_BID_FORECAST_PRECOMPUTE.md](HANDOFF_BID_FORECAST_PRECOMPUTE.md).

**Deeper architecture / CI vs Magelo / global ownership:** [HANDOFF_GLOBAL_ITEM_BID_FORECAST.md](HANDOFF_GLOBAL_ITEM_BID_FORECAST.md).

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

**Files touched:** [`docs/supabase-schema-full.sql`](supabase-schema-full.sql), [`scripts/backfill_bid_portfolio_export.py`](../scripts/backfill_bid_portfolio_export.py), this doc (**Historical backfill** below).

## What shipped

Officers get **heuristic** bid-interest views for a chosen item: **by raid** (who attended and might care) or **active guild roster** (same active-account rules as global — leave raid id blank on **Bid hints**, or use the dedicated **Global bid** page). Both use spend patterns (last purchase locus, per-toon concentration, balance), optional **Magelo-style upgrade scoring**, and a rough **bid band** capped by account balance. **Bid hints** and **Global bid** prefer the **CI-built precomputed upgrade index** (`web/public/bid_forecast_by_item.json`) when present, and fall back to live `class_rankings.json` (or `VITE_CLASS_RANKINGS_URL`) scoring. Global adds **guild prior-sale reference** per purchase when history exists. This is **not** a bid log or a guarantee of behavior.

### Raid bid reconstruction (v2)

**By-raid** flow calls **`officer_loot_bid_forecast_v2`**. Officers can pick a **recent raid** from a dropdown, an optional **loot row** (recorded clearing price), and an item; the UI shows **Pool @ item** (reconstructed account DKP before that auction) and **Est. bid (heur.)** (upgrade rank vs clearing price). Simulation uses `balance + spent_this_raid − earned_this_raid` as opening pool before the raid, then walks **tics** (`per_event` mode) or full-raid earn (`raid_level` mode) plus prior loot in order. **Officer → Loot bid interest** passes `?raid=` when a raid is selected in the officer raid dropdown. **Apply v2 in Supabase** before relying on by-raid **Run**; otherwise the RPC is missing.

## Deploy checklist

1. **Apply SQL in Supabase** (once per project): run the canonical [`docs/supabase-schema-full.sql`](supabase-schema-full.sql). Near the end it defines the bid-forecast objects:
   - `public.officer_loot_bid_forecast(p_raid_id text)` (`SECURITY DEFINER`, `is_officer()`) — legacy; **by-raid UI uses v2**.
   - `public.officer_loot_bid_forecast_v2(p_raid_id text, p_loot_id bigint DEFAULT NULL)` — attendees (union when per-event data is incomplete; tic-scoped when loot row pins an event with attendance), profiles with **`per_toon_earned_this_raid`**, plus **`loot_timeline`**, **`raid_events_ordered`**, **`per_event_earned`**, **`account_raid_rollup`**, optional **`loot_context`**, **`sim_mode`**.
   - `public.normalize_item_name_for_lookup(text)` (internal, `IMMUTABLE`) and `public.officer_global_bid_forecast(p_activity_days int DEFAULT 120)` (`SECURITY DEFINER`, `is_officer()`). `GRANT EXECUTE` on the RPCs only (`authenticated`); the normalizer has no execute grant for clients.

2. **Static JSON**
   - `web/public/item_stats.json` — already part of the app.
   - `web/public/dkp_prices.json` — committed snapshot; **refresh** with Magelo `scripts/build_dkp_prices_json.py` (or your pipeline) so sale anchors stay current.
   - `class_rankings.json` — **not** committed by default (large). Either copy the Magelo-generated file to `web/public/class_rankings.json` or set **`VITE_CLASS_RANKINGS_URL`** on Vercel (build-time) to a hosted URL, e.g. `https://ammordius.github.io/NAGD-spell-inventory/class_rankings.json`. Without rankings URL/file, **Bid hints** / **Global bid** still run RPC + precompute rows but **live** upgrade fallback (and Global slot-deep upgrades) need an explicit fetch or stay skipped (yellow warning).
   - **`bid_forecast_by_item.json`** / **`bid_forecast_meta.json`** — guild-scoped **positive upgrade** index (item id → who gains, with slot / stat deltas). Built in CI (see below). The repo ships **empty placeholders** until the workflow runs successfully.

3. **GitHub Actions: precomputed upgrade index** (job `bid_forecast_index` in [`.github/workflows/loot-to-character.yml`](../.github/workflows/loot-to-character.yml))
   - Runs on the **same schedule and `workflow_dispatch`** as loot-to-character, but **not** gated on new `raid_loot` count (gear can change without new loot).
   - **Secrets** (in addition to existing Supabase keys): **`CLASS_RANKINGS_URL`** — URL to the **same** `class_rankings.json` the app uses (`VITE_CLASS_RANKINGS_URL`). CI fetches it and filters to the **active guild roster** using [`scripts/export_bid_forecast_roster.py`](../scripts/export_bid_forecast_roster.py) (table reads with `SUPABASE_SERVICE_ROLE_KEY`; does **not** call `officer_global_bid_forecast`, which requires `is_officer()`).
   - **Build**: [`scripts/build_bid_forecast_by_item.mjs`](../scripts/build_bid_forecast_by_item.mjs) imports [`web/src/lib/mageloUpgradeEngine.js`](../web/src/lib/mageloUpgradeEngine.js) and runs `computeUpgradesForCharacter` per roster-matched Magelo character.
   - On success, the bot **commits** updated `web/public/bid_forecast_by_item.json` and `bid_forecast_meta.json`.

4. **Redeploy the web app** after env/build changes (or rely on the next commit from CI).

## Where things live

| Piece | Location |
|--------|-----------|
| Route (Bid hints: raid **or** blank raid = active roster) | `/officer/loot-bid-forecast` — [`web/src/pages/OfficerLootBidForecast.jsx`](../web/src/pages/OfficerLootBidForecast.jsx) |
| Wallet sim + bid heuristic | [`web/src/lib/bidForecastModel.js`](../web/src/lib/bidForecastModel.js) (`simulateBalancesBeforeLootRow`, `estimateBidReconstructionHeuristic`) |
| Unit tests (`npm test` in `web/`) | [`web/src/lib/bidForecastRaidSim.test.js`](../web/src/lib/bidForecastRaidSim.test.js) |
| Route (active roster) | `/officer/global-loot-bid-forecast` — [`web/src/pages/OfficerGlobalLootBidForecast.jsx`](../web/src/pages/OfficerGlobalLootBidForecast.jsx) |
| Nav | “Bid hints” / “Global bid” in [`web/src/App.jsx`](../web/src/App.jsx); links from [`web/src/pages/Officer.jsx`](../web/src/pages/Officer.jsx) |
| Magelo scoring port | [`web/src/lib/mageloUpgradeEngine.js`](../web/src/lib/mageloUpgradeEngine.js) (`evaluateItemUpgradeForCharacter`, `computeUpgradesForCharacter`, etc.) |
| Heuristics / tags / bid band | [`web/src/lib/bidForecastModel.js`](../web/src/lib/bidForecastModel.js) (`bidVsMarketFromPurchasesTimeAware`, …), [`web/src/lib/itemNameNormalize.js`](../web/src/lib/itemNameNormalize.js) |
| Active window constant | [`web/src/lib/dkpLeaderboard.js`](../web/src/lib/dkpLeaderboard.js) (`ACTIVE_DAYS`, same idea as global default) |
| RPC definitions | [`docs/supabase-schema-full.sql`](supabase-schema-full.sql) (Officer bid forecast RPCs section) |
| CI: roster export + Node index | [`scripts/export_bid_forecast_roster.py`](../scripts/export_bid_forecast_roster.py), [`scripts/build_bid_forecast_by_item.mjs`](../scripts/build_bid_forecast_by_item.mjs) |
| Canonical schema | [`docs/supabase-schema-full.sql`](supabase-schema-full.sql) |
| Bidding portfolio (SQL) | View `guild_loot_sale_enriched`; table `bid_portfolio_auction_fact`; RPCs `officer_bid_portfolio_for_loot`, `officer_account_bidding_portfolio`, `officer_backfill_bid_portfolio_batch`; export script [`scripts/backfill_bid_portfolio_export.py`](../scripts/backfill_bid_portfolio_export.py); **local CSV rebuild** [`scripts/bid_portfolio_local/`](../scripts/bid_portfolio_local/), [`scripts/compute_bid_portfolio_from_csv.py`](../scripts/compute_bid_portfolio_from_csv.py), [`scripts/upload_bid_portfolio_fact.py`](../scripts/upload_bid_portfolio_fact.py) (see **Historical backfill** Option D) |

## Bidding portfolio scaffold (SQL, officers)

Historical **heuristics only** — there is still **no auction log**. Objects live in [`docs/supabase-schema-full.sql`](supabase-schema-full.sql) next to the other bid-forecast definitions.

| Object | Role |
|--------|------|
| `guild_loot_sale_enriched` | View: each `raid_loot` row with `norm_name`, `ref_price_at_sale` (avg of up to 3 prior guild sales of that name), `paid_to_ref_ratio`, `buyer_account_id`, **`next_guild_sale_loot_id` / `next_guild_sale_buyer_account_id`** (next guild sale of same `norm_name`, by `raid_date` then `loot_id`). |
| `bid_forecast_attendees_resolved_for_scope(raid_id, pin_event_id)` | Internal: attendee rows with account resolution; **same rules** as by-raid v2 (tic-scoped when that event has attendance). Used by v2 and portfolio RPCs. |
| `attendee_accounts_for_loot(loot_id)` | Internal: distinct attendee `account_id` for that loot row’s event scope. |
| `account_balance_before_loot(loot_id, account_id)` | Internal: reconstructed pool immediately before that loot row (parity with [`simulateBalancesBeforeLootRow`](../web/src/lib/bidForecastModel.js)). |
| `bid_portfolio_runner_up_guess(loot_id)` | Internal: non-buyer attendee with **maximum** `pool_before` among those with `pool_before >= clearing price`; tie-break `account_id`. |
| `officer_bid_portfolio_for_loot(loot_id)` | Officers: JSON — sale enrichment, `sim_mode`, per-attendee `pool_before`, `could_clear`, `synthetic_max_bid` (= `LEAST(pool, P-1)` teaching scaffold), historic medians (`median_paid_prior`, `median_paid_to_ref_prior`), `later_bought_same_norm`, `runner_up_account_guess`. |
| `officer_account_bidding_portfolio(account_id, from_date, to_date)` | Officers: aggregates over `raid_date` range — wins, DKP on wins, `auction_rows_present`, `could_clear_but_not_buyer_count`, `runner_up_guess_count`, sum of synthetic max bids when present and not buyer, avg `paid_to_ref` on wins. |
| `bid_portfolio_auction_fact` | Optional table: denormalized row per `loot_id` (runner-up guess, next guild sale columns, optional full `payload` JSON). Officer RLS only. |
| `officer_backfill_bid_portfolio_batch(min_id, max_id, include_payload)` | Upsert fact rows for **`loot_id` in range** (officers, **service_role**, or **postgres / supabase_admin** in SQL Editor). Per-call **`SET LOCAL statement_timeout = '20min'`**. Large jobs: chunk from the client or use **`dba_backfill_bid_portfolio_range`** (**COMMIT** between chunks). **`include_payload=true`** is **much** heavier (often **chunk size 1**). |
| `dba_backfill_bid_portfolio_range(...)` | **Procedure** (SQL Editor only): loops **`officer_backfill_bid_portfolio_batch`** with **`COMMIT`** after each slice. |

**Assumptions (explicit):**

- `synthetic_max_bid` does **not** prove anyone bid `P-1`; it is a labeled scaffold.
- `runner_up_account_guess` is **not** a true second-price winner when many attendees could pay `P`; it picks the richest eligible non-buyer by pool-before.
- Attendees and pools use **raid/tic data only** — no Magelo / current gear.

**Apply:** run the updated canonical schema (or equivalent migration) on Supabase so these objects exist alongside `officer_loot_bid_forecast_v2`.

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

## Data model notes (RPC)

### `officer_loot_bid_forecast_v2` (by-raid UI)

- **Attendees:** If the chosen **loot row** maps to an `event_id` that has **`raid_event_attendance`** rows, roster is **that tic only**. Otherwise, with per-event mode, **union** of all `raid_event_attendance` for the raid plus **`raid_attendance`** (deduped). Without per-event rows, **`raid_attendance`** only.
- **Profiles:** Same spend/balance shape as before, but **`per_toon_earned_this_raid`** replaces lifetime `per_toon_earned` for this RPC (raid-scoped earned per toon).
- **Reconstruction payloads:** `loot_timeline` (ordered loot with buyer account), `per_event_earned`, `raid_events_ordered`, `account_raid_rollup` (`earned_this_raid` / `spent_this_raid` per account), `sim_mode` (`per_event` vs `raid_level`).

### `officer_loot_bid_forecast` (legacy)

- Attendees: distinct rows from **`raid_event_attendance`** for the raid if any exist; else **`raid_attendance`**.
- Characters/classes: `LEFT JOIN characters` on `char_id` or **case-insensitive name** match.
- Accounts: `character_account`; spend aggregates only include `raid_loot` rows whose **`char_id`** links to that account (rows with missing `char_id` are invisible to per-account history here).
- Returns per account: `last_purchase`, `days_since_last_spend`, `per_toon_spent`, `top_toon_share`, `recent_purchases_desc` (up to 150, chronological), `balance` from `account_dkp_summary`.

### Global RPC (`officer_global_bid_forecast`)

- **Active accounts**: `account_dkp_summary.last_activity_date >= CURRENT_DATE - p_activity_days` **or** `account_id` in **`active_accounts`**, excluding `accounts.inactive`.
- **`roster`**: per active account, all linked rows from `character_account` + `characters` (`char_id`, `name`, `class_name`).
- **`recent_purchases_desc`**: each purchase may include **`ref_price_at_sale`** (average of up to **3 prior** guild sales for the same normalized item name, strictly before that loot row) and **`paid_to_ref_ratio`** (`cost / ref` when both positive). Normalization matches [`web/src/lib/itemNameNormalize.js`](../web/src/lib/itemNameNormalize.js) via `normalize_item_name_for_lookup` in SQL — keep them aligned if you change either.
- **Vercel**: the deployed site uses the same Supabase project; apply the SQL there so the RPC exists in production.

## Model limitations (intentional / known)

- **No auction history** — only cleared prices in `raid_loot`.
- **Bid vs “market”**: **By-raid** RPC does not attach per-sale reference prices; the UI still uses **`dkp_prices.json`** (last-three style) for median paid/reference on that flow. **Global** RPC adds **guild prior-sale** reference per purchase when history exists; the UI prefers `paid_to_ref_ratio` and falls back to `dkp_prices.json` per purchase ([`bidVsMarketFromPurchasesTimeAware`](../web/src/lib/bidForecastModel.js)).
- **Item identity**: loot is by **name**; resolution to Allaclone id uses the same normalization as Magelo price tooling.
- **RLS**: other tables remain readable to authenticated users; **sensitive aggregation is gated by the RPC** for this feature. Do not rely on hiding data if someone queries tables directly.

## Follow-ups (if you want to extend)

- Wire the officer UI to **`officer_bid_portfolio_for_loot`** / **`officer_account_bidding_portfolio`** if you want portfolio output in-app (data is already available via RPC).
- Add **by-raid** `ref_price_at_sale` to **`officer_loot_bid_forecast_v2`** (or v1) if you want the same time-aware ratios on the raid-scoped page without duplicating logic client-side — or read from **`guild_loot_sale_enriched`** / reuse the view’s columns in a thin RPC.
- Expression or denormalized index on `(normalize_item_name_for_lookup(item_name), raid_date, id)` if global RPC latency is high (many LATERAL lookups).
- Add `spell_focii_level65.json` (or equivalent) to the web bundle if focus scoring should match Magelo HTML exactly in edge cases.
- Optional: officer audit log entry when “Run” is clicked (privacy/forensics).

## Quick test

1. Apply SQL (including **`officer_loot_bid_forecast_v2`**), sign in as an officer.
2. Open **Bid hints**, enter a real `raid_id` (or use **Recent raid**), enter an item **name** or **numeric id**, click **Run**; confirm rows, tags, expandable **Detail**, and **Account** link.
3. Optional: choose a **Loot row**, **Run** again; confirm **Pool @ item**, **Est. bid (heur.)**, and the reconstruction summary (guessed winner by upgrade rank + pool).
4. From **Officer**, select a raid and open **Loot bid interest** — URL should include `?raid=…` and the raid field should be prefilled.
5. Clear **Raid id**, set **Activity days** if needed, **Run** again — should match **Global bid** roster behavior for the same item.
6. After CI has populated precompute JSON, confirm upgrade summaries show **(Precomputed CI index)** in expanded detail where applicable.
7. **Global** page: with schema applied (step 1), open **Global bid**, set activity days (default 120 matches leaderboard), enter an item, **Run**; expand **Show top upgrades by slot** on a row that qualifies (concentrated spend on that toon or recent spend on that toon).
8. From `web/`, run **`npm test`** to exercise bid simulation helpers.
9. **Bidding portfolio:** as an officer, call **`officer_bid_portfolio_for_loot`** with a real `loot_id`; confirm `sale` (including `next_guild_sale_*`), `attendees`, and `runner_up_account_guess`. Call **`officer_account_bidding_portfolio`** with an `account_id` and a **narrow date range** first (unbounded scans all loot and can be slow).
10. **Backfill:** in SQL Editor, **`CALL dba_backfill_bid_portfolio_range(...)`** or **`SELECT * FROM officer_backfill_bid_portfolio_batch(...)`** on a small range; confirm **`bid_portfolio_auction_fact`** rows. Or **`scripts/backfill_bid_portfolio_export.py`** with service role (**`--db-batch`**) or officer JWT + **`--out`** JSONL.
