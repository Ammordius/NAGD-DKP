# Debug: Loot-to-character CI updates Supabase but data doesn’t appear

## Goal

CI should update **Supabase** so that:

1. **raid_loot** rows get `assigned_char_id` and `assigned_character_name` (who actually has the item, from Magelo).
2. **character_loot_assignment_counts** gets one row per character with assigned loot.
3. The **site** (e.g. Vercel) shows “on toon: Badammo” on the account page and “Loot assigned to this toon” on `/characters/Badammo` when the data is in Supabase.

## What’s happening

- **CI reports success**: “Done. Updated 14804 raid_loot rows.” and “Inserted 650 rows into character_loot_assignment_counts.”
- **Observed**: The site (and/or Supabase Table Editor) does **not** show the expected assignments (e.g. Platinum Cloak of War · Ammordius should show “on toon: Badammo”; Badammo’s character page should list that item).
- **Local CSV is correct**: Running `python inspect_loot_assignment.py --item "Platinum Cloak" --buyer Ammordius` on `data/raid_loot.csv` shows `assigned_to=Badammo (via Magelo)`. So the **assign** step produces the right data.

## Pipeline (what CI does)

1. **Fetch** from Supabase: `raid_loot` (with `id`), `characters`, `character_account`, `raids` → `data/*.csv`.
2. **Download** Magelo dumps (or restore from 24h cache).
3. **Assign**: `assign_loot_to_characters.py` reads `data/raid_loot.csv`, preserves existing assignments, assigns unassigned rows, writes back to `data/raid_loot.csv` and `data/character_loot_assignment_counts.csv`.
4. **Update Supabase**:  
   - `update_raid_loot_assignments_supabase.py` → upserts by `id` into `raid_loot` (columns: `assigned_char_id`, `assigned_character_name`, `assigned_via_magelo`).  
   - `push_character_loot_assignment_counts_supabase.py` → deletes all rows in `character_loot_assignment_counts`, then inserts from the CSV.

CI secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

## Why CI wasn't updating (and how to fix it going forward)

**CI does not use the CSVs in the repo as the source for Supabase.** By design, when secrets are set, CI:

1. **Fetches** `raid_loot`, `characters`, `character_account`, `raids` **from Supabase** (overwrites `data/*.csv` in the runner).
2. Downloads Magelo dumps (or uses cache).
3. **Assigns** using that fetched data + Magelo → writes updated `data/raid_loot.csv` and `data/character_loot_assignment_counts.csv`.
4. **Pushes** those results back to Supabase by `id` (update only, no new rows).

So the **live DB is the source of truth** for each run. Repo CSVs are not used when pushing to Supabase.

**Why the site still showed NULL / wrong data:**

1. **Wrong Supabase project (most likely)**  
   If `SUPABASE_URL` in GitHub secrets points to a **different** project than `VITE_SUPABASE_URL` on the site (e.g. Vercel), CI updates the wrong database. The site never sees the changes.  
   **Fix:** Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the repo to the **same** project the site uses. In Vercel (or your host), ensure `VITE_SUPABASE_URL` is that same URL.

2. **Rows skipped by the update script**  
   The updater used to skip any row whose `id` in the CSV was not `isdigit()` (e.g. `"123.0"` from the API). Those rows were never sent, so their `assigned_character_name` stayed NULL.  
   **Fix:** Applied in code: the update script now accepts numeric `id` (e.g. `"123.0"` → 123), and the fetch script writes `id` as an integer string so the CSV stays consistent.

3. **Assign in CI didn't set the toon**  
   Assign links buyers to toons via `character_account` and `characters` (from the same Supabase fetch). If in **that** DB Ammordius and Badammo are not on the same `account_id`, assign leaves the row as namesake (buyer = Ammordius) or doesn't set Badammo.  
   **Fix:** Do a **one-time full reset/import** from your canonical CSVs (see `docs/supabase-reset-and-import.sql`) so Supabase has correct `character_account` and `characters`. After that, CI fetch → assign → update will run against that same DB and the site will show the right assignments.

**Checklist so it works going forward:**

- [ ] CI secrets `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` point to the **same** Supabase project as the site’s `VITE_SUPABASE_URL`.
- [ ] One-time: reset and re-import DKP tables from your CSVs (including `raid_loot` with assignment columns and correct `character_account` / `characters`) so the DB matches your intended data.
- [ ] Run the workflow (or wait for cron). Then in that project’s SQL Editor run:  
  `SELECT id, character_name, assigned_character_name FROM raid_loot WHERE item_name ILIKE '%Platinum Cloak of War%' AND character_name = 'Ammordius' LIMIT 1;`  
  You should see `assigned_character_name = 'Badammo'`.

## Likely causes to check

1. **Different Supabase project**  
   CI might be writing to a **different** project than the one the site uses. The site uses `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (in web env). If CI’s `SUPABASE_URL` is not the same project, updates go to the wrong DB.

2. **RLS (Row Level Security)**  
   The service role key bypasses RLS for **writes**. If something else (e.g. a trigger, or a different role) is overwriting or blocking, that could explain it. Also confirm the **site** can **read** `raid_loot.assigned_character_name` (anon policy allows select).

3. **Update script / IDs**  
   - Confirm the CSV that the **update** script reads has an `id` column and that those `id`s match the rows in Supabase (same table, same project).  
   - If the fetch in step 1 is from project A and the site reads from project B, then “updating 14804 rows” in A would not be visible on the site (B).

4. **Caching**  
   Site or CDN might cache old responses; less likely if Table Editor also doesn’t show the data.

## Concrete debug steps

1. **Confirm same project**  
   - In the repo: CI secrets `SUPABASE_URL` (and optionally `SUPABASE_SERVICE_ROLE_KEY`’s project).  
   - In Vercel (or wherever the site is built): env `VITE_SUPABASE_URL`.  
   They must point to the **same** Supabase project URL (e.g. `https://xxxx.supabase.co`).

2. **Query Supabase directly**  
   In Supabase SQL Editor (for the project the **site** uses), run:
   ```sql
   SELECT id, item_name, character_name, assigned_character_name, cost
   FROM raid_loot
   WHERE item_name ILIKE '%Platinum Cloak of War%' AND character_name = 'Ammordius'
   LIMIT 5;
   ```
   - If `assigned_character_name` is `Badammo`, the DB is correct and the issue is site/cache.  
   - If it’s NULL or `Ammordius`, CI is either writing to another project or the update isn’t applying to this row (e.g. wrong or skipped `id`).

   **When one row (e.g. Ammordius) shows NULL:** (1) The update script used to skip rows whose `id` was written as `"123.0"` (float-style); that is now fixed. (2) If the assign step in CI doesn't link the buyer to an account (or Ammordius and Badammo aren't on the same account in `character_account`), assign leaves the row as namesake and won't set Badammo. Check that both toons share an `account_id` in Supabase. (3) After assign, run `grep -i "Platinum Cloak of War" data/raid_loot.csv | grep -i Ammordius` and confirm the first column is a numeric `id` and the assigned_character_name column has `Badammo`.

3. **Check one row’s `id` end-to-end**  
   - In CI (or locally): after the assign step, run something like:
     `grep -i "Platinum Cloak of War" data/raid_loot.csv | grep Ammordius`
     and note the `id` (first column if CSV has `id`).  
   - In Supabase Table Editor: open `raid_loot`, find that same row by `id`, and check whether `assigned_character_name` is updated after the workflow runs.

4. **Optional: log what the update script sends**  
   In `update_raid_loot_assignments_supabase.py`, temporarily log the first few rows (or the row for the test `id`) before calling `upsert`, and confirm they have `assigned_character_name = 'Badammo'` and the correct `id`.

5. **character_loot_assignment_counts**  
   In SQL Editor: `SELECT * FROM character_loot_assignment_counts WHERE character_name ILIKE '%Badammo%';`  
   If this returns rows in the project the site uses, the push step is writing to the right DB and the character page **should** show them (if the site’s env is the same project).

## Key files

- **CI**: `.github/workflows/loot-to-character.yml`
- **Fetch**: `fetch_raid_loot_from_supabase.py` (writes `raid_loot.csv` + `--all-tables`: characters, character_account, raids)
- **Assign**: `assign_loot_to_characters.py` (reads/writes `raid_loot.csv`, writes `character_loot_assignment_counts.csv`)
- **Update raid_loot**: `update_raid_loot_assignments_supabase.py` (reads CSV, upserts by `id` into `raid_loot`)
- **Push counts**: `push_character_loot_assignment_counts_supabase.py` (replaces `character_loot_assignment_counts` from CSV)
- **Inspect CSV locally**: `inspect_loot_assignment.py --item "Platinum Cloak" --buyer Ammordius`
- **Frontend**: `web/src/pages/AccountDetail.jsx` (shows “on toon” when `assigned_character_name` ≠ buyer), `web/src/pages/CharacterPage.jsx` (lists loot where `assigned_character_name` ILIKE character)

## One-line summary

**Verify CI’s `SUPABASE_URL` is the same as the site’s `VITE_SUPABASE_URL`; then confirm in that project’s SQL Editor that the test row has `assigned_character_name = 'Badammo'` after a CI run.**
