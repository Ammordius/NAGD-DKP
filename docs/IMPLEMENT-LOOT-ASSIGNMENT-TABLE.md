# Step-by-step: Implement loot_assignment table migration

This note describes an old migration. The current schema, including `loot_assignment`, is `docs/supabase-schema-full.sql`. Do not apply the archived SQL named below.

---

## 1. Confirm current DB state

Your Supabase project should already have:

- **supabase-schema.sql** applied (tables: `raid_loot`, `profiles`, etc.)
- **supabase-officer-raids.sql** applied (officer write policies)
- **supabase-loot-to-character.sql** applied (`raid_loot` has columns `assigned_char_id`, `assigned_character_name`, `assigned_via_magelo`)

If an older database still has assignment columns on `raid_loot`, applying `docs/supabase-schema-full.sql` copies them into `loot_assignment` and drops the columns. Do not apply the archived loot SQL.

---

## 2. Where the migration lives now

`loot_assignment`, the backfill from old `raid_loot` assignment columns, the view, the RPCs, and the RLS are in `docs/supabase-schema-full.sql`. Apply that file. The steps below are the historical procedure and are not a second schema step.

- Create table **loot_assignment** (one-to-one with `raid_loot`).
- Backfill from existing `raid_loot` assignment columns (if they exist).
- Drop `assigned_char_id`, `assigned_character_name`, `assigned_via_magelo` from **raid_loot**.
- Create view **raid_loot_with_assignment**.
- Replace RPCs and triggers to use **loot_assignment**.
- Add RLS and GRANTs for **loot_assignment** and the view.

---

## 3. (Optional) Refresh caches once

In the same SQL Editor, run:

```sql
SELECT refresh_character_dkp_spent();
SELECT refresh_dkp_summary_internal();
```

This repopulates **character_dkp_spent** and **dkp_summary** from the new layout. Triggers will keep them updated going forward; this is just a one-time sync after migration.

---

## 4. Verify in Supabase

1. **Table Editor**
   - **raid_loot**: should have columns `id`, `raid_id`, `event_id`, `item_name`, `char_id`, `character_name`, `cost` only (no assignment columns).
   - **loot_assignment**: should exist with `loot_id`, `assigned_char_id`, `assigned_character_name`, `assigned_via_magelo`; row count should match **raid_loot** (backfill inserts one row per raid_loot row).
2. **Views**
   - **raid_loot_with_assignment** should appear; open it and confirm it shows raid_loot columns plus the three assignment columns.
3. **RPC**
   - In SQL Editor: `SELECT update_raid_loot_assignments('[]'::jsonb);` should return `0` (no-op). That confirms the RPC exists and runs.

---

## 5. Deploy the web app

The app code is already updated to:

- **Read** from **raid_loot_with_assignment** where assignment is needed (Loot tab, character page, item page, raid detail, Item History, Account Loot tab).
- **Write** loot rows to **raid_loot** (officer insert/update/delete); assignment changes still go through the RPC **update_single_raid_loot_assignment**.

Steps:

1. Build and deploy the **web** app as you usually do (e.g. push to main, or your host’s deploy from repo).
2. No new env vars are required.

After deploy:

- Officers can add/edit/delete loot and edit assignments from the website.
- Players can edit assignments for loot owned by their account (Loot tab).
- Item History, raid detail, character page, and item page should show assignment as before (they now read from the view).

---

## 6. CI / fetch script (no change required)

- **fetch_raid_loot_from_supabase.py** already uses **raid_loot_with_assignment** for the full fetch (so the CSV has `id` and assignment columns). Count still uses **raid_loot**.
- **update_raid_loot_assignments_supabase.py** still calls the RPC **update_raid_loot_assignments** with the same payload; the RPC now writes **loot_assignment** instead of **raid_loot**. No script changes needed.
- CI can keep using the same Supabase key (e.g. service role) for now. Later you can switch to a scoped key that only has EXECUTE on **update_raid_loot_assignments** and SELECT on the tables the fetch needs.

If you run the loot-assignment workflow after migration:

1. CI fetches from **raid_loot_with_assignment** (script change already in repo).
2. Assign script produces CSV with `id` and assignment columns.
3. **update_raid_loot_assignments_supabase.py** calls the RPC; RPC upserts **loot_assignment** and runs the refreshes.

---

## 7. Quick checklist

- [ ] **supabase-loot-to-character.sql** has been run before (raid_loot had assignment columns).
- [ ] **supabase-loot-assignment-table.sql** run in Supabase SQL Editor with no errors.
- [ ] (Optional) `refresh_character_dkp_spent()` and `refresh_dkp_summary_internal()` run once.
- [ ] Table Editor: **raid_loot** has no assignment columns; **loot_assignment** exists; view **raid_loot_with_assignment** exists.
- [ ] Web app deployed; Loot tab and raid/character/item pages load and show assignments.
- [ ] Officer can edit a loot assignment on the Account Loot tab and it saves.
- [ ] (When you run it) CI loot-assignment job runs without errors.

---

## Rollback (only if you must)

There is no automated rollback script. To undo you would need to:

1. Add the three columns back to **raid_loot**.
2. Copy data from **loot_assignment** back into **raid_loot**.
3. Drop the view, drop **loot_assignment**, and restore the old RPC/trigger definitions from **supabase-loot-to-character.sql**.

So ensure you have a DB backup (e.g. Supabase backup or dump) before running the migration if you might need to roll back.
