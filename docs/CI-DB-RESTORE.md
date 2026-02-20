# Restore Supabase from a backup artifact

Use this when you need to **restore the database** from a previous backup (e.g. after a bad migration or data issue). Restore runs as a **manual GitHub Action** and loads a backup artifact into your Supabase project.

## Prerequisites

1. **Backup artifact** – At least one successful run of [DB backup (on change)](../.github/workflows/db-backup.yml) so an artifact exists (e.g. `supabase-backup-2025-02-19` or a weekly/monthly one).
2. **Database connection secret** – Supabase direct Postgres URL in GitHub secrets (see below).

## GitHub secret: `SUPABASE_DB_URL`

Restore uses a **direct Postgres connection** (not the REST API). Add this secret in **Settings → Secrets and variables → Actions**:

| Secret | Value |
|--------|--------|
| **`SUPABASE_DB_URL`** | Direct connection URI from Supabase Dashboard |

**How to get it:**

1. Supabase Dashboard → your project → **Project Settings** → **Database**.
2. Under **Connection string**, choose **URI**.
3. Copy the string; it looks like:
   ```text
   postgresql://postgres.[PROJECT-REF]:[YOUR-PASSWORD]@db.[PROJECT-REF].supabase.co:5432/postgres
   ```
4. Replace `[YOUR-PASSWORD]` with your **database password** (from the same page).
5. If the UI shows a placeholder like `[YOUR-PASSWORD]`, use the password you set when creating the project (or reset it under Database settings).
6. Add `?sslmode=require` if your client expects it:
   ```text
   postgresql://postgres.xxx:password@db.xxx.supabase.co:5432/postgres?sslmode=require
   ```
7. Paste the full URI as the value of **`SUPABASE_DB_URL`** in GitHub Actions secrets.

**Security:** This URL contains the DB password. Restrict repo access and only run restore when necessary.

## Running a restore (GitHub Actions)

1. Go to **Actions** → **DB restore from backup**.
2. Click **Run workflow**.
3. Choose **Branch** (usually `main`).
4. **Artifact name** – Either:
   - Leave as **`latest`** (default) to restore from the most recent backup artifact, or
   - Paste a specific name (e.g. `supabase-backup-2026-02-20`). The first step of the job lists all available backup artifacts in the run summary—if you want an older backup, run once with `latest`, open the run, copy a name from the "List backup artifacts" step, then re-run with that name.
5. **Include profiles** – Leave unchecked unless you intend to overwrite the `profiles` table (auth-related). Default is to restore only DKP data tables and skip `profiles`.
6. Click **Run workflow**.

The job will:

- **List backup artifacts** – Fetches backup artifact names from the repo and shows them in the step summary (so you can copy a name for a future run).
- Resolve **latest** to the most recent artifact name, or use the name you entered.
- Download the chosen artifact from the DB backup workflow.
- Extract the `backup/` directory of CSVs.
- Truncate the relevant tables (see `docs/supabase-restore-truncate.sql`).
- Load each CSV into Supabase via Postgres `COPY`.

After a successful restore, run in **Supabase SQL Editor** if you use the DKP cache:

```sql
SELECT refresh_dkp_summary();
SELECT refresh_all_raid_attendance_totals();
```

Or use the **Refresh DKP totals** button on the DKP page (officers only).

## Running restore locally

If you have the backup directory (e.g. from downloading and extracting an artifact yourself):

```bash
# From repo root
export SUPABASE_DB_URL='postgresql://postgres.xxx:password@db.xxx.supabase.co:5432/postgres?sslmode=require'
pip install psycopg2-binary
python scripts/restore_supabase_from_backup.py --backup-dir backup
# Optional: --include-profiles to restore profiles table as well
```

## What gets restored

- All tables exported by `export_supabase_public_tables.py`: characters, accounts, character_account, raids, raid_events, raid_loot, raid_attendance, raid_event_attendance, raid_dkp_totals, raid_attendance_dkp, raid_classifications, dkp_adjustments, dkp_summary, dkp_period_totals, active_raiders, officer_audit_log.
- **profiles** only if you pass `--include-profiles` (or check **Include profiles** in the workflow).

Backups do **not** include `character_loot_assignment_counts`. If you use loot-to-character, repopulate that table after restore (e.g. run the loot-to-character workflow or import from CSV if you have it).
