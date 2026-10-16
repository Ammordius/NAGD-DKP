# Full database backup and restore

The daily portable SQL backup remains the frequent recovery point for guild DKP. It is unchanged. This weekly full backup is the copy that also keeps website users: `auth.users`, `auth.identities`, password hashes, `public.profiles`, `public.officer_audit_log`, and every other classified table the catalog finds. It does not use the portable 13-table allowlist.

The first full backup is manual. The Sunday schedule is not registered until that artifact has been verified. Hosted restore is implemented and stays closed: the workflow cannot turn writes on.

No new GitHub secrets, variables, or environments are required.

## What each backup is for

| | Daily portable SQL | Weekly full database |
| --- | --- | --- |
| Workflow | DB SQL backup | Full self-host backup |
| Artifact | `sql-backup-*` | `full-db-backup-*` |
| Format | portable SQL | `full-db-1` |
| Users and password hashes | left in place on restore | included |
| When it runs | daily once `SQL_BACKUP_SCHEDULE` is `enabled`, plus manual | manual until the Sunday cron is added |

CSV backup is unchanged and stays disabled as it already is in that workflow's own behavior. This work does not re-enable it.

## Configuration already in use

These are the same names the portable SQL workflows use. Scopes match the workflow YAML.

| Name | Kind | Scope | Used by |
| --- | --- | --- | --- |
| `SUPABASE_DB_URL` | Secret | Repository | Full backup. Verify and restore read it too. Session pooler, port 5432, `sslmode=require`. |
| `SQL_BACKUP_AGE_RECIPIENT` | Secret | Repository | Full backup only. Public `age1...` key. |
| `SQL_BACKUP_AGE_IDENTITY` | Secret | Repository | Inspect and verify. Not the backup job, not list, and not pin. |
| `SQL_RESTORE_DESTINATION_NAME` | Variable | Repository | `nagd-dkp` |
| `SQL_RESTORE_DESTINATION_HOST` | Variable | Repository | Session-pooler host, no user or password |
| `SQL_RESTORE_DATABASE_NAME` | Variable | Repository | `postgres` |
| `SQL_RESTORE_PROJECT_REF` | Variable | Repository | `ynvwtvphqsevhpytcugj` |

The backup job does not declare an environment, so the four destination variables must be repository variables. Variables that exist only on `sql-restore` are invisible to that job. Inspect, verify, and restore declare `environment: sql-restore` and still read those repository variables with `vars.`.

`sql-restore` is the existing protected environment. This workflow does not create another one and does not call the environments API. Required reviewers and the deployment branch policy stay with the environment administrator. The jobs also require `main`.

Changing `SQL_RESTORE_DESTINATION_*` to point at a new project also retargets the portable SQL restore. Leave them on production unless that is a deliberate choice for both workflows.

Local disposable tests still use `FULL_DB_DATABASE_URL` and `FULL_DB_BACKUP_AGE_RECIPIENT`. Those are not GitHub configuration.

## Age keys

One key pair encrypts both the portable guild backup and the full database backup. The private identity decrypts password hashes, so it stays off the backup job. Keep a copy of the private identity outside GitHub. Losing it makes every encrypted artifact unreadable. Do not generate a new key in Actions and do not replace the existing recipient.

## First manual backup

Hosted inventory was not run from this workstation. `SUPABASE_DB_URL` is not stored here. The manual workflow runs `docs/full-db-hosted-inventory.sql` with `default_transaction_read_only=on` and stops before `pg_dump` unless the server is PostgreSQL 17 and the connection proves `SQL_RESTORE_PROJECT_REF`.

1. On `main`, open Actions → Full self-host backup → Run workflow.
2. Confirm the log shows the inventory and `FULL DATABASE BACKUP: PASS`.
3. Confirm the artifact name starts with `full-db-backup-`, the age header is present, and the summary lists SHA-256, size, table count, and the coverage lines below.
4. Only after that artifact is verified, add this trigger to `.github/workflows/full_self_host_backup.yml`:

```yaml
on:
  workflow_dispatch:
  schedule:
    - cron: '0 8 * * 0'
```

`0 8 * * 0` is 08:00 UTC Sunday, after the 07:30 UTC daily portable backup. Do not add a schedule variable. Do not upload a second weekly or monthly copy. Each artifact is its own restore point. A later backup does not delete an earlier one.

The job summary reports:

- `FULL DATABASE BACKUP: PASS` or `FAIL`
- PostgreSQL data coverage
- Auth and user-data coverage
- Storage object bytes: `NOT INCLUDED`
- Vault: `CIPHERTEXT ONLY`
- External JWT, OAuth, and dashboard settings: `NOT INCLUDED`

`PASS` means the encrypted database artifact uploaded. It does not mean the whole Supabase project can be recreated.

## Inspect and verify

Actions → Full self-host restore. Choices are static. The list job prints artifact ids; copy one when you choose Specific artifact ID.

List does not decrypt and does not use `sql-restore`. Inspect and verify run only from `main`, use `sql-restore`, and decrypt with `SQL_BACKUP_AGE_IDENTITY`. Verify also opens a read-only session and runs the inventory script. Neither job writes SQL.

The pin is the artifact id, repository, workflow run, and SHA-256 of the zip. A later job downloads that id again. It does not look up Latest a second time.

Portable `sql-backup-*` artifacts and CSV artifacts are rejected.

## Website users

A full artifact contains the authentication tables and the profile, claim, and officer rows that live in Postgres. Restore replays them with the certified `full-db-1` member order: roles, schema, auth-custom triggers, data, history, then clears `restore_in_progress`.

Password hashes being present is not the same as a successful login. After a real restore, sign in through GoTrue with a known account and confirm an officer can read the audit log and a player cannot. This repository's certification did that on disposable local projects. The hosted workflow does not do it yet.

## New Supabase project

The certified restore target is a newly initialized project whose platform schemas, extensions, and reserved roles already exist. The hosted workflow refuses to start that write. It also refuses a destination that already has `auth.users` rows, rather than merging users or wiping managed roles.

There is no separate recovery-project variable. Pointing the existing destination variables at a new project would also point the portable SQL restore there.

## What this backup does not recover

- Storage object bytes. Bucket and object metadata can be in the dump. The file bytes are not.
- Vault plaintext. Ciphertext may be archived. A new project cannot decrypt it without the external pgsodium key.
- JWT signing keys, anon and service-role API keys, OAuth provider settings, SMTP, and dashboard configuration.
- Default privileges owned by roles other than `postgres`. Explicit grants are kept.

Because those stay outside the artifact, a database restore that otherwise matches is `PROJECT_RECOVERY_CONDITIONAL`, not complete project recovery. `RECOVERY_FAILED` means the run did not restore the database.

## Retention and an off-site copy

The workflow requests 90 days, which is the longest `actions/upload-artifact` retains an artifact. GitHub may expire it sooner if the repository policy is shorter. Download the verified `full-db-backup-*.tar.gz.age` and store that ciphertext somewhere else you control. Do not decrypt it to make the copy. The private key stays with the existing age identity, not inside the copy.

## Emergency restore

Hosted destructive restore is not activated. Running Restore full database from `main` requires the destination name in the confirmation `RESTORE FULL DATABASE nagd-dkp`, passes the identity checks, and then stops with `RECOVERY_FAILED` and the message that hosted restore is not activated. It does not modify the database.

To activate it later, after a separate rehearsal on a disposable project:

1. Keep the local disposable checks as they are.
2. Confirm a read-only full backup of the destination uploaded and verified, and that this backup is not the artifact being restored.
3. Confirm the destination is a new project with zero `auth.users` rows, or stop. Do not wipe a populated project from this workflow.
4. Change `HOSTED_WRITES_ENABLED` in `scripts/full_db_restore.py` only when that rehearsal has passed and you explicitly authorize it.
5. Give the restore step `SQL_BACKUP_AGE_IDENTITY` in the same change. The inactive restore job does not have that secret.
6. Rehearse login and officer authorization before treating the site as recovered.
7. Leave cron, `net`, `pgmq`, and HTTP hooks inert. Do not turn external integrations back on in the restore job.

`DATABASE_RECOVERY_PASS` can be reported for the Postgres data. The headline remains `PROJECT_RECOVERY_CONDITIONAL` while storage bytes or external secrets are missing.
