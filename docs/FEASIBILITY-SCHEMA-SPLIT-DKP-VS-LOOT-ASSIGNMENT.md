# Schema Split: DKP Data vs Loot-to-Character Assignment

## Goal

- **Officers** keep **full write** on all DKP tables (raids, raid_events, raid_loot, attendance, etc.) **from the website**. The website is where data entry happens.
- **Loot assignment** (which character has the item, from Magelo) is moved to a **separate table** `loot_assignment` (one-to-one with `raid_loot`) so we can scope permissions: CI (and later a minimum-permission API key) only needs to write that table or call an RPC that does.
- **Service role** is for **migration and one-off imports** only. CI (loot assignment, daily backups) should not require the service role once a scoped API key is set up.
- **Later:** Set up a new API key with minimum required permissions for GitHub CI (loot assignment job and backups).

## Design

### Tables

| Table | Purpose | Who writes |
|-------|---------|------------|
| **raid_loot** | DKP loot row: id, raid_id, event_id, item_name, char_id, character_name, cost. No assignment columns. | Officers from website; import scripts (migration). |
| **loot_assignment** | One-to-one with raid_loot: loot_id (FK → raid_loot.id), assigned_char_id, assigned_character_name, assigned_via_magelo. | Officers from website (Loot tab); CI via RPC `update_raid_loot_assignments`. |

### View

- **raid_loot_with_assignment**: `SELECT rl.*, la.assigned_char_id, la.assigned_character_name, la.assigned_via_magelo FROM raid_loot rl LEFT JOIN loot_assignment la ON la.loot_id = rl.id`
- Used for **reads** that need assignment (Loot tab, character page, item page, LootRecipients, RaidDetail, etc.). Writes to loot data go to **raid_loot** (insert/update/delete); assignment-only updates go via RPC **update_single_raid_loot_assignment** or bulk **update_raid_loot_assignments**.

### Permissions (after migration)

| Actor | Allowed |
|-------|--------|
| **Website (officers)** | Full read/write on raids, raid_events, **raid_loot**, attendance; full read/write on **loot_assignment** (so Loot tab works); RPCs for refresh, single assignment, etc. |
| **Website (players)** | Read DKP + assignment; RPC **update_single_raid_loot_assignment** when they own the loot row (enforced in RPC). |
| **GitHub CI (loot assignment)** | Call RPC **update_raid_loot_assignments** (writes only `loot_assignment`). With a scoped key: only EXECUTE on that RPC + SELECT on raid_loot (and characters, character_account, raids) for the fetch/assign script. No service role. |
| **Daily backups** | Read-only export (scoped key with SELECT only, or same as today until key is created). |
| **Migration / one-off imports** | Service role for running migrations and initial data load. |

## Implementation

- **Migration:** `docs/supabase-loot-assignment-table.sql` creates `loot_assignment`, backfills from `raid_loot`, drops assignment columns from `raid_loot`, adds view and updated functions/RPCs/triggers, and RLS for `loot_assignment`.
- **App:** Reads that need assignment use **raid_loot_with_assignment**; writes to loot rows use **raid_loot**; assignment-only updates use existing RPCs.
- **CI:** Keeps calling **update_raid_loot_assignments**; once a scoped key exists, CI uses that key (no service role).

## Summary

| Item | Status |
|------|--------|
| Officers keep full write on DKP tables from website | Yes |
| Loot assignment in separate table for permission scoping | Yes (`loot_assignment`) |
| Service role only for migration | Yes; CI can use scoped key later |
| Scoped API key for GitHub CI (later) | Design supports it: key needs only RPC + SELECT on a few tables |
