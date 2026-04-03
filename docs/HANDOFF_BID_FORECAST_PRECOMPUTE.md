# Handoff: Bid forecast precompute (CI) + Bid hints UX

**Purpose:** One-page pass-down for the **guild-scoped upgrade JSON** pipeline and how it ties to **`/officer/loot-bid-forecast`**. Full product and RPC notes stay in [HANDOFF_OFFICER_LOOT_BID_FORECAST.md](HANDOFF_OFFICER_LOOT_BID_FORECAST.md) and [HANDOFF_GLOBAL_ITEM_BID_FORECAST.md](HANDOFF_GLOBAL_ITEM_BID_FORECAST.md).

## What you own

| Area | Summary |
|------|---------|
| **User-facing** | Officers use **Bid hints** with optional raid id (blank = active roster, same RPC idea as Global bid). Table shows interest, **bid band**, then expandable **Detail** (spend + upgrade narrative). |
| **Precompute** | `web/public/bid_forecast_by_item.json` maps **item id → list of guild toons** for whom Magelo-style scoring shows a **positive** upgrade vs current gear (slot, score Δ, HP/mana/AC deltas, etc.). |
| **CI** | GitHub Actions job **`bid_forecast_index`** in [`.github/workflows/loot-to-character.yml`](../.github/workflows/loot-to-character.yml) rebuilds that JSON on the **same cron / manual dispatch** as loot-to-character, but **not** gated on new `raid_loot` (gear changes without new loot still matter). |

## What the next owner must configure

1. **GitHub secret `CLASS_RANKINGS_URL`**  
   - Must return the **same** `class_rankings.json` shape the Magelo export uses (characters + `class_weights` + `focus_candidates`).  
   - Align with **`VITE_CLASS_RANKINGS_URL`** on Vercel when you want CI and browser fallback scoring to match.  
   - If this secret is missing, **`bid_forecast_index` skips** (no failure); placeholders in `web/public/` stay empty until you fix it.

2. **Existing Supabase secrets** (already used for loot assignment)  
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — required for [scripts/export_bid_forecast_roster.py](../scripts/export_bid_forecast_roster.py), which mirrors **active account** logic from `officer_global_bid_forecast` via **table reads** (the RPC itself is **not** called in CI because `is_officer()` fails for the service role).

3. **Bot push**  
   - Workflow uses `contents: write` and commits **`bid_forecast_by_item.json`** + **`bid_forecast_meta.json`** when they change. Ensure the default `GITHUB_TOKEN` is allowed to push to `main` (branch protection may need an exception or use a PAT).

## Local reproduction

```bash
# From repo root, with env set:
export SUPABASE_URL=...
export SUPABASE_SERVICE_ROLE_KEY=...
export CLASS_RANKINGS_URL=...   # or omit and use --rankings-file

pip install -r requirements.txt
python scripts/export_bid_forecast_roster.py --out data/bid_forecast_roster.json

cd web && npm ci && cd ..
node scripts/build_bid_forecast_by_item.mjs
# Optional: --rankings-file path/to/class_rankings.json
```

Intermediate `data/bid_forecast_roster.json` is **gitignored**.

## Behavior without browser `class_rankings.json`

- **RPC + spend + bid bands:** always work for signed-in officers (SQL applied).  
- **Rich upgrade lines:** come from **`bid_forecast_by_item.json`** once CI has populated it — **no** `VITE_CLASS_RANKINGS_URL` required in the browser for those rows.  
- **Live fallback** (toons/items missing from precompute): still needs **`class_rankings.json`** in the bundle or via `VITE_CLASS_RANKINGS_URL`; otherwise you see the yellow warning and weaker “why” text.

## Key files (implementation)

| File | Role |
|------|------|
| [scripts/export_bid_forecast_roster.py](../scripts/export_bid_forecast_roster.py) | Active roster → `data/bid_forecast_roster.json` |
| [scripts/build_bid_forecast_by_item.mjs](../scripts/build_bid_forecast_by_item.mjs) | Fetch rankings URL, filter by roster, `computeUpgradesForCharacter` → public JSON |
| [web/src/pages/OfficerLootBidForecast.jsx](../web/src/pages/OfficerLootBidForecast.jsx) | UI: optional raid, RPC, precompute merge, `<details>` |
| [web/src/lib/mageloUpgradeEngine.js](../web/src/lib/mageloUpgradeEngine.js) | Single source of truth for scoring (browser + Node CI) |

## Troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| Job always “Skipping bid forecast index” | Missing `CLASS_RANKINGS_URL` or Supabase secrets. |
| Empty `byItem` after run | No roster ↔ Magelo name+class matches, or rankings fetch failed (check workflow logs). |
| CI slow or OOM | Guild roster × `item_stats` size; reduce `--max-per-slot` in the script if needed. |
| Upgrade text wrong vs Magelo site | Stale `CLASS_RANKINGS_URL` or stale `item_stats.json` vs what Magelo used. |
| Duplicate-name guild toons | Roster export dedupes by **name + class**; edge case if two chars collide. |

## Commit / deploy flow

1. CI runs → commits JSON to `main` → Vercel deploy picks up `web/public/*.json`.  
2. No new Vercel env vars are **required** for precompute-only upgrade copy; `VITE_CLASS_RANKINGS_URL` remains optional for **live** fallback.

## Related commits

Feature landed as **`feat: CI bid forecast JSON, optional raid on loot bid hints`** (includes workflow, scripts, UI, placeholders, handoff updates).
