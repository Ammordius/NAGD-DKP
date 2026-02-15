-- =============================================================================
-- Merge typo "Anmordius" (char_id 22036483) into "Ammordius" (char_id 22036509).
-- Run this in Supabase SQL Editor. Then run: SELECT refresh_dkp_summary();
-- =============================================================================

-- 1) Give the one per-event attendance row to Ammordius (so the 1 DKP is credited to 22036509)
UPDATE raid_event_attendance
SET char_id = '22036509', character_name = 'Ammordius'
WHERE char_id = '22036483';

-- 2) Remove the duplicate raid-level attendance row (Ammordius 22036509 already has a row for this raid)
DELETE FROM raid_attendance
WHERE raid_id = '1598436' AND char_id = '22036483';

-- 3) Remove the typo character from account link and roster (optional; keeps roster clean)
DELETE FROM character_account WHERE char_id = '22036483';
DELETE FROM characters WHERE char_id = '22036483';

-- 4) Remove Ammordius one-off adjustment (after merge, base earned = 820 = GT, so +1 would over-correct)
DELETE FROM dkp_adjustments WHERE character_name = 'Ammordius';

-- 5) Refresh cached DKP totals (required after the UPDATE/DELETE above)
SELECT refresh_dkp_summary();
