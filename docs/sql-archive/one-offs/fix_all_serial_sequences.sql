-- =============================================================================
-- Fix: duplicate key value violates unique constraint "..._pkey" on id columns.
-- Happens when id sequences are behind max(id), e.g. after restore/import from
-- CSV (CSVs include explicit id; Postgres does not advance the sequence).
-- Run once in Supabase SQL Editor after a restore, or when you see duplicate
-- key on: raid_events, raid_loot, raid_attendance, raid_event_attendance.
-- =============================================================================

SELECT setval(pg_get_serial_sequence('raid_events', 'id'), COALESCE((SELECT max(id) FROM raid_events), 1));
SELECT setval(pg_get_serial_sequence('raid_loot', 'id'), COALESCE((SELECT max(id) FROM raid_loot), 1));
SELECT setval(pg_get_serial_sequence('raid_attendance', 'id'), COALESCE((SELECT max(id) FROM raid_attendance), 1));
SELECT setval(pg_get_serial_sequence('raid_event_attendance', 'id'), COALESCE((SELECT max(id) FROM raid_event_attendance), 1));
