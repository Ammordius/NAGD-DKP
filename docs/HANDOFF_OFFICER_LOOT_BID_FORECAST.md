# Handoff: Officer loot bid interest (“Bid hints”)

## What shipped

Officers get a **heuristic** view of who on a raid might care about a chosen item: spend patterns (last purchase locus, per-toon concentration, balance), optional **Magelo-style upgrade deltas** when `class_rankings.json` is available, and a rough **bid band** capped by account balance. This is **not** a bid log or a guarantee of behavior.

## Deploy checklist

1. **Apply SQL in Supabase** (once per project): run [`docs/supabase-officer-loot-bid-forecast.sql`](supabase-officer-loot-bid-forecast.sql). It creates `public.officer_loot_bid_forecast(p_raid_id text)` as `SECURITY DEFINER` and raises unless `public.is_officer()` is true. `GRANT EXECUTE` is for `authenticated` only.

2. **Static JSON**
   - `web/public/item_stats.json` — already part of the app.
   - `web/public/dkp_prices.json` — committed snapshot; **refresh** with Magelo `scripts/build_dkp_prices_json.py` (or your pipeline) so sale anchors stay current.
   - `class_rankings.json` — **not** committed by default (large). Either copy the Magelo-generated file to `web/public/class_rankings.json` or set **`VITE_CLASS_RANKINGS_URL`** to a hosted URL. Without it, the page still runs RPC spend narratives but **skips upgrade scoring** (and shows a yellow warning).

3. **Redeploy the web app** after env/build changes.

## Where things live

| Piece | Location |
|--------|-----------|
| Route | `/officer/loot-bid-forecast` — [`web/src/pages/OfficerLootBidForecast.jsx`](../web/src/pages/OfficerLootBidForecast.jsx) |
| Nav | “Bid hints” in [`web/src/App.jsx`](../web/src/App.jsx); link from [`web/src/pages/Officer.jsx`](../web/src/pages/Officer.jsx) |
| Magelo scoring port | [`web/src/lib/mageloUpgradeEngine.js`](../web/src/lib/mageloUpgradeEngine.js) (`evaluateItemUpgradeForCharacter`, etc.) |
| Heuristics / tags / bid band | [`web/src/lib/bidForecastModel.js`](../web/src/lib/bidForecastModel.js), [`web/src/lib/itemNameNormalize.js`](../web/src/lib/itemNameNormalize.js) |
| RPC definition | [`docs/supabase-officer-loot-bid-forecast.sql`](supabase-officer-loot-bid-forecast.sql) |
| Schema pointer | Comment at end of [`docs/supabase-schema-full.sql`](supabase-schema-full.sql) |

## Data model notes (RPC)

- Attendees: distinct rows from **`raid_event_attendance`** for the raid if any exist; else **`raid_attendance`**.
- Characters/classes: `LEFT JOIN characters` on `char_id` or **case-insensitive name** match.
- Accounts: `character_account`; spend aggregates only include `raid_loot` rows whose **`char_id`** links to that account (rows with missing `char_id` are invisible to per-account history here).
- Returns per account: `last_purchase`, `days_since_last_spend`, `per_toon_spent`, `top_toon_share`, `recent_purchases_desc` (up to 150, chronological), `balance` from `account_dkp_summary`.

## Model limitations (intentional / known)

- **No auction history** — only cleared prices in `raid_loot`.
- **Bid vs “market”** in the UI uses **`dkp_prices.json`** (recent last-three style anchor), not a full time-traveling index per raid date. True “rolling price at time of purchase” would need extra SQL or a batch job (see plan).
- **Item identity**: loot is by **name**; resolution to Allaclone id uses the same normalization as Magelo price tooling.
- **RLS**: other tables remain readable to authenticated users; **sensitive aggregation is gated by the RPC** for this feature. Do not rely on hiding data if someone queries tables directly.

## Follow-ups (if you want to extend)

- Extend RPC or add a second RPC to return **guild-wide** prior sales per item name for date-aware reference prices.
- Add `spell_focii_level65.json` (or equivalent) to the web bundle if focus scoring should match Magelo HTML exactly in edge cases.
- Optional: officer audit log entry when “Run” is clicked (privacy/forensics).

## Quick test

1. Apply SQL, sign in as an officer.
2. Open **Bid hints**, enter a real `raid_id`, enter an item **name** or **numeric id**, click **Run**.
3. Confirm rows, tags, and reasons; confirm linked **Account** opens account detail.
