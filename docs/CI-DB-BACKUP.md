# CI database backup (on change, tiered artifacts)

Backup runs only when data has changed (e.g. after raids). Artifacts are split into: **rolling** (~last 3), **weekly**, and **monthly**, so storage stays small and you keep both recent and longer-term copies.

## Backup size estimation (one-time)

To measure your actual backup size before relying on CI:

### Option A: Script using web app env (no pg_dump)

Uses the same Supabase access as the web app (reads from **web/.env.local** or **web/.env**).

```bash
# From repo root; ensure web/.env.local has VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
pip install -r requirements.txt
python estimate_backup_size.py
```

The script loads `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from `web/.env.local` (or `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` from root `.env`), connects via the REST API, and estimates size from row counts and sample row sizes. For full counts under RLS, put the service role key in `web/.env.local` as `VITE_SUPABASE_SERVICE_ROLE_KEY` (do not commit it). Output includes estimated uncompressed and gzipped backup size.

### Option B: Supabase Dashboard (logical backup)

1. **Supabase Dashboard** → your project → **Database** → **Backups**.
2. If your plan has **Point-in-Time Recovery (PITR)** or physical backups only, the dashboard may not offer a “Download” for logical backups. Use Option A or C instead.
3. If you see a **Download** for a daily backup, download it and check the file size (likely compressed).

### Option C: `pg_dump` locally

1. **Get the DB connection string**  
   Dashboard → **Project Settings** → **Database** → **Connection string** → **URI** (Session mode). Example:
   ```text
   postgresql://postgres.[PROJECT_REF]:[YOUR-PASSWORD]@aws-0-[region].pooler.supabase.com:5432/postgres
   ```
2. **Install PostgreSQL client** (e.g. `pg_dump`), then:
   ```bash
   pg_dump "CONNECTION_URI?sslmode=require" -n public -f backup.sql
   gzip -k backup.sql
   ```
3. **Check** `backup.sql.gz` size. Typical for this DKP DB: **~1–15 MB** gzipped (often ~5 MB). Use that for the estimates below.

---

## How the CI backup works

- **Workflow:** [`.github/workflows/db-backup.yml`](../.github/workflows/db-backup.yml)
- **Schedule:** Runs once per day (e.g. 07:00 UTC).
- **When it backs up:** Compares current `raid_loot` row count (from Supabase) to the count stored at last backup (in `.ci/last_backup_trigger_count.txt`). If the count changed (or no previous backup), it runs a full backup; otherwise it skips. With ~3 raids per week, you get about **3 backups per week**, not 7.
- **What it does when backing up:**
  1. `pg_dump -n public` (schema + data; no `auth` schema), then gzip.
  2. **Rolling:** Uploads `supabase-backup-YYYY-MM-DD` with **retention-days: 7** → keeps roughly the last 3 backups (3 per week).
  3. **Weekly:** If this is the first backup of the calendar week, uploads `supabase-backup-weekly-YYYY-Www` with **retention-days: 90**.
  4. **Monthly:** If this is the first backup of the month, uploads `supabase-backup-monthly-YYYY-MM` with **retention-days: 90**.
  5. Updates `.ci/last_backup_trigger_count.txt`, `.ci/last_weekly_backup_week.txt`, and `.ci/last_monthly_backup_month.txt` and pushes so the next run knows whether to backup and whether to emit weekly/monthly.

### Required secrets

| Secret | Purpose |
|--------|--------|
| `SUPABASE_URL` | Used with service role key to fetch `raid_loot` count (change check). |
| `SUPABASE_SERVICE_ROLE_KEY` | Same as above. |
| `SUPABASE_DATABASE_URL` | Postgres connection URI (Session mode) for `pg_dump`. Dashboard → **Database** → **Connection string** → **URI**. |

If `SUPABASE_DATABASE_URL` is unset, the workflow skips the backup so CI still passes (e.g. on forks).

---

## Size estimate for this approach

Assume **~5 MB** per gzipped backup (use your own number from Option B if different).

| Tier | What’s kept | Retention | Approx. count | Approx. size |
|------|----------------------------|------------|----------------|---------------|
| **Rolling** | One per backup run (~3/week) | 7 days | ~3 | **~15 MB** |
| **Weekly** | First backup of each week | 90 days | ~13 | **~65 MB** |
| **Monthly** | First backup of each month | 90 days | ~3 | **~15 MB** |
| **Total** | | | | **~95 MB** |

So total artifact usage stays well under the 500 MB (Free) or 1–2 GB (Pro/Team) limits. If you increase monthly retention (e.g. to 1 year), add ~9 more monthly backups × 5 MB ≈ 45 MB.

---

## GitHub Actions artifact storage (per repo)

| Plan | Artifact storage |
|------|-------------------|
| Free | 500 MB |
| Pro | 1 GB |
| Team | 2 GB |
| Enterprise | 50 GB |

With the tiered strategy above, you use a small fraction of that.

---

## Restore from a backup

1. In **Actions** → select the workflow run → **Artifacts**, download the `.sql.gz` you need (rolling, weekly, or monthly).
2. Decompress: `gunzip backup-YYYY-MM-DD.sql.gz` (or keep `.gz` and use `psql` with a pipe).
3. Restore (destructive; replace `public` content as needed):
   ```bash
   psql "YOUR_DATABASE_URL" -f backup-YYYY-MM-DD.sql
   ```
   For a fresh project, apply `docs/supabase-schema.sql` first if the dump doesn’t create schema, then load the dump.

---

## Summary

- **Estimate size:** One-time `pg_dump -n public` + gzip (or Supabase backup download) gives per-backup size (~5 MB typical).
- **Conditional backup:** CI runs daily but only backs up when `raid_loot` count has changed (~3 runs per week with 3 raids).
- **Tiered artifacts:** Rolling (~3, 7-day retention), weekly (90-day), monthly (90-day) → total **~95 MB** typical.
