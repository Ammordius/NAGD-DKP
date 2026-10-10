# Schema and RPC index

Where each public function the app or scripts call is defined, and what calls it.

**Deploy:** Run **[docs/supabase-schema-full.sql](supabase-schema-full.sql)** once. See [SCHEMA_DEPLOYMENT.md](SCHEMA_DEPLOYMENT.md). That file includes loot assignment, raider activity, and class coverage. Do not also run the historical copies named below.

**`docs/supabase-schema.sql` is not in the repo.** Edit `supabase-schema-full.sql` when the schema changes.

---

## What the single file includes

| Area | Also copied historically in (do not run) |
|------|------------------------------------------|
| Core tables, DKP, officer raids, upload, bidding portfolio | supabase-account-dkp-schema.sql, supabase-officer-raids.sql, upload_script_rpcs.sql |
| `character_dkp_spent`, `get_character_dkp_spent`, assignment RPCs on `loot_assignment` | supabase-loot-to-character.sql (older column-on-raid_loot version), supabase-loot-assignment-table.sql |
| `officer_raider_activity` | supabase-officer-raider-activity.sql |
| `account_class_coverage`, `officer_upsert_account_class_coverage` | supabase-account-class-coverage.sql |

---

## RPCs in supabase-schema-full.sql

| RPC / function | Used by |
|----------------|---------|
| **add_character_to_my_account** | Profile.jsx, AccountDetail.jsx. One-off copy: fix_add_character_refresh_account_dkp.sql |
| **claim_account** | AccountDetail.jsx |
| **create_account** | Officer.jsx. Standalone copy: supabase-create-my-account-rpc.sql (do not run on a fresh deploy) |
| **create_my_account** | Same standalone copy. Not called by the current app. |
| **unclaim_account** | Profile.jsx |
| **reset_claim_cooldown** | OfficerClaimCooldowns.jsx |
| **delete_raid** | Officer.jsx |
| **delete_tic** | Officer.jsx |
| **remove_attendee_from_tic** | Officer.jsx, RaidDetail.jsx |
| **add_officer_tic** | Officer.jsx |
| **add_attendee_to_tic** | Officer.jsx, RaidDetail.jsx |
| **delete_raid_for_reupload** | upload_raid_detail_to_supabase.py. Older copy: delete_raid_for_reupload_rpc.sql (superseded) |
| **insert_raid_event_attendance_for_upload** | upload_raid_detail_to_supabase.py |
| **refresh_dkp_summary** | DKP.jsx, upload script, restore, dedupe, zerodkp |
| **refresh_dkp_summary_internal** | Triggers, delete_raid, end_restore_load |
| **refresh_account_dkp_summary** | DKP.jsx, Officer.jsx, restore_supabase_from_backup.py |
| **refresh_account_dkp_summary_internal** | end_restore_load |
| **refresh_account_dkp_summary_for_raid** | AccountDetail.jsx, RaidDetail.jsx, upload script, delete_tic, remove_attendee_from_tic. Older copy: fix_refresh_dkp_summary_includes_account_summary.sql |
| **refresh_raid_attendance_totals** | Triggers and end_restore_load |
| **refresh_all_raid_attendance_totals** | end_restore_load, restore script |
| **truncate_dkp_for_restore** | restore_supabase_from_backup.py. Standalone copy: supabase-restore-truncate-rpc.sql |
| **begin_restore_load** | restore script, diff_inactive_tic_loot_dry_run.py |
| **end_restore_load** | restore script, run_end_restore_load.py. Also calls `refresh_character_dkp_spent`. |
| **restore_load_in_progress** | Triggers skip work while a restore is in progress |
| **fix_serial_sequences_for_restore** | end_restore_load |
| **is_officer** | RLS and officer RPCs |
| **raid_date_parsed** | Refresh logic and views |
| **handle_new_user** | Auth trigger; new users get role `player` |
| **normalize_item_name_for_lookup** | Bidding portfolio |
| **officer_bid_portfolio_for_loot** | ItemPage.jsx, backfill_bid_portfolio_export.py |
| **officer_account_bidding_portfolio** | AccountBiddingPortfolioCard.jsx |
| **officer_backfill_bid_portfolio_batch** | Officer or service_role backfill |
| **dba_backfill_bid_portfolio_range** (procedure) | SQL Editor only (`postgres` / `supabase_admin`) |
| **bid_forecast_attendees_resolved_for_scope**, **account_balance_before_loot**, **bid_portfolio_runner_up_guess**, **attendee_accounts_for_loot** | Helpers for the portfolio RPCs above |

Trigger functions in the same file (`trigger_delta_*`, `trigger_raid_events_*`, `trigger_refresh_raid_totals_stmt`, `trigger_loot_assignment_spent`, `trigger_capture_loot_delete_account`, `trigger_refresh_dkp_summary`) are not called from the app. They run from table triggers.

---

## RPCs in the same file (historical copies exist; do not run them)

| RPC / object | Historical copy (do not run) | Used by |
|--------------|------------------------------|---------|
| **officer_raider_activity** | supabase-officer-raider-activity.sql | OfficerRaiderActivity.jsx |
| **officer_upsert_account_class_coverage** and table **account_class_coverage** | supabase-account-class-coverage.sql | OfficerRaiderActivity.jsx; CI `scripts/build_account_class_coverage.mjs` |
| **get_character_dkp_spent** | supabase-loot-to-character.sql | LootRecipients.jsx |
| **update_single_raid_loot_assignment** | loot-assignment-table.sql (final). loot-to-character.sql is the older raid_loot-column version. | AccountDetail.jsx |
| **update_raid_loot_assignments** | loot-assignment-table.sql (final) | Loot CI / update_raid_loot_assignments_supabase.py |
| **refresh_character_dkp_spent** | loot-assignment-table.sql (reads `loot_assignment`) | Trigger on loot and assignment (no-op while `restore_load_in_progress`), and `end_restore_load` |
| **refresh_after_bulk_loot_assignment** | loot-assignment-table.sql | After bulk assignment |

## Not in supabase-schema-full.sql

| RPC | Defined in | Used by |
|-----|------------|---------|
| **update_raid_event_times** | supabase-update-event-times-rpc.sql | update_supabase_event_times.py only. Not a web route. |

---

## Retired (do not deploy)

| RPC | Status |
|-----|--------|
| **officer_global_bid_forecast** | Removed from the live database. Not in `supabase-schema-full.sql`. Drop script: drop-officer-bid-forecast.sql. Unrouted page `OfficerGlobalLootBidForecast.jsx` still calls it. |
| **officer_loot_bid_forecast** | Same drop script. |
| **officer_loot_bid_forecast_v2** | Same drop script. Unrouted page `OfficerLootBidForecast.jsx` still calls it. |

---

## Migration-only (do not run on a fresh deploy)

| RPC / function | Definition | Purpose |
|----------------|------------|---------|
| clear_restore_load | supabase-account-dkp-migration.sql | Re-enable triggers after an old migration step |
| refresh_raid_attendance_totals_batch | supabase-account-dkp-migration.sql | Batched attendance refresh during that migration |
| run_account_dkp_migration and step1 / step1_batch / step2a / step3 / step4 | supabase-account-dkp-migration.sql | One-time account DKP backfill |
| parse_raid_date_to_iso | supabase-backfill-raid-dates.sql | One-off `date_iso` backfill |

The live DKP project still has these functions. They are leftovers, not part of standup.

---

## One-off SQL (fix data or an old database; no new app RPCs)

| File | Purpose |
|------|---------|
| fix_account_dkp_after_raid_delete.sql | Calls `refresh_account_dkp_summary()` after a raid delete. |
| fix_event_attendance_delete_trigger_statement_level.sql | Old databases only. New deploys from `supabase-schema-full.sql` already use the statement-level DELETE trigger. |
| fix_refresh_dkp_summary_includes_account_summary.sql | Superseded by `supabase-schema-full.sql`. |
| supabase-require-auth-remove-anon-read.sql | Drops anon SELECT, including on `loot_assignment` and `character_dkp_spent`. `supabase-schema-full.sql` recreates those two policies. Run it after the full file if you want them gone. |
| drop-officer-bid-forecast.sql | Drops the retired forecast RPCs above. |
| supabase-backfill-event-times.sql | Data updates for `event_time`. No function. |
| supabase-backfill-raid-dates.sql | `parse_raid_date_to_iso` plus date backfill. |

---

## Checklist

1. Every `supabase.rpc(...)` on a **routed** page is in the tables above, with a file you actually run in [SCHEMA_DEPLOYMENT.md](SCHEMA_DEPLOYMENT.md).
2. Retired forecast RPCs stay out of `supabase-schema-full.sql`.
3. New RPCs used by the app go in `supabase-schema-full.sql`, and this index stays pointed at that file.
