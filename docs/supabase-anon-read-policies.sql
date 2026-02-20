-- DEPRECATED: Data now requires sign-in. Do not run this file.
-- Previously this allowed anon read for public browsing. To restore that (not recommended if you want to protect egress), you would re-add the policies below.
-- To require auth (current design): use docs/supabase-schema.sql as-is (no anon read). For existing DBs that had anon read, run docs/supabase-require-auth-remove-anon-read.sql to drop anon policies.
--
-- Legacy content (do not run):

DROP POLICY IF EXISTS "Anon read characters" ON characters;
CREATE POLICY "Anon read characters" ON characters FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "Anon read accounts" ON accounts;
CREATE POLICY "Anon read accounts" ON accounts FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "Anon read character_account" ON character_account;
CREATE POLICY "Anon read character_account" ON character_account FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "Anon read raids" ON raids;
CREATE POLICY "Anon read raids" ON raids FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "Anon read raid_events" ON raid_events;
CREATE POLICY "Anon read raid_events" ON raid_events FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "Anon read raid_loot" ON raid_loot;
CREATE POLICY "Anon read raid_loot" ON raid_loot FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "Anon read raid_attendance" ON raid_attendance;
CREATE POLICY "Anon read raid_attendance" ON raid_attendance FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "Anon read raid_event_attendance" ON raid_event_attendance;
CREATE POLICY "Anon read raid_event_attendance" ON raid_event_attendance FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "Anon read raid_classifications" ON raid_classifications;
CREATE POLICY "Anon read raid_classifications" ON raid_classifications FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "Anon read dkp_adjustments" ON dkp_adjustments;
CREATE POLICY "Anon read dkp_adjustments" ON dkp_adjustments FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "Anon read dkp_summary" ON dkp_summary;
CREATE POLICY "Anon read dkp_summary" ON dkp_summary FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "Anon read dkp_period_totals" ON dkp_period_totals;
CREATE POLICY "Anon read dkp_period_totals" ON dkp_period_totals FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "Anon read active_raiders" ON active_raiders;
CREATE POLICY "Anon read active_raiders" ON active_raiders FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "Anon read raid_dkp_totals" ON raid_dkp_totals;
CREATE POLICY "Anon read raid_dkp_totals" ON raid_dkp_totals FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "Anon read raid_attendance_dkp" ON raid_attendance_dkp;
CREATE POLICY "Anon read raid_attendance_dkp" ON raid_attendance_dkp FOR SELECT TO anon USING (true);
