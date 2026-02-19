# Full-stack mirror setup (step-by-step)

This guide walks through setting up a **complete mirror** of the DKP site: your own database (Supabase), your own GitHub repo with the same CI workflows, and the same data and frontend. The mirror has its own DB and can run backups, the SQL Ledger, and (optionally) loot-to-character assignment independently.

---

## What you get

- **Own Supabase project** — separate from any other instance; you control schema and data.
- **Same CI** — DB backup (on change), SQL Ledger (daily delta to GitHub Pages), and optionally loot-to-character assignment.
- **Same data** — loaded either from a **backup artifact** (e.g. from the original repo’s Actions) or from your own `data/` CSVs.
- **Same web app** — React frontend deployed to Vercel (or similar), pointed at your Supabase.

---

## Prerequisites

- **GitHub account** — to host the repo and run Actions.
- **Supabase account** — [supabase.com](https://supabase.com).
- **Vercel account** (optional) — for frontend deploy; [vercel.com](https://vercel.com).
- **Python 3.11+** — only if you load data from backup artifacts or run scripts locally (e.g. extract CSVs from a `.tar.gz`).
- **Node.js** — for running the web app locally and for Vercel build.

---

## Step 1: Get the code

1. **Fork or clone** the DKP repo to your GitHub (e.g. `your-org/dkp-mirror`).
2. Clone locally:
   ```bash
   git clone https://github.com/YOUR_ORG/dkp-mirror.git
   cd dkp-mirror
   ```
3. Ensure you have the `docs/` SQL files and `.github/workflows/` in the repo (they are part of the repo).

---

## Step 2: Create your Supabase project (mirror DB)

1. Go to [supabase.com](https://supabase.com) and sign in.
2. **New project** → choose **Name** (e.g. `dkp-mirror`), **Database password** (save it), **Region**.
3. Wait until the project is ready.

You will use this project for all schema and data; CI and the web app will talk only to this DB.

---

## Step 3: Run SQL in order (schema + optional)

Run these in the Supabase **SQL Editor** (New query → paste → Run). Order matters: schema first, then optional extensions.

### 3.1 Core schema (required)

1. Open **`docs/supabase-schema.sql`** from the repo, copy all of it, paste into SQL Editor, **Run**.  
   This creates tables, RLS, triggers, RPCs, and the `handle_new_user` trigger. You should see “Success.”

### 3.2 Optional SQL (run if you use those features)

| File | When to run |
|------|-------------|
| **`docs/supabase-loot-to-character.sql`** | If you want loot-to-character assignment (Magelo) and the `update_raid_loot_assignments` RPC. Required for the **Loot-to-character** CI workflow. |
| **`docs/supabase-loot-assignment-table.sql`** | Loot assignment split (loot_assignment table + RPC). Run if you use the split schema; then run **`docs/supabase-github-worker-role.sql`** for CI. |
| **`docs/supabase-github-worker-role.sql`** | For GitHub Actions: creates `github_worker` role (SELECT on all tables, EXECUTE on `update_raid_loot_assignments` / `refresh_after_bulk_loot_assignment`, INSERT/DELETE on `character_loot_assignment_counts`, UPDATE on `characters`). Run after **loot-assignment-table** SQL. Then use a JWT with `role: github_worker` as your CI key (see Step 5 Option B). |
| **`docs/supabase-officer-audit-log.sql`** | If you want the officer audit log table (may already be in schema; run only if the table or policies are missing). |
| **`docs/supabase-create-my-account-rpc.sql`** | If the schema doesn’t already define `create_my_account` / account-claiming (usually already in main schema). |
| **`docs/supabase-anon-read-policies.sql`** | Only if you need to re-apply anon read policies (main schema already includes anon read; use only if you changed RLS). |

Do **not** run `docs/supabase-reset-and-import.sql` now; that truncates data and is for re-imports later.

---

## Step 4: Load data into your mirror DB

You need to get CSV data into Supabase. Two main options: **from a backup artifact** (e.g. from the original repo’s Actions) or **from your own `data/` CSVs**.

### Option A: Restore from a GitHub backup artifact (recommended if you have one)

Use this when you have a backup from the **original** repo’s Actions or from your mirror after at least one successful DB backup run. The first time you set up the mirror, you can use an artifact from the source repo; after that your own CI will produce artifacts.

1. In the **source** repo (or your mirror), go to **Actions** → workflow **“DB backup (on change)”**.
2. Open a run that has artifacts and **download** the artifact named like **`supabase-backup-YYYY-MM-DD`** (or a weekly/monthly one). GitHub gives you a **zip** file.
3. Unzip it; inside you’ll see **`backup-YYYY-MM-DD.tar.gz`**. Extract that:
   ```bash
   tar xzf backup-YYYY-MM-DD.tar.gz
   ```
   You should get a **`backup/`** directory with one CSV per table (e.g. `raids.csv`, `raid_loot.csv`, `profiles.csv`, …).
4. In **Supabase → Table Editor**, for each table that has a CSV in `backup/`:
   - Open the table → **Insert** → **Import data from CSV**.
   - Choose the corresponding CSV from `backup/` and map columns to match (names usually match).
5. **Import order** (respect foreign keys):  
   `characters` → `accounts` → `character_account` → `raids` → `raid_events` → `raid_loot` → `raid_attendance` → `raid_event_attendance` → `raid_classifications` → `raid_dkp_totals` → `raid_attendance_dkp` → `dkp_adjustments` → `dkp_summary` → `dkp_period_totals` → `active_raiders` → `profiles` (if you want to copy profile rows; often you’ll create new users and only set one officer — see Step 8).

**Note:** Backup artifacts do **not** include `character_loot_assignment_counts`. If you use loot-to-character, CI will populate that table after the first run, or you can import `data/character_loot_assignment_counts.csv` if you have it.

### Option B: Import from your own `data/` CSVs

If you have (or generate) CSVs in the repo’s `data/` directory:

1. Use the same **import order** as in [SETUP-WALKTHROUGH.md](SETUP-WALKTHROUGH.md) Part 4 and in the comments of **`docs/supabase-reset-and-import.sql`**:
   - characters → accounts → character_account → raids → raid_events → raid_loot → raid_attendance → raid_event_attendance → raid_classifications (and optionally dkp_adjustments).
2. In Supabase: **Table Editor** → each table → **Import data from CSV** and select the matching file from `data/`.

---

## Step 5: GitHub repo secrets (for CI)

CI needs to talk to **your** Supabase project. In your **mirror** repo go to **Settings** → **Secrets and variables** → **Actions** and add:

| Secret | Value | Used by |
|--------|--------|--------|
| **`SUPABASE_URL`** | Your Supabase **Project URL** (Settings → API) | DB backup, Loot-to-character |
| **`SUPABASE_SERVICE_ROLE_KEY`** | See below: **service_role** key **or** scoped JWT | Same workflows |

Without these, the **DB backup** and **Loot-to-character** workflows will skip or fail. The **SQL Ledger** workflow only uses backup artifacts and does not call Supabase.

### Option A: Service role key (simplest)

Use your Supabase **service_role** key (Dashboard → Project Settings → API → **service_role** secret). Paste it into the **`SUPABASE_SERVICE_ROLE_KEY`** secret. This key has full access; use it if you prefer minimal setup.

### Option B: Scoped API key (GitHub worker JWT, recommended)

Use a **custom JWT** that forces CI to run as the **`github_worker`** role: read-only on most tables, plus only the operations the workflows need (export, loot assignment RPC, character_loot_assignment_counts replace, character level/class update). Requires the **split** loot schema and the worker role.

**1. Run the worker role SQL (if you haven’t already)**  
In Supabase SQL Editor, run **`docs/supabase-loot-assignment-table.sql`** (so `loot_assignment` and the RPC exist), then **`docs/supabase-github-worker-role.sql`**. That creates the `github_worker` role and grants.

**2. Generate a custom JWT**

- In **Supabase Dashboard** → **Project Settings** → **API**, copy your **JWT Secret**.
- Use a JWT generator (e.g. [jwt.io](https://jwt.io)):
  - **Header:** `{"alg":"HS256","typ":"JWT"}`
  - **Payload:** `{"role":"github_worker","iss":"supabase","iat":1708300000}`  
    (Use a real Unix timestamp for `iat`; you can set `exp` far in the future or omit it for no expiry.)
  - **Signature:** paste your **JWT Secret** in the “Verify Signature” box.
- Copy the **encoded JWT** (the long string on the left).

**3. Store it in GitHub**

- Repo → **Settings** → **Secrets and variables** → **Actions**.
- Add or edit **`SUPABASE_SERVICE_ROLE_KEY`** and set its value to the **encoded JWT** (not the service_role key). CI will use this token; Supabase will treat it as the `github_worker` role.

**4. Keep `SUPABASE_URL`**  
Leave **`SUPABASE_URL`** as your project URL (same for both options).

---

## Step 6: Enable GitHub Pages (for SQL Ledger)

The SQL Ledger publishes a daily delta report to GitHub Pages.

1. In your mirror repo: **Settings** → **Pages**.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. Save. After the first successful run of the **“SQL Ledger (daily delta → GitHub Pages)”** workflow, the site will be at `https://<owner>.github.io/<repo>/`.  
   Note: The ledger needs at least **two** backup artifacts to generate a delta; until then it will show “No delta yet.”

---

## Step 7: Deploy the web app (Vercel)

1. Go to [vercel.com](https://vercel.com) and sign in (e.g. with GitHub).
2. **Add New…** → **Project** → import your **mirror** repo.
3. **Root Directory**: set to **`web`**.
4. **Environment variables** (for the mirror’s Supabase):
   - **`VITE_SUPABASE_URL`** = your Supabase Project URL (same as `SUPABASE_URL`).
   - **`VITE_SUPABASE_ANON_KEY`** = your Supabase **anon public** key (Settings → API).
5. Deploy. The site will use your mirror DB only.

---

## Step 8: First officer and post-import refresh

1. **Create a user:** Open your deployed app (or run `npm run dev` in `web/` with `VITE_SUPABASE_*` in `web/.env.local`), sign up with email/password.
2. **Promote to officer:** In Supabase → **Authentication** → **Users** → copy your user’s **UUID**. Then in **SQL Editor** run:
   ```sql
   UPDATE profiles SET role = 'officer' WHERE id = 'YOUR_USER_UUID';
   ```
3. **Refresh DKP caches** (so leaderboard and activity data are correct):  
   As an officer, use the app’s **“Refresh DKP totals”** on the DKP page, or in SQL Editor run:
   ```sql
   SELECT refresh_dkp_summary();
   SELECT refresh_all_raid_attendance_totals();
   ```

---

## Optional: Loot-to-character (Magelo) and data files

If you want the **Loot-to-character** workflow and the Loot Recipients / assignment features:

1. **SQL:** You should have run **`docs/supabase-loot-to-character.sql`** in Step 3.
2. **Secrets:** `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` must be set (Step 5).
3. **Data files** the workflow expects (in repo or generated by CI):
   - **`data/elemental_armor.json`** — from the magelo repo or build process.
   - **`dkp_elemental_to_magelo.json`** — mapping for elemental armor names.
   - Magelo dumps are **downloaded by CI** from TAKP (e.g. `TAKP_character.txt`, `TAKP_character_inventory.txt`); you don’t need to commit them.
4. **First run:** Either run the workflow manually (Actions → Loot-to-character assignment → Run workflow) or wait for the daily schedule. It will fetch raid_loot from your Supabase, pull Magelo dumps, run assignment, then push assignments and `character_loot_assignment_counts` back to your DB.

See [LOOT-TO-CHARACTER.md](LOOT-TO-CHARACTER.md) and [DEBUG-loot-to-character-supabase-sync.md](DEBUG-loot-to-character-supabase-sync.md) for details.

---

## CI summary (what runs and when)

| Workflow | Schedule | What it does | Needs |
|----------|----------|--------------|--------|
| **DB backup (on change)** | Daily (e.g. 07:00 UTC) | If `raid_loot` count changed: exports public tables to CSV, uploads artifact `supabase-backup-YYYY-MM-DD` (and weekly/monthly when applicable). | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| **SQL Ledger** | Daily (e.g. 07:30 UTC) | Downloads two latest backup artifacts, diffs them (excluding `raid_loot`), publishes delta to GitHub Pages. | At least 2 backup artifacts (from DB backup workflow). No Supabase secrets. |
| **Loot-to-character assignment** | Daily (e.g. 18:00 UTC) or manual | Fetches raid_loot (and related) from Supabase, downloads Magelo dumps, assigns loot to characters, pushes assignments and counts to Supabase. | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`; optional: `data/elemental_armor.json`, `dkp_elemental_to_magelo.json` |

All three workflows use the **same** repo and the **same** Supabase project (your mirror DB). The SQL in the repo (e.g. in `docs/`) is the source of schema; data comes from your DB and (for the ledger) from the backup artifacts produced by CI.

---

## Quick checklist

- [ ] Repo forked/cloned (mirror).
- [ ] New Supabase project created; password saved.
- [ ] **docs/supabase-schema.sql** run in SQL Editor.
- [ ] Optional: **docs/supabase-loot-to-character.sql** (and any other optional SQL) run.
- [ ] Data loaded: from backup artifact (Option A) or from **data/** CSVs (Option B), in correct import order.
- [ ] GitHub Actions secrets set: **SUPABASE_URL**, **SUPABASE_SERVICE_ROLE_KEY** (service_role key or scoped JWT per Step 5).
- [ ] GitHub Pages enabled (Source: GitHub Actions).
- [ ] Web app deployed (e.g. Vercel) with **VITE_SUPABASE_URL** and **VITE_SUPABASE_ANON_KEY** for the mirror.
- [ ] First user created and set to officer; **refresh_dkp_summary** and **refresh_all_raid_attendance_totals** run once.
- [ ] (Optional) Loot-to-character: SQL run, data files present; run workflow once to verify.

---

## Reference docs

- **[SETUP-WALKTHROUGH.md](SETUP-WALKTHROUGH.md)** — Single-instance setup (Supabase, import, local run, Vercel).
- **[CI-DB-BACKUP.md](CI-DB-BACKUP.md)** — Backup workflow, retention, restore from artifact.
- **[SQL-LEDGER.md](SQL-LEDGER.md)** — How the ledger workflow and GitHub Pages work.
- **[LOOT-TO-CHARACTER.md](LOOT-TO-CHARACTER.md)** — Loot-to-character assignment and CI.
- **[supabase-reset-and-import.sql](supabase-reset-and-import.sql)** — Truncate and re-import (order of CSVs and refresh commands).
