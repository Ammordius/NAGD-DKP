# Portable SQL backup

This workflow exports guild DKP data as inspectable SQL so it can move between independent Supabase projects. It is the portable recovery backup. The CSV export in [CI-DB-BACKUP.md](CI-DB-BACKUP.md) stays scheduled for the public ledger and for legacy recovery. Restore from this artifact is [CI-DB-SQL-RESTORE.md](CI-DB-SQL-RESTORE.md). Do not run a scheduled production backup until `SUPABASE_DB_URL` and `SQL_BACKUP_AGE_RECIPIENT` are set and `SQL_BACKUP_SCHEDULE` is `enabled`. A manual run is separate and still needs those two secrets.

Another repository can list and dry-run these artifacts from **DB SQL restore** without writing the destination. See [CI-DB-SQL-RESTORE.md](CI-DB-SQL-RESTORE.md). Decrypting the archive needs the offline age identity, which this backup workflow does not store. The reader is [`scripts/sql_backup_fetch.py`](../scripts/sql_backup_fetch.py), described in [CI-DB-SQL-BACKUP-FETCH.md](CI-DB-SQL-BACKUP-FETCH.md).

The artifact records two different schema facts. `canonical_schema_sha256` is the sha256 of the checked-out `docs/supabase-schema-full.sql`. It is the source-code fingerprint. `live_schema_status` is a read-only catalog probe of the source database: `compatible` or `incompatible` after that probe, and `not_assessed` when the probe did not run. `live_schema_compared_to_repository_file` is false. A matching file hash does not mean the live catalog was verified. The probe does not apply the schema file. An incompatible catalog is still exported, and restore refuses that artifact before any write.

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
| `dkp_summary` | Rebuilt by `refresh_dkp_summary()`. |
| `account_dkp_summary` | Rebuilt by `refresh_account_dkp_summary_internal()`. |
| `dkp_period_totals` | Rebuilt by `refresh_dkp_period_totals()`. |
| `character_dkp_spent` | Rebuilt by `refresh_character_dkp_spent()`. |
| `character_loot_assignment_counts` | Rebuilt from `loot_assignment`. |
| `bid_portfolio_auction_fact` | Denormalized bidding facts. Rebuild with the existing backfill. |
| `account_class_coverage` | Magelo rankings cache refreshed by CI. |
| Views | Not source data. |

## Portable guild backup and disaster recovery

A portable guild backup is the 13 allowlisted tables above. It is enough to rebuild DKP on another database that already has `docs/supabase-schema-full.sql`. It is not a complete disaster-recovery copy. Supabase’s own backup or point-in-time recovery is what recreates logins, roles, secrets, and schema. This artifact cannot.

The CSV exporter still writes profiles, the officer audit log, and several caches. [scripts/restore_supabase_from_backup.py](../scripts/restore_supabase_from_backup.py) does not load every CSV it finds. `character_dkp_spent` is in neither export; restore rebuilds it.

| Table | CSV export | SQL portable backup |
| --- | --- | --- |
| `characters`, `accounts`, `character_account`, `raids`, `raid_events`, `raid_attendance`, `raid_event_attendance`, `raid_loot`, `loot_assignment`, `dkp_adjustments`, `raid_classifications`, `active_raiders`, `active_accounts` | yes | yes |
| `profiles`, `officer_audit_log` | yes | no; identity-linked, destination keeps its own |
| `account_class_coverage`, `bid_portfolio_auction_fact` | yes | no; cache and bidding facts |
| `raid_dkp_totals`, `raid_attendance_dkp`, `raid_attendance_dkp_by_account`, `dkp_summary`, `account_dkp_summary`, `dkp_period_totals`, `character_loot_assignment_counts` | yes | no; rebuilt after restore |
| `character_dkp_spent` | no | no; rebuilt |
| `auth.users` and other non-public schemas | no | no; Supabase-managed |
| `restore_in_progress` | no | no; environment flag |
| Views | no | no |

Restore loads the allowlisted tables in one transaction, then calls `end_restore_load()`. See [CI-DB-SQL-RESTORE.md](CI-DB-SQL-RESTORE.md).

## GitHub Actions

Workflow: [`.github/workflows/db-sql-backup.yml`](../.github/workflows/db-sql-backup.yml). Actions installs the PostgreSQL 17 client from apt.postgresql.org because `pg_dump` must be at least the server major version.

- **Manual:** Actions → **DB SQL backup** → Run workflow, from `main`. This is the on-demand backup. It does not consult the `raid_loot` count. Check **force** to also upload this week’s and this month’s long-retention copies even when those names already exist. A run selected from another branch does not start the job.
- **Daily:** `30 7 * * *`, thirty minutes after the CSV job. GitHub runs the schedule only from the default branch. The export runs only when that ref is `main` and the repository variable `SQL_BACKUP_SCHEDULE` is `enabled`, or when someone starts the workflow by hand from `main`. A push of this file does not read production. The schedule is not gated on the `raid_loot` row count, and it does not commit `.ci` marker files.
- The job has `contents: read` and `actions: write`. It does not commit or push. Weekly and monthly copies are chosen by listing this repository’s own Actions artifacts. A fork does not inherit another fork’s artifact list, so a stale `.ci` commit cannot suppress or repeat those copies.
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

Every successful run uploads `sql-backup-<utc>.tar.gz.age` with **retention 7 days** (about 7 daily copies). When this repository does not already have a non-expired `sql-backup-weekly-<YYYY-Www>` artifact, the same file is also uploaded under that name for **90 days**. The same rule creates `sql-backup-monthly-<YYYY-MM>` for **90 days**. `actions/upload-artifact` cannot keep a file longer than 90 days.

Using the existing ~5 MB upper bound from the CSV size note, and not a new measurement of production, 7 daily copies plus about 13 weekly and 3 monthly copies are on the order of 100 MB. The SQL allowlist is a subset of the CSV export, so the encrypted file should be smaller. Do not run `estimate_backup_size.py` against production just to refresh that number; it calls the live REST API.

**DB SQL restore** lists checkpoints and can select the latest snapshot, the previous distinct snapshot, or a weekly or monthly copy without an artifact id. A numeric artifact id remains optional. The file inside the zip stays `sql-backup-<utc>.tar.gz.age`. Restore compares schema structure. It keeps the source file hash as provenance and does not require the canonical schema files to be byte-identical.

After decrypting with the offline private key:

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
