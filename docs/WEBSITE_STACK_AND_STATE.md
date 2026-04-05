# DKP website stack, data sources, and UI state

Single reference for the **player/officer web UI** in this repo. The deployable app lives under `web/` (not the repo root).

## Stack (what actually runs on Vercel)

| Piece | Technology | Notes |
|--------|------------|--------|
| Bundler / dev server | **Vite 5** | `npm run dev` → http://localhost:5173 |
| UI | **React 18** | Function components |
| Routing | **react-router-dom v6** | `BrowserRouter` in `web/src/main.jsx` |
| Live data | **Supabase JS** (`@supabase/supabase-js`) | Anon key + RLS; client in `web/src/lib/supabase.js` |
| Caching / dedup | **SWR** | Account detail, raid detail, etc. |
| Analytics | **@vercel/analytics** | In `web/src/App.jsx` |
| Deploy | **Vercel** | Project **root directory** = `web/`; SPA fallback in `web/vercel.json` |

This is a **client-side SPA**, not Next.js. All routes are served `index.html` and handled in the browser.

### Environment variables

Set in `.env.local` (local) and Vercel project settings (production):

| Variable | Purpose |
|----------|---------|
| `VITE_SUPABASE_URL` | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon (public) key |
| `VITE_CLASS_RANKINGS_URL` | Optional; bid forecast pages default to `/class_rankings.json` |

Access in code: `import.meta.env.VITE_*` (Vite convention).

## Directory map (`web/`)

| Path | Role |
|------|------|
| `web/src/main.jsx` | React root, `BrowserRouter` |
| `web/src/App.jsx` | Auth/session, nav, `<Routes>`, `RequireAuth`, last-path restore |
| `web/src/pages/*.jsx` | One main component per route (screens) |
| `web/src/components/*.jsx` | Shared UI (links, disclaimers, cards) |
| `web/src/lib/*.js` | Supabase client, DKP math, static JSON helpers, `usePersistedState`, caches |
| `web/public/` | Static assets served at site root (`/item_stats.json`, `/dkp_mob_loot.json`, etc.) |
| `web/api/` | Vercel serverless (e.g. `get-dkp.ts`) if used by deployment |
| `web/vercel.json` | SPA rewrites (`/*` → `/index.html`), cache headers for selected JSON |

Repo-level SQL/docs (schema, imports) live under `docs/` at the **repository** root; this file is the **web app** map.

## Routing table

Defined in `web/src/App.jsx`.

| Path | Component | Access |
|------|-----------|--------|
| `/login` | `Login` | Public |
| `/` | `Dashboard` | Signed in |
| `/raids` | `Raids` | Signed in |
| `/raids/:raidId` | `RaidDetail` | Signed in |
| `/dkp` | `DKP` | Signed in |
| `/officer` | `Officer` | Signed in (redirect if not officer) |
| `/officer/dkp-changelog` | `DkpChangelog` | Signed in (officer gate in page) |
| `/officer/loot-bid-forecast` | `OfficerLootBidForecast` | Signed in (officer) |
| `/officer/global-loot-bid-forecast` | `OfficerGlobalLootBidForecast` | Signed in (officer) |
| `/officer/claim-cooldowns` | `OfficerClaimCooldowns` | Signed in (officer) |
| `/loot` | `LootSearch` | Signed in |
| `/loot-recipients` | `LootRecipients` | Signed in |
| `/mobs` | `MobLoot` | Signed in |
| `/accounts` | `Accounts` | Signed in |
| `/accounts/:accountId` | `AccountDetail` | Signed in |
| `/profile` | `Profile` | Signed in |
| `/items/:itemNameEncoded` | `ItemPage` | Signed in |
| `/characters/:charKey` | `CharacterPage` | Signed in |
| `*` | Redirect to `/` | — |

**Roles:** `App` loads `profiles.role` for the signed-in user. `isOfficer` toggles officer nav links; individual pages may also `navigate('/')` if not officer.

## Data sources (where values come from)

### Supabase (runtime)

Typical tables/RPCs (non-exhaustive; see `docs/supabase-schema-full.sql` for truth):

- **Raids / events / loot / attendance:** `raids`, `raid_events`, `raid_loot`, `raid_attendance`, views like `raid_loot_with_assignment`, RPCs such as `refresh_account_dkp_summary_for_raid`, `delete_raid`, officer audit helpers.
- **Accounts / characters:** `accounts`, `characters`, `character_account`, profile claim RPCs.
- **Leaderboard / summaries:** Used from DKP and account pages via `web/src/lib/dkpLeaderboard.js`, `accountData.js`, and direct queries in pages.

**Client:** `web/src/lib/supabase.js` — missing env vars log a warning and still create a client (requests will fail until configured).

### Static JSON (build / deploy artifacts)

Fetched with `fetch('/…')` from `public/` or CDN:

- Item stats, prices, mob loot, raid item sources: see `getDkpMobLoot`, `getRaidItemSources` in `web/src/lib/staticData.js` and usages in item/raid/officer flows.
- Bid forecast precompute: `/bid_forecast_meta.json`, shards under `/bid_forecast_items/` (see `web/src/lib/bidForecastPrecomputeFetch.js`).
- Optional `VITE_CLASS_RANKINGS_URL` or `/class_rankings.json` for bid forecast rankings.

`web/vercel.json` sets long cache headers for some JSON paths.

### Browser storage (client-only)

| Mechanism | Key pattern | Purpose |
|-----------|------------|---------|
| `sessionStorage` | `dkp-last-path` | Last visited path (see below) |
| `sessionStorage` | `pageState:…` | `usePersistedState` UI persistence (filters, Raids calendar month, bid-forecast fields, raid detail expanded tics, account activity page index, etc.) |
| `sessionStorage` | `account-detail-cache-${accountId}` | SWR fallback for account page |
| `sessionStorage` | Loot search cache | See `LootSearch.jsx` |
| TTL cache | `raids_month_*` | Raids calendar month blobs (`web/src/lib/cache.js`) |

## UI state persistence playbook

React Router **unmounts** screens when you navigate away. Any state held only in `useState` is **lost** unless mirrored elsewhere.

### Rules of thumb

1. **Shareable / primary context** (which raid, which tab on account/profile): prefer the **URL** — `useSearchParams` or path params. Enables refresh, back/forward, and link sharing.
2. **Filters / form convenience** (search text, sort, calendar month): use **`usePersistedState`** in `web/src/lib/usePersistedState.js` with keys `'<logical-path>:<field>'` (stored as `pageState:` + key in `sessionStorage`).
3. **Ephemeral** (loading, errors, dropdown open): keep **`useState`** only.

### `usePersistedState`

- **API:** `const [x, setX] = usePersistedState('key', initialValue)`
- **Storage:** `sessionStorage` key `pageState:` + your key.
- **Dynamic keys:** When the key changes (e.g. per `accountId` or `raidId`), the hook reloads that storage slot (see implementation).

### Last route restore (`dkp-last-path`)

In `web/src/App.jsx`:

- On each navigation (except bare `/login`), the app stores `pathname + search` in `sessionStorage['dkp-last-path']`.
- When the user is signed in and lands on **`/`** the **first time** in that session, the app may `replace` navigate to the saved path (`hasRestoredRef` ensures this runs once). **Clicking “Home” later stays on `/`** because the restore effect does not run again.

If a bookmark to `/` unexpectedly jumps elsewhere, this behavior is why.

### URL query conventions (post–state-audit)

| Screen | Query | Meaning |
|--------|--------|---------|
| `/officer` | `raid` | Selected raid for officer editing (synced with dropdown) |
| `/officer/loot-bid-forecast` | `raid` | Raid scope for bid hints |
| `/accounts/:accountId` | `tab` | `activity` \| `characters` \| `loot` (default: activity; default tab may omit query) |
| `/profile` | `tab` | `activity` \| `characters` |

**Note:** Top nav `<Link to="/officer">` does not preserve `?raid=`; deep links and browser history still do. Activity tab pagination on account pages uses `pageState:/accounts/detail:{accountId}:activityPage` (not the URL).

## Local development

```bash
cd web
npm install
npm run dev
```

Copy `web/.env.example` to `web/.env.local` and set Supabase variables.

Tests (where present): `npm test` runs Node tests on selected `web/src/lib/*.test.js` files.

## Build / deploy

```bash
cd web
npm run build
npm run preview   # optional local preview of production build
```

Vercel: set root to **`web`**, add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.

## Debugging cheatsheet

| Symptom | Check |
|---------|--------|
| “I left the page and my selection reset” | Is that state only `useState`? Should it be URL or `usePersistedState`? |
| “Refresh loses everything” | URL params missing for primary context; or only sessionStorage without URL |
| “Landing on `/` sends me somewhere else” | `dkp-last-path` + one-time restore in `App.jsx` |
| “Supabase errors / empty data” | Env vars, RLS policies, user role in `profiles` |
| “Static JSON 404” | File under `web/public/` or deployment artifact path |

**First files to open:** `web/src/App.jsx` (routes, auth), the relevant `web/src/pages/*.jsx`, `web/src/lib/supabase.js`, `web/src/lib/usePersistedState.js`.
