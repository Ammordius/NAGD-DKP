# Fetch a portable SQL backup artifact

Listing and dry-run now live in [DB SQL restore](CI-DB-SQL-RESTORE.md). The standalone discovery and fetch workflows have been removed. This page describes the reader those operations still call. It does not restore a database, and it does not need `SUPABASE_DB_URL`, `SUPABASE_URL`, or `SUPABASE_SERVICE_ROLE_KEY`.

The job prints a summary and leaves a downloaded file on the runner only when a fetch is requested. It does not upload a new artifact. A git fork relationship does not by itself grant access to another repository's Actions artifacts. The script accepts a repository only when GitHub says it is `Ammordius/NAGD-DKP` or a fork of that repository, identified by node id `R_kgDORQRiNA`, and the repository has `db-sql-backup.yml`. Rimi's deployment is node id `R_kgDORnePRA`.

Script: [`scripts/sql_backup_fetch.py`](../scripts/sql_backup_fetch.py).

## Fork network

Open **DB SQL restore** and choose **List available backups** to list the root and every accessible fork, including forks of forks. The summary shows the repository, deployment, GitHub repository id, whether it is an eligible fork, checkpoints, timestamps, daily/weekly/monthly copies, artifact ids, and why a source cannot be read. A private fork the tokens cannot see is omitted and is not authorized. Typing an unrelated `owner/name` does not make it a source.

A renamed repository stays the same source. GitHub resolves the old name and the current name to one repository id. The manifest's `source_repository` must resolve to the repository that actually stored the artifact. When `source_repository_id` is present it must be that repository's numeric id. Older artifacts omit that field and remain valid. A copied archive, whose manifest names a different repository, is refused. The manifest is not rewritten. The error tells the operator to generate a new backup in the selected repository.

Eligible runs must be on `main`. A successful run on any other ref is rejected, including when you pass its artifact id.

## What is selected

The script searches the workflow file `db-sql-backup.yml` only. It pages through GitHub's results. It keeps a run only when `status` is `completed` and `conclusion` is `success`.

Latest discovery accepts only `sql-backup-YYYYMMDDTHHMMSSZ`. A name that merely contains `backup` is not enough. `supabase-backup-*` artifacts from the CSV workflow are rejected and are not treated as SQL. `sql-backup-weekly-<YYYY-Www>` and `sql-backup-monthly-<YYYY-MM>` are ignored by latest discovery. Pass their artifact id to download one. The zip member is still `sql-backup-<utc>.tar.gz.age`.

Expired artifacts are rejected (`expired`, or `expires_at` already passed). If one run has two eligible SQL artifacts, pass an artifact id. Otherwise the script stops instead of guessing.

Selection order:

1. Artifact id, when you pass one. The script still checks the workflow, the run result, the branch, the name, and the expiry. An explicit id may be a daily, weekly, or monthly SQL artifact. It may not be a CSV artifact.
2. Workflow run id, when you pass one and leave the artifact id empty.
3. The latest eligible artifact.

The download uses `GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/zip`. The zip must contain exactly one `sql-backup-*.tar.gz.age` member, with no absolute paths and no `..`. The file must start with the age header. The zip is capped at 64 MiB.

## GitHub authentication

### Same repository

When the source is the repository running the job, the job uses that repository's `GITHUB_TOKEN` with `actions: read`. No personal access token is required. `GITHUB_TOKEN` can list and download artifacts only in the repository that contains the workflow.

### Another repository

`GITHUB_TOKEN` from the destination cannot read Actions artifacts in another owner's repository. Forking the source does not change that, whether the source is public or private.

For another repository, the job tries unlabeled token slots and uses the first one that can read that repository. The slots are `BACKUP_ARTIFACT_READ_TOKEN_STAGING`, `BACKUP_FORK_READ_TOKEN`, and `BACKUP_FORK_READ_TOKEN_2` through `BACKUP_FORK_READ_TOKEN_4`. The current repository uses `GITHUB_TOKEN`. Do not rename `BACKUP_ARTIFACT_READ_TOKEN_STAGING`. A new fork owned by an account that an existing token can already read needs no workflow change. A new owner needs a token in the next empty slot.

For the initial version, create a fine-grained personal access token and store it under the mapped secret name on the **destination** repository:

1. Open GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.
2. Resource owner: the account that owns the source you need to read. A fine-grained token has one resource owner. A second owner uses the next empty `BACKUP_FORK_READ_TOKEN` slot. A 403 on one token makes the script try the next slot. It does not try a different repository.
3. Repository access: Only select repositories → that source repository.
4. Repository permissions: **Actions → Read-only**. Leave Contents, Administration, and every other permission at **No access**. Actions write is not required.
5. Generate the token and copy it once. Do not commit it, and do not paste it into the workflow file.
6. On the destination repository: Settings → Secrets and variables → Actions → New repository secret. Use `BACKUP_ARTIFACT_READ_TOKEN_STAGING` or the next empty `BACKUP_FORK_READ_TOKEN` slot. The secret name is not the repository name.

If the source account is an organization, an owner may have to approve the token before it can read that repository.

The job's own `GITHUB_TOKEN` still has only `contents: read` and `actions: read`. The personal access token is a separate credential and is used only when the selected source is not the current repository.

### Classic tokens

GitHub's artifact download endpoint asks a classic personal access token for the `repo` scope. That scope includes write access. Do not use a classic token for this reader.

### GitHub App

A GitHub App installed on a source repository can mint an installation token with Actions: Read and no Contents write, Actions write, or administration permission. The token lasts one hour and applies to one installation, so each owning account installs the app separately. This workflow does not mint GitHub App tokens. The fine-grained personal access token above is the credential the job reads.

### Public and private repositories

A private source is invisible unless the token is granted that repository and Actions: Read. Unauthenticated requests do not receive its artifacts.

A public source may expose workflow run metadata more widely. This job still sends a token. The destination `GITHUB_TOKEN` is not accepted as a credential for the other repository. Artifact bytes are downloaded through the authenticated API, then a short-lived redirect. The script drops the `Authorization` header on that redirect so the token is not sent to the storage host.

### Test the token without exposing it

Put the token in an environment variable. Do not pass it as a command-line argument, and do not echo it. `gh` reads `GH_TOKEN` from the environment.

```bash
GH_TOKEN="$BACKUP_ARTIFACT_READ_TOKEN_STAGING" gh api repos/OWNER/REPO/actions/artifacts?per_page=1 >/dev/null
echo "exit:$?"
```

On PowerShell, set `$env:GH_TOKEN` from the existing variable and do not write that variable to the host:

```powershell
$env:GH_TOKEN = $env:BACKUP_ARTIFACT_READ_TOKEN_STAGING
gh api "repos/OWNER/REPO/actions/artifacts?per_page=1" > $null
Write-Output "exit:$LASTEXITCODE"
```

Exit 0 means GitHub accepted a read. A non-zero exit leaves GitHub's error on stderr (`401` bad or missing token, `403` no access, `404` the token cannot see that repository). Those messages do not include the token. If any output contains `github_pat_` or `ghp_`, stop and revoke the token.

Confirm on the token's settings page that Actions is Read-only and that Contents and Administration are No access. Do not send a write request to prove the absence of write.

Replace `OWNER/REPO` with the source you intend to read, for example `Ammordius/NAGD-DKP`.

## Age identity

The uploaded object is `sql-backup-<utc>.tar.gz.age`. Manifest, checksums, schema fingerprint, and row counts are inside that encrypted archive.

Leave `SQL_BACKUP_AGE_IDENTITY` unset to download and check the GitHub zip only. The summary then says `inner_verified: false` and does not describe the snapshot as verified.

To decrypt and verify, store the age **identity** (the `AGE-SECRET-KEY-...` line from `age-keygen`) as the destination secret `SQL_BACKUP_AGE_IDENTITY`. That is the private key. It is not the `age1...` public recipient used by the backup workflow, and it must not be added to the backup workflow. The fetch script writes it to a temporary file mode `0600`, passes that file to `age --decrypt`, and redacts it from errors. It does not print SQL rows.

When the identity is present the script also checks:

- The archive contains only `data.sql`, `manifest.json`, `SHA256SUMS`, and `summary.txt`.
- No links, no `..`, no absolute paths, and no execute bits.
- Decrypted tar at most 128 MiB, extracted members at most 256 MiB total.
- `format_version` and `included_tables` match `scripts/sql_backup.py`.
- `canonical_schema_sha256` is recorded and compared with the checked-out `docs/supabase-schema-full.sql`. A different hash is provenance. The gate is the structural class: formatting/comment-only and additive and compatible continue; potentially incompatible and definitely incompatible fail. The fingerprint does not mark the live catalog as verified.
- `live_schema_status` is `not_assessed`, `compatible`, or `incompatible`. `live_schema_compared_to_repository_file` must be false. A missing block is `not_assessed`, not compatible.
- `source_repository` resolves to the same GitHub repository as the artifact, and `workflow_run_id` is the resolved run. A different name for that same repository is accepted. A different repository is not.
- `SHA256SUMS` matches `data.sql` and `manifest.json`, and the manifest checksum matches `data.sql`.

The script does not execute anything from the archive and does not run `psql`.

## Run the reader

Actions → **DB SQL restore** → Run workflow.

- Operation: **List available backups** does not need a source or a database. **Dry-run restore** and **Restore** use the source choice.
- Source: **Current repository**, **Rimi staging**, or **Other discovered fork**. Other uses the optional `owner/name` field. **Rimi staging** resolves node id `R_kgDORnePRA`, not a historical repository name.
- Checkpoint, workflow run id, and artifact id apply to dry-run and restore. Leave the artifact id empty for a normal checkpoint.

The step summary shows the GitHub artifact identity. With `SQL_BACKUP_AGE_IDENTITY` set, it also shows the manifest's format version, schema fingerprint, schema compatibility class, and row counts. A different schema file hash is provenance. Restore fails only when the structural class is potentially incompatible or definitely incompatible.

## Local test

Discovery tests mock the GitHub API. They do not need a token. Decrypt tests need `age` and `age-keygen` on `PATH`. Schema check runs both. Set `DKP_PG_TEST=1` to fail instead of skip when `age` is missing.

```bash
python scripts/test_sql_backup_fetch.py
```

A live read against GitHub is off unless `BACKUP_ARTIFACT_LIVE_TEST=1`. Put the read token in `BACKUP_FORK_READ_TOKEN` or `BACKUP_ARTIFACT_READ_TOKEN_STAGING`. The test prints neither the token nor the artifact body. A mocked request does not establish that the real secret is authorized. Schema check does not set these variables.

```bash
BACKUP_ARTIFACT_LIVE_TEST=1 \
BACKUP_ARTIFACT_LIVE_REPO=owner/name \
BACKUP_ARTIFACT_LIVE_ARTIFACT_ID=123456789 \
python scripts/test_sql_backup_fetch.py
```

`BACKUP_ARTIFACT_LIVE_REPO` must be the NAGD-DKP root or a fork of it. The live check requests that artifact's metadata only.
