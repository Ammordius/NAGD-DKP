# Handoff: Officer loot bid interest (“Bid hints”)

## What shipped

Officers get **heuristic** bid-interest views for a chosen item: **by raid** (who attended and might care) or **global** (all **active** accounts — recent raid activity or pinned in Admin — and their characters). Both use spend patterns (last purchase locus, per-toon concentration, balance), optional **Magelo-style upgrade scoring** when `class_rankings.json` is available, and a rough **bid band** capped by account balance. Global adds **guild prior-sale reference** per purchase when history exists. This is **not** a bid log or a guarantee of behavior.

## Deploy checklist

1. **Apply SQL in Supabase** (once per project):
   - [`docs/supabase-officer-loot-bid-forecast.sql`](supabase-officer-loot-bid-forecast.sql) — `public.officer_loot_bid_forecast(p_raid_id text)` (`SECURITY DEFINER`, `is_officer()`).
   - [`docs/supabase-officer-global-bid-forecast.sql`](supabase-officer-global-bid-forecast.sql) — `public.normalize_item_name_for_lookup(text)` (internal, `IMMUTABLE`) and `public.officer_global_bid_forecast(p_activity_days int DEFAULT 120)` (`SECURITY DEFINER`, `is_officer()`). `GRANT EXECUTE` on the RPC only (`authenticated`); the normalizer has no execute grant for clients.

2. **Static JSON**
   - `web/public/item_stats.json` — already part of the app.
   - `web/public/dkp_prices.json` — committed snapshot; **refresh** with Magelo `scripts/build_dkp_prices_json.py` (or your pipeline) so sale anchors stay current.
   - `class_rankings.json` — **not** committed by default (large). Either copy the Magelo-generated file to `web/public/class_rankings.json` or set **`VITE_CLASS_RANKINGS_URL`** to a hosted URL. Without it, the page still runs RPC spend narratives but **skips upgrade scoring** (and shows a yellow warning).

3. **Redeploy the web app** after env/build changes.

## Where things live

| Piece | Location |
|--------|-----------|
| Route (by raid) | `/officer/loot-bid-forecast` — [`web/src/pages/OfficerLootBidForecast.jsx`](../web/src/pages/OfficerLootBidForecast.jsx) |
| Route (active roster) | `/officer/global-loot-bid-forecast` — [`web/src/pages/OfficerGlobalLootBidForecast.jsx`](../web/src/pages/OfficerGlobalLootBidForecast.jsx) |
| Nav | “Bid hints” / “Global bid” in [`web/src/App.jsx`](../web/src/App.jsx); links from [`web/src/pages/Officer.jsx`](../web/src/pages/Officer.jsx) |
| Magelo scoring port | [`web/src/lib/mageloUpgradeEngine.js`](../web/src/lib/mageloUpgradeEngine.js) (`evaluateItemUpgradeForCharacter`, `computeUpgradesForCharacter`, etc.) |
| Heuristics / tags / bid band | [`web/src/lib/bidForecastModel.js`](../web/src/lib/bidForecastModel.js) (`bidVsMarketFromPurchasesTimeAware`, …), [`web/src/lib/itemNameNormalize.js`](../web/src/lib/itemNameNormalize.js) |
| Active window constant | [`web/src/lib/dkpLeaderboard.js`](../web/src/lib/dkpLeaderboard.js) (`ACTIVE_DAYS`, same idea as global default) |
| RPC definitions | [`docs/supabase-officer-loot-bid-forecast.sql`](supabase-officer-loot-bid-forecast.sql), [`docs/supabase-officer-global-bid-forecast.sql`](supabase-officer-global-bid-forecast.sql) |
| Schema pointer | Comment at end of [`docs/supabase-schema-full.sql`](supabase-schema-full.sql) |

## Data model notes (RPC)

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

- Add **by-raid** `ref_price_at_sale` to `officer_loot_bid_forecast` if you want the same time-aware ratios on the raid-scoped page without duplicating logic client-side.
- Expression or denormalized index on `(normalize_item_name_for_lookup(item_name), raid_date, id)` if global RPC latency is high (many LATERAL lookups).
- Add `spell_focii_level65.json` (or equivalent) to the web bundle if focus scoring should match Magelo HTML exactly in edge cases.
- Optional: officer audit log entry when “Run” is clicked (privacy/forensics).

## Quick test

1. Apply SQL, sign in as an officer.
2. Open **Bid hints**, enter a real `raid_id`, enter an item **name** or **numeric id**, click **Run**.
3. Confirm rows, tags, and reasons; confirm linked **Account** opens account detail.

4. **Global**: apply [`docs/supabase-officer-global-bid-forecast.sql`](supabase-officer-global-bid-forecast.sql), open **Global bid**, set activity days (default 120 matches leaderboard), enter an item, **Run**; expand **Show top upgrades by slot** on a row that qualifies (concentrated spend on that toon or recent spend on that toon).
