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

### How restore clears tables

The restore script **always uses the `truncate_dkp_for_restore()` RPC** (defined in **`docs/supabase-schema.sql`**) to clear DKP data tables. Truncate is one fast call; then the job loads from CSV. No manual SQL step.

**Load-only:** To skip the clear phase (e.g. you already truncated in Supabase), run the workflow with **Truncate already run in Supabase (load only)** set to **true**.

### Run a restore

1. Go to **Actions** → **DB restore from backup**.
2. Click **Run workflow**.
3. Choose **Branch** (usually `main`).
4. **Artifact name** – `latest` or paste a name from the list shown in the first step.
5. Leave **Truncate already run in Supabase (load only)** **unchecked**.
6. Click **Run workflow**.

The job will:

- **List backup artifacts** – Fetches backup artifact names and shows them in the step summary.
- Resolve **latest** or use the name you entered.
- Download the chosen artifact and extract the `backup/` directory of CSVs.
- **Clear** DKP data tables via `truncate_dkp_for_restore()` RPC (in main schema), call **begin_restore_load()** so DKP triggers skip during insert, **insert** rows from each CSV via the API, then **end_restore_load()** to refresh DKP summary and raid totals once.

### How long it takes

- **Load only** (after running the truncate SQL in Supabase): about **1–2 minutes per 100k rows** for the load phase only → **~5–12 minutes** for ~330k rows.
- **Normal restore** (RPC truncate + load): clear is one fast RPC call; load about **1–2 min per 100k rows** → **~5–12 minutes** for ~330k rows.

Progress is logged every 5,000 rows. If the same line hasn’t changed for 15+ minutes, the run may be stuck.

After a successful restore, run in **Supabase SQL Editor** if you use the DKP cache:

```sql
SELECT refresh_dkp_summary();
SELECT refresh_all_raid_attendance_totals();
```

Or use the **Refresh DKP totals** button on the DKP page (officers only).

### Reclaim space after restore (if DB size grew)

Restore does many DELETEs then INSERTs; PostgreSQL keeps dead row versions until **VACUUM** runs. If your database size grew (e.g. doubled), run in SQL Editor to reclaim space and update stats:

```sql
VACUUM ANALYZE;
```

This runs on the whole database and may take a minute. Supabase also runs autovacuum, but a manual run right after a restore can bring size back down quickly. For a one-time aggressive reclaim (rewrites tables, brief lock), you can run `VACUUM FULL ANALYZE;` during low traffic—otherwise `VACUUM ANALYZE;` is enough.

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
