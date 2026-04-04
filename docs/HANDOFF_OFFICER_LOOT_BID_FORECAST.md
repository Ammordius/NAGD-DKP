# Handoff: Officer loot bid interest (“Bid hints”)

**CI precompute + secrets + troubleshooting (short):** [HANDOFF_BID_FORECAST_PRECOMPUTE.md](HANDOFF_BID_FORECAST_PRECOMPUTE.md).

**Deeper architecture / CI vs Magelo / global ownership:** [HANDOFF_GLOBAL_ITEM_BID_FORECAST.md](HANDOFF_GLOBAL_ITEM_BID_FORECAST.md).

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

- Add **by-raid** `ref_price_at_sale` to **`officer_loot_bid_forecast_v2`** (or v1) if you want the same time-aware ratios on the raid-scoped page without duplicating logic client-side.
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
