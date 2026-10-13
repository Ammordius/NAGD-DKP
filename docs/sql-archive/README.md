# DO NOT DEPLOY

**These files are not schema steps.** Do not run them to install or upgrade the database.

The only schema install and upgrade file is [`docs/supabase-schema-full.sql`](../supabase-schema-full.sql). Apply it with:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f docs/supabase-schema-full.sql
```

Files in this directory are kept for provenance. They are superseded copies, one-time data corrections, or read-only diagnostics.

**Never run a file here that contains `TRUNCATE` as an upgrade.** That includes `one-offs/supabase-reset-and-import.sql` and `one-offs/supabase-restore-truncate.sql`. Restore uses `truncate_dkp_for_restore()` from the canonical schema, and only when you intend to wipe DKP tables.

## superseded/

Older copies of tables, policies, and functions that already live in `docs/supabase-schema-full.sql`. Running one of these after the canonical file can replace a current function with an older body. `supabase-siteadmin-delete-user.sql` is one of those copies. Fresh and existing databases get that function from the canonical file.

## one-offs/

Historical data corrections, generated `UPDATE` scripts, the account-DKP migration definitions, reset and truncate scripts, the retired bid-forecast drop, and the optional `github_worker` role script.

The account-DKP migration is not an ordinary upgrade. Production was already migrated. If `raid_event_attendance.account_id` is still null for rows that have a linked character, stop and inspect that database. Do not fold those steps into a schema apply.

`supabase-github-worker-role.sql` is not idempotent (`CREATE ROLE`) and CI does not use it. CI uses the Supabase `service_role` key.

`audit_and_fix_duplicate_raids_raid_id.sql` deletes duplicate `raids` rows. It is archived here because it changes data, not because the name starts with `audit_`.

## diagnostics/

Read-only queries and a rolled-back display-name test. They do not change the schema. Do not list them as required setup.
