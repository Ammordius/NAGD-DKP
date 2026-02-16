# DKP site setup walkthrough (no CLI)

Follow these steps in order. Everything is done in the browser and in this repo.

---

## Part 1: Create a Supabase project

1. Go to **https://supabase.com** and sign in (or create an account with GitHub/email).

2. Click **“New project”**.

3. Fill in:
   - **Name**: e.g. `dkp` or `guild-dkp`
   - **Database password**: choose a strong password and **save it somewhere safe** (you need it to connect to the DB later).
   - **Region**: pick one close to you.
   Click **“Create new project”** and wait until the project is ready (1–2 minutes).

4. You should land on the project **Dashboard**. Keep this tab open; you’ll use it for the next parts.

---

## Part 2: Run the schema SQL

1. In the left sidebar, click **“SQL Editor”**.

2. Click **“New query”** (or the + button).

3. Open the file **`docs/supabase-schema.sql`** from this repo in your editor (e.g. Cursor/VS Code).  
   Select **all** the contents (Ctrl+A) and copy (Ctrl+C).

4. Paste into the Supabase SQL Editor (the big text area).

5. Click **“Run”** (or press Ctrl+Enter).

6. You should see a green “Success” message.  
   If you see any red errors, copy the error message and we can fix the schema.  
   Otherwise, the tables (`profiles`, `characters`, `raids`, etc.) and RLS policies are now created.

---

## Part 3: Get your API keys (for the web app)

1. In the left sidebar, click **“Project Settings”** (gear icon at the bottom).

2. Click **“API”** in the left submenu.

3. On that page you’ll see:
   - **Project URL** – e.g. `https://xxxxxxxxxxxx.supabase.co`
   - **Project API keys**:
     - **anon public** – safe to use in the browser; we use this in the frontend.

4. Copy both and save them somewhere:
   - **Project URL** → you’ll use as `VITE_SUPABASE_URL`
   - **anon public** key → you’ll use as `VITE_SUPABASE_ANON_KEY`

---

## Part 4: Import your data (CSVs)

You have two options.

### Option A: Import via Table Editor (one table at a time)

1. In the sidebar, click **“Table Editor”**.

2. For each table below, do this:
   - Click the table name (e.g. **characters**).
   - Click **“Insert”** → **“Import data from CSV”** (or the upload/import option if the wording is different).
   - Choose the CSV from this repo under **`data/`** (see list below).
   - Map columns: CSV column names should match the table columns. Supabase will suggest mappings; confirm and import.

**Import in this order** (to satisfy foreign keys):

| Table              | CSV file in `data/`        |
|--------------------|----------------------------|
| characters         | `characters.csv`           |
| accounts           | `accounts.csv`             |
| character_account  | `character_account.csv`    |
| raids              | `raids.csv`                |
| raid_events        | `raid_events.csv`          |
| raid_loot          | `raid_loot.csv`            |
| raid_attendance    | `raid_attendance.csv`      |
| raid_event_attendance | `raid_event_attendance.csv` (optional; for per-event DKP earned) |
| raid_classifications | `raid_classifications.csv` |

**Raid classifications:** Run `python build_raid_classifications.py` (after `extract_structured_data.py`) to generate `data/raid_classifications.csv` from `data/raid_loot.csv`, `data/items_seen_to_mobs.json`, and `data/raid_loot_classification.json` (overrides/aliases, e.g. Plane of Time P1/P3). The script also writes `web/public/item_sources.json` so the Loot search page can show “Drops from”. Import `raid_classifications.csv` into the `raid_classifications` table. For the **Mob loot** page, copy `data/dkp_mob_loot.json` to `web/public/dkp_mob_loot.json`, or run `python build_raid_classifications.py --copy-dkp-mob-loot`.

If the importer complains about types (e.g. empty numbers), you can:
- Leave problematic columns unmapped and fix data later, or
- Temporarily change the column type in SQL, import, then change it back.

**Data notes:**
- **Loot item names:** The `raid_loot` table has an `item_name` column and the app shows it on raid detail pages. **Item names are filled by the pipeline**: run `extract_structured_data.py` (after `pull_raids.py`) so `data/raid_loot.csv` is built from `raids/*.html`; re-run when you refresh raid HTML. (Previously the CSVs didn’t include item names. If you have another source (e.g. scrape from raid HTML) that includes item names, you can add an `item_name` column to the CSV or update rows in the Table Editor after import.
- **DKP:** If `raid_event_attendance` is imported, earned uses per-event attendance (matches official site); otherwise earned = sum of each raid’s event DKP for every raid that character attended. Spent = sum of loot costs for that character. Balance = earned − spent. The DKP page shows **one row per account** (all toons on the same account summed). Account labels use the account’s **display name** when set; run `docs/supabase-account-display-names.sql` in Supabase SQL Editor after importing accounts. That script is generated from `ground_truth.txt` (first character per account in file order) so names match the official DKP export.

**DKP not matching ground truth (e.g. Spent = 0 or Earned too low)?**
- **Spent = 0 for everyone** → `raid_loot` is missing or empty in Supabase. Import `data/raid_loot.csv` into the `raid_loot` table (Table Editor → raid_loot → Import from CSV). The app needs `char_id` or `character_name` and `cost` on each row to compute spent.
- **Earned much lower than official** → Either only a subset of raids/events is in Supabase, or **per-event attendance** is missing. For earned to match the official DKP export (see `docs/DKP-GROUND-TRUTH.md`): (1) Run `pull_raid_attendees.py` and `parse_raid_attendees.py` to create `data/raid_event_attendance.csv`, (2) Import that CSV into the `raid_event_attendance` table. Without it, the app uses raid-level attendance and may over- or under-credit depending on data.
- In Supabase Table Editor, check row counts: `raid_loot` and `raid_events` should have thousands of rows if you have full history; `raid_event_attendance` should have many rows for per-event earned.

**After importing (or re-importing) raid/attendance/loot data:** Run a full refresh once to build the DKP cache: log in as an officer and click **“Refresh DKP totals”** on the DKP page, or in SQL Editor run `SELECT refresh_dkp_summary();` After that, **new** attendance and loot rows are applied automatically (triggers update the cache on every INSERT). If you edit or delete historical rows, run “Refresh DKP totals” again to correct. The DKP page reads from this cache; if empty it falls back to live computation (slower).

**Cache refresh behavior:** The cache is updated **whenever a new row is added** to `raid_event_attendance`, `raid_attendance`, or `raid_loot` (incremental delta). Because the 30d/60d attendance windows roll with the calendar, run a **full refresh at least daily** (e.g. Supabase Dashboard → Database → Extensions → enable `pg_cron`, then schedule `SELECT refresh_dkp_summary_internal();` daily, or use an external cron that calls the RPC). Otherwise 30d/60d columns will drift until the next manual refresh.

### Option B: Import via SQL (copy/paste from CSVs)

If the Table Editor importer is awkward, we can add a small script that reads your `data/*.csv` files and outputs `INSERT` statements (or a single SQL file) you can paste into the SQL Editor. Say if you want that and we’ll generate it.

### Manually adding one raid (if pull_raids.py can't fetch it)

If you're missing a single raid (e.g. due to 403), save it from the browser: open the raid details page, get the **raid ID** from the URL (the number after `raidId=`), then **Save As** → "Webpage, Complete" to `raids/raid_<raidId>.html`. Run `python refresh_raid_index.py` to update `raids_index.csv` from the HTML; then re-run `extract_structured_data.py` if you use the pipeline.

---

## Updating the website (after you change data or code)

When you refresh raid data or re-run the pipeline, update the site in two places: **Supabase (data)** and **frontend (code)** if you host it.

### 1. Refresh your local data

Run your usual pipeline so the `data/` CSVs are up to date, for example:

- `python extract_structured_data.py` — rebuilds `raid_events`, `raid_loot`, `raid_attendance`, `raids`, etc. from `raids/*.html`
- `python parse_raid_attendees.py` — builds `data/raid_event_attendance.csv` from `raids/raid_*_attendees.html`
- `python build_raid_classifications.py` — if you use raid classifications / loot search

(You don’t need to re-run `pull_raids.py` or `pull_raid_attendees.py` unless you’re fetching new raids.)

### 2. Re-import CSVs into Supabase

In the Supabase **Table Editor**, for each table that gets new data, either:

- **Replace data:** Delete all rows (e.g. right‑click table → Delete all rows, or run `DELETE FROM raid_events;` in SQL Editor), then **Insert** → **Import data from CSV** and choose the updated file from `data/`, or  
- Use **Import data from CSV** and let Supabase append; if you do that, avoid duplicate rows (e.g. re-import only after clearing the table).

**Tables you’ll usually re-import after a pipeline run:**

| Table | CSV |
|-------|-----|
| raids | `raids.csv` |
| raid_events | `raid_events.csv` |
| raid_loot | `raid_loot.csv` |
| raid_attendance | `raid_attendance.csv` |
| raid_event_attendance | `raid_event_attendance.csv` (if you use per-event DKP) |
| raid_classifications | `raid_classifications.csv` (if you ran `build_raid_classifications.py`) |

If the **raid_event_attendance** table doesn’t exist yet, run the schema again (Part 2) or run just the `CREATE TABLE raid_event_attendance ...` and related index/RLS statements from `docs/supabase-schema.sql`, then import `data/raid_event_attendance.csv`.

### 3. Redeploy the frontend (if hosted)

If the app is deployed (e.g. Vercel, Netlify), push your code changes and let the site redeploy, or trigger a deploy from the host’s dashboard. That way the live site uses the latest logic (e.g. DKP page using per-event attendance when the table is filled).

---

## Part 5: Turn yourself into an officer

Right now there are no users, so no one can log in. After you run the web app and sign up once, you’ll create a user; then you give that user the officer role.

1. **Create your user (do this after Part 6):**
   - Run the web app locally (Part 6).
   - Open the app in the browser, go to the login page, and **“Sign up”** with your email and a password.
   - Complete sign-up (and confirm email if Supabase email confirmation is on).

2. **Find your user ID:**
   - In Supabase: **Authentication** → **Users**.
   - You’ll see your user; click the row or the user to see details.
   - Copy the **User UID** (a long UUID like `a1b2c3d4-e5f6-7890-abcd-ef1234567890`).

3. **Set your role to officer:**
   - Go to **SQL Editor** → **New query**.
   - Paste this (replace the UUID with your User UID):

   ```sql
   UPDATE profiles SET role = 'officer' WHERE id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
   ```

   - Click **Run**.  
   After that, when you sign in to the app you’ll see the Officer label and any officer-only UI.

---

## Part 6: Run the web app locally

1. Open a terminal in this repo and go to the web app folder:
   ```bash
   cd c:\TAKP\dkp\web
   ```

2. Create the env file:
   - Copy `web/.env.example` to `web/.env.local`.
   - Edit `web/.env.local` and set:
     - `VITE_SUPABASE_URL` = your **Project URL** from Part 3
     - `VITE_SUPABASE_ANON_KEY` = your **anon public** key from Part 3

3. Install and run:
   ```bash
   npm install
   npm run dev
   ```

4. Open the URL it prints (e.g. **http://localhost:5173**). You should see the login page.

5. Sign up with your email and a password, then sign in.

6. Go back to **Part 5** and run the `UPDATE profiles SET role = 'officer' ...` SQL with your User UID. Refresh the app; you should see “Officer” in the nav.

---

## Part 7: Deploy to Vercel (optional, free)

1. Push this repo to **GitHub** (if it isn’t already).

2. Go to **https://vercel.com** and sign in (e.g. with GitHub).

3. Click **“Add New…”** → **“Project”**, then import your GitHub repo.

4. In project settings:
   - **Root Directory**: set to **`web`** (so Vercel builds the React app).
   - **Environment Variables**: add:
     - `VITE_SUPABASE_URL` = your Project URL
     - `VITE_SUPABASE_ANON_KEY` = your anon public key  
   Then save/deploy.

5. After the build, Vercel gives you a URL like `https://your-project.vercel.app`. Use that to share the DKP site; everyone signs in with the accounts you create in Supabase.

---

## Optional: Loot-to-character assignment (Magelo)

To link each raid loot row to the **toon that actually has the item** (from Magelo): (1) Run **`docs/supabase-loot-to-character.sql`** in the SQL Editor. (2) Put Magelo dumps in place (`character/TAKP_character.txt`, `inventory/TAKP_character_inventory.txt`) and ensure `magelo/elemental_armor.json` exists (e.g. Magelo repo as sibling of `dkp`). (3) Export **`raid_loot`** from Supabase (with **`id`**), save as `data/raid_loot.csv`, then run **`python assign_loot_to_characters.py`** (it preserves `id`). (4) Run **`python update_raid_loot_assignments_supabase.py`** (with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`) to update existing rows by id—do not re-import the full CSV or you will get duplicates. See **`docs/LOOT-TO-CHARACTER.md`** for full rules and CI. Per-character assignment is automated from Magelo and heuristics and may be inaccurate; treat those stats as best-effort.

---

## Quick checklist

- [ ] Part 1: Supabase project created, password saved
- [ ] Part 2: `docs/supabase-schema.sql` run in SQL Editor, success
- [ ] Part 3: Project URL and anon key copied
- [ ] Part 4: All 7 CSVs imported (characters, accounts, character_account, raids, raid_events, raid_loot, raid_attendance)
- [ ] Part 5: Signed up in the app, then ran `UPDATE profiles SET role = 'officer'` with your User UID
- [ ] Part 6: `web/.env.local` set, `npm run dev` works, you can log in and see Officer
- [ ] Part 7 (optional): Repo on GitHub, Vercel project with root `web` and env vars, deploy works
- [ ] Optional: Loot-to-character – run `docs/supabase-loot-to-character.sql`, export raid_loot (with id), run `assign_loot_to_characters.py`, then `update_raid_loot_assignments_supabase.py` (do not re-import raid_loot)

If you tell me which part you’re on and what you see (or any error message), I can give you the exact next click or fix.
