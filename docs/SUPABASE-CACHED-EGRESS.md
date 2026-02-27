# Supabase Cached vs Uncached Egress

## Why you see 0 GB cached egress

Supabase counts **cached egress** only when traffic is **served from their CDN** (cache hit). In practice:

- **PostgREST (Database API)** — All your current usage is this. Every request is dynamic and auth-dependent, so Supabase does **not** cache these responses at the edge. → **100% uncached** from Supabase’s perspective.
- **Storage** — All Storage traffic goes through a CDN. When the same object is requested again, the CDN can serve it (cache HIT) → that egress counts as **cached**. (Smart CDN with auto-invalidation is Pro+ only.)
- **Edge Functions** — Can be cached only if you set cache headers and the platform respects them; typically dynamic.
- **Auth / Realtime** — Dynamic; uncached.

Your client-side caching (sessionStorage, `createCache`, SWR, etc.) **reduces how often** you call Supabase, so it **lowers total egress**. It does **not** change the split: when a request does hit Supabase, it’s still PostgREST → uncached.

So: to get **cached** egress, you need traffic that goes through **Storage** (or another CDN-cached path), not PostgREST.

---

## Options to split egress (cached vs uncached)

### 1. Serve some read-only data from Storage (recommended way to get cached egress)

Use a **public Storage bucket** for data that:

- Is read-heavy and same for many users (e.g. raid list by month, raid classifications, character list).
- Can be eventually consistent (e.g. updated every 5–15 minutes by a job).

Flow:

1. **Export job** (cron or on-demand): Query PostgREST or DB, write JSON (e.g. `raids/2026-02.json`, `raid_classifications.json`) to a **public** bucket. Use `cacheControl` on upload if you want (e.g. `max-age=900` for 15 min).
2. **Client**: For list/calendar views, **first** try to fetch from the Storage public URL (e.g. `https://<project>.supabase.co/storage/v1/object/public/cache/raids/2026-02.json`). Same URL for all users → CDN can cache → subsequent hits = **cached egress**. If the file is missing or you need fresher data, fall back to PostgREST.

Result: Part of your egress moves from **Database (uncached)** to **Storage**. After the first request per object, repeat requests are CDN cache hits → **cached egress**. Free plan: Storage still uses a CDN (Smart CDN with 60s invalidation is Pro+).

### 2. Pro plan + Smart CDN

If you upgrade to Pro:

- **Smart CDN** for Storage is on by default: cache invalidation when objects are updated/deleted (within ~60s).
- Same pattern as above (export to Storage, client fetches from Storage URL) gives you better cache hit rates and clearer cached egress.
- Quotas: 250 GB uncached + 250 GB cached; overage $0.09/GB uncached, $0.03/GB cached.

### 3. What you cannot do

- **Cache PostgREST at Supabase** — There is no built-in “cache this GET at the edge” for the Database API. So you cannot turn existing PostgREST traffic into cached egress without changing where the data is served from (e.g. Storage).
- **Your own CDN in front** — Putting Cloudflare (or similar) in front of your app caches at Cloudflare; egress from Supabase to Cloudflare is still **uncached** in Supabase billing.

---

## Implementation sketch: cacheable reads via Storage

If you want to try option 1:

1. **Bucket**: Create a **public** bucket, e.g. `cache` or `exports`.
2. **Export script** (Node or backend):
   - Query `raids` + `raid_events` + `raid_classifications` (e.g. by month) via Supabase client or SQL.
   - Upload JSON to paths like `raids/{year}-{month}.json` with `cacheControl: 'max-age=900'` (or similar).
   - Run on a schedule (e.g. every 15 min) or via a webhook after raid updates.
3. **Client** (e.g. Raids.jsx):
   - Build the same path `raids/{year}-{month}.json`.
   - Try `fetch(storagePublicUrl)` first. If 200 and valid JSON, use it and avoid PostgREST for that month.
   - On 404 or error, fall back to current PostgREST `fetchOneMonth`.
   - Optional: keep your existing sessionStorage cache so you still avoid repeated network calls when the user flips months.

This shifts a portion of reads from PostgREST to Storage; that Storage traffic can then show up as cached egress once the CDN has the object.

---

## Summary

| Source of egress        | Can be cached by Supabase? | How to get cached egress |
|-------------------------|----------------------------|---------------------------|
| PostgREST (current use) | No                         | Move reads to Storage (see above). |
| Storage (public files)   | Yes (CDN)                  | Serve cacheable JSON (or other assets) from a public bucket. |
| Edge Functions          | Depends on response headers| Not primary for this. |

Your client-side caching already minimizes total egress; to actually **split** egress into cached vs uncached, you need to serve some of that data from **Storage** so it can be delivered from the CDN and counted as cached egress.
