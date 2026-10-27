# Public DKP change ledger (GitHub Pages)

The **NAGD DKP Mirror — Daily Change Report** is a human-readable record of what changed in the mirror database between successful SQL mirror updates. After each successful scheduled (or forced) mirror restore, CI generates a sanitized report and:

1. Uploads a **dated GitHub Actions artifact** (retained ~90 days; not permanent).
2. Deploys the **latest** report only to GitHub Pages.

**Generated report HTML/JSON is never committed to git** (no `main`, `gh-pages`, or reports branch).

Public URL (this repository):

- Latest report: `https://ammordius.github.io/NAGD-DKP/`

Historical mirror reports: download from the corresponding **DB SQL mirror** workflow run’s Actions artifacts (`mirror-ledger-<stamp>-src-<artifact_id>`).

## What it shows

The report emphasizes **guild events**, not raw SQL row dumps:

1. **Raids and tics** — new/removed/edited raids; added/removed/modified tics; attendance changes (details collapsed by default).
2. **Loot and adjustments** — new/removed/modified `raid_loot` (and assignment changes); manual `dkp_adjustments`.
3. **Character DKP deltas** — before/after balances (`earned`, `spent`, `balance = earned − spent`).
4. **Account DKP deltas** — same for accounts (not a sum of character balances).
5. **Other changes** — characters, accounts, mappings, active lists, classifications (collapsible; public-safe fields only).

Each added raid includes tic name, DKP, attendee count, time when available, and **total potential DKP** (sum of distinct tic DKP values for that raid — not attendees × DKP), plus a link to `https://nagd-dkp.vercel.app/raids/<raid_id>`.

The report is a **snapshot comparison**, not an officer audit trail. The mirror does not copy production `officer_audit_log`.

### Balance sources

| Report type | Balance source | Adjustments |
|-------------|----------------|-------------|
| Scheduled mirror | Live `dkp_summary` / `account_dkp_summary` after restore | Listed separately; not folded into balances |
| Manual SQL artifact compare | Independently reconstructed from portable guild rows (`expected_account_totals` / `expected_character_totals`) | Listed separately; **not** included in reconstructed balances |

Displayed website leaderboard totals that apply adjustments in the frontend may differ from these base balances. The report states which source was used and which validation checks ran or could not run.

## Scheduled mirror flow

Workflow: [`.github/workflows/db-sql-mirror.yml`](../.github/workflows/db-sql-mirror.yml).

When the mirror gate proceeds:

1. Read-only **before** snapshot from the destination (`SUPABASE_DB_URL`).
2. Dispatch and wait for **DB SQL restore**.
3. **Record** the mirrored source artifact id immediately (Pages/report failure cannot force a destructive repeat restore).
4. Read-only **after** snapshot.
5. Diff + write `index.html`, `delta.json`, `manifest.json`.
6. Upload dated Actions artifact; separate **publish** job (no DB secrets) deploys latest `index.html` to Pages.

Plaintext snapshots stay on the runner and are scrubbed. Skip / failed restore never replaces Pages.

### Artifact retention

GitHub Actions artifacts use the repository’s retention settings (this workflow requests **90 days**). History is **not** permanent beyond that retention and storage quota. Prefer downloading important reports promptly.

## Manual SQL artifact comparison

Workflow: [`.github/workflows/compare-sql-artifacts.yml`](../.github/workflows/compare-sql-artifacts.yml).

Compare **any two compatible portable SQL backups** you can authenticate to, including cross-repository, **without restoring** and **without overwriting Pages**.

Inputs:

| Input | Meaning |
|-------|---------|
| `old_repository` | `owner/name` |
| `old_artifact_id` | Exact numeric Actions artifact id |
| `new_repository` | `owner/name` |
| `new_artifact_id` | Exact numeric Actions artifact id |

Output artifact: `sql-compare-<old_id>-vs-<new_id>` containing standalone `index.html`, `delta.json`, `manifest.json`.

### Finding an artifact id

1. Open the source repository → **Actions** → a successful SQL backup run.
2. Open the run → **Artifacts** → note the numeric id from the artifact URL/API, **or**
3. Use `gh api repos/<owner>/<repo>/actions/artifacts` / the restore workflow’s **List available backups**.

### Authentication

- Current repository: job `GITHUB_TOKEN`.
- Other repositories: first configured fork-read PAT that can read that repo’s Actions artifacts (`BACKUP_ARTIFACT_READ_TOKEN_STAGING`, `BACKUP_FORK_READ_TOKEN` … `_4`).
- Decryption: `SQL_BACKUP_AGE_IDENTITY` (must decrypt both archives; mismatched recipients fail closed).

This path uses a **comparison-only** source opener and does **not** weaken restore’s NAGD fork-network authorization.

### How comparison works without a database

1. Download each artifact zip → verify age envelope → decrypt with age → verify checksums, manifest provenance, schema compatibility, table allowlist.
2. Parse `data.sql` COPY blocks into memory.
3. Reconstruct base character/account DKP summaries from guild rows.
4. Run the same semantic diff/report engine as the mirror ledger.
5. Scrub decrypted temp files. Never upload raw SQL.

## Enabling GitHub Pages

1. Repo **Settings → Pages**.
2. **Build and deployment → Source**: **GitHub Actions**.
3. After the first successful mirror publish job: `https://<owner>.github.io/<repo>/`.

The publish job must not receive database credentials.

## Secrets and variables

| Name | Kind | Role |
|------|------|------|
| `SUPABASE_DB_URL` | Secret | Mirror job snapshots only |
| `SQL_BACKUP_AGE_IDENTITY` | Secret | Decrypt portable backups (mirror restore + manual compare) |
| `SQL_MIRROR_SOURCE` / `SQL_MIRROR_SCHEDULE` | Variables | Mirror schedule/source |
| Fork-read token slots | Secrets | Cross-repo artifact reads |

## Local tools and tests

```bash
python scripts/test_mirror_ledger.py
python scripts/test_sql_artifact_compare.py
python scripts/test_sql_mirror_gate.py
```

Offline report from snapshot dirs:

```bash
python scripts/mirror_ledger_report.py --old snap_before --new snap_after --out ledger_site \
  --source-repository SomeOrg/Some-Fork --source-artifact-id 12345
```

## Files

| File | Purpose |
|------|---------|
| `.github/workflows/db-sql-mirror.yml` | Mirror + snapshot + dated artifact + Pages latest |
| `.github/workflows/compare-sql-artifacts.yml` | Manual cross-repo SQL compare (artifact-only) |
| `scripts/mirror_ledger_snapshot.py` | Live DB read-only snapshot |
| `scripts/mirror_ledger_diff.py` | Semantic diff + validation |
| `scripts/mirror_ledger_report.py` | HTML / delta.json / manifest.json |
| `scripts/sql_artifact_compare.py` | Fetch/decrypt/reconstruct/compare portable backups |
| `scripts/ledger_delta.py` | Deprecated CSV helper |
| `.github/workflows/sql-ledger.yml` | Retired CSV Pages publisher |

## Retired CSV ledger

The old CSV `supabase-backup-*` Pages publisher is retired and cannot overwrite the mirror Pages site.
