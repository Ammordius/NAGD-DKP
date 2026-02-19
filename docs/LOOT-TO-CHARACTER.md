# Loot-to-Character Assignment (DKP → Magelo)

This feature links each raid loot row to the **character that actually has the item** (from Magelo), not just the namesake buyer. It uses the instrumented Magelo dump (TAKP character + inventory files) and the DKP schema.

**Note:** Stats per character (e.g. which toon received which item) are produced automatically from Magelo pulls and from assumptions about assignment when multiple toons could have the item. They are not guaranteed to be accurate and should be treated as best-effort guidance rather than a definitive record.

## Rules

1. **Unique match**: If exactly one character on the account has that item on Magelo → assign to that character.
2. **Multiple matches**: If several toons have the item and the account bought multiple (e.g. same item in different raids), we assign in **raid order (oldest first)**. For each assignment we give the piece to the toon who currently has the **most items already assigned** (so the “most geared” toon gets credit first).
3. **No match**: If we can’t determine which toon has it → leave **unassigned** (do not default to buyer/namesake). The UI shows “Unassigned” and the account owner or an officer can set the assignment on the account page **Loot** tab.
4. **Elemental loot**: Source of truth is `magelo/elemental_armor.json` (item_ids that are elemental armor). A loot row is treated as elemental when its item name matches a name seen in Magelo inventory for an item whose id is in that JSON. Then we match any toon on the account that has any elemental armor (by item_id). No separate “Unadorned” list—elemental is defined only by `elemental_armor.json` and the names that appear in the dump for those ids.
5. **Manual assignments**: Rows set in the Account **Loot** tab (or via `update_single_raid_loot_assignment`) have `assigned_via_magelo = 0`. The assign script and the Supabase update script **never overwrite** these: they are preserved in the script output and excluded from the push to Supabase so Magelo-based runs do not change them.

## Inputs

- **DKP**: `data/raid_loot.csv`, `data/raids.csv`, `data/character_account.csv`, `data/characters.csv`, `data/accounts.csv`
- **Magelo**: `character/TAKP_character.txt`, `inventory/TAKP_character_inventory.txt` (from TAKP export or Magelo repo)
- **Elemental**: `magelo/elemental_armor.json` (item_id → category)

## Outputs

- **data/raid_loot.csv**: Same rows plus `assigned_char_id`, `assigned_character_name` (empty = unassigned), and `assigned_via_magelo`. If the input CSV had an `id` column (e.g. from a Supabase export), it is preserved so you can update Supabase by id without duplicates.
- **data/character_loot_assignment_counts.csv**: `char_id`, `character_name`, `items_assigned` (for reporting / tie-breaker).

## Schema (Supabase)

Run **`docs/supabase-loot-to-character.sql`** after the main schema (adds assignment columns to `raid_loot` and RPCs). Then run **`docs/supabase-loot-assignment-table.sql`** to move assignment into a separate table for permission scoping:

- **`loot_assignment`** (one-to-one with `raid_loot`): `loot_id` (FK → `raid_loot.id`), `assigned_char_id`, `assigned_character_name`, `assigned_via_magelo`. Enables scoped API keys for CI (no service role required).
- **`raid_loot`** after migration: only DKP columns (id, raid_id, event_id, item_name, char_id, character_name, cost). Officers still have full write on `raid_loot` and `loot_assignment` from the website.
- **View `raid_loot_with_assignment`**: `raid_loot` LEFT JOIN `loot_assignment`. Use for reads that need assignment; write loot to `raid_loot`, assignment via RPC or `loot_assignment`.
- View: `character_loot_assignment_count` (from `loot_assignment`).
- RPC **`update_single_raid_loot_assignment(...)`**: officers or account owner; writes to `loot_assignment`.
- RPC **`update_raid_loot_assignments(data)`**: bulk upsert into `loot_assignment` (used by CI; later a scoped key can have EXECUTE on this only).

## Deploy (site + DB)

To ship loot-to-character on the live site:

1. **Database**: Run **`docs/supabase-loot-to-character.sql`**, then **`docs/supabase-loot-assignment-table.sql`** (moves assignment into `loot_assignment`, adds view `raid_loot_with_assignment`).
2. **Data (no duplicates)**: Do **not** re-import the full `raid_loot` CSV—that would insert duplicate rows. Instead: export from the view (Table Editor → **raid_loot_with_assignment** → Export as CSV, or `SELECT * FROM raid_loot_with_assignment`) so the CSV includes **`id`** and assignment columns. Save as **`data/raid_loot.csv`**. Run **`python assign_loot_to_characters.py`** (preserves `id`). Then run **`python update_raid_loot_assignments_supabase.py`** to upsert **`loot_assignment`** by `id` (no `raid_loot` rows inserted).
3. **Frontend**: Deploy the web app. The app shows `assigned_character_name` (or “Unassigned”) on Item History, Item page, Raid detail, Account activity, Profile, and Character page. On the **Account** page, the **Loot** tab lets claimed-account owners and officers edit assignments per row. No env vars needed.
4. **CI**: The workflow (`.github/workflows/loot-to-character.yml`) keeps `data/raid_loot.csv` updated in the repo. To sync assignments into Supabase without duplicates, periodically: export `raid_loot` (with `id`) → run the assign script → run `update_raid_loot_assignments_supabase.py`, or add that flow to CI with Supabase credentials in secrets.

## Troubleshooting

**650 characters / rows seems low?** The number is **distinct characters** that have at least one loot row assigned to them. There are ~14.8k raid_loot rows; many are assigned to the same toons, and some rows are left unassigned when Magelo can’t determine which toon has the item. So 650 unique toons with ≥1 assigned item is expected.

**Elemental DKP purchases don’t assign to the toon with the elemental piece.** Elemental is defined by `magelo/elemental_armor.json` (item_ids). The script builds the set of “elemental item names” from the Magelo inventory: any item in the dump whose `item_id` is in that JSON. If the DKP log uses a name that never appears in the dump (e.g. a spelling variant), add it with `--elemental-source-name "Item Name"`. Matching: any toon on the account with any elemental armor (by item_id) can receive the assignment.

**A toon (e.g. badammo) shows no loot on their character page.** The character page lists rows where `raid_loot.assigned_char_id` or `assigned_character_name` matches that toon. If an item is **unassigned** (no Magelo match) or was assigned to another toon, it won’t appear on this character’s page. The account owner or an officer can set the assignment on the account page **Loot** tab. To let the script re-assign: clear `assigned_char_id` and `assigned_character_name` for that row in **raid_loot**, then re-run the workflow.

**CI log: “Preserved N existing; assigned M new.”** So you can see how many rows were left as-is vs newly assigned.

**All (or most) loot from yesterday’s raid stayed unassigned.** The assigner only assigns a row when it finds a character (on the buyer’s account) who **has that item in the Magelo inventory dump**. Two common causes:

1. **Magelo cache timing (CI)**  
   The workflow caches Magelo dumps by date (`magelo-dumps-Linux-YYYY-MM-DD`). When the run gets a **cache hit**, it does **not** re-download the TAKP character/inventory files. So the inventory snapshot can be from earlier in the day (or an earlier run). If the TAKP Magelo export at https://www.takproject.net/magelo/export/ hasn’t been updated yet with the new loot (players haven’t refreshed their Magelo), **no character will have the item** in the dump → every such row gets “no candidates” and is left unassigned.  
   **What to do:** Run the workflow **manually** (Actions → Loot-to-character assignment → Run workflow) later in the day (or the next day) after the TAKP export has updated; that run will use the cache from that day, or if the cache was invalidated, it will re-download fresh dumps. To force a fresh download, you can change the cache key (e.g. in the workflow) or wait until the next calendar day.

2. **Account/character resolution**  
   If the buyer’s `char_id` or `character_name` from the raid isn’t in Supabase `characters` or `character_account`, the script can’t resolve an account and falls back to “single-toon” (only that buyer). Assignment can still work if that toon has the item in Magelo. If many raid buyers are missing from `characters`/`character_account`, or names don’t match (casing, spelling), you’ll see more unassigned rows.

**Diagnostics:** Run the assign script with **`--verbose`** (or `-v`) to see loaded counts (raids, character_account links, DKP chars, Magelo chars/inventory), how many loot rows were resolved by account vs single-toon vs unknown, how many rows had “no toon has item on Magelo”, and a sample of those item names. Use this to tell whether the failure is “no Magelo match” (cache/export timing) vs “no account/name match”.

## Applying assignments to Supabase (no duplicates)

After running `assign_loot_to_characters.py`, the output CSV has `id` only if the **input** CSV had `id` (e.g. from a Supabase export). To push assignments into Supabase without inserting duplicate rows:

```bash
export SUPABASE_URL=https://your-project.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
python update_raid_loot_assignments_supabase.py
```

This script reads `data/raid_loot.csv` (must include `id`) and **updates** existing `raid_loot` rows by `id` for `assigned_char_id`, `assigned_character_name`, and `assigned_via_magelo`. Optional: `--csv path/to/raid_loot.csv`, `--batch 200`. Requires `pip install supabase`.

## Running locally

From the `dkp` repo, with Magelo as a sibling repo (or override paths):

```bash
python assign_loot_to_characters.py
```

With custom paths:

```bash
python assign_loot_to_characters.py \
  --magelo-dir ../magelo \
  --elemental-armor-json ../magelo/elemental_armor.json \
  --out-raid-loot data/raid_loot.csv \
  --out-counts data/character_loot_assignment_counts.csv
```

To treat an item name as elemental when it doesn’t appear in the Magelo dump (e.g. spelling variant):

```bash
python assign_loot_to_characters.py --elemental-source-name "Elemental Plate Vambraces"
```

To print diagnostic counts and a sample of items that couldn’t be assigned (e.g. to debug “no assignments for a raid”):

```bash
python assign_loot_to_characters.py --verbose
```

## Continuous integration (CI) in the DKP repo

A **separate** workflow in this repo (`.github/workflows/loot-to-character.yml`) runs the assignment without depending on the Magelo repo’s CI. It triggers **once daily** at 18:00 UTC or **manually** via workflow_dispatch (no push trigger). **Steps when Supabase secrets are set**: (1) **Check for new loot** — compare `raid_loot` row count to `.ci/last_raid_loot_count.txt`; if unchanged, skip (no Magelo pull). (2) If count changed or first run: fetch from Supabase `raid_loot` (with id), `characters`, `character_account`, and `raids` (so the assign script can link buyers to accounts and find which toon has the item) → download Magelo dumps → assign → push to Supabase by id → record count in `.ci/last_raid_loot_count.txt` (committed). The live DB is the source of truth; CI does not commit the CSVs. **“On toon” only appears when the item is on a different character than the buyer**; the buyer and that character must be on the same account in `character_account` for the script to assign.

**Repo secrets**: **`SUPABASE_URL`**, **`SUPABASE_SERVICE_ROLE_KEY`**. If set, CI only runs the Magelo pull and assignment when new loot has been added; at most once per day (cron).

A copy of **elemental_armor.json** lives in **`data/elemental_armor.json`** so the job does not clone Magelo; update it from the Magelo repo when new elemental armor IDs are added.

The Magelo repo has its own **daily workflow** (e.g. `.github/workflows/daily-update.yml`) that:

1. Downloads the latest TAKP character and inventory dumps.
2. Caches them and generates spell/inventory/delta pages.

To **update DKP loot-to-character automatically** when Magelo updates:

1. **Option A – Same repo / submodule**: In the Magelo workflow, after downloading the dumps, run the DKP assignment script (pointing at the dkp data dir and the freshly downloaded `character/` and `inventory/` files). Then commit updated `data/raid_loot.csv` and `data/character_loot_assignment_counts.csv` (or push to a branch and open a PR).

2. **Option B – Separate DKP repo**: Add a scheduled or manual workflow in the **dkp** repo that:
   - Fetches the latest Magelo dumps (from TAKP export URL or from the Magelo repo’s artifact/cache).
   - Runs `assign_loot_to_characters.py` with `--character-file` and `--inventory-file` pointing at those files.
   - Commits/pushes the updated CSVs (or writes to Supabase via API/SQL if you import from CSV there).

3. **Option C – Supabase + cron**: Store the Magelo dump paths or a “last run” snapshot in the DB. A pg_cron or external cron job periodically downloads the Magelo files (or reads from a shared store), runs the assignment logic (e.g. in a small service or script), and updates `raid_loot.assigned_char_id` / `assigned_character_name` via SQL.

For “instrumented” Magelo data: use the same **TAKP_character.txt** and **TAKP_character_inventory.txt** that the Magelo site/CI already uses so assignments stay in sync. The DKP workflow uses the same TAKP export URLs.
