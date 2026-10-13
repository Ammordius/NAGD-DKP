-- Require sign-in to access DKP data. Removes anon read so only authenticated users (and officers) can read.
-- Run this in Supabase SQL Editor on an existing project that had anon read enabled.
-- After this, anon key is only used for auth (handshake, sign-in); data access requires a valid session.

DROP POLICY IF EXISTS "Anon read characters" ON characters;
DROP POLICY IF EXISTS "Anon read accounts" ON accounts;
DROP POLICY IF EXISTS "Anon read character_account" ON character_account;
DROP POLICY IF EXISTS "Anon read raids" ON raids;
DROP POLICY IF EXISTS "Anon read raid_events" ON raid_events;
DROP POLICY IF EXISTS "Anon read raid_loot" ON raid_loot;
DROP POLICY IF EXISTS "Anon read raid_attendance" ON raid_attendance;
DROP POLICY IF EXISTS "Anon read raid_event_attendance" ON raid_event_attendance;
DROP POLICY IF EXISTS "Anon read raid_classifications" ON raid_classifications;
DROP POLICY IF EXISTS "Anon read dkp_adjustments" ON dkp_adjustments;
DROP POLICY IF EXISTS "Anon read dkp_summary" ON dkp_summary;
DROP POLICY IF EXISTS "Anon read dkp_period_totals" ON dkp_period_totals;
DROP POLICY IF EXISTS "Anon read active_raiders" ON active_raiders;
DROP POLICY IF EXISTS "Anon read raid_dkp_totals" ON raid_dkp_totals;
DROP POLICY IF EXISTS "Anon read raid_attendance_dkp" ON raid_attendance_dkp;
-- Optional tables (may exist if account-dkp or loot SQL was run)
DROP POLICY IF EXISTS "Anon read account_dkp_summary" ON account_dkp_summary;
DROP POLICY IF EXISTS "Anon read raid_attendance_dkp_by_account" ON raid_attendance_dkp_by_account;
DROP POLICY IF EXISTS "Anon read active_accounts" ON active_accounts;
DROP POLICY IF EXISTS "Anon read character_dkp_spent" ON character_dkp_spent;
DROP POLICY IF EXISTS "Anon read loot_assignment" ON loot_assignment;
