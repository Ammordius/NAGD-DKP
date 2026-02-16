# Loot-to-Character Assignment (DKP → Magelo)

This feature links each raid loot row to the **character that actually has the item** (from Magelo), not just the namesake buyer. It uses the instrumented Magelo dump (TAKP character + inventory files) and the DKP schema.

## Rules

1. **Unique match**: If exactly one character on the account has that item on Magelo → assign to that character.
2. **Multiple matches**: If several toons have the item and the account bought multiple (e.g. same item in different raids), we assign in **raid order (oldest first)**. For each assignment we give the piece to the toon who currently has the **most items already assigned** (so the “most geared” toon gets credit first).
3. **No match**: If we can’t determine which toon has it → leave it on the **namesake** (buyer).
4. **Elemental loot**: DKP logs the pre–quest item (e.g. *Unadorned Plate Vambraces*). After the quest turn-in, Magelo shows the converted piece (e.g. *Elemental …*). We use `magelo/elemental_armor.json` so that any **elemental armor** piece on a toon counts as a match for that account’s elemental-source purchases.

## Inputs

- **DKP**: `data/raid_loot.csv`, `data/raids.csv`, `data/character_account.csv`, `data/characters.csv`, `data/accounts.csv`
- **Magelo**: `character/TAKP_character.txt`, `inventory/TAKP_character_inventory.txt` (from TAKP export or Magelo repo)
- **Elemental**: `magelo/elemental_armor.json` (item_id → category)

## Outputs

- **data/raid_loot.csv**: Same rows plus `assigned_char_id`, `assigned_character_name` (empty = use namesake), and `assigned_via_magelo`. If the input CSV had an `id` column (e.g. from a Supabase export), it is preserved so you can update Supabase by id without duplicates.
- **data/character_loot_assignment_counts.csv**: `char_id`, `character_name`, `items_assigned` (for reporting / tie-breaker).

## Schema (Supabase)

Run `docs/supabase-loot-to-character.sql` after the main schema:

- `raid_loot.assigned_char_id`, `raid_loot.assigned_character_name` (nullable).
- `raid_loot.assigned_via_magelo` (optional, 0/1 for analytics).
- View: `character_loot_assignment_count` (char_id, character_name, items_assigned).

## Deploy (site + DB)

To ship loot-to-character on the live site:

1. **Database**: In Supabase SQL Editor, run **`docs/supabase-loot-to-character.sql`** (adds columns and view).
2. **Data (no duplicates)**: Do **not** re-import the full `raid_loot` CSV—that would insert duplicate rows. Instead: **Export** `raid_loot` from Supabase (Table Editor → raid_loot → Export as CSV, or SQL: `SELECT * FROM raid_loot`) so the CSV includes the **`id`** column. Save that CSV as **`data/raid_loot.csv`** (or pass it to the script). Run **`python assign_loot_to_characters.py`** (it preserves `id` in its output). Then set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` and run **`python update_raid_loot_assignments_supabase.py`** to **update** existing `raid_loot` rows by `id` (no new rows inserted).
3. **Frontend**: Deploy the web app (the app already selects and shows `assigned_character_name` on Loot search, Item page, Raid detail, Account activity, and Character page “Loot on this character”). No env vars needed.
4. **CI**: The workflow (`.github/workflows/loot-to-character.yml`) keeps `data/raid_loot.csv` updated in the repo. To sync assignments into Supabase without duplicates, periodically: export `raid_loot` (with `id`) → run the assign script → run `update_raid_loot_assignments_supabase.py`, or add that flow to CI with Supabase credentials in secrets.

## Troubleshooting

**650 characters / rows seems low?** The number is **distinct characters** that have at least one loot row assigned to them. There are ~14.8k raid_loot rows; many are assigned to the same toons (or left on namesake). So 650 unique toons with ≥1 assigned item is expected.

**A toon (e.g. badammo) shows no loot on their character page.** The character page lists rows where `raid_loot.assigned_char_id` or `assigned_character_name` matches that toon. If an item was assigned to the **buyer** (namesake) instead—e.g. we didn’t find it on Magelo for that toon, or the row was assigned before we fixed matching—that row won’t appear on the other toon’s page. In Supabase: open **raid_loot**, filter by `item_name` (e.g. “Platinum Cloak of War”) and check `assigned_character_name`. If it’s the buyer, the script didn’t assign it to the other toon (name/account/Magelo mismatch, or the row was preserved from an earlier run). To force reassignment for that row: set `assigned_char_id` and `assigned_character_name` to empty for that row in **raid_loot**, then re-run the workflow; the script will assign it again (and will only assign rows that don’t already have an assignment).

**CI log: “Preserved N existing; assigned M new.”** So you can see how many rows were left as-is vs newly assigned.

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

To add more DKP item names that are “elemental source” (bought then turned in):

```bash
python assign_loot_to_characters.py --elemental-source-name "Plate Bracer"
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
