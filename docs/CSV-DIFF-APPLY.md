# Applying CSVs in diff mode (canonical guide)

This guide covers **incremental apply** of DKP data from CSVs: diff (CSV vs DB), then apply only what’s missing. No full restore; we **add** rows and **never overwrite** existing data by default.

---

## 1. Diff-first, no duplicates

Every run of the diff/apply pipeline does a **full diff at start**:

1. Load **current** DB state (accounts, character_account, characters, raid_event_attendance, raid_loot).
2. Load CSVs (e.g. `data/raid_event_attendance.csv`, `data/raid_loot.csv`).
3. Compute **to-add** = rows in CSV that are **not** in DB (multiset: CSV count minus DB count per key).
4. **Apply** only those rows: upsert for accounts/characters/character_account; insert only missing tics/loot.

So:

- **Re-running `--apply` is safe.** The next run re-diffs; if the previous run already wrote the rows, to-add is 0 and nothing is inserted again. No duplicate uploads.
- **After a timeout** (e.g. on `end_restore_load()`): Data (accounts, characters, character_account, tics) is already written. Run `run_end_restore_load.py` to finish refresh. You do **not** need to “start again”; re-running `--apply` will simply see nothing left to add.

---

## 2. Scripts and data

| Script | Purpose |
|--------|--------|
| `scripts/pull_parse_dkp_site/diff_inactive_tic_loot_dry_run.py` | Diff CSV tics/loot vs Supabase; list unlinked raiders; optional apply/unapply. |
| `scripts/pull_parse_dkp_site/link_csv_char_ids_to_existing_accounts.py` | Link CSV char_ids to existing accounts by character name (so they drop out of “unlinked”). |
| `scripts/pull_parse_dkp_site/run_end_restore_load.py` | Run `end_restore_load()` only (e.g. after apply timed out). |

**Data (default `data/`):**

- `raid_event_attendance.csv` – required for diff/apply.
- `raid_loot.csv` – optional; included in diff if present.
- `accounts.csv` – optional; used to compare unlinked names to DKP site accounts.

**Env:** `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (e.g. from `.env` or `web/.env`).

---

## 3. Inactive / unlinked raiders flow (step by step)

Goal: Add one account per “unlinked” raider (character in CSV with no Supabase account), plus any missing tics, without overwriting existing data.

### Step 1: Dry run and report (no DB changes)

```bash
python scripts/pull_parse_dkp_site/diff_inactive_tic_loot_dry_run.py --data-dir data --write
```

- Diffs CSV vs DB.
- Prints: tics to add, loot to add, count of unlinked characters, sample names.
- With `--write`, writes:
  - `docs/dry_run_inactive_raiders_summary.md` – full summary and list of unlinked names.
  - `docs/apply_inactive_raiders.sql` – SQL that would add accounts, characters, character_account, and missing tics.
  - `docs/unapply_inactive_raiders.sql` – SQL to revert that apply.
  - `docs/inactive_raiders_to_add.txt` – plain list of unlinked names.

Review the summary. Many “unlinked” names may already have an account under a **different** char_id (e.g. DKP site vs Magelo). To attach those CSV char_ids to existing accounts and shrink the unlinked list, do Step 2.

### Step 2 (optional): Link CSV char_ids to existing accounts

If the dry run shows “Unlinked names that MATCH an existing Supabase account,” those names are in the DB by **name** but the **CSV char_id** is not in `character_account`. Linking fixes that so they are no longer treated as unlinked:

```bash
# Dry run (no writes)
python scripts/pull_parse_dkp_site/link_csv_char_ids_to_existing_accounts.py

# Apply links (insert characters if missing, character_account rows)
python scripts/pull_parse_dkp_site/link_csv_char_ids_to_existing_accounts.py --apply
```

Then re-run the diff with `--write` to get an updated unlinked list and updated apply SQL.

### Step 3: Apply (add only what’s missing)

```bash
python scripts/pull_parse_dkp_site/diff_inactive_tic_loot_dry_run.py --data-dir data --apply
```

- Re-diffs CSV vs DB (full diff at start).
- **Accounts / characters / character_account:** Upserts one account per unlinked name (synthetic id like `unlinked_Frinop`), one character per name, and links. Uses `on_conflict` so existing rows are not duplicated.
- **Tics:** Inserts only rows in **to_add_tics** (in CSV, not in DB). Uses `begin_restore_load()` before tic insert so triggers no-op; then `end_restore_load()` for one full refresh.

If `end_restore_load()` times out:

- All accounts, characters, character_account, and tic rows are already written.
- Run: `python scripts/pull_parse_dkp_site/run_end_restore_load.py` to finish refresh.
- Re-running `--apply` is safe: diff will show 0 tics to add and no new inserts.

### Step 4 (optional): Unapply

To remove the inactive-raiders accounts and the tics that were added by this flow:

```bash
python scripts/pull_parse_dkp_site/diff_inactive_tic_loot_dry_run.py --data-dir data --unapply
```

This deletes the added tics, character_account links, characters, and accounts created for unlinked names, then runs `refresh_dkp_summary()`.

---

## 4. What apply does (detail)

- **Accounts:** One row per unlinked name. `account_id` = synthetic (e.g. `unlinked_Aadd`), `display_name` = character name. Upsert on `account_id`.
- **Characters:** One row per unlinked name. `char_id` = same synthetic id, `name` = character name. Upsert on `char_id`.
- **character_account:** Links each synthetic character to its synthetic account. Upsert on `(char_id, account_id)`.
- **raid_event_attendance:** Only rows in **to_add_tics** (CSV − DB). Insert only; no unique key, so the diff guarantees we don’t re-insert the same row on a later run (next diff would show 0 to add).
- **Loot:** This script does **not** insert into `raid_loot`. Loot for these characters is assumed already in the DB; `refresh_dkp_summary()` attributes by character name.

---

## 5. Timeout on `end_restore_load()`

- **Cause:** Large DB; `end_restore_load()` runs `fix_serial_sequences_for_restore()`, `refresh_dkp_summary()`, and `refresh_all_raid_attendance_totals()` in one RPC, which can hit the API statement timeout.
- **Data:** All apply writes (accounts, characters, character_account, tics) are already committed. Only the final refresh step failed.
- **Fix:** Run `python scripts/pull_parse_dkp_site/run_end_restore_load.py`. If that still times out, run the same logic in Supabase SQL Editor (see [RESTORE-BACKUP.md](RESTORE-BACKUP.md) §5).
- **Re-run apply:** Safe. Full diff at start; nothing extra will be uploaded.

---

## 6. Related docs

| Doc | Purpose |
|-----|--------|
| [RESTORE-BACKUP.md](RESTORE-BACKUP.md) | Full restore from backup; truncate + load. |
| [WHY_ABOMINATION_IN_226.md](WHY_ABOMINATION_IN_226.md) | Why a name can be “unlinked” (CSV char_id vs name). |
| [dry_run_inactive_raiders_summary.md](dry_run_inactive_raiders_summary.md) | Generated summary from `--write` (list of unlinked, tics to add, etc.). |
