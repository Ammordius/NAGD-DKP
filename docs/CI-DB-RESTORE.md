# Restore Supabase from a backup artifact

Use this when you need to **restore DKP data** from a previous backup (e.g. after a bad migration or data issue). Restore runs as a **manual GitHub Action** and loads a backup artifact into your Supabase project.

**Authentication and accounts are never touched**—only DKP data tables (characters, raids, loot, attendance, etc.). The `profiles` table and `auth.users` are left unchanged.

## Prerequisites

1. **Backup artifact** – At least one successful run of [DB backup (on change)](../.github/workflows/db-backup.yml) so an artifact exists (e.g. `supabase-backup-2025-02-19` or a weekly/monthly one).
2. **Supabase API secrets** – Same as the backup workflow (see below).

## GitHub secrets (same as DB backup)

Restore uses the **Supabase REST API** with the same secrets as the backup workflow. No database password or Postgres URI needed.

| Secret | Value |
|--------|--------|
| **`SUPABASE_URL`** | Your project URL, e.g. `https://ynvwtvphqsevhpytcugj.supabase.co` |
| **`SUPABASE_SERVICE_ROLE_KEY`** | Service role key from Supabase Dashboard → **Project Settings** → **API** (under "Project API keys", the **service_role** secret key) |

Add both in **Settings → Secrets and variables → Actions**. The backup workflow already uses these; restore uses them to clear tables and insert rows via the API.

## Running a restore (GitHub Actions)

1. Go to **Actions** → **DB restore from backup**.
2. Click **Run workflow**.
3. Choose **Branch** (usually `main`).
4. **Artifact name** – Either:
   - Leave as **`latest`** (default) to restore from the most recent backup artifact, or
   - Paste a specific name (e.g. `supabase-backup-2026-02-20`). The first step of the job lists all available backup artifacts in the run summary—if you want an older backup, run once with `latest`, open the run, copy a name from the "List backup artifacts" step, then re-run with that name.
5. Click **Run workflow**.

The job will:

- **List backup artifacts** – Fetches backup artifact names from the repo and shows them in the step summary (so you can copy a name for a future run).
- Resolve **latest** to the most recent artifact name, or use the name you entered.
- Download the chosen artifact from the DB backup workflow.
- Extract the `backup/` directory of CSVs.
- Clear existing rows in **DKP data tables only** via the API (child tables first). Profiles and auth are never touched.
- Insert rows from each CSV into those tables via the API (same credentials as backup).

### How long it takes

Restore time is driven by **total row count** and **API latency** (GitHub runner ↔ Supabase). The script does about **6 API calls per 1,000 rows** (clear: 2 calls per 500 rows; load: 1 call per 500 rows). At ~200–300 ms per call, that’s about **1–2 minutes per 100k rows**.

| Total rows (all tables) | Typical run time |
|-------------------------|------------------|
| ~50k                    | 1–3 min          |
| ~100k–150k              | 3–6 min          |
| ~200k–300k              | 6–12 min         |
| ~500k+                  | 15–25 min        |

Progress is logged every 5,000 rows so you can see it moving. If the same line hasn’t changed for 15+ minutes, the run may be stuck.

After a successful restore, run in **Supabase SQL Editor** if you use the DKP cache:

```sql
SELECT refresh_dkp_summary();
SELECT refresh_all_raid_attendance_totals();
```

Or use the **Refresh DKP totals** button on the DKP page (officers only).

## Running restore locally

If you have the backup directory (e.g. from downloading and extracting an artifact yourself):

```bash
# From repo root (same env as backup workflow)
export SUPABASE_URL='https://your-project.supabase.co'
export SUPABASE_SERVICE_ROLE_KEY='your-service-role-key'
pip install -r requirements.txt
python scripts/restore_supabase_from_backup.py --backup-dir backup
```

## What gets restored

Only **DKP data tables** are cleared and reloaded: characters, accounts, character_account, raids, raid_events, raid_loot, raid_attendance, raid_event_attendance, raid_dkp_totals, raid_attendance_dkp, raid_classifications, dkp_adjustments, dkp_summary, dkp_period_totals, active_raiders, officer_audit_log. **Profiles and auth are never touched.**

Backups do **not** include `character_loot_assignment_counts`. If you use loot-to-character, repopulate that table after restore (e.g. run the loot-to-character workflow or import from CSV if you have it).
