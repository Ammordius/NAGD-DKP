# Schema audit: live DKP database vs repo

Audit of the live Supabase project **DKP** (`ynvwtvphqsevhpytcugj`, us-west-2) against the repo, checked 2026-10-09. Deploy order is [SCHEMA_DEPLOYMENT.md](SCHEMA_DEPLOYMENT.md). RPC locations are [SCHEMA_RPC_INDEX.md](SCHEMA_RPC_INDEX.md).

**`docs/supabase-schema.sql` is not in the repo.** The applyable schema is [supabase-schema-full.sql](supabase-schema-full.sql). It includes loot assignment, `character_dkp_spent`, raider activity, and class coverage. The older split files are historical sources. Do not run them after the full file.

A fresh database that runs `supabase-schema-full.sql` once matches the routed app. Re-run that file on an existing project to install anything it newly includes (`CREATE OR REPLACE` for functions, `CREATE TABLE IF NOT EXISTS` for `character_dkp_spent` and `account_class_coverage`).

---

## 1. Required deploy

| File | Run? |
|------|------|
| supabase-schema-full.sql | Yes. Once. |
| supabase-loot-to-character.sql | No. Older copy. Re-adds `raid_loot` assignment columns and replaces the assignment RPCs. |
| supabase-loot-assignment-table.sql | No. Folded into the full file. |
| supabase-officer-raider-activity.sql | No. Folded into the full file. |
| supabase-account-class-coverage.sql | No. Folded into the full file. |

---

## 2. Tables

| Table | Live DKP | Where it is created |
|-------|----------|---------------------|
| profiles, characters, accounts, character_account | yes | supabase-schema-full.sql |
| raids, raid_events, raid_loot, raid_attendance, raid_event_attendance | yes | supabase-schema-full.sql |
| raid_dkp_totals, raid_attendance_dkp, raid_classifications | yes | supabase-schema-full.sql |
| dkp_adjustments, dkp_summary, dkp_period_totals, active_raiders | yes | supabase-schema-full.sql |
| officer_audit_log, restore_in_progress | yes | supabase-schema-full.sql |
| loot_assignment | yes | supabase-schema-full.sql (table early; RLS and assignment RPCs at the end) |
| character_loot_assignment_counts | yes | supabase-schema-full.sql |
| account_dkp_summary, raid_attendance_dkp_by_account, active_accounts | yes | supabase-schema-full.sql |
| bid_portfolio_auction_fact (includes `runner_up_char_guess`) | yes | supabase-schema-full.sql |
| character_dkp_spent | yes | supabase-schema-full.sql |
| account_class_coverage | yes | supabase-schema-full.sql |

Live `raid_loot` columns are `id`, `raid_id`, `event_id`, `item_name`, `char_id`, `character_name`, `cost`. Assignment columns are not on `raid_loot`. They live on `loot_assignment`.

Views on the live database that `schema-full` creates: `raid_events_ordered`, `officer_audit_loot`, `raid_loot_with_assignment`, `character_loot_assignment_count`, `guild_loot_sale_enriched`.

---

## 3. Functions the app or scripts call

Present on live DKP and defined in `supabase-schema-full.sql`:

- Account claim: `add_character_to_my_account`, `claim_account`, `unclaim_account`, `create_account`, `create_my_account`, `reset_claim_cooldown`
- DKP refresh: `refresh_dkp_summary`, `refresh_account_dkp_summary`, `refresh_account_dkp_summary_for_raid`, `refresh_all_raid_attendance_totals`
- Officer raids: `delete_raid`, `delete_tic`, `remove_attendee_from_tic`, `add_officer_tic`, `add_attendee_to_tic`
- Restore and upload: `begin_restore_load`, `end_restore_load`, `truncate_dkp_for_restore`, `delete_raid_for_reupload`, `insert_raid_event_attendance_for_upload`
- Bidding portfolio: `normalize_item_name_for_lookup`, `officer_bid_portfolio_for_loot`, `officer_account_bidding_portfolio`, `officer_backfill_bid_portfolio_batch`, procedure `dba_backfill_bid_portfolio_range`
- Loot assignment and spent: `update_single_raid_loot_assignment`, `update_raid_loot_assignments`, `get_character_dkp_spent`, `refresh_character_dkp_spent`, `refresh_after_bulk_loot_assignment`
- Raider activity and class coverage: `officer_raider_activity`, `officer_upsert_account_class_coverage`

Not in `supabase-schema-full.sql`:

| Function | Defined in |
|----------|------------|
| update_raid_event_times | supabase-update-event-times-rpc.sql (script only; not a web route) |

---

## 4. Retired bid-forecast RPCs

Not in `supabase-schema-full.sql`. Not on the live database (checked 2026-10-09):

- `officer_global_bid_forecast`
- `officer_loot_bid_forecast`
- `officer_loot_bid_forecast_v2`

[drop-officer-bid-forecast.sql](drop-officer-bid-forecast.sql) drops them. `web/src/pages/OfficerLootBidForecast.jsx` and `OfficerGlobalLootBidForecast.jsx` still call the retired RPCs, and those pages are **not** routed in `web/src/App.jsx`. Do not add the functions back into the canonical schema.

`normalize_item_name_for_lookup` is still in `supabase-schema-full.sql` and is still on the live database. It is not the retired forecast RPC.

---

## 5. RLS

Core DKP tables are authenticated-only in `supabase-schema-full.sql`.

The same file creates anon SELECT on:

- `loot_assignment` (“Anon read loot_assignment”)
- `character_dkp_spent` (“Anon read character_dkp_spent”)

That matches the live database as of 2026-10-09. [supabase-require-auth-remove-anon-read.sql](supabase-require-auth-remove-anon-read.sql) drops those policies. Re-running `supabase-schema-full.sql` creates them again. `supabase-schema-full.sql` also `GRANT SELECT ON raid_loot_with_assignment TO anon`. The view has RLS off; row access still depends on the underlying tables.

---

## 6. Leftovers on the live database

These are from one-time migration or backfill. They are not part of a fresh standup. Leave them on an already-migrated database.

- `run_account_dkp_migration`, `run_account_dkp_migration_step1`, `run_account_dkp_migration_step1_batch`, `run_account_dkp_migration_step2a`, `run_account_dkp_migration_step3`, `run_account_dkp_migration_step4`
- `clear_restore_load`
- `refresh_raid_attendance_totals_batch` (two overloads)
- `parse_raid_date_to_iso`

Defined in `supabase-account-dkp-migration.sql` and `supabase-backfill-raid-dates.sql`.
