# Schema & RPC index

Single index of **all public RPCs/functions** and **one-off SQL** in this repo: where each is defined (canonical vs supplemental), what uses it, and how to avoid orphans.

**Canonical schema** = the files that define the live database when deploying from scratch, in order:

1. **docs/supabase-schema.sql** — core tables, triggers, DKP summary (character), restore, profiles, accounts, raid totals
2. **docs/supabase-account-dkp-schema.sql** — account_dkp_summary, account-scoped refresh, end_restore_load/truncate overrides
3. **docs/supabase-officer-raids.sql** — is_officer, delete_raid, RLS for officer-managed tables
4. **docs/supabase-loot-assignment-table.sql** — loot_assignment table, update_single_raid_loot_assignment, get_character_dkp_spent, refresh_character_dkp_spent (if using loot_assignment flow)

---

## RPCs / functions: canonical definition and callers

| RPC / function | Canonical definition | Supplemental / one-off definition | Used by |
|----------------|----------------------|-----------------------------------|---------|
| **add_character_to_my_account** | supabase-schema.sql | — | Profile.jsx, AccountDetail.jsx |
| **claim_account** | supabase-schema.sql | — | AccountDetail.jsx |
| **create_account** | supabase-schema.sql | supabase-create-my-account-rpc.sql (standalone add-on) | Officer.jsx |
| **create_my_account** | supabase-schema.sql | supabase-create-my-account-rpc.sql (standalone add-on) | — |
| **unclaim_account** | supabase-schema.sql | — | Profile.jsx |
| **reset_claim_cooldown** | supabase-schema.sql | — | OfficerClaimCooldowns.jsx |
| **delete_raid** | supabase-officer-raids.sql | — | Officer.jsx (permanent delete raid + tics) |
| **delete_raid_for_reupload** | — | **delete_raid_for_reupload_rpc.sql** | upload_raid_detail_to_supabase.py |
| **refresh_dkp_summary** | supabase-schema.sql | — | Officer.jsx, RaidDetail.jsx, DKP.jsx, upload script, restore, dedupe, zerodkp |
| **refresh_dkp_summary_internal** | supabase-schema.sql | — | Triggers, delete_raid, delete_raid_for_reupload, end_restore_load |
| **refresh_account_dkp_summary** | supabase-account-dkp-schema.sql | — | DKP.jsx, upload script (fallback), restore_supabase_from_backup.py |
| **refresh_account_dkp_summary_internal** | supabase-account-dkp-schema.sql | — | end_restore_load, delete_raid (if present), delete_raid_for_reupload |
| **refresh_account_dkp_summary_for_raid** | supabase-account-dkp-schema.sql | fix_refresh_dkp_summary_includes_account_summary.sql (for DBs without account schema) | Officer.jsx, RaidDetail.jsx, upload_raid_detail_to_supabase.py |
| **refresh_raid_attendance_totals** | supabase-schema.sql (base); supabase-account-dkp-schema.sql (account version) | — | Triggers, delete_raid_for_reupload |
| **refresh_all_raid_attendance_totals** | supabase-schema.sql | — | end_restore_load, restore script |
| **truncate_dkp_for_restore** | supabase-schema.sql; supabase-account-dkp-schema.sql (extends) | supabase-restore-truncate-rpc.sql (standalone) | restore_supabase_from_backup.py |
| **begin_restore_load** | supabase-schema.sql | — | restore script, diff_inactive_tic_loot_dry_run.py |
| **end_restore_load** | supabase-schema.sql; supabase-account-dkp-schema.sql (overrides) | — | restore script, run_end_restore_load.py, diff_inactive_tic_loot_dry_run.py |
| **restore_load_in_progress** | supabase-schema.sql | — | Triggers (no-op when true) |
| **fix_serial_sequences_for_restore** | supabase-schema.sql | — | end_restore_load |
| **is_officer** | supabase-schema.sql; supabase-officer-raids.sql (overrides) | — | RLS, delete_raid, refresh_account_dkp_summary |
| **raid_date_parsed** | supabase-schema.sql | — | refresh logic, views |
| **handle_new_user** | supabase-schema.sql | — | Auth trigger |
| **trigger_refresh_dkp_summary** | supabase-schema.sql | — | Trigger |
| **trigger_refresh_raid_totals_after_events** | supabase-schema.sql | — | Trigger |
| **trigger_refresh_raid_totals_after_event_attendance** | supabase-schema.sql | — | Trigger |
| **trigger_delta_*** (event_attendance, attendance, loot)** | supabase-schema.sql | — | Triggers |
| **update_raid_event_times** | — | **supabase-update-event-times-rpc.sql** | update_supabase_event_times.py |
| **update_single_raid_loot_assignment** | — | supabase-loot-assignment-table.sql; supabase-loot-to-character.sql | AccountDetail.jsx |
| **get_character_dkp_spent** | — | supabase-loot-to-character.sql | LootRecipients.jsx |
| **refresh_character_dkp_spent** | supabase-loot-assignment-table.sql | — | Trigger (loot_assignment) |
| **parse_raid_date_to_iso** | — | supabase-backfill-raid-dates.sql (one-off backfill) | Backfill script / manual |

**Migration-only** (run once when adding account-DKP; not part of normal deploy):

| RPC / function | Definition | Purpose |
|----------------|------------|---------|
| clear_restore_load | supabase-account-dkp-migration.sql | Re-enable triggers after migration step 1 |
| refresh_raid_attendance_totals_batch | supabase-account-dkp-migration.sql | Batched refresh_raid_attendance_totals |
| run_account_dkp_migration_step1**, step2a, step3, step4** | supabase-account-dkp-migration.sql | Backfill account_id, populate account_dkp_summary |
| run_account_dkp_migration | supabase-account-dkp-migration.sql | Orchestrator (optional) |

---

## One-off SQL (no new RPCs; run once to fix state)

| File | Purpose |
|------|---------|
| **fix_account_dkp_after_raid_delete.sql** | Run `SELECT refresh_account_dkp_summary();` after deleting a raid so leaderboard (account_dkp_summary) matches. Supabase: run as officer. |
| **fix_event_attendance_delete_trigger_statement_level.sql** | Run once: switch `raid_event_attendance` DELETE trigger to FOR EACH STATEMENT so deleting a tic (many rows) refreshes each raid once instead of N times; avoids statement timeout. |
| fix_refresh_dkp_summary_includes_account_summary.sql | Defines **refresh_account_dkp_summary_for_raid** for DBs that have account_dkp_summary but not this RPC yet. Superseded if you deploy full supabase-account-dkp-schema.sql. |
| fix_piama_dkp_to_account_22078559.sql | One-account DKP fix (example). |
| supabase-backfill-event-times.sql | Data-only UPDATEs for event_time; no function. |
| supabase-backfill-raid-dates.sql | Defines parse_raid_date_to_iso + UPDATEs for date_iso backfill. |

---

## Orphans and where they live

These are **not** in the canonical schema; deploy the listed file if you need them.

| RPC | Only defined in | Required for |
|-----|------------------|---------------|
| **delete_raid_for_reupload** | docs/delete_raid_for_reupload_rpc.sql | upload_raid_detail_to_supabase.py (delete before re-upload) |
| **update_raid_event_times** | docs/supabase-update-event-times-rpc.sql | scripts/pull_parse_dkp_site/update_supabase_event_times.py |
| **update_single_raid_loot_assignment** | docs/supabase-loot-assignment-table.sql or docs/supabase-loot-to-character.sql | AccountDetail.jsx (loot assignment UI) |
| **get_character_dkp_spent** | docs/supabase-loot-to-character.sql | LootRecipients.jsx |
| **parse_raid_date_to_iso** | docs/supabase-backfill-raid-dates.sql | One-off backfill only |

---

## Documentation cross-references

- **DKP_TRIGGERS_AND_STORAGE_AUDIT.md** — Triggers, derived tables, website/upload flow, delete_raid_for_reupload, refresh_account_dkp_summary_for_raid.
- **DKP_AUDIT.md** — Gamer Launch vs Supabase audit; mentions fix_refresh_dkp_summary_includes_account_summary.sql.
- **IMPLEMENT-LOOT-ASSIGNMENT-TABLE.md** / **LOOT-TO-CHARACTER.md** — Loot assignment RPCs and flows.

---

## Checklist: no orphans

1. **App/scripts** — Every `supabase.rpc('...')` or `client.rpc(...)` is listed in the table above with a canonical or supplemental definition file.
2. **One-offs** — Every `fix_*.sql` and backfill SQL that defines a function is either in this index or marked as one-off; run-once scripts that only call existing RPCs (e.g. fix_account_dkp_after_raid_delete.sql) are in the one-off table.
3. **Main schema** — New RPCs used by the app or restore/upload should be added to supabase-schema.sql, supabase-account-dkp-schema.sql, or supabase-officer-raids.sql so they are not orphaned. Standalone RPCs (e.g. delete_raid_for_reupload, update_raid_event_times) stay in their own files but are documented here.
