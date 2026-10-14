# Portable SQL restore

This restores a portable SQL backup into an independent database. The backup contains guild DKP rows, not authentication. The destination keeps its own `auth.users`, `profiles`, local sign-in identities, site-admin and officer roles, profile preferences, and officer audit log.

The CSV restore in [CI-DB-RESTORE.md](CI-DB-RESTORE.md) is a different path. Do not use it for a cross-project SQL artifact. This workflow does not apply `docs/supabase-schema-full.sql`. The destination must already be on that canonical schema. Production restore is disabled.

## What changes

The restore replaces the allowlisted guild tables from [CI-DB-SQL-BACKUP.md](CI-DB-SQL-BACKUP.md): characters, accounts, character links, raids, attendance, loot, loot assignment, adjustments, classifications, and active lists.

Derived DKP tables are not loaded from the artifact. `end_restore_load()` rebuilds them after the guild rows are in place. `character_loot_assignment_counts` is rebuilt from `loot_assignment` in the same transaction. `bid_portfolio_auction_fact` is cleared and left empty; fill it again with the existing bidding backfill. That backfill is not part of this transaction.

`account_class_coverage` is not in the artifact. Rows for accounts that remain stay. Rows for unclaimed accounts that are not in the snapshot are deleted before those accounts are deleted. Claimed accounts keep their cache rows.

## Accounts claimed by destination profiles

`profiles.account_id` points at `accounts`. The restore never updates a profile, never clears a claim, and never invents a mapping.

- A claim whose account is absent from the snapshot keeps that account row. Guild rows for the account are replaced, so the account remains as the claim anchor.
- A claim whose account is in the snapshot keeps the profile row. Guild columns on that account are updated from the snapshot.
- An account that no profile claims, and that is absent from the snapshot, is deleted.
- An account that exists only in the snapshot is inserted.

Running the same artifact again replaces the guild tables with the same rows. It does not append, and it does not duplicate attendance or DKP.

## Transaction

Dry-run is the default. It verifies the artifact and reads the destination. It does not create staging tables and does not write.

An actual restore uses one `psql` session with `ON_ERROR_STOP=1`:

1. Copy the snapshot into temporary tables.
2. Reject the snapshot if its foreign keys do not hold.
3. Call `begin_restore_load()` so ledger triggers no-op during the swap.
4. Delete guild rows by named table. There is no `TRUNCATE ... CASCADE` and foreign keys stay enabled.
5. Merge accounts using the claim rule above. The account display-name guard is disabled only for that update and enabled again before commit. A rollback turns it back on.
6. Insert parents before children.
7. Call `end_restore_load()`, which clears the restore flag, resets sequences, and refreshes DKP.
8. Check counts, claims, DKP totals, and auth, profile, and audit fingerprints.
9. Commit.

A failed statement rolls the transaction back, including derived totals and the restore flag. Use the session pooler on port 5432. The transaction pooler on port 6543 is refused. `data.sql` is not executed as a script, and `SET` or `setval` lines inside it are ignored.

## GitHub Actions

Workflow: [`.github/workflows/db-restore-sql.yml`](../.github/workflows/db-restore-sql.yml).

It starts only from **Actions → DB SQL restore → Run workflow**, and only from `main`. It does not run on push, pull request, or when an artifact is uploaded. A fork pull request cannot run this workflow with this repository's secrets.

Create a GitHub Environment named `sql-restore` before the first run. Give it required reviewers and a deployment branch policy that allows only `main`. Store these on that environment:

| Name | Kind | Value |
| --- | --- | --- |
| `SQL_RESTORE_DB_URL` | Secret | Session-mode URI of the non-production destination, with `sslmode=require`. Do not reuse the production `SUPABASE_DB_URL`. |
| `SQL_RESTORE_DESTINATION_NAME` | Variable | Short name the operator must type. Must not be `production` or `prod`. |
| `SQL_RESTORE_DESTINATION_HOST` | Variable | Host of `SQL_RESTORE_DB_URL`, without the user or password. |
| `SQL_RESTORE_DATABASE_NAME` | Variable | Database name in that URI. |

The workflow also reads the existing repository secrets `SQL_BACKUP_AGE_IDENTITY`, `SQL_BACKUP_AGE_RECIPIENT`, and, for another repository, `BACKUP_ARTIFACT_READ_TOKEN`.

Inputs:

- **execution** defaults to `dry-run`.
- **source repository** is limited to this repository, `Ammordius/NAGD-DKP`, and `RimidalEQ/RimidalEQ-NAGD-DKP-backup`.
- **artifact id** is required. The latest artifact is not selected automatically.
- **destination name** must match `SQL_RESTORE_DESTINATION_NAME`.
- **confirm** stays empty for a dry-run. A restore requires `RESTORE <destination name>`.

The restore job runs only after the dry-run succeeds. It then takes an encrypted backup of the destination and uploads that artifact before any mutation. If that backup fails, the restore does not start. Only one restore workflow runs at a time.

`PRODUCTION_RESTORE_ENABLED` in `scripts/sql_restore.py` is false. A destination name of production, or a host listed in `scripts/sql_restore_production_denylist.txt`, is refused even if a variable says otherwise. Enabling a production restore is a later code change after a separate test.

## Local test

```bash
python scripts/test_sql_restore.py
```

Set `DKP_PG_TEST=1` to fail instead of skip when Docker, `psql`, `pg_dump`, or `age` is missing. The test uses two disposable Postgres databases. It does not read a production URL.

The test checks source DKP totals, preserved destination auth and privileges, historical name-only attendance, a rolled-back mid-restore failure, and a second restore that does not duplicate rows.
