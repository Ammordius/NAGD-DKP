# Schema and RPC index

Where each public function the app or scripts call is defined, and what calls it.

**Deploy and upgrade:** apply **[docs/supabase-schema-full.sql](supabase-schema-full.sql)** only. See [SCHEMA_DEPLOYMENT.md](SCHEMA_DEPLOYMENT.md). Historical copies under `docs/sql-archive/` are not schema steps.

**`docs/supabase-schema.sql` is not in the repo.** Edit `supabase-schema-full.sql` when the schema changes.

---

## What the single file includes

| Area | Archived copy (not a schema step) |
|------|--------------------------------------|
| Core tables, DKP, officer raids, upload, bidding portfolio | `docs/sql-archive/superseded/` (`supabase-account-dkp-schema.sql`, `supabase-officer-raids.sql`, `upload_script_rpcs.sql`) |
| `character_dkp_spent`, assignment RPCs | `docs/sql-archive/superseded/supabase-loot-to-character.sql`, `supabase-loot-assignment-table.sql` |
| `officer_raider_activity` | `docs/sql-archive/superseded/supabase-officer-raider-activity.sql` |
| `account_class_coverage` | `docs/sql-archive/superseded/supabase-account-class-coverage.sql` |

---

## RPCs in supabase-schema-full.sql

| RPC / function | Used by |
|----------------|---------|
| **add_character_to_my_account** | Profile.jsx, AccountDetail.jsx |
| **claim_account** | AccountDetail.jsx |
| **create_account** | Officer.jsx |
| **create_my_account** | Defined in the canonical file. Not called by the current app. |
| **unclaim_account** | Profile.jsx |
| **reset_claim_cooldown** | OfficerClaimCooldowns.jsx |
| **delete_raid** | Officer.jsx |
| **delete_tic** | Officer.jsx |
| **remove_attendee_from_tic** | Officer.jsx, RaidDetail.jsx |
| **add_officer_tic** | Officer.jsx |
| **add_attendee_to_tic** | Officer.jsx, RaidDetail.jsx |
| **delete_raid_for_reupload** | upload_raid_detail_to_supabase.py |
| **insert_raid_event_attendance_for_upload** | upload_raid_detail_to_supabase.py |
| **update_raid_event_times** | update_supabase_event_times.py. `service_role` only. Not a web route. |
| **refresh_dkp_summary** | DKP.jsx, upload script, restore, dedupe, zerodkp |
| **refresh_dkp_summary_internal** | Triggers, delete_raid, end_restore_load |
| **refresh_account_dkp_summary** | DKP.jsx, Officer.jsx, restore_supabase_from_backup.py |
| **refresh_account_dkp_summary_internal** | end_restore_load |
| **refresh_account_dkp_summary_for_raid** | AccountDetail.jsx, RaidDetail.jsx, upload script, delete_tic, remove_attendee_from_tic |
| **refresh_raid_attendance_totals** | Triggers and end_restore_load |
| **refresh_all_raid_attendance_totals** | end_restore_load, restore script |
| **truncate_dkp_for_restore** | restore_supabase_from_backup.py. Called by restore, not by schema apply. |
| **begin_restore_load** | restore script, diff_inactive_tic_loot_dry_run.py |
| **end_restore_load** | restore script, run_end_restore_load.py. Also calls `refresh_character_dkp_spent`. |
| **restore_load_in_progress** | Triggers skip work while a restore is in progress |
| **fix_serial_sequences_for_restore** | end_restore_load |
| **is_officer** | RLS and officer RPCs. True for `officer` and `siteadmin`. |
| **is_site_admin** | Site Profile Accounts actions on `/officer/SiteAdmin` |
| **set_my_display_name** | Profile.jsx. Owner sets `profiles.display_name` (1-32 characters). |
| **set_my_ui_preferences** | Profile.jsx Website settings. Owner merges `showTicCharacterPicker`, `useCharacterAdminSelectors`, and `raidNameOnly` into `profiles.ui_preferences`. Missing keys mean on. Does not change role or account claim, and does not grant table UPDATE on `profiles`. |
| **account_claim_labels** | Accounts.jsx. `account_id` and site display name only; no email. |
| **siteadmin_unclaim_profile** | OfficerClaimCooldowns.jsx. Clears `profiles.account_id` without a cooldown. |
| **siteadmin_set_role** | OfficerClaimCooldowns.jsx. Sets `player`, `officer`, or `siteadmin`. |
| **siteadmin_delete_user** | OfficerClaimCooldowns.jsx via `POST /api/delete-site-user`. The function authorizes removal and writes a pending audit row. The API then calls `auth.admin.deleteUser` with `SUPABASE_SERVICE_ROLE_KEY` (server only). The profile row cascades when the auth user is deleted. Game accounts and characters stay. Officers may remove players. Site admins may remove players and officers. Nobody may remove a site admin or themselves. |
| **discord_username_from_meta** | Signup trigger and Discord display-name backfill. Not called from the app. |
| **write_site_admin_audit** | Audit insert used by the siteadmin RPCs. Not granted to the client. |
| **raid_date_parsed** | Refresh logic and views |
| **handle_new_user** | Auth trigger; new users get role `player` and `profiles.display_name` from email sign-up metadata or the Discord username |
| **normalize_item_name_for_lookup** | Bidding portfolio |
| **officer_bid_portfolio_for_loot** | ItemPage.jsx, backfill_bid_portfolio_export.py |
| **officer_account_bidding_portfolio** | AccountBiddingPortfolioCard.jsx |
| **officer_backfill_bid_portfolio_batch** | Officer or service_role backfill |
| **dba_backfill_bid_portfolio_range** (procedure) | SQL Editor only (`postgres` / `supabase_admin`) |
| **bid_forecast_attendees_resolved_for_scope**, **account_balance_before_loot**, **bid_portfolio_runner_up_guess**, **attendee_accounts_for_loot** | Helpers for the portfolio RPCs above |

Trigger functions in the same file (`trigger_delta_*`, `trigger_raid_events_*`, `trigger_refresh_raid_totals_stmt`, `trigger_loot_assignment_spent`, `trigger_capture_loot_delete_account`, `trigger_refresh_dkp_summary`, `profiles_role_guard`) are not called from the app. They run from table triggers. `profiles_role_guard` blocks authenticated role changes unless `siteadmin_set_role` set `nagddkp.allow_role_change`.

---

## More RPCs in the same file

| RPC / object | Used by |
|--------------|---------|
| **officer_raider_activity** | OfficerRaiderActivity.jsx |
| **officer_upsert_account_class_coverage** and table **account_class_coverage** | OfficerRaiderActivity.jsx; CI `scripts/build_account_class_coverage.mjs` |
| **get_character_dkp_spent** | LootRecipients.jsx |
| **update_single_raid_loot_assignment** | AccountDetail.jsx |
| **update_raid_loot_assignments** | Loot CI / update_raid_loot_assignments_supabase.py |
| **refresh_character_dkp_spent** | Trigger on loot and assignment (no-op while `restore_load_in_progress`), and `end_restore_load` |
| **refresh_after_bulk_loot_assignment** | After bulk assignment |

Older copies of these functions are under `docs/sql-archive/superseded/`. They are not schema steps.

---

## Retired

`officer_global_bid_forecast`, `officer_loot_bid_forecast`, and `officer_loot_bid_forecast_v2` are not in the canonical file and are not on the live database (checked 2026-10-09). Unrouted pages still mention them. Leave them out of `supabase-schema-full.sql`. A historical drop script is archived and is not an upgrade step.

---

## Leftovers that are not part of standup

An already-migrated database may still have `clear_restore_load`, `refresh_raid_attendance_totals_batch`, `run_account_dkp_migration*`, and `parse_raid_date_to_iso`. Definitions are archived under `docs/sql-archive/one-offs/`. Ordinary install and upgrade do not create or call them.

---

## Checklist

1. Every `supabase.rpc(...)` on a routed page is defined in `docs/supabase-schema-full.sql`.
2. Retired forecast RPCs stay out of that file.
3. New RPCs go in that file, and this index stays pointed at it.
