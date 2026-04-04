-- =============================================================================
-- Fix: duplicate key value violates unique constraint "raid_event_attendance_pkey"
-- This happens when the id sequence is behind max(id), e.g. after restore/import.
-- Run once in Supabase SQL Editor when you see that error adding an attendee to a TIC.
-- To fix all serial id tables in one go, use docs/fix_all_serial_sequences.sql
-- =============================================================================

SELECT setval(
  pg_get_serial_sequence('raid_event_attendance', 'id'),
  COALESCE((SELECT max(id) FROM raid_event_attendance), 1)
);
