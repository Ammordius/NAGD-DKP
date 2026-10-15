# DKP

Full-stack guild DKP app: **Supabase** (Postgres, auth, RLS), **React** frontend, **Vercel** deploy. Raids, attendance, loot, and a DKP leaderboard with role-based access (anon handshake, player, officer). Data is behind sign-in; officers are granted in the DB.

## What’s in the repo

A single deployable app plus the pipelines and docs to run it in production. The backend is one canonical schema ([`docs/supabase-schema-full.sql`](docs/supabase-schema-full.sql)): tables, RLS policies, triggers for derived totals, and RPCs for uploads and bulk updates. That file is the only schema install and upgrade. Apply it with `psql --single-transaction` as described in [docs/SCHEMA_DEPLOYMENT.md](docs/SCHEMA_DEPLOYMENT.md). The web app is a small React SPA that talks to Supabase (REST and Realtime where it matters). CI covers backup, restore, and a separate “SQL ledger” that publishes human-readable deltas.

**Backup and restore**  
The portable recovery backup is an age-encrypted SQL export of the guild DKP tables ([docs/CI-DB-SQL-BACKUP.md](docs/CI-DB-SQL-BACKUP.md)). Its daily schedule stays off until the repository variable `SQL_BACKUP_SCHEDULE` is `enabled`. A manual run can take a backup without that variable. The older CSV workflow still runs when the `raid_loot` count changes, or when a manual run checks **force**, and the public ledger diffs those CSV artifacts. CSV restore remains available for those artifacts. Profiles and auth are not copied by either restore.

**Audit and compliance**  
Sensitive officer actions (add/delete raid, add/remove tics, loot edits, manual DKP changes) are written to an `officer_audit_log` table with actor, timestamp, action type, and a minimal JSON delta. The app exposes a changelog view. The CSV backup still exports that table for same-project recovery. The portable SQL backup leaves it out, because the rows are tied to `auth.users` on this project. The public ledger continues to diff the CSV artifacts.

**Public SQL ledger**  
A second CI workflow takes the two most recent daily (or weekly/monthly) backup artifacts, diffs them table-by-table, and publishes an HTML report of **added / removed / changed** rows to GitHub Pages. So you get a daily, tamper-resistant record of what changed in the DB, without touching production at report time. Useful for transparency and for answering “what actually changed between these two dates?”

## Tech stack

- **Backend:** Supabase (Postgres 15+, RLS, auth, storage)
- **Frontend:** React, Vite, React Router
- **Hosting:** Vercel (web), GitHub Actions (backup, ledger, restore), GitHub Pages (ledger site)
- **CI:** Scheduled and manual workflows; artifact-based backup and restore; paginated artifact listing so the ledger always uses the last two backups from full history

## Getting started

- **Setup (Supabase, import, run locally, deploy):** [docs/SETUP-WALKTHROUGH.md](docs/SETUP-WALKTHROUGH.md)
- **Auth and lock-down (require login, disable sign-up, egress):** [docs/AUTH-AND-EGRESS-PROTECTION.md](docs/AUTH-AND-EGRESS-PROTECTION.md)
- **Run your own mirror (same app, own DB, backup/CSV as source):** [docs/MIRROR-SETUP-FULL-STACK.md](docs/MIRROR-SETUP-FULL-STACK.md)

## Deploy (Vercel)

1. Push the repo to GitHub.
2. In Vercel: New Project → Import repo → set **Root Directory** to `web`.
3. Add env: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
4. Deploy. See [the walkthrough](docs/SETUP-WALKTHROUGH.md) for Supabase project setup and first data import.
