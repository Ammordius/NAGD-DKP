# Schema audit: DB vs repo

Audit from exported Supabase inventory (tables, functions, triggers, RLS policies) vs the repo’s SQL files. Use this to keep the canonical schema and docs in sync.

**Redundancy cleanup (supabase-schema-full.sql):** The single-file schema was audited and duplicate definitions removed: only one definition each of `is_officer`, `refresh_raid_attendance_totals` (account version, including `raid_attendance_dkp_by_account`), `end_restore_load`, and `truncate_dkp_for_restore`; one Profiles RLS block (select/update). `delete_raid` now deletes from `raid_attendance_dkp_by_account` for the raid so that table does not retain stale rows.

---

## 1. Tables (DB vs repo)

| Table | In DB | In repo (file) | Notes |
|-------|-------|----------------|-------|
| account_dkp_summary | ✓ | supabase-account-dkp-schema.sql | |
| accounts | ✓ | supabase-schema.sql | |
| active_accounts | ✓ | supabase-account-dkp-schema.sql | |
| active_raiders | ✓ | supabase-schema.sql | |
| character_account | ✓ | supabase-schema.sql | |
| character_dkp_spent | ✓ | supabase-loot-to-character.sql / loot-assignment-table | Optional (loot flow). |
| character_loot_assignment_counts | ✓ | supabase-loot-to-character.sql (table); loot-assignment-table (view `character_loot_assignment_count`) | Optional. Loot-to-character uses table; loot-assignment-table uses view. |
| characters | ✓ | supabase-schema.sql | |
| dkp_adjustments | ✓ | supabase-schema.sql | |
| dkp_period_totals | ✓ | supabase-schema.sql | |
| dkp_summary | ✓ | supabase-schema.sql | |
| loot_assignment | ✓ | account-dkp (stub); loot-assignment-table (full) | |
| officer_audit_log | ✓ | supabase-schema.sql | |
| profiles | ✓ | supabase-schema.sql | |
| raid_attendance | ✓ | supabase-schema.sql | |
| raid_attendance_dkp | ✓ | supabase-schema.sql | |
| raid_attendance_dkp_by_account | ✓ | supabase-account-dkp-schema.sql | |
| raid_classifications | ✓ | supabase-schema.sql | |
| raid_dkp_totals | ✓ | supabase-schema.sql | |
| raid_event_attendance | ✓ | supabase-schema.sql | |
| raid_events | ✓ | supabase-schema.sql | |
| raid_loot | ✓ | supabase-schema.sql | |
| raids | ✓ | supabase-schema.sql | |
| restore_in_progress | ✓ | supabase-schema.sql | |

All DB tables are accounted for in the repo. Optional tables (character_dkp_spent, character_loot_assignment_counts) come from loot-to-character / loot-assignment optional SQL.

---

## 2. Functions (DB vs repo)

### Required for deploy (canonical)

| Function | In DB | In repo (file) | Notes |
|----------|-------|----------------|-------|
| add_character_to_my_account | ✓ | supabase-schema.sql | |
| begin_restore_load | ✓ | supabase-schema.sql | |
| claim_account | ✓ | supabase-schema.sql | |
| create_account | ✓ | supabase-schema.sql | |
| create_my_account | ✓ | supabase-schema.sql | |
| delete_raid | ✓ | supabase-officer-raids.sql | |
| delete_raid_for_reupload | ✓ | delete_raid_for_reupload_rpc.sql → **upload_script_rpcs.sql** | Consolidated in upload_script_rpcs.sql. |
| delete_tic | ✓ | supabase-officer-raids.sql | |
| end_restore_load | ✓ | supabase-schema.sql; overridden in account-dkp-schema | |
| fix_serial_sequences_for_restore | ✓ | supabase-schema.sql | |
| handle_new_user | ✓ | supabase-schema.sql | |
| is_officer | ✓ | supabase-schema.sql; overridden in officer-raids | |
| raid_date_parsed | ✓ | supabase-schema.sql | |
| refresh_account_dkp_summary | ✓ | supabase-account-dkp-schema.sql | |
| refresh_account_dkp_summary_for_raid | ✓ | supabase-account-dkp-schema.sql | |
| refresh_account_dkp_summary_internal | ✓ | supabase-account-dkp-schema.sql | |
| refresh_all_raid_attendance_totals | ✓ | supabase-schema.sql | |
| refresh_dkp_summary | ✓ | supabase-schema.sql | |
| refresh_dkp_summary_internal | ✓ | supabase-schema.sql | |
| refresh_raid_attendance_totals | ✓ | supabase-schema.sql; overridden in account-dkp-schema | |
| reset_claim_cooldown | ✓ | supabase-schema.sql | |
| restore_load_in_progress | ✓ | supabase-schema.sql | |
| truncate_dkp_for_restore | ✓ | supabase-schema.sql; overridden in account-dkp-schema | |
| unclaim_account | ✓ | supabase-schema.sql | |
| trigger_* (delta, refresh_dkp_summary, refresh_raid_totals_*) | ✓ | supabase-schema.sql | |

### Upload script (canonical – in upload_script_rpcs.sql)

| Function | In DB | In repo | Notes |
|----------|-------|---------|-------|
| insert_raid_event_attendance_for_upload | ✓ | **Was missing** → added in **upload_script_rpcs.sql** | Used by upload_raid_detail_to_supabase.py; had no definition in repo. |

### Optional (loot / backfill / migration)

| Function | In DB | In repo (file) | Notes |
|----------|-------|----------------|-------|
| get_character_dkp_spent | ✓ | supabase-loot-to-character.sql | Optional. |
| refresh_after_bulk_loot_assignment | ✓ | supabase-loot-to-character.sql; loot-assignment-table.sql | Optional. |
| refresh_character_dkp_spent | ✓ | supabase-loot-assignment-table.sql | Optional. |
| update_raid_event_times | ✓ | supabase-update-event-times-rpc.sql | Optional (backfill script). |
| update_raid_loot_assignments | ✓ | supabase-loot-to-character.sql; loot-assignment-table | Optional. |
| update_single_raid_loot_assignment | ✓ | supabase-loot-assignment-table.sql; supabase-loot-to-character.sql | Optional. |
| trigger_refresh_character_dkp_spent* | ✓ | loot-to-character; loot-assignment-table | Optional. |
| parse_raid_date_to_iso | ✓ | supabase-backfill-raid-dates.sql | One-off backfill only. |

### Migration-only (do not run on fresh deploy)

| Function | In DB | In repo (file) | Notes |
|----------|-------|----------------|-------|
| clear_restore_load | ✓ | supabase-account-dkp-migration.sql | Only for migration. |
| refresh_raid_attendance_totals_batch (2 overloads) | ✓ | supabase-account-dkp-migration.sql | (int, text) and (int, bigint); both intentional. |
| run_account_dkp_migration | ✓ | supabase-account-dkp-migration.sql | One-shot. |
| run_account_dkp_migration_step1, step1_batch, step2a, step3, step4 | ✓ | supabase-account-dkp-migration.sql | One-shot. |

---

## 3. Redundant / incorrect

- **refresh_raid_attendance_totals_batch** — Two overloads in DB; both defined in migration file. Not redundant: (int, bigint) wrapper calls (int, text). Keep both; migration-only.
- **Anon read policies** — Canonical is *no* anon read. DB had "Anon read character_dkp_spent" and "Anon read loot_assignment" (likely added for a feature). Repo now drops these when reapplying schema/require-auth so deploy is consistent.
- **insert_raid_event_attendance_for_upload** — Was in DB and used by upload script but **had no definition in repo**. Added to **docs/upload_script_rpcs.sql** so deploy includes it.

---

## 4. RLS policies

- **Canonical:** Authenticated read for data; officer-only write where applicable; no anon read on DKP/loot tables.
- **DB had:** Anon read on `character_dkp_spent` and `loot_assignment`. These are now dropped in main schema and in require-auth script so a full re-apply matches canonical (auth-only).

---

## 5. Triggers

All DB triggers match repo:

- DKP: delta_dkp_after_*, full_refresh_dkp_after_*, refresh_raid_totals_after_events_*, refresh_raid_totals_after_event_attendance_* (including statement-level del).
- Loot (optional): refresh_character_dkp_spent_after_assignment (loot_assignment), refresh_character_dkp_spent_after_loot (raid_loot).

No redundant or missing triggers.

---

## 6. Single canonical deploy

**Run once:** **docs/supabase-schema-full.sql** in the Supabase SQL Editor. No other SQL files are required for a working deploy. Optional (loot-to-character, etc.) only if you use those features.

Do **not** run account-dkp-migration.sql on a fresh deploy; only for one-time migration of existing DBs.
