# Schema and triggers: single source of truth

This document is the **canonical reference** for standing up or mirroring the DKP Supabase database.

**Deploy: run one file.** **[docs/supabase-schema-full.sql](supabase-schema-full.sql)** — single SQL file. Run it once in the Supabase SQL Editor after creating a project. It contains all tables, RLS, triggers, account DKP, officer writes, and upload script RPCs. No other SQL files are required for a working deploy.

**See also:** [SCHEMA_RPC_INDEX.md](SCHEMA_RPC_INDEX.md) — index of every RPC and where it’s defined. [DKP_TRIGGERS_AND_STORAGE_AUDIT.md](DKP_TRIGGERS_AND_STORAGE_AUDIT.md) — how triggers and cache tables work.

---

## 1. Required: single schema file

| File | Purpose |
|------|---------|
| **docs/supabase-schema-full.sql** | **Run this once.** Creates everything: tables, RLS, triggers, `refresh_dkp_summary`, `refresh_account_dkp_summary`, `refresh_account_dkp_summary_for_raid`, `end_restore_load`, `truncate_dkp_for_restore`, officer RLS and `delete_raid` / `delete_tic`, `delete_raid_for_reupload`, `insert_raid_event_attendance_for_upload`. |

After running it you have:

- All tables and triggers
- Leaderboard (account DKP) and character DKP
- Officer UI (add raid/tic/loot, delete raid/tic)
- Restore/backup flow (`begin_restore_load` / `end_restore_load` / `truncate_dkp_for_restore`)
- Upload script support (`delete_raid_for_reupload`, `insert_raid_event_attendance_for_upload`)

*The single file is generated from the split files in `docs/` (supabase-schema.sql, supabase-account-dkp-schema.sql, supabase-officer-raids.sql, upload_script_rpcs.sql) for maintenance; you do not need to run those separately.*

---

## 2. Optional SQL (only if you use those features)

| File | When to run |
|------|-------------|
| **docs/supabase-loot-to-character.sql** | Loot-to-character assignment (Magelo), `update_raid_loot_assignments`, columns on `raid_loot` for assignment |
| **docs/supabase-loot-assignment-table.sql** | Split: `loot_assignment` table + views + RPCs. Run **after** supabase-loot-to-character if you had assignment columns on `raid_loot`; otherwise account-dkp-schema already created a stub `loot_assignment` and this file adds views and migration from `raid_loot`. |
| **docs/supabase-github-worker-role.sql** | Custom role for CI/direct DB (optional; CI usually uses service_role key) |
| **docs/supabase-officer-audit-log.sql** | Audit log table/policies (often already in main schema) |
| **docs/supabase-create-my-account-rpc.sql** | Standalone add-on for `create_my_account` (already in supabase-schema.sql) |
| **docs/supabase-anon-read-policies.sql** | Only if you need to re-apply anon read; main schema uses authenticated-only by default |

Do **not** run `docs/supabase-reset-and-import.sql` during initial setup; it truncates data and is for re-imports.

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

Then diff `docs/dumped_schema_public.sql` (or `schema_only.sql`) against the repo’s `docs/supabase-schema.sql` and related files to see drift.

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
| **docs/fix_event_attendance_delete_trigger_statement_level.sql** | Existing DB that had the old per-row DELETE trigger on `raid_event_attendance` (causing timeouts). New deploys from supabase-schema.sql already have the statement-level trigger. |
| **docs/fix_refresh_dkp_summary_includes_account_summary.sql** | DB has `account_dkp_summary` but not `refresh_account_dkp_summary_for_raid`. Superseded if you run full supabase-account-dkp-schema.sql. |
| **docs/supabase-account-dkp-migration.sql** | One-time migration to backfill `account_id` and populate `account_dkp_summary` (already-migrated DBs don’t need this). |

**Superseded:** **docs/delete_raid_for_reupload_rpc.sql** — use **docs/upload_script_rpcs.sql** or run **docs/supabase-schema-full.sql** (which includes it).

---

## 5. Checklist: mirror or new deploy

- [ ] Run **docs/supabase-schema-full.sql** in SQL Editor → Success
- [ ] Optional: loot-to-character and/or loot-assignment-table if you use those features
- [ ] After loading data: run `SELECT refresh_dkp_summary();` and `SELECT refresh_all_raid_attendance_totals();` and `SELECT refresh_account_dkp_summary();`
- [ ] Promote one user to officer: `UPDATE profiles SET role = 'officer' WHERE id = 'USER_UUID';`

If anything fails, compare with the live schema using section 3 and fix the repo SQL or apply the missing object (trigger/RPC) from the dump.
