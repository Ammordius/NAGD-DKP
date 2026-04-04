-- Keep only the 2 DKP (name-only row). Remove all attendance for char_id 21990375 so we deduplicate
-- to just character_key = 'Frinop' with earned 2. You can re-upload tics from inactive raiders etc. later.
-- Run in Supabase SQL Editor, then run the refreshs at the end.

BEGIN;

-- Remove attendance that creates the 21990375 row (1895 earned)
DELETE FROM raid_event_attendance
WHERE char_id = '21990375';

DELETE FROM raid_attendance
WHERE char_id = '21990375';

-- Remove all loot assigned to him (so spent goes to 0 for the 21990375 row; we keep only the name-only row)
DELETE FROM raid_loot
WHERE char_id = '21990375';

COMMIT;

-- Then run:
SELECT refresh_all_raid_attendance_totals();
SELECT refresh_dkp_summary();
