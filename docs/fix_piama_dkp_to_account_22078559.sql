-- =============================================================================
-- Fix: Move 153 DKP from account "Piama" to account 22078559.
-- Run in Supabase SQL Editor. Run diagnostic first, then apply section.
--
-- Triggers: Step 1 (UPDATE raid_event_attendance) fires per-row triggers that
-- call refresh_raid_attendance_totals(raid_id) and a full refresh_dkp_summary.
-- Steps 4 and 5 are safe with triggers on (they write to tables with no triggers).
-- To avoid slow/redundant trigger work on the UPDATE, use restore-load mode
-- (option B below): begin_restore_load() before step 1, clear_restore_load()
-- after step 5 (or use clear_restore_load from migration — does not run full refresh).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- DIAGNOSTIC (run first, read-only): confirm Piama has ~153 earned and 22078559 exists
-- -----------------------------------------------------------------------------
SELECT 'account_dkp_summary' AS source, account_id, display_name, earned, spent, earned_30d, earned_60d
FROM account_dkp_summary
WHERE account_id IN ('Piama', '22078559')
ORDER BY account_id;

SELECT 'raid_event_attendance_Piama' AS source, COUNT(*) AS rows, COALESCE(SUM((re.dkp_value::numeric)), 0)::numeric(10,2) AS dkp_sum
FROM raid_event_attendance rea
LEFT JOIN raid_events re ON re.raid_id = rea.raid_id AND re.event_id = rea.event_id
WHERE rea.account_id = 'Piama';

SELECT 'raid_attendance_dkp_by_account_Piama' AS source, COUNT(*) AS rows, SUM(dkp_earned)::numeric(10,2) AS dkp_sum
FROM raid_attendance_dkp_by_account
WHERE account_id = 'Piama';

-- -----------------------------------------------------------------------------
-- FIX: Apply in order. Use either A (triggers on) or B (restore-load, recommended).
-- -----------------------------------------------------------------------------

-- OPTION B (recommended): Disable trigger work for the UPDATE; then we run full refresh in steps 4–5.
-- Uncomment the next line and run it before step 1:
-- SELECT begin_restore_load();

-- 1) Point all raid_event_attendance rows from Piama to 22078559 (source of earned DKP)
UPDATE raid_event_attendance
SET account_id = '22078559'
WHERE account_id = 'Piama';

-- 2) Point any dkp_adjustments from Piama to 22078559
UPDATE dkp_adjustments
SET account_id = '22078559'
WHERE account_id = 'Piama';

-- 3) Reassign character_account: link Piama's characters to 22078559, then remove Piama links
INSERT INTO character_account (char_id, account_id)
SELECT char_id, '22078559'
FROM character_account
WHERE account_id = 'Piama'
ON CONFLICT (char_id, account_id) DO NOTHING;

DELETE FROM character_account
WHERE account_id = 'Piama';

-- 4) Recompute account DKP summary (drops Piama, 22078559 gets combined earned)
SELECT refresh_account_dkp_summary_internal();

-- 5) Rebuild per-raid per-account totals (raid_attendance_dkp_by_account).
--    refresh_all_raid_attendance_totals() can timeout on large datasets. Use batched refresh instead:
--    Run the following, then repeat with the returned next_raid_id until processed = 0:
--
--    SELECT * FROM refresh_raid_attendance_totals_batch(50, NULL);
--    -- then e.g. SELECT * FROM refresh_raid_attendance_totals_batch(50, '<next_raid_id from above>');
--    -- repeat until (processed, next_raid_id) = (0, NULL)
--
SELECT * FROM refresh_raid_attendance_totals_batch(50, NULL);

-- If you used begin_restore_load() before step 1, re-enable triggers (do NOT use end_restore_load — we already ran the refreshes):
-- SELECT clear_restore_load();

-- 6) Optional: remove Piama from active_accounts and accounts if no longer needed.
--    Skip or comment out if DELETE FROM accounts fails (e.g. referenced by profiles).
DELETE FROM active_accounts WHERE account_id = 'Piama';
DELETE FROM accounts WHERE account_id = 'Piama';

-- -----------------------------------------------------------------------------
-- VERIFY (run after fix): 22078559 should show the combined DKP; Piama should be gone
-- -----------------------------------------------------------------------------
-- SELECT account_id, display_name, earned, spent FROM account_dkp_summary WHERE account_id = '22078559';
-- SELECT COUNT(*) FROM raid_event_attendance WHERE account_id = 'Piama';  -- should be 0
