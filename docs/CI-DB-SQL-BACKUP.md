# Portable SQL backup

This workflow exports guild DKP data as inspectable SQL so it can move between independent Supabase projects. It runs beside the CSV backup. It does not replace [CI-DB-BACKUP.md](CI-DB-BACKUP.md) or [CI-DB-RESTORE.md](CI-DB-RESTORE.md). Restore from this artifact is a later track. Do not run this against production until `SUPABASE_DB_URL` and `SQL_BACKUP_AGE_RECIPIENT` are set and that run is explicitly authorized.

`docs/supabase-schema-full.sql` remains the only schema deploy file. The artifact does not contain schema SQL.

## Why `pg_dump`

`supabase db dump --data-only --use-copy` wraps `pg_dump` and filters with excludes. A new public table would be included until someone adds an exclude. This export uses `pg_dump --data-only --format=plain` with one `--table=public.<name>` per allowed table, so a new table stays out until it is reviewed. Plain `COPY` SQL is readable and can be loaded with `psql`. There is no custom or binary dump format.

`pg_dump` reads the whole dump in one repeatable-read snapshot. The script sets `default_transaction_read_only=on` and does not update attendance or fill NULL `account_id` values.

## What is included

| Table | Why it is included |
| --- | --- |
| `characters`, `accounts`, `character_account` | Game accounts and character mappings. `accounts` is not a login. |
| `raids`, `raid_events`, `raid_attendance`, `raid_event_attendance` | Raids, events, and attendance, including rows whose `account_id` is NULL. |
| `raid_loot`, `loot_assignment` | Loot and loot assignments. |
| `dkp_adjustments` | Authoritative adjustments, including nullable `account_id`. |
| `raid_classifications` | Stored guild zone and mob labels. Triggers do not rebuild this table. |
| `active_raiders`, `active_accounts` | Officer pin lists, not computed caches. |

## What is excluded

| Table | Why it is excluded |
| --- | --- |
| `auth.users` and other non-public Supabase schemas | Managed identities, sessions, and secrets. |
| `profiles` | Auth user, role, email, and claim state. It references `auth.users`. |
| `officer_audit_log` | `actor_id` references `auth.users`, and rows store email plus site-admin actions. Those identities do not exist on another project. The CSV backup still exports this table for same-project recovery. |
| `restore_in_progress` | One-row operational flag for the database that was dumped. |
| `raid_dkp_totals`, `raid_attendance_dkp`, `raid_attendance_dkp_by_account` | Rebuilt by `refresh_all_raid_attendance_totals()`. |
| `dkp_summary`, `account_dkp_summary`, `dkp_period_totals` | Rebuilt by `refresh_dkp_summary()` and `refresh_account_dkp_summary_internal()`. |
| `character_dkp_spent` | Rebuilt by `refresh_character_dkp_spent()`. |
| `character_loot_assignment_counts` | Rebuilt from `loot_assignment`. |
| `bid_portfolio_auction_fact` | Denormalized bidding facts. Rebuild with the existing backfill. |
| `account_class_coverage` | Magelo rankings cache refreshed by CI. |
| Views | Not source data. |

A later restore should load the included tables, then call the existing refresh functions (`end_restore_load()` already runs the DKP, attendance, and character-spent refreshes). This track does not restore.

## GitHub Actions

Workflow: [`.github/workflows/db-sql-backup.yml`](../.github/workflows/db-sql-backup.yml).

- **Manual:** Actions → **DB SQL backup** → Run workflow.
- **Daily:** the cron is present but commented. Uncomment it only after both secrets exist and a production run is explicitly authorized. It is `30 7 * * *` so it does not start at the same minute as the CSV backup.
- The job has `contents: read` and `actions: write` (artifact upload only). It does not commit or push.
- Upload runs only after the export step succeeds (`if: success()`), and `if-no-files-found: error` rejects an empty upload. A failed `pg_dump` or missing secret writes no artifact.
- Logs and the step summary list table names and row counts. They do not include the connection string, password, recipient, or row contents.

Add these secrets by hand in **Settings → Secrets and variables → Actions**. Do not commit them and do not put them in the workflow file.

| Secret | Value |
| --- | --- |
| `SUPABASE_DB_URL` | Session-mode Postgres URI from Supabase → Project Settings → Database. Include `sslmode=require`. Percent-encode reserved characters in the password. Use the session pooler (port 5432), not the transaction pooler. |
| `SQL_BACKUP_AGE_RECIPIENT` | An `age` **public** key, the `age1...` line from `age-keygen`. |

Generate the key pair on a machine you control:

```bash
age-keygen -o sql-backup-key.txt
```

Put the public key line into `SQL_BACKUP_AGE_RECIPIENT`. Keep `sql-backup-key.txt` offline. This workflow never decrypts, and the private key must not be a secret of this workflow or a committed file. GitHub Actions artifacts on a public repository are world-readable, so the uploaded file is the age-encrypted archive only.

The script passes host, port, user, database, and password through libpq environment variables, not on the `pg_dump` command line. It also sets `PGOPTIONS=-c default_transaction_read_only=on`.

Optional later, and not applied by this track: a `SELECT`-only role with `BYPASSRLS` so row security cannot hide guild rows. The database owner role already used by `SUPABASE_DB_URL` can read the allowlist. A role without `BYPASSRLS` can dump an empty table when RLS hides the rows.

```sql
CREATE ROLE dkp_backup_reader LOGIN BYPASSRLS PASSWORD 'replace-me';
GRANT CONNECT ON DATABASE postgres TO dkp_backup_reader;
GRANT USAGE ON SCHEMA public TO dkp_backup_reader;
GRANT SELECT ON TABLE
  public.characters,
  public.accounts,
  public.character_account,
  public.raids,
  public.raid_events,
  public.raid_attendance,
  public.raid_event_attendance,
  public.raid_loot,
  public.loot_assignment,
  public.dkp_adjustments,
  public.raid_classifications,
  public.active_raiders,
  public.active_accounts
TO dkp_backup_reader;
```

## Artifact

The uploaded file is `sql-backup-<utc>.tar.gz.age` (retention 7 days). After decrypting with the offline private key:

```bash
age -d -i sql-backup-key.txt -o backup.tar.gz sql-backup-YYYYMMDDTHHMMSSZ.tar.gz.age
tar xzf backup.tar.gz
sha256sum -c SHA256SUMS
```

The archive contains only:

- `data.sql` — `pg_dump` data, including sequence `setval` lines. No `CREATE TABLE`.
- `manifest.json` — snapshot identity, allowlist, exclusions, row counts, and the `data.sql` checksum.
- `SHA256SUMS` — SHA-256 of `data.sql` and `manifest.json`.
- `summary.txt` — the same identity and counts, with no row samples.

`canonical_schema_sha256` is the SHA-256 of the checked-out `docs/supabase-schema-full.sql`. Run the workflow from the commit whose schema file matches the database. The fingerprint is not a second copy of the schema.

Example manifest (illustrative counts, not a real backup):

```json
{
  "format_version": "1",
  "source_repository": "owner/dkp",
  "workflow_run_id": "123456789",
  "source_commit_sha": "abc123deadbeef",
  "created_at": "2026-10-14T15:04:05Z",
  "canonical_schema_source": "docs/supabase-schema-full.sql",
  "canonical_schema_sha256": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "postgresql_version": "16.11 (Debian 16.11-1.pgdg120+1)",
  "included_tables": ["characters", "accounts", "character_account", "raids", "raid_events", "raid_attendance", "raid_event_attendance", "raid_loot", "loot_assignment", "dkp_adjustments", "raid_classifications", "active_raiders", "active_accounts"],
  "excluded_tables": [
    {"name": "profiles", "reason": "auth-linked identity"},
    {"name": "officer_audit_log", "reason": "auth-linked personal data"}
  ],
  "row_counts": {"characters": 2, "raid_event_attendance": 1},
  "checksums": {"data.sql": "sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"}
}
```

The real manifest lists every included table and every exclusion from `scripts/sql_backup.py`.

## Local test

The test uses disposable Docker Postgres, the auth stub, and `docs/supabase-schema-full.sql`. It does not read a production URL.

```bash
python scripts/test_sql_backup.py
```

Docker, `pg_dump`, and `age` (including `age-keygen`) must be on `PATH`. Set `DKP_PG_TEST=1` to fail instead of skip when those tools are missing. Schema check runs that command with `DKP_PG_TEST=1`.

The test checks the allowlist, auth and profile exclusion, character/account links, NULL historical `account_id` values, checksums, manifest identity, missing credentials, a failed dump that writes no artifact, and that the uploaded bytes are an age file rather than plaintext SQL.
