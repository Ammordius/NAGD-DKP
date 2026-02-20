# Restoring the database from backup (canonical guide)

This guide covers **full restore** of DKP data from a backup (e.g. after a bad migration or to revert data). It does **not** cover incremental/diff apply of CSVs (see [CSV-DIFF-APPLY.md](CSV-DIFF-APPLY.md)).

**Authentication and profiles are never touched.** Only DKP data tables are cleared and reloaded (characters, accounts, character_account, raids, raid_events, raid_loot, raid_attendance, raid_event_attendance, and derived/cache tables).

---

## 1. Prerequisites

- **Backup artifact** – At least one successful run of **DB backup (on change)** (`.github/workflows/db-backup.yml`) so an artifact exists (e.g. `supabase-backup-2026-02-20`), or a local `backup/` directory of CSVs.
- **Secrets** – `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (Supabase Dashboard → Project Settings → API → service_role key).

---

## 2. How restore works

1. **Clear** – DKP data tables are cleared (via `truncate_dkp_for_restore()` RPC, or manually in SQL).
2. **Load** – Rows are inserted from backup CSVs (from artifact or local `backup/`).
3. **Fast load (optional)** – If your schema has `begin_restore_load()` / `end_restore_load()`, the script calls `begin_restore_load()` before inserts so DKP triggers no-op during bulk load; then `end_restore_load()` runs once to fix sequences, refresh DKP summary, and refresh raid totals. This avoids per-row trigger work and speeds up large restores.
4. **Refresh** – After load, `end_restore_load()` (or manual `refresh_dkp_summary()` + `refresh_all_raid_attendance_totals()`) brings cache tables up to date.

**Tables cleared and loaded (order matters for FKs):**  
characters, accounts, character_account, raids, raid_events, raid_loot, raid_attendance, raid_event_attendance, raid_dkp_totals, raid_attendance_dkp, raid_classifications, dkp_adjustments, dkp_summary, dkp_period_totals, active_raiders, officer_audit_log.

**Notes:**
- `accounts` is **not** truncated (profiles references it). Restore **upserts** accounts from CSV to avoid breaking profiles.
- `raid_dkp_totals` and `raid_attendance_dkp` are **not** loaded from CSV; they are repopulated by triggers / `end_restore_load()`.

---

## 3. Running a restore (GitHub Actions)

1. Go to **Actions** → **DB restore from backup**.
2. **Run workflow**.
3. **Branch:** usually `main`.
4. **Artifact name:** `latest` (most recent backup) or a specific name from the list (e.g. `supabase-backup-2026-02-20`).
5. **Truncate already run in Supabase (load only):**  
   - **Unchecked (default)** – workflow runs truncate RPC then loads from CSVs.  
   - **Checked** – skip truncate; only load from CSVs. Use only if you already ran the truncate SQL in Supabase (e.g. `docs/supabase-restore-truncate.sql`). Tables should be empty or you may get duplicates.

The job downloads the artifact, extracts `backup/`, then runs:

```bash
python scripts/restore_supabase_from_backup.py --backup-dir backup [--load-only]
```

---

## 4. Running restore locally

With a local backup directory (e.g. from extracting an artifact):

```bash
# From repo root
export SUPABASE_URL='https://your-project.supabase.co'
export SUPABASE_SERVICE_ROLE_KEY='your-service-role-key'
pip install -r requirements.txt   # or: pip install supabase

# Full restore (truncate + load)
python scripts/restore_supabase_from_backup.py --backup-dir backup

# Load only (you already truncated in Supabase)
python scripts/restore_supabase_from_backup.py --backup-dir backup --load-only
```

**Backup dir layout:** `backup/` must contain one CSV per table, e.g. `backup/characters.csv`, `backup/accounts.csv`, `backup/raid_event_attendance.csv`, etc. Column names must match the schema.

---

## 5. Duration and timeouts

- **Truncate:** One RPC call; fast.
- **Load:** Roughly 1–2 minutes per 100k rows (depends on network and Supabase). Progress is logged every 5,000 rows.
- **end_restore_load():** Runs `fix_serial_sequences_for_restore()`, `refresh_dkp_summary()`, and `refresh_all_raid_attendance_totals()`. On large DBs this can hit the **statement timeout** (e.g. 60s in Supabase).

**If `end_restore_load()` times out:**

- All CSV rows have already been inserted; only the final refresh step failed.
- Run the refresh manually:

  **Option A – Same script (recommended):**  
  From repo root with env set:

  ```bash
  python scripts/pull_parse_dkp_site/run_end_restore_load.py
  ```

  This calls `end_restore_load()` once. If it still times out, run Option B.

  **Option B – Supabase SQL Editor (no API timeout):**  
  In Dashboard → SQL Editor, run:

  ```sql
  UPDATE restore_in_progress SET in_progress = false WHERE id = 1;
  SELECT fix_serial_sequences_for_restore();
  SELECT refresh_dkp_summary();
  SELECT refresh_all_raid_attendance_totals();
  ```

  You can run each statement separately if one of them is slow.

---

## 6. Duplicate key after restore (serial sequences)

If you see **duplicate key value violates unique constraint "..._pkey"** on `raid_events`, `raid_loot`, `raid_attendance`, or `raid_event_attendance`, the table’s `id` sequence is behind the data (backup CSVs include explicit `id` values; Postgres does not advance the sequence automatically).

**Fix (all four tables):** Run in SQL Editor:

```sql
-- See docs/fix_all_serial_sequences.sql
SELECT setval(pg_get_serial_sequence('raid_events', 'id'), COALESCE((SELECT max(id) FROM raid_events), 1));
SELECT setval(pg_get_serial_sequence('raid_loot', 'id'), COALESCE((SELECT max(id) FROM raid_loot), 1));
SELECT setval(pg_get_serial_sequence('raid_attendance', 'id'), COALESCE((SELECT max(id) FROM raid_attendance), 1));
SELECT setval(pg_get_serial_sequence('raid_event_attendance', 'id'), COALESCE((SELECT max(id) FROM raid_event_attendance), 1));
```

With the current schema, `end_restore_load()` calls `fix_serial_sequences_for_restore()`, which does the equivalent for these tables. If you skipped or failed `end_restore_load()`, run the statements above manually.

---

## 7. Reclaim space after restore

Restore does many deletes and inserts; PostgreSQL can retain dead row versions until VACUUM. If the database size grew, run in SQL Editor:

```sql
VACUUM ANALYZE;
```

For a one-time aggressive reclaim (brief lock): `VACUUM FULL ANALYZE;` during low traffic.

---

## 8. Related files

| File | Purpose |
|------|--------|
| `scripts/restore_supabase_from_backup.py` | Restore script (truncate + load from CSVs). |
| `scripts/pull_parse_dkp_site/run_end_restore_load.py` | Run `end_restore_load()` only (after timeout). |
| `.github/workflows/db-restore.yml` | GitHub Action for restore from artifact. |
| `docs/CI-DB-RESTORE.md` | Shorter CI-focused restore notes. |
| `docs/supabase-schema.sql` | Defines `truncate_dkp_for_restore`, `begin_restore_load`, `end_restore_load`, `fix_serial_sequences_for_restore`. |
| `docs/supabase-restore-truncate.sql` | Manual truncate SQL if you want load-only. |
| `docs/fix_all_serial_sequences.sql` | Manual sequence fix. |
