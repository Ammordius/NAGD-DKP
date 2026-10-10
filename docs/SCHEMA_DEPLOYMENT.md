# Schema and triggers: single source of truth

This document is the **canonical reference** for standing up or mirroring the DKP Supabase database.

**Deploy: run one file.** **[docs/supabase-schema-full.sql](supabase-schema-full.sql)** in the Supabase SQL Editor after creating a project. It is the whole schema: tables, RLS, triggers, account DKP, officer raid writes, upload RPCs, bidding portfolio, loot assignment, `character_dkp_spent`, raider activity, and class coverage.

**See also:** [SCHEMA_RPC_INDEX.md](SCHEMA_RPC_INDEX.md) — where app and script RPCs are defined. [SCHEMA_AUDIT.md](SCHEMA_AUDIT.md) — live database vs these files. [DKP_TRIGGERS_AND_STORAGE_AUDIT.md](DKP_TRIGGERS_AND_STORAGE_AUDIT.md) — how triggers and cache tables work.

---

## 1. Required SQL

| File | Purpose |
|------|---------|
| **docs/supabase-schema-full.sql** | **Run this once.** Tables, RLS, triggers, `refresh_dkp_summary`, `refresh_account_dkp_summary`, officer raid RPCs, upload RPCs, bidding portfolio, `loot_assignment` plus `update_single_raid_loot_assignment` / `update_raid_loot_assignments` / `get_character_dkp_spent`, `officer_raider_activity`, and `account_class_coverage`. |

After that file you have:

- Core tables, triggers, and the DKP leaderboard
- Officer raid UI (add raid/tic/loot, delete raid/tic)
- Restore/backup flow (`begin_restore_load` / `end_restore_load` / `truncate_dkp_for_restore`)
- Upload script support (`delete_raid_for_reupload`, `insert_raid_event_attendance_for_upload`)
- Loot assignment, Character History spent, raider activity, and class coverage

Edit `docs/supabase-schema-full.sql` when the schema changes. These files are historical sources and must not be applied on top of the full file: `supabase-loot-to-character.sql`, `supabase-loot-assignment-table.sql`, `supabase-officer-raider-activity.sql`, `supabase-account-class-coverage.sql`, `supabase-account-dkp-schema.sql`, `supabase-officer-raids.sql`, `upload_script_rpcs.sql`. **`docs/supabase-schema.sql` is not in the repo.**

Re-running `supabase-schema-full.sql` replaces functions (`CREATE OR REPLACE`) and adds columns that use `ADD COLUMN IF NOT EXISTS`. If `raid_loot` still has old `assigned_*` columns, the file copies them into `loot_assignment` and drops them.

---

## 2. Optional SQL (not required for the web app)

| File | When to run |
|------|-------------|
| **docs/supabase-update-event-times-rpc.sql** | Only if you run `scripts/pull_parse_dkp_site/update_supabase_event_times.py` (`update_raid_event_times`). |
| **docs/supabase-github-worker-role.sql** | Custom role for CI/direct DB (optional; CI usually uses the service_role key). |
| **docs/supabase-officer-audit-log.sql** | Only if `officer_audit_log` or its policies are missing. The table is already created by `supabase-schema-full.sql`. |
| **docs/supabase-create-my-account-rpc.sql** | Standalone copy of `create_my_account`. Already in `supabase-schema-full.sql`. Do not run it on a fresh deploy. |
| **docs/supabase-anon-read-policies.sql** | Re-opens anon read. Do not run this for a normal deploy. Core tables are authenticated-only. `supabase-schema-full.sql` still creates anon SELECT on `loot_assignment` and `character_dkp_spent`; see section 4 if you want those dropped. |

Do **not** run `docs/supabase-reset-and-import.sql` during initial setup; it truncates data and is for re-imports.

Magelo assignment **data** (dumps, `assign_loot_to_characters.py`, CI) is separate from `supabase-schema-full.sql`. The assignment RPCs are already in that file.

---

## 3. Getting the exact schema from the database

To compare the live DB to the repo (e.g. after applying fixes or to document “what’s actually there”), dump the schema from the running project.

### Option A: Supabase CLI (recommended)

Requires [Supabase CLI](https://supabase.com/docs/guides/cli) and either a linked project or the DB URL.

**Linked project:**

```bash
cd /path/to/dkp
supabase link --project-ref YOUR_PROJECT_REF
supabase db dump -f docs/dumped_schema.sql
```

**Direct connection string** (from Supabase Dashboard → Project Settings → Database → Connection string, “URI”; use the **session** pooler for full schema):

```bash
supabase db dump --db-url "postgresql://postgres.[ref]:[YOUR_PASSWORD]@aws-0-[region].pooler.supabase.co:5432/postgres" -f docs/dumped_schema.sql
```

To restrict to the `public` schema only:

```bash
supabase db dump --db-url "..." -f docs/dumped_schema_public.sql -s public
```

The CLI runs `pg_dump` with Supabase-specific exclusions (auth, storage, etc.) and is the supported way to get a clean schema.

### Option B: Raw pg_dump

If you don’t use the CLI, use the same connection string (Session mode, port 5432) and run:

```bash
pg_dump "postgresql://postgres.[ref]:[PASSWORD]@aws-0-[region].pooler.supabase.co:5432/postgres" \
  --schema=public \
  --no-owner \
  --no-privileges \
  -f docs/dumped_schema_public.sql
```

For **schema only** (no data), add `--schema-only`. For **triggers and functions** you want the default dump (includes CREATE TRIGGER and CREATE FUNCTION). To compare triggers only:

```bash
pg_dump "..." --schema=public --no-owner --no-privileges --schema-only -f schema_only.sql
```

Then diff `docs/dumped_schema_public.sql` (or `schema_only.sql`) against `docs/supabase-schema-full.sql`.

### Option C: List triggers and functions in SQL Editor

You **cannot** run `pg_dump` in the SQL Editor — the Editor runs only SQL, and `pg_dump` is a separate client. So you cannot produce a full schema dump file from the Dashboard alone; use Option A or B for that.

You **can** run the following in the Supabase **SQL Editor** to list what’s actually in the DB. Use the result to verify that the required triggers and RPCs are present (or to compare with another environment). Export the result from the Editor (e.g. Download as CSV) if you want to keep it.

```sql
-- Schema inventory for public schema (run in SQL Editor)
-- Tables
SELECT 'table' AS kind, c.relname AS name, '' AS extra
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relname LIKE 'pg_%'
ORDER BY c.relname;

-- Functions (RPCs)
SELECT 'function' AS kind, p.proname AS name, pg_get_function_arguments(p.oid) AS extra
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
ORDER BY p.proname;

-- Triggers
SELECT 'trigger' AS kind, t.tgname AS name, c.relname AS table_name
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND NOT t.tgisinternal
ORDER BY c.relname, t.tgname;

-- RLS policies
SELECT 'policy' AS kind, pol.polname AS name, c.relname AS table_name
FROM pg_policy pol
JOIN pg_class c ON c.oid = pol.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
ORDER BY c.relname, pol.polname;
```

To get a single result set you can export, use:

```sql
SELECT 'table' AS kind, c.relname AS name, '' AS extra
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relname LIKE 'pg_%'
UNION ALL
SELECT 'function', p.proname, pg_get_function_arguments(p.oid)
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
UNION ALL
SELECT 'trigger', t.tgname || ' ON ' || c.relname, ''
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND NOT t.tgisinternal
UNION ALL
SELECT 'policy', pol.polname || ' ON ' || c.relname, ''
FROM pg_policy pol
JOIN pg_class c ON c.oid = pol.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
ORDER BY kind, name;
```

Then diff the exported list against what **docs/supabase-schema-full.sql** creates (see SCHEMA_RPC_INDEX).

---

## 4. One-off / fix SQL (run only when needed)

These are not part of the standard deploy; run only for the stated situation.

| File | When to run |
|------|-------------|
| **docs/fix_event_attendance_delete_trigger_statement_level.sql** | Existing DB that had the old per-row DELETE trigger on `raid_event_attendance` (causing timeouts). New deploys from `supabase-schema-full.sql` already have the statement-level trigger. |
| **docs/fix_refresh_dkp_summary_includes_account_summary.sql** | DB has `account_dkp_summary` but not `refresh_account_dkp_summary_for_raid`. Superseded by `supabase-schema-full.sql`. |
| **docs/supabase-account-dkp-migration.sql** | One-time migration to backfill `account_id` and populate `account_dkp_summary`. Do not run on a fresh deploy. Leftover functions (`run_account_dkp_migration*`, `clear_restore_load`, `refresh_raid_attendance_totals_batch`) may still exist on an already-migrated database; leave them. |
| **docs/supabase-require-auth-remove-anon-read.sql** | Drops anon SELECT, including on `loot_assignment` and `character_dkp_spent`. `supabase-schema-full.sql` recreates those two policies. Run this after the full file if you want authenticated-only reads on those tables. Not applied automatically. |
| **docs/drop-officer-bid-forecast.sql** | Drops retired `officer_global_bid_forecast` and `officer_loot_bid_forecast_v2`. Those functions are not in `supabase-schema-full.sql` and are not routed in the app. |

**Superseded:** **docs/delete_raid_for_reupload_rpc.sql** — use **docs/upload_script_rpcs.sql** or run **docs/supabase-schema-full.sql** (which includes it).

---

## 5. Checklist: mirror or new deploy

- [ ] Run **docs/supabase-schema-full.sql** once in the SQL Editor
- [ ] After loading data: run `SELECT refresh_dkp_summary();` and `SELECT refresh_all_raid_attendance_totals();` and `SELECT refresh_account_dkp_summary();`
- [ ] Promote one user to officer: `UPDATE profiles SET role = 'officer' WHERE id = 'USER_UUID';`

If anything fails, compare with the live schema using section 3 and fix the repo SQL or apply the missing object (trigger/RPC) from the dump.
