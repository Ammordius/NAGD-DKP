# Schema deployment

[`docs/supabase-schema-full.sql`](supabase-schema-full.sql) is the only SQL file used to install or upgrade the application database. It creates tables, relationships, RLS, grants, role guards, officer write RPCs, DKP triggers, account and character resolution, audit, restore functions, loot assignment, and site-admin RPCs.

Historical SQL lives in [`docs/sql-archive/`](sql-archive/README.md). That directory starts with **DO NOT DEPLOY**. It is not a second schema step.

The SQL Editor does not promise one transaction or a full rollback if a later statement fails. Apply the file with `psql`:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f docs/supabase-schema-full.sql
```

`$DATABASE_URL` is the Postgres URI from Supabase (Project Settings → Database → connection string, session mode). `COMMIT` inside `dba_backfill_bid_portfolio_range` is procedure source. Deploy does not call that procedure, so `--single-transaction` still wraps the file.

See [SCHEMA_RPC_INDEX.md](SCHEMA_RPC_INDEX.md) for which RPCs the app calls.

---

## 1. Fresh project

1. Create an empty Supabase project.
2. Take note of the database password. You need it for `psql`.
3. Apply `docs/supabase-schema-full.sql` with the command above.
4. Import data (see [SETUP-WALKTHROUGH.md](SETUP-WALKTHROUGH.md)). Do not import by running archived SQL.
5. After the load, refresh derived totals: `SELECT refresh_dkp_summary();`, `SELECT refresh_all_raid_attendance_totals();`, and `SELECT refresh_account_dkp_summary();`.
6. Promote one user in the SQL editor, which connects as `postgres`: `UPDATE profiles SET role = 'siteadmin' WHERE id = 'USER_UUID';`

A fresh database has no raid rows, so the attendance unique indexes and the unresolved-attendance preflight do not need a data migration.

---

## 2. Existing database

Use the same file and the same `psql` command. Re-applying replaces functions, policies, and triggers. It adds missing tables and columns with `IF NOT EXISTS`. It does not truncate raid, account, character, or DKP tables, and it does not recalculate DKP.

Two writes happen while the file runs:

- `INSERT` of the `restore_in_progress` flag row, skipped when that row already exists.
- `UPDATE` of `profiles.display_name` only where the name is blank and the user signed up with Discord. A name that is already set is left alone.

Stop before applying if any preflight below fails. Fix the data, then apply again. Because the command uses one transaction, a failed apply leaves the previous schema in place.

---

## 3. Backup and preflight

Take a portable SQL backup before an upgrade ([CI-DB-SQL-BACKUP.md](CI-DB-SQL-BACKUP.md)). The artifact is guild data only. It does not contain schema SQL, so restoring it does not undo a committed schema change. A failed `psql --single-transaction` already rolls the upgrade back. The CSV workflow in [CI-DB-BACKUP.md](CI-DB-BACKUP.md) is retired. Historical `supabase-backup-*` artifacts are not deleted. The only schema file is still `docs/supabase-schema-full.sql`.

Run these checks before `psql`. They only read.

```sql
-- Roles outside the canonical check abort the upgrade.
SELECT id, role FROM public.profiles
WHERE role NOT IN ('siteadmin', 'officer', 'player');

-- Duplicate tic attendance aborts the upgrade. This file will not delete the rows.
SELECT raid_id, event_id, char_id, count(*)
FROM public.raid_event_attendance
WHERE char_id IS NOT NULL AND trim(char_id::text) <> ''
GROUP BY raid_id, event_id, char_id
HAVING count(*) > 1;

SELECT raid_id, event_id, character_name, count(*)
FROM public.raid_event_attendance
WHERE character_name IS NOT NULL AND trim(character_name) <> ''
GROUP BY raid_id, event_id, character_name
HAVING count(*) > 1;

-- A null account_id is valid when the installed resolver finds one account.
-- Stop only when that function returns null. Do not backfill account_id
-- and do not run the archived account-DKP migration as part of this deploy.
SELECT count(*) AS unresolved_attendance
FROM public.raid_event_attendance rea
WHERE public.resolve_dkp_account_id(
  rea.account_id, rea.char_id::text, rea.character_name
) IS NULL;
```

If `unresolved_attendance` is not zero, stop. A null `account_id` that `resolve_dkp_account_id` resolves is an ordinary upgrade. The canonical file adds the column when it is missing and does not backfill it. Rewriting attendance during schema apply is not part of this upgrade.

The attendance unique indexes and the nullable `account_id` column do not require a stamped account id. A name-only row is stored when its character name is unique on that tic.

---

## 4. Schema verification

After a successful apply, list what landed. These queries do not change data.

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

Confirm `update_raid_event_times`, `siteadmin_delete_user`, `truncate_dkp_for_restore`, and `refresh_dkp_summary` are present. Compare the list with [SCHEMA_RPC_INDEX.md](SCHEMA_RPC_INDEX.md).

To diff a live database against the file, dump the public schema with the Supabase CLI or `pg_dump --schema-only --schema=public` and diff that dump against `docs/supabase-schema-full.sql`. A dump is a comparison artifact. It is not a second deploy file.

---

## 5. Triggers, RLS, and RPC permissions

Triggers on `raid_event_attendance` and `raid_loot` are statement-level. Re-applying drops the named triggers and creates them again. Confirm:

```sql
SELECT c.relname, t.tgname
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND NOT t.tgisinternal
  AND c.relname IN ('raid_event_attendance', 'raid_loot', 'profiles')
ORDER BY 1, 2;
```

Expect `delta_dkp_after_event_attendance`, `delta_dkp_after_event_attendance_del`, `profiles_role_guard`, and `on_auth_user_created` (that last trigger is on `auth.users`).

RLS is enabled on the public tables. Core DKP tables are readable by `authenticated`. `loot_assignment` and `character_dkp_spent` also have anon SELECT, matching the current file. Browser roles cannot insert, update, or delete `profiles`. Role, claim, email, and unclaim changes go through the site-admin and claim RPCs.

Restore, upload, and ledger-maintenance functions are granted to `service_role` and revoked from `anon` and `authenticated`. `update_raid_event_times` is in that set. Officer and player RPCs, including `siteadmin_delete_user`, are granted to `authenticated`. The functions themselves reject callers who lack the role.

```sql
SELECT p.proname,
       has_function_privilege('anon', p.oid, 'execute') AS anon_exec,
       has_function_privilege('authenticated', p.oid, 'execute') AS auth_exec,
       has_function_privilege('service_role', p.oid, 'execute') AS service_exec
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'truncate_dkp_for_restore',
    'update_raid_event_times',
    'delete_raid',
    'siteadmin_delete_user',
    'refresh_dkp_summary_internal'
  )
ORDER BY 1;
```

`anon_exec` and `auth_exec` are false for `truncate_dkp_for_restore`, `update_raid_event_times`, and `refresh_dkp_summary_internal`. `auth_exec` is true for `delete_raid` and `siteadmin_delete_user`.

---

## 6. Recovery and rollback

If `psql` exits non-zero, `--single-transaction` rolls the upgrade back. Fix the reported error and run the file again.

If an upgrade committed and the guild data is wrong, restore the SQL artifact from section 3 onto a database that already has this schema. That restore does not roll the schema back. Do not try to undo the file by running archived SQL. Archived copies can replace a current function with an older body.

Data restore is separate from schema upgrade. The portable path is [CI-DB-SQL-RESTORE.md](CI-DB-SQL-RESTORE.md). [RESTORE-BACKUP.md](RESTORE-BACKUP.md) is the legacy CSV procedure. It uses `truncate_dkp_for_restore()`, `begin_restore_load()`, and `end_restore_load()` from the canonical schema. Those functions truncate only when called. Applying the schema file does not call them. Do not point a CSV restore at an SQL artifact.

---

## 7. How to change the schema later

Edit `docs/supabase-schema-full.sql`. Do not add another file under `docs/` and do not tell operators to run a patch from `docs/sql-archive/`.

Keep new objects idempotent: `CREATE OR REPLACE`, `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, and `DROP POLICY/TRIGGER IF EXISTS` before `CREATE`. Revoke and re-grant in the privilege block at the end of the file. Do not put `TRUNCATE`, `DELETE`, or `UPDATE` of production rows at the top level of the file. `TRUNCATE` inside a function body is allowed when the function is not called during apply.

Update [SCHEMA_RPC_INDEX.md](SCHEMA_RPC_INDEX.md) when an app or script calls a new function. `scripts/check-canonical-schema.mjs` fails if a new `.sql` file appears outside this file, `docs/sql-archive/`, `web/test/pg/`, and `docs/full-db-hosted-inventory.sql`. That inventory file is read-only and is not a schema step.
