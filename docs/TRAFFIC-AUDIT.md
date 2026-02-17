# Vercel/Supabase Traffic Efficiency Audit

## 1. Over-fetching (select columns)

- **RaidDetail.jsx** – Previously used `.select('*')` for `raids`, `raid_events`, `raid_loot`, and `raid_attendance`. **Fixed:** all four queries now request only the columns used in the UI (e.g. `raid_id, raid_name, date_iso, date, attendees` for raids; explicit fields for events, loot, attendance). This reduces payload size and Supabase/PostgREST work.
- **Other pages** – `AccountDetail`, `CharacterPage`, `ItemPage`, `LootRecipients`, `LootSearch`, `DKP`, `Raids`, and `useCharToAccountMap` already use explicit `.select(...)` lists. No `select('*')` remains in those files.

## 2. Re-fetching on every render or window focus

- **No refetch on window focus** – The app does not listen to `window` focus events to refetch. Data is loaded in `useEffect` when a component mounts.
- **Re-fetch on every visit** – Each time a user navigates to a page (e.g. Raid detail, DKP, Raids), that page’s `useEffect` runs and triggers Supabase requests. There was no request deduplication: two components mounting at the same time (or the same user revisiting a route) could each trigger the same fetch.
- **Mitigation** – SWR (or TanStack Query) is introduced with a 60s deduplication interval so that:
  - Multiple components using the same key share one in-flight request and one cached result.
  - Revisiting a page within the dedupe window reuses cached data and optional revalidation instead of an immediate extra DB hit.

## 3. Caching strategy (implemented)

- **Client-side: SWR** – Used for:
  - **Raid detail** – Key `raid-detail-${raidId}`. Same raid opened twice (or two components for same raid) within 60s share one fetch; stale-while-revalidate after that.
  - **Char-to-account map** – Key `char-to-account-map`. Shared across RaidDetail, AccountDetail, CharacterPage, etc., with 60s deduplication so 100 users each hitting one page don’t each trigger separate character_account/characters/accounts fetches in the same 60s window (per client; see below).
- **Existing sessionStorage** – DKP and Raids pages keep using their existing sessionStorage cache (e.g. `dkp_leaderboard_v2`, `raids_list_v2`) for quick repeat visits. SWR complements this by deduplicating in-flight requests.
- **Note** – This is a Vite/React SPA, not Next.js. There is no server-side data cache (no `unstable_cache` or `force-cache`). To get “100 users → 1 DB hit” you’d need either:
  - A Next.js app with server components and `unstable_cache` (or similar) around Supabase calls, or
  - A small backend/edge function that caches Supabase responses (e.g. 5-minute revalidate) and that the SPA calls instead of Supabase directly.

## 4. Images and static assets (egress)

- **Item stats / icons** – Item data and links come from:
  - **`/item_stats.json`** – Static file in `web/public/`, served by Vercel. Caching is controlled by Vercel (and any CDN). Not Supabase.
  - **TAKP external URLs** – e.g. `https://www.takproject.net/allaclone/item.php?id=...`. No Supabase Storage or Vercel egress for these.
- **Supabase Storage** – Not used for images or item icons in this app. No change needed for cache-control on Supabase Storage.
- **Recommendation** – If you later add Supabase Storage for images, use the Supabase public URL and set appropriate cache-control (e.g. long-lived) so browsers/CDNs cache and you don’t pull through Vercel repeatedly.

## Summary

| Item | Status |
|------|--------|
| Replace `select('*')` with explicit columns | Done in RaidDetail |
| Avoid refetch on every render | No render-triggered refetch; SWR dedupes in-flight requests |
| Deduplication (e.g. 60s) for same query | SWR with 60s deduplication for raid detail and char-to-account map |
| Caching (SWR / React Query) | SWR added for raid detail and char-to-account map |
| Images via Vercel/Supabase | Item assets from static JSON + external TAKP; no Supabase Storage |

## Implementation summary

- **RaidDetail.jsx**: All four Supabase queries now use explicit column lists; main data fetch uses `useSWR` with key `raid-detail-${raidId}` and 60s `dedupingInterval`. After officer mutations (edit DKP, edit time, edit cost, delete loot, add to tic) the code calls `mutate()` to revalidate.
- **useCharToAccountMap.js**: Refactored to `useSWR` with key `char-to-account-map` and 60s `dedupingInterval`; `revalidateOnFocus: false` to avoid refetch on tab focus.
- **Item stats / icons**: Served from `web/public/item_stats.json` (Vercel) and external TAKP URLs; no Supabase Storage. If you add Supabase Storage later, use the public URL and set long-lived cache-control headers so assets are cached and don’t count against Vercel egress on every request.
