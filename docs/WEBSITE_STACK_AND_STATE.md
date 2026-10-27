# DKP website stack, data sources, and UI state

Single reference for the **player/officer web UI** in this repo. The deployable app lives under `web/` (not the repo root).

## Stack (what actually runs on Vercel)

| Piece | Technology | Notes |
|--------|------------|--------|
| Bundler / dev server | **Vite 7** | `npm run dev` → http://localhost:5173 |
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
| `VITE_SITE_TITLE` | Deployment display name. Also the sign-in heading, the Home (`/`) heading, and the suffix on Site Admin (`Site Admin - …`). Each route sets the browser tab to `Page · <title>` (for example `DKP · NAGD DKP - Staging Site`). Set per deployment so development, staging, and production stay distinguishable while the git code stays the same. Falls back to `NAGD DKP - Development` when unset. Display text only — does not control development warnings. The site footer is always shown. |
| `VITE_SITE_ENV` | Deployment environment: `production`, `staging`, or `development`. Only `production` (case-insensitive exact match) hides the development banner and the DKP/account warning. Missing, blank, or any other value defaults to non-production (warnings shown). |
| `VITE_CLASS_RANKINGS_URL` | Optional; Raider Activity “Reload coverage” falls back to `/class_rankings.json`. Guild export: `https://ammordius.github.io/NAGD-spell-inventory/class_rankings.json` (set GitHub secret `CLASS_RANKINGS_URL` to the same for CI). CSP `connect-src` allows `https://ammordius.github.io` for this fetch. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only. Used by `POST /api/delete-site-user` to call `auth.admin.deleteUser`. Set it in Vercel and in `web/.env.local` (or the repo root `.env`) for `npm run dev`. Do not prefix it with `VITE_` — Vite would expose it to the browser. |

Access in client code: `import.meta.env.VITE_*` (Vite convention). The service role key is read only in `web/api/delete-site-user.js` from `process.env`.

## Directory map (`web/`)

| Path | Role |
|------|------|
| `web/src/main.jsx` | React root, `BrowserRouter` |
| `web/src/App.jsx` | Auth/session, nav, `<Routes>`, `RequireAuth`, last-path restore |
| `web/src/pages/*.jsx` | One main component per route (screens) |
| `web/src/components/*.jsx` | Shared UI (links, disclaimers, cards) |
| `web/src/lib/*.js` | Supabase client, DKP math, static JSON helpers, `usePersistedState`, caches |
| `web/public/` | Static assets served at site root (`/item_stats.json`, `/dkp_mob_loot.json`, etc.) |
| `web/api/` | Vercel serverless. `delete-site-user.js` removes an auth user (service role). |
| `web/vercel.json` | SPA rewrites (`/*` → `/index.html`), cache headers for selected JSON, and a content security policy plus `nosniff`, frame denial, and referrer policy on every response |

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
| `/officer/RaidAdmin` | `Officer` | Signed in (redirect if not officer). Old `/officer` redirects here. |
| `/officer/dkp-changelog` | `DkpChangelog` | Signed in (officer gate in page) |
| `/officer/SiteAdmin` | `OfficerClaimCooldowns` | Signed in (officer or siteadmin). Old `/officer/claim-cooldowns` redirects here. Site Profile Accounts lists users. Officers can remove players. Site admins can also unclaim, claim an unclaimed game account for a profile, change roles, and remove officers. Nobody can remove a site admin or themselves. |
| `/officer/raider-activity` | `OfficerRaiderActivity` | Signed in (officer); class coverage from `account_class_coverage` (CI/Magelo) |
| `/loot` | `LootSearch` | Signed in |
| `/loot-recipients` | `LootRecipients` | Signed in |
| `/mobs` | `MobLoot` | Signed in |
| `/accounts` | `Accounts` | Signed in |
| `/accounts/:accountId` | `AccountDetail` | Signed in |
| `/profile` | `Profile` | Signed in |
| `/items/:itemNameEncoded` | `ItemPage` | Signed in |
| `/characters/:charKey` | `CharacterPage` | Signed in |
| `*` | Page not found | Public |

**Roles:** `App` loads `profiles.role` for the signed-in user. `player`, `officer`, and `siteadmin` are allowed. `isOfficer` is true for `officer` and `siteadmin` and toggles officer nav links; `RequireOfficer` sends anyone else home before the officer page renders. If that profile read fails and no profile is already loaded, the app shows a retry instead of treating the user as a player. `isSiteAdmin` is true only for `siteadmin`. On `/officer/SiteAdmin`, officers and site admins see Site Profile Accounts. Unclaim, claim-on-behalf, and role changes are siteadmin only. Claim sets `profiles.account_id` from an unclaimed `accounts` row (`account_id` and `display_name`) and does not clear an unclaim cooldown. Remove user is `POST /api/delete-site-user`: it deletes the profile, then `auth.admin.deleteUser` with the server-only service role key. Officers may remove players. Site admins may remove players and officers. Nobody may remove a site admin or themselves. `profiles.display_name` is the site name (email sign-up field, or the Discord username). It is separate from `accounts.display_name`. Nav labels are Game Accounts (`/accounts`) and My Site Profile (`/profile`).

**Site time** is Eastern for everyone. There is no timezone setting on My Site Profile. The clock is Eastern Standard Time (EST, UTC-5), and Eastern Daylight Time (EDT, UTC-4) while daylight saving is in effect (`America/New_York`). Raid dates stored as an offset instant, tic clocks, and the raids calendar use that zone. A date-only raid stays on that calendar date. A new raid with no Discord date stores the current Eastern date and time as an offset instant. Discord raid-line parsing is unchanged.

**Raid Admin settings** sit on My Site Profile, in the same row as Display Name and to its right, and only for `officer` and `siteadmin`. Players do not see the section. The choices belong to the signed-in site user, stored in `profiles.ui_preferences` through `set_my_ui_preferences`. They are not stored on the game account and are not shared by every officer. The checkboxes are "Show full list for Attendance tics" (`showTicCharacterPicker`), "Show full list for Site Admin" (`useCharacterAdminSelectors`), and "Require Discord raid_schedule raid names". Missing keys stay on. For the two list settings, on keeps the full character list; turning one off restores paste-first tic entry or one row per account. The Discord checkbox is the existing `raidNameOnly` setting flipped in the form only: unticked (the default) is name-only entry, ticked is the existing Discord raid-line paste. Raid creation parsing is unchanged. Hovering a checkbox shows the longer description in the same kind of hover card used for items on Character History. Raid Admin, raid detail, and Site Admin read the same profile object. The tic paste, resolutions, and Attending selections for the open raid stay in `sessionStorage` under `pageState:user:<user id>:/officer/RaidAdmin:ticDraft:<raid id>`, so opening Profile and coming back does not drop an unsaved tic. A leftover unscoped draft is moved to the signed-in user once. Signing out removes it. Hiding the attendance list does not clear those selections; Raid Admin lists them and offers Clear selected characters. Active and inactive on Site Admin always change the whole account. The separate "Add one character" form was removed from Raid Admin; adding someone to a tic uses the attendance form above it.

## Data sources (where values come from)

### Supabase (runtime)

Typical tables/RPCs (non-exhaustive; see `docs/supabase-schema-full.sql` for truth):

- **Raids / events / loot / attendance:** `raids`, `raid_events`, `raid_loot`, `raid_attendance`, views like `raid_loot_with_assignment` and `raid_loot_history` (Item History search/sort/paging), RPCs such as `refresh_account_dkp_summary_for_raid`, `delete_raid`, officer audit helpers.
- **Accounts / characters:** `accounts`, `characters`, `character_account`, profile claim RPCs.
- **Leaderboard / summaries:** Used from DKP and account pages via `web/src/lib/dkpLeaderboard.js`, `accountData.js`, and direct queries in pages.

**Client:** `web/src/lib/supabase.js` — missing env vars log a warning and still create a client (requests will fail until configured).

### Static JSON (build / deploy artifacts)

Fetched with `fetch('/…')` from `public/` or CDN:

- Item stats, mob loot, raid item sources: see `getDkpMobLoot`, `getRaidItemSources` in `web/src/lib/staticData.js` and usages in item/raid/officer flows.
- Optional `VITE_CLASS_RANKINGS_URL` or `/class_rankings.json` for officer **Reload coverage** on Raider Activity.
- **Class coverage cache:** table `account_class_coverage` (deploy `docs/sql-archive/superseded/supabase-account-class-coverage.sql`). Refreshed by CI job `class_coverage` (`scripts/build_account_class_coverage.mjs`) in `.github/workflows/loot-to-character.yml`, not on each page load.

`web/vercel.json` sets long cache headers for some JSON paths.

### Browser storage (client-only)

| Mechanism | Key pattern | Purpose |
|-----------|------------|---------|
| `localStorage` | `dkp-last-path:<userId>` | Last visited path for that signed-in user (see below). A legacy unscoped `dkp-last-path` value is deleted and is not copied onto the next user. |
| `localStorage` | `pageState:user:<userId>:…` | `usePersistedState` viewing state: search, filters, expansion, show-more, calendar month, loaded page counts, and personalized drafts. Versioned `{ v, exp, value }`. A legacy session key is moved here once for that user, then deleted. Signing out does not delete the slot. Another user has a different key. |
| `localStorage` | `pageState:user:<userId>:scroll:<pathname>` | Per-route scroll anchor for that user. Account and profile keys include `?tab=`. |
| `localStorage` | `pageState:user:<userId>:/officer/RaidAdmin:ticDraft:<raid id>` | Unsaved tic paste for that officer and raid. A legacy session key is moved here once, then deleted. Never auto-submitted. |
| `localStorage` | `pageState:user:<userId>:/site:ambiance` | Optional visual ambiance: `{ ambianceEnabled, selectedTheme }`. Client-only; does not sync via `ui_preferences`. |
| `sessionStorage` | `account-detail-cache-${accountId}` | SWR fallback for account page. Not the saved view. |
| TTL cache | `raids_month_*` | Raids calendar month blobs (`web/src/lib/cache.js`) |
| TTL cache | `accounts_list_v10` | Accounts list (`web/src/pages/Accounts.jsx`, 10 minutes), sorted by account name ascending. Includes inactive accounts and the Claimed by column from `account_claim_labels()` and Last Raid Date from `account_dkp_summary.last_activity_date` plus every linked character's `dkp_summary.last_activity_date` (the newest date on the account, not the one alt name). The page hides inactive rows unless that viewer’s Show inactive accounts toggle is on (`pageState:user:<userId>:/accounts:showInactive`, default off). The toggle does not write `accounts.inactive`. The page refetches on load and overwrites this key. Character “spent” is loot for that account, same buyer fallback as the account page (assignee, else `character_name`, else `char_id`). It is not the DKP leaderboard total. |

### Refreshing DKP totals

`/dkp` reads earned, spent, balance, and the 30-day and 60-day columns from `account_dkp_summary`, plus `dkp_adjustments`. It does not download `raid_attendance_dkp_by_account`. The “Cached …” time is `account_dkp_summary.updated_at`. Reloading the page, or clearing `sessionStorage` key `dkp_leaderboard_v2`, does not rebuild the summary. `useDkpData` does not read that key.

An officer (`profiles.role = officer`) rebuilds totals from `/dkp` with **Refresh DKP totals**. That calls `refresh_dkp_summary()`, then `refresh_account_dkp_summary()`, then refetches. The account refresh rebuilds `raid_attendance_dkp_by_account` and then rebuilds `account_dkp_summary` from `raid_event_attendance` and the loot buyer. The summary does not copy the per-raid cache. If the account refresh fails, the page shows the error and still refetches whatever is already stored.

Those RPCs allow an officer, `service_role`, or the database roles `postgres` and `supabase_admin`. A null `auth.uid()` is not enough.

```sql
SELECT refresh_dkp_summary();
SELECT refresh_account_dkp_summary();
```

A full rebuild can exceed the API gateway timeout even though the function sets `statement_timeout` to 600s. The SQL editor is the reliable path when the caller is one of the roles above. Deploy `docs/supabase-schema-full.sql` if `refresh_account_dkp_summary` is not in the database.

The account page header uses the same summary totals. If the activity tab’s per-raid cache or loot list disagrees by more than 1, the header shows a warning and does not change the numbers. 30-day and 60-day windows are inclusive (`raid date >= current_date - N`) and move only when a refresh runs; ordinary tic and loot writes update the totals without that button.

## UI state persistence playbook

React Router **unmounts** screens when you navigate away. Any state held only in `useState` is **lost** unless mirrored elsewhere.

### Rules of thumb

User-facing viewing state persists across navigation by default. New pages use `usePersistedState` and the scroll helper unless an exception is written down here. Ordinary navigation is not a reset.

1. **Shareable / primary context** (which raid, which tab on account/profile, an item's open second-place section): prefer the **URL** — `useSearchParams` or path params. A hash or other deep link wins over a saved scroll anchor.
2. **Viewing context** (search, sort, filters, expanded and explicitly collapsed sections, show-more counts, calendar month, loaded page count, display mode): use **`usePersistedState`**. Keys look like `'<logical-path>:<field>'`.
3. **Scroll position:** mark rows with `data-scroll-anchor` and call `useScrollContentReady` from `web/src/lib/routeScrollView.jsx`. The app restorer in `App.jsx` saves a throttled anchor per route for the signed-in user. Do not copy another route's scroll.
4. **Ephemeral** (loading, errors, hover, open dropdowns, in-flight saves): keep **`useState`**. Do not ban `useState`.
5. **Drafts that must not submit themselves** (tic paste, who-parser paste, Discord schedule paste and rows): persist them in that user's local slot so another account on the same browser does not inherit them. Do not persist create-raid paste, loot forms, delete confirms, add-character fields, or loot-assignment drafts — restoring those could be submitted by the next click.
6. **Server data** (SWR, TTL caches, leaderboard rows): refetch. Do not store payloads in view-state keys.

Clearing a search clears only that field. It does not collapse sections or reset unrelated filters.

### `usePersistedState`

- **API:** `const [x, setX] = usePersistedState('key', initialValue, normalize?, options?)`
- **Storage:** `localStorage` key `pageState:user:<userId>:` + your key, wrapped as `{ v, exp, value }` (default version 1, optional `ttlMs`). This survives navigation, reload, a closed tab, and a second tab. Pass `storage: 'session'` only for a value that must die with the tab. `userScope: false` is the shared unscoped slot. Corrupt JSON, a failed `normalize`, an unknown `v`, or a passed `exp` falls back to `initialValue`.
- **Migration:** a legacy session key, unscoped or already scoped to this user, is copied into the local slot once and then deleted. `migrateUnscoped: true` still moves an unscoped value that is already in the same store.
- **Other tabs:** `listenStorage` is on by default for local slots, so another tab's newer write replaces this tab's copy. `mergeWrite(stored, previous, next)` rebases this tab's edit onto a newer stored value instead. An older scroll `savedAt` does not overwrite a newer one. Two open tabs do not live-sync scroll while both stay open; a newly opened tab reads the latest saved anchor.
- **Dynamic keys:** When the key changes (e.g. per `accountId` or `raidId`), the hook reloads that storage slot.
- **Normalize:** Optional third argument. It runs on the parsed value when the slot is read. If it throws, the hook uses `initialValue`.

### Scroll restoration

`web/src/lib/routeScroll.js` and `web/src/lib/routeScrollView.jsx`. While the app is mounted, `history.scrollRestoration` is `manual`.

- Key: `pageState:user:<userId>:scroll:<pathname>` in `localStorage`, plus `?tab=` on account and profile pages. `/dkp` cannot restore `/mobs`. A legacy `pageState:scroll:<pathname>` session record is moved into that user's slot once.
- Value: `{ anchorId, itemId, top, offset, savedAt }`. `offset` is the anchor's position relative to the scrollport. Rows use `data-scroll-anchor` and optional `data-scroll-item`. Item History's virtual list restores `top` inside its scroller (`useScrollPixelMode`).
- The visible route is marked `data-scroll-route`. Scroll events update an in-memory snapshot immediately. Storage is written on a short throttle, on `pagehide` / `visibilitychange`, and when the listener unmounts. Leaving a page writes that snapshot. It does not measure the next page, and it does not replace a saved position with zero when the snapshot was never measured. An older `savedAt` does not overwrite a newer one.
- Restore waits until `useScrollContentReady(true)` and, when an item id was saved, until that item row exists. It then places the anchor at the saved `offset` and keeps it there across layout changes until the user wheels, touches, or presses a key. A missing anchor falls back to the section header, then to the top. A hash (or `useLeaveScrollToPage`, used when an item URL asks for the second-place section) is left to the page.

### Raid Items (`/mobs`)

Search, slot, class, and groups use the same per-user local slot as every other page: `pageState:user:<userId>:/mobs:query`, `filterSlot`, `filterClass`, and `groups`.

Group memory is `pageState:user:<userId>:/mobs:groups` (`web/src/lib/mobLootViewState.js`):

- `expanded[mobKey] === true` means the user opened that mob. `false` means the user closed it. A missing key is not a choice.
- While a slot or class filter is on, a mob with one or two matching items opens for that visit only. That open state is not stored, and it does not override an explicit `false`.
- `itemsShown[mobKey]` is how many loot rows Show more has revealed (20, 40, …). A single mob keeps its JSON key. A merged group is keyed by sorted mob names plus the JSON zones, not the inferred display zone. Older keys still open the group and are moved onto the canonical key.
- A write rebases onto the newest stored revision, so another open tab does not lose its expansion when this tab saves. `rev` counts those writes.
- Clearing the search box clears only the query. Signing out does not delete the slot. Another signed-in user has a different key.

Scroll uses `pageState:user:<userId>:scroll:/mobs`. Changing search, slot, or class drops that user's anchor. Last-3 DKP figures are loaded again and are not part of the saved view.

### Other exploration pages

Those fields use the same per-user local slot: DKP search and sort, raids month, accounts search, the accounts Show inactive accounts toggle, item history query, sort, and loaded page count, character history window, sort, and expanded rows, account activity page and missing-raid toggles (the same activity list on My Site Profile), which missed tics are expanded (`/accounts/detail:{accountId}:showWhichTics`), raid detail expanded tics, raider-activity filters, changelog loaded page count, item elemental class, per-account bidding dates, and Raid Admin expanded tics and raid-picker query. Item History still loads `raid_loot_history` one page at a time; the saved fields are the query and sort, not the result rows. Server rows are still fetched again.

### Intentionally not persisted

Login email, password, and display name. Loading and error flags. Hover cards and open dropdowns. Officer create-raid paste, loot entry, and delete confirmation. Account add-character and display-name editors. In-progress loot assignment on an account. Profile checkbox drafts until they are saved on `profiles.ui_preferences`.

### Last route restore (`dkp-last-path`)

In `web/src/App.jsx`:

- On each navigation (except bare `/login` and `/auth/callback`), the app stores `pathname + search` in `localStorage['dkp-last-path:<userId>']`.
- When the user is signed in and lands on **`/`** the **first time** in that session, the app may `replace` navigate to that user's saved path (`hasRestoredRef` ensures this runs once). **Clicking “Home” later stays on `/`** because the restore effect does not run again.
- An older unscoped `localStorage` or `sessionStorage` key named `dkp-last-path` is removed on that restore and is not given to whoever signs in next.

If a bookmark to `/` unexpectedly jumps elsewhere, this behavior is why.

### Tab focus does not reload the page

Supabase emits `SIGNED_IN` again when a browser tab becomes visible. `App` ignores that event for the user who is already signed in (`web/src/lib/authGate.js`), and it does not query Supabase from inside the auth callback. The route components stay mounted, so in-progress Raid Admin tics, open Raid Items mobs, and open Character History rows stay as they were. SWR hooks also set `revalidateOnFocus` and `revalidateOnReconnect` to false.

### URL query conventions (post–state-audit)

| Screen | Query | Meaning |
|--------|--------|---------|
| `/officer/RaidAdmin` | `raid` | Selected raid for officer editing (synced with dropdown) |
| `/accounts/:accountId` | `tab` | `activity` \| `characters` \| `loot` \| `history` (default: activity; default tab may omit query) |
| `/profile` | `tab` | `activity` \| `characters` |

**History tab charts:** bounded to account raids with earn/tic/loot (not guild absence rows). Default window is last 12 months, clipped to actual activity dates; window selector persisted as `pageState:user:<userId>:/accounts/history:months` (12 / 24 / 36 / all).

**Note:** Top nav `<Link to="/officer/RaidAdmin">` does not preserve `?raid=`; deep links and browser history still do. On a raid page (`/raids/:raidId`), officers and site admins see an **Edit raid** link beside the title that opens `/officer/RaidAdmin?raid=<raidId>`. Activity tab pagination on account pages uses `pageState:/accounts/detail:{accountId}:activityPage` (not the URL).

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

Vercel: set root to **`web`**, add `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_SITE_TITLE`, and `VITE_SITE_ENV` (`production` only on the live site).

## Debugging cheatsheet

| Symptom | Check |
|---------|--------|
| “I left the page and my selection reset” | Is that state only `useState`? Should it be URL or `usePersistedState`? |
| “Switching browser tabs reloads the page” | `App` must ignore a repeat `SIGNED_IN` for the same user. Open sections live in that user's `pageState:user:<userId>:` slot. |
| “Refresh loses everything” | URL params missing for primary context; or only sessionStorage without URL |
| “Landing on `/` sends me somewhere else” | `dkp-last-path` + one-time restore in `App.jsx` |
| “Supabase errors / empty data” | Env vars, RLS policies, user role in `profiles` |
| “Static JSON 404” | File under `web/public/` or deployment artifact path |

**First files to open:** `web/src/App.jsx` (routes, auth), the relevant `web/src/pages/*.jsx`, `web/src/lib/supabase.js`, `web/src/lib/usePersistedState.js`.
