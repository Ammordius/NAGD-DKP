# Portable SQL restore

This restores a portable SQL backup into an independent database. The backup contains guild DKP rows, not authentication. The destination keeps its own `auth.users`, `profiles`, local sign-in identities, site-admin and officer roles, profile preferences, and officer audit log.

The CSV restore in [CI-DB-RESTORE.md](CI-DB-RESTORE.md) is a different path. Do not use it for a cross-project SQL artifact. This workflow does not apply `docs/supabase-schema-full.sql`. The destination must already be on that canonical schema.

This is the supported historical restore for the live site. Anyone who can run **DB SQL restore** on `main` and pass the `sql-restore` environment can use it. A new artifact does not require a source change.

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
| `SQL_RESTORE_DB_URL` | Secret | Session-pooler URI for Supabase project `ynvwtvphqsevhpytcugj`, port 5432, `sslmode=require`. This is the same database `SUPABASE_DB_URL` reads. Do not commit the password. Do not use port 6543. |
| `SQL_RESTORE_DESTINATION_NAME` | Variable | `nagd-dkp`. The workflow reads this variable. Operators do not type it. |
| `SQL_RESTORE_DESTINATION_HOST` | Variable | Host of `SQL_RESTORE_DB_URL`, without the user or password. Copy the session-pooler hostname from Supabase → Project Settings → Database. |
| `SQL_RESTORE_DATABASE_NAME` | Variable | `postgres` |
| `SQL_RESTORE_PROJECT_REF` | Variable | `ynvwtvphqsevhpytcugj` |

The workflow also reads `SQL_BACKUP_AGE_IDENTITY` and `SQL_BACKUP_AGE_RECIPIENT`. The current repository uses `GITHUB_TOKEN`. Other forks are read with the first configured slot that can see that repository's Actions artifacts: `BACKUP_ARTIFACT_READ_TOKEN_STAGING`, `BACKUP_FORK_READ_TOKEN`, and `BACKUP_FORK_READ_TOKEN_2` through `BACKUP_FORK_READ_TOKEN_4`. Empty slots are skipped. A new fork does not require a workflow edit. A fork with no working token is listed and cannot be restored.

`workflow_dispatch` cannot fill a dropdown from the API. Run **DB SQL backup discovery** first. It prints repositories, checkpoints, timestamps, and whether artifacts are readable. Paste one `owner/name` from that summary into the restore source field. A separate picker UI is optional later and is not required for this workflow.

Inputs:

- **execution** defaults to `dry-run`.
- **source repository** is the discovered `owner/name`. `Current repository` means the repository running the workflow. A name that is not the NAGD-DKP root or a fork of it is rejected. Membership uses GitHub's repository id `R_kgDORQRiNA`, so a rename still matches and an unrelated repository does not.
- **checkpoint** defaults to `Latest available backup`. The normal choices are the previous distinct snapshot, the latest weekly backup, and the latest monthly backup. Previous weekly and a specific artifact name stay available for an older backup.
- **checkpoint name** is only for `Specific checkpoint by artifact name`.
- **artifact id** is optional. Leave it empty for a normal run.

The destination name is `SQL_RESTORE_DESTINATION_NAME` on the `sql-restore` environment. For this deployment that value is `nagd-dkp`. Discovering a fork does not authorize a write to that fork's database. There is no typed `RESTORE nagd-dkp` field. A destructive restore instead requires the environment's required reviewers and a deployment branch policy that allows only `main`. If either is missing, the restore stops before the destination backup. It does not fall back to a typed phrase.

A renamed repository is the same source when GitHub resolves both names to one repository id. The manifest is not rewritten. An artifact whose manifest names a different repository id is refused, and the error says to generate a new backup in the selected repository. The error prints the selected name, the canonical name, the repository ids, and the workflow run. It does not print SQL, credentials, or download URLs.

Daily, weekly, and monthly artifacts from the same backup run are one snapshot when their sizes match. Latest and previous choose distinct snapshots. A weekly or monthly choice uses that retention copy. The preflight prints the five newest available snapshots, plus the selected snapshot if it is older, with the UTC time, repository, artifact name, artifact id, created and expiration times, tier, size, and whether it is still available.

The inventory job has no environment. It lists fork backups and resolves the checkpoint once. The reviewer can read that summary before the approval prompt. The `sql-restore` job is the only environment approval. It downloads that same artifact. It does not look up Latest a second time. A backup uploaded while the workflow is running is not the one restored. The preflight summary names the snapshot, the canonical source, the workflow run, the artifact id, and the destination `nagd-dkp`. Destination auth, profiles, claims, and the officer audit log stay in place.

Dry-run stops after that preflight. A restore, in the same job and the same approval, checks the environment protection, takes an encrypted backup of the destination, and uploads that artifact before any mutation. That backup is kept for 90 days. If that backup or the protection check fails, the restore does not start. Only one restore workflow runs at a time.

A hosted connection is accepted only when the environment configuration and the connection agree. The name, host, and database must match `SQL_RESTORE_DB_URL`. `SQL_RESTORE_PROJECT_REF` must match the project reference the connection proves. On the session pooler, that reference is the suffix of the username `postgres.<project-ref>`, and the host must be a `*.pooler.supabase.com` name on port 5432. A direct host must be `db.<project-ref>.supabase.co` with username `postgres`. Hosted TLS must be `sslmode=require`. If any value is missing or disagrees, the destination is rejected. `SQL_RESTORE_ALLOW_PRODUCTION` does not grant access. Outside Actions, `localhost` and `127.0.0.1` remain available for the disposable tests. Actions rejects those hosts. A host listed in `scripts/sql_restore_production_denylist.txt` is refused; leave the configured destination host off that list.

Create the `sql-restore` environment, with at least one required reviewer and a deployment branch policy that allows only `main`, before the first destructive restore. The workflow does not create that protection by itself, and it refuses to restore while the environment has no reviewers or allows any other branch. As of the fork-discovery change, that environment had neither required reviewers nor a branch policy. Configuring the reviewers is an administrator action on the GitHub environment. People who can approve that environment are the people who can restore. Granting that access does not require a source change.

## Restore procedure

1. On the source repository, set `SUPABASE_DB_URL` to the session-pooler URI (port 5432, `sslmode=require`) and `SQL_BACKUP_AGE_RECIPIENT` to the age public key. Generate the key pair with `age-keygen` on a machine you control. Keep the identity file offline. Put that identity only in the destination secret `SQL_BACKUP_AGE_IDENTITY`. The backup workflow must not have the private key.
2. To read artifacts from another owner's fork, store a fine-grained token with Actions read as one of the unlabeled slots. `BACKUP_ARTIFACT_READ_TOKEN_STAGING` remains the existing slot. Further owners use `BACKUP_FORK_READ_TOKEN` and `BACKUP_FORK_READ_TOKEN_2` through `_4`. One token has one owner. A fork the tokens cannot read stays in the discovery summary with the reason. It is not a restore source. Do not rename the staging secret.
3. Open **Actions → DB SQL backup discovery** on `main` and read the summary. Then open **Actions → DB SQL restore → Run workflow** on `main`. Paste the discovered repository and choose a checkpoint. Use `Latest available backup` or `Previous backup (previous distinct snapshot)` for a normal restore. Choose a weekly or monthly checkpoint when you want that retention copy. For one named artifact, choose `Specific checkpoint by artifact name`. Leave the artifact id empty unless you already have a numeric id.
4. Run it with execution `dry-run`. The inventory names the selected artifact before approval. After approval, the preflight should show `writes: none`, the pinned snapshot, the canonical source, source and destination row counts, preserved claims, and expected DKP. A fetch that reports `inner_verified: false` has not done this check.
5. Approve the `sql-restore` environment once. Required reviewers and a `main`-only branch policy are the approval. The workflow then uploads `sql-restore-destination-backup-*` before it writes. A restore run does not ask for a second environment approval.
6. After a committed restore, read the step summary again: counts, claim anchors, and DKP totals. `source_schema_fingerprint: match` means the artifact matches the checked-out `docs/supabase-schema-full.sql`. `live_schema_status` is the source catalog probe and is not that file hash. `restore_compatibility: compatible` means the destination preflight passed. `schema_apply: false` means this workflow did not apply schema. `not_assessed` is not a live-schema verification.
7. A failed statement rolls the transaction back, including derived totals and the restore flag. If the destination backup fails, the restore does not start. If a committed restore is wrong, run this workflow again and select the earlier guild checkpoint. `sql-restore-destination-backup-*` is the encrypted destination backup taken before the write. It is not a source checkpoint. `end_restore_load()` rebuilds derived DKP in the transaction. `bid_portfolio_auction_fact` is cleared and must be filled again with the existing bidding backfill. Reload the site so browser caches refresh.

Set `SQL_BACKUP_SCHEDULE` to `enabled` only after a manual backup has succeeded and an officer has authorized the scheduled read of production. This repository does not set that variable by itself.

## Local test

```bash
python scripts/test_sql_restore_checkpoint.py
python scripts/test_sql_backup_fetch.py
python scripts/test_sql_restore.py
```

Set `DKP_PG_TEST=1` to fail instead of skip when Docker, `psql`, `pg_dump`, or `age` is missing. The test uses two disposable Postgres databases. It does not read a production URL.

The test checks source DKP totals, preserved destination auth and privileges, historical name-only attendance, a rolled-back mid-restore failure, and a second restore that does not duplicate rows. It also zips the backup, discovers it as a same-repository artifact and as an approved-fork artifact, refuses a CSV artifact in that listing, and restores the downloaded bytes.
