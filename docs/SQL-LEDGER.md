# Public SQL Ledger (GitHub Pages)

The **Public SQL Ledger** audits the database for changes and displays a **daily delta** on a GitHub Pages site. It provides a transparent, historical record of database state. Because it is hosted on GitHub, it acts as a **root of trust**: even a site admin cannot easily wipe it without leaving a trace (history lives in the repo and in Actions).

## Backup type selection

When you run the SQL Ledger workflow (manually or on schedule), you can choose which backup artifacts to compare:

| Type     | Artifact name pattern              | Default |
|----------|------------------------------------|--------|
| **daily**  | `supabase-backup-YYYY-MM-DD`       | Yes (schedule and manual) |
| **weekly** | `supabase-backup-weekly-YYYY-Www`  | No |
| **monthly** | `supabase-backup-monthly-YYYY-MM` | No |

- **Scheduled runs** (cron): always use **daily** (two most recent daily backups).
- **Manual run** (Actions → “SQL Ledger” → Run workflow): use the **“Backup artifact type to compare”** dropdown. Pick **daily**, **weekly**, or **monthly** to compare the two most recent artifacts of that type. Default is **daily**.

The report title and index page show the type and the two backup labels (e.g. `2026-02-15 → 2026-02-18` for daily, `2026-W06 → 2026-W07` for weekly, `2026-01 → 2026-02` for monthly).

## What is included

- **Backup-to-backup comparison**: the CI compares the two most recent backup artifacts of the selected type (from the [DB backup](CI-DB-BACKUP.md) workflow) and generates an HTML report. Default is daily-to-daily.
- **All audited tables** from the schema are included **except**:
  - **`raid_loot`** — loot assignments to character are excluded by design (as requested).
- Tables that are diffed: `profiles`, `characters`, `accounts`, `character_account`, `raids`, `raid_events`, `raid_attendance`, `raid_event_attendance`, `raid_dkp_totals`, `raid_attendance_dkp`, `raid_classifications`, `dkp_adjustments`, `dkp_summary`, `dkp_period_totals`, `active_raiders`.  
  (`officer_audit_log` is in the schema but not exported by the backup script by default; if you add it to the export, you can add it to `scripts/ledger_delta.py`’s `LEDGER_TABLES` and `TABLE_KEYS`.)

## How it works

1. **DB backup workflow** (`.github/workflows/db-backup.yml`) runs on a schedule and, when data has changed, exports public tables to CSV and uploads a rolling artifact named `supabase-backup-YYYY-MM-DD`.
2. **SQL Ledger workflow** (`.github/workflows/sql-ledger.yml`) runs daily (after the backup) or on manual trigger. It:
   - Uses the selected backup type (daily, weekly, or monthly; default daily) and picks the **two most recent** artifact names of that type.
   - Downloads those two artifacts (from their respective workflow runs).
   - Extracts the backup CSVs and runs `scripts/ledger_delta.py` to diff every table (except `raid_loot`).
   - Generates:
     - **`delta.html`** — the daily delta report (added / removed / changed rows per table).
     - **`index.html`** — landing page with a link to the latest delta.
   - Uploads the `ledger/` directory as a GitHub Pages artifact and deploys to GitHub Pages.

## Enabling GitHub Pages

1. In the repo: **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. The first time the SQL Ledger workflow runs and deploys, the site will be available at  
   `https://<owner>.github.io/<repo>/`  
   (or your custom domain if configured).

If there are fewer than two daily backup artifacts, the ledger workflow still publishes an index page that says “No delta yet” and links to Actions.

## Opening backups and comparing two dates

- **Latest delta**: the published page always shows the **latest** delta (newest backup vs. previous backup). Open the site and click the “Latest delta” link to view `delta.html`.
- **Other backups**: backup files live as **GitHub Actions artifacts** (rolling 7 days, plus weekly/monthly). To compare two specific backup dates:
  1. Go to **Actions → DB backup (on change)** and find runs that produced the dates you want.
  2. Download the two artifacts (`supabase-backup-YYYY-MM-DD`).
  3. Locally: extract both `.tar.gz` files so you have two directories (e.g. `backup_old/`, `backup_new/` with CSVs inside).
  4. Run:
     ```bash
     python scripts/ledger_delta.py --old backup_old --new backup_new --out my_delta.html --old-date 2026-02-15 --new-date 2026-02-18
     ```
  5. Open `my_delta.html` in a browser.

## Files

| File | Purpose |
|------|--------|
| `.github/workflows/sql-ledger.yml` | CI: fetch two latest backup artifacts, diff, generate HTML, deploy to Pages. |
| `scripts/ledger_delta.py` | Diffs two backup dirs (CSV per table), excludes `raid_loot`, outputs HTML (and optional JSON). |
| `docs/SQL-LEDGER.md` | This doc. |

## Security and trust

- The ledger is **read-only** and only reflects data that was already exported by the backup workflow (same Supabase access as backup).
- Content is built in CI and deployed to GitHub Pages; the published site does not talk to your database.
- Deleting or altering the published site would require changing the repo or Actions, which is visible in history and permissions.
