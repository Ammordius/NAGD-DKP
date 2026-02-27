-- =============================================================================
-- One-off: delete all data for a single raid so you can re-upload (e.g. after
-- a timeout left partial data or duplicate key on raid_event_attendance).
--
-- Option A (via API, recommended): Deploy docs/delete_raid_for_reupload_rpc.sql
-- once in Supabase SQL Editor. After that, the upload script calls the RPC
-- automatically (.\raids.ps1 upload-raid-detail 1598692). No SQL Editor needed.
--
-- Option B (manual SQL): Run the block below in Supabase SQL Editor.
-- Replace '1598692' with your raid_id. Then re-run upload-raid-detail.
-- =============================================================================

-- Child tables first (order matters for any FK).
DELETE FROM raid_event_attendance WHERE raid_id = '1598692';
DELETE FROM raid_loot          WHERE raid_id = '1598692';
DELETE FROM raid_attendance    WHERE raid_id = '1598692';
DELETE FROM raid_events        WHERE raid_id = '1598692';

SELECT refresh_raid_attendance_totals('1598692');
