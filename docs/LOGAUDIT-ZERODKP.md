# Log audit: 0 DKP roll loot

The script `scripts/pull_parse_dkp_site/audit_log_zerodkp_rolls.py` scans EQ chat logs for loot messages where an item was awarded at **0 DKP** by roll (top roll, no bids, or “high roll 0 dkp”). It matches log dates to raids, fuzzy-matches winner names to your character list, and skips items already in `raid_loot`. Output is a JSON file you can use to add missing 0 DKP loot to raids.

## Log format

Lines must look like:

```text
[Mon Feb 09 21:24:35 2026] Speaker says out of character, 'message'
```

Only the quoted message is parsed. Supported patterns (0 DKP roll only):

- `Congrats PATH Girdle of Earthen Stability top roll, no bids`
- `Item no bids, Slay and Tolsarian top rolls, grats!`
- `Girdle... congrats cicatriz and tracka top rolls, no bids` (no bids at end)
- `congrats AMMORDIOUS and TRACKA top rolls Girdle of Earthen Stability` (item after)
- `Item ... Headcrushar other with the high roll 0 dkp`
- `Item congrats TAPPYAMMO top roll, loot on correct char`
- **Raid tells** (same format in logs): `tells Nag:1, 'no bids Mask of Conceptual Energy, slay top roll'` or `tells Nagd:1, 'Ring of Force No bids - Grats YUUKII w/ 423/999'`
- `grats dullwin with a 176 roll Ring of Force` / `Grats X w/ N/N`

Skipped:

- “anyone beat 262/464 roll on Item” (roll in progress, no award)
- “Item 2 DKP grats Threllin!” (positive DKP)
- “Item 2 DKP, tie... Jasie and Y” (tie line; the next line that says “grats X!” is the actual award)

## Usage

1. **Put logs in a directory**  
   Default: `./logs` (or `./data/logs` if it exists). Any `.txt` or `.log` files in that directory are scanned.

   **TAKPv22 + rotated EQ logs (eqlog_{name}_loginse*.txt):** Use `--logs` and `--characters`. You can pass `--logs` multiple times to include several directories (e.g. current TAKPv22 plus rotated `...\Desktop\old\EQ`). With `--characters` set, only files whose stem matches `eqlog_{name}_loginse` or `eqlog_{name}_loginse_*` for those names. Use **`--all-logs`** to scan every `eqlog_*_loginse*` file (e.g. Khord, Dallron, Ammomats) so raid tells and ooc from any toon’s log are included. **Identical log lines (timestamp + message) are deduped** so the same line in multiple toons’ logs counts once.

   ```bash
   python scripts/pull_parse_dkp_site/audit_log_zerodkp_rolls.py --logs "c:\TAKP\TAKPv22" --logs "c:\Users\You\OneDrive\Desktop\old\EQ" --data "c:\TAKP\dkp\data" --characters "Ammomage,Animalammo,..."
   # To include Khord, Dallron, Ammomats, etc. (any eqlog_*_loginse* file):
   python scripts/pull_parse_dkp_site/audit_log_zerodkp_rolls.py --logs "c:\TAKP\TAKPv22" --logs "c:\...\old\EQ" --data "c:\TAKP\dkp\data" --all-logs
   ```

   Or run the helper script from repo root (it adds TAKPv22 and, if present, `%USERPROFILE%\OneDrive\Desktop\old\EQ`):

   ```powershell
   .\scripts\pull_parse_dkp_site\run_audit_zerodkp_takpv22.ps1
   ```

   That script uses `dkp/data` and the 10 raiding characters above; it expects a sibling folder `TAKPv22` next to `dkp`.

2. **Data files** (default `./data`):
   - `characters.csv` – used to resolve winner names (fuzzy match)
   - `raids.csv` – used to match log date to `raid_id` (same day or nearest within `--max-days`)
   - `raid_loot.csv` – existing loot; entries already here are excluded
   - `dkp_mob_loot.json` – known item names (longest match used)

3. **Run:**

```bash
# From repo root
python scripts/pull_parse_dkp_site/audit_log_zerodkp_rolls.py

# Custom paths
python scripts/pull_parse_dkp_site/audit_log_zerodkp_rolls.py --logs path/to/logs --data path/to/data --out my_zerodkp.json

# Prefer same-day raid only (no “nearest” fallback)
python scripts/pull_parse_dkp_site/audit_log_zerodkp_rolls.py --max-days 0

# See why lines were skipped (no character/raid match, or already in raid_loot)
python scripts/pull_parse_dkp_site/audit_log_zerodkp_rolls.py --verbose
```

4. **Output**  
   Default: `audit_zerodkp_rolls.json` in repo root.

   - **`generated_for_upload`**: array of `{ raid_id, event_id, item_name, char_id, character_name, cost: "0" }` ready to insert into `raid_loot` (e.g. via Officer UI “Add loot” or Supabase).
   - **`audit`**: same rows plus `source_log_date` and `source_log_winner_raw` for review.

## Raid matching

- Log timestamp is converted to `YYYY-MM-DD`.
- A raid is chosen if `raids.date_iso` (first 10 chars) equals that date.
- If no same-day raid exists, the script picks the **nearest** raid within `--max-days` (default 1). Use `--max-days 0` to only use same-day raids.
- If your logs are for 2026 but `raids.csv` only has older dates, either import 2026 raids into Supabase and re-export `raids.csv`, or run with `--max-days` and review that the chosen raid is correct.

## Character matching

Winner names from the log (e.g. `TAPPYAMMO`, `ifuri`) are matched to `characters.name` in this order:

1. Exact match (case-insensitive)
2. Prefix match (log name is prefix of character name or vice versa)
3. Fuzzy match (`difflib.get_close_matches` with cutoff 0.5)

Unmatched winners are skipped; use `--verbose` to see them.

## Adding the loot

- **Officer UI**: For each object in `generated_for_upload`, add a loot row with that raid, item, character, and cost 0 (or paste/import in bulk if the UI supports it).
- **Supabase**: Insert into `raid_loot` with columns `raid_id`, `event_id`, `item_name`, `char_id`, `character_name`, `cost`. You can leave `event_id` null if you don’t tie loot to a specific tic.

After inserting, run “Refresh DKP totals” (or `SELECT refresh_dkp_summary();`) so spent totals include the new 0 DKP rows. To validate and insert from the audit JSON in one step: `python scripts/upload_zerodkp_rolls_supabase.py --dry-run` then `--apply`.
